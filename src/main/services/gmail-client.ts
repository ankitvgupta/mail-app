import { google, type gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { createServer, type Server } from "http";
import { readFile, writeFile, readdir, copyFile, access } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { shell } from "electron";
import { createTransport } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type {
  Email,
  EmailSearchResult,
  SentEmail,
  GmailDraft,
  SendMessageOptions,
  ComposeMessageOptions,
  AttachmentMeta,
} from "../../shared/types";
import { getAccounts } from "../db";
import { getDataDir } from "../data-dir";
import { extractEmail } from "../utils/address-formatting";
import { createLogger } from "./logger";

const log = createLogger("gmail");

// Lazy — app.getPath() throws if called before Electron is initialized (e.g. in unit tests).
// getDataDir() is itself lazy (defers app.getPath() to call time), so this is safe.
function getConfigDir(): string {
  return getDataDir();
}

const OLD_CONFIG_DIR = join(homedir(), ".config", "exo");

/**
 * One-time migration: copy token/credential files from the old ~/.config/exo/
 * location to app.getPath("userData"). Only needed on macOS where those paths differ.
 * Safe to call multiple times — skips files that already exist at the destination.
 */
export async function migrateOldConfigIfNeeded(): Promise<void> {
  const newDir = getConfigDir();
  if (OLD_CONFIG_DIR === newDir) return; // Linux: paths are the same, nothing to do

  // Skip if credentials already exist in the new location — migration already happened
  // or was never needed. Avoids touching ~/.config/ on every startup.
  if (existsSync(join(newDir, "credentials.json"))) return;

  const filesToMigrate = ["credentials.json", "tokens.json"];
  try {
    const entries = await readdir(OLD_CONFIG_DIR);
    for (const f of entries) {
      if (/^tokens-.+\.json$/.test(f)) filesToMigrate.push(f);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // fresh install
    log.warn({ err: err }, "[Config] Could not scan old config dir");
  }

  for (const file of filesToMigrate) {
    const src = join(OLD_CONFIG_DIR, file);
    const dst = join(newDir, file);
    try {
      await access(dst); // Already exists at destination — skip
    } catch {
      try {
        await copyFile(src, dst);
        log.info(`[Config] Migrated ${file} to ${newDir}`);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          log.warn(`[Config] Could not migrate ${file}: ${err}`);
        }
      }
    }
  }
}

// Helper to get config paths
// Credentials are shared across all accounts (same OAuth app)
function getCredentialsFile(): string {
  return join(getConfigDir(), "credentials.json");
}

function getTokensFile(accountId: string): string {
  if (accountId === "default") {
    return join(getConfigDir(), "tokens.json");
  }
  return join(getConfigDir(), `tokens-${accountId}.json`);
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.readonly",
];

interface Credentials {
  client_id: string;
  client_secret: string;
  redirect_uri?: string;
}

// Bundled OAuth credentials for the app's Google Cloud project.
// For desktop apps, Google considers the client secret non-secret — security relies on
// localhost redirect + user consent. Users can override by placing credentials.json on disk.
//
// Injected at build time via MAIN_VITE_GOOGLE_CLIENT_ID / MAIN_VITE_GOOGLE_CLIENT_SECRET
// env vars (electron-vite replaces import.meta.env.MAIN_VITE_* in the main process bundle).
// For local dev without these env vars, the app falls through to credentials.json on disk.
const _clientId = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? "";
const _clientSecret = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? "";
const BUNDLED_CREDENTIALS: Credentials | null =
  _clientId && _clientSecret ? { client_id: _clientId, client_secret: _clientSecret } : null;

/**
 * Detect whether an error is an OAuth authentication error (expired/revoked token).
 * Used by email-sync to distinguish auth failures from transient network errors.
 */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  // Google returns these for expired/revoked tokens
  if (msg.includes("invalid_grant") || msg.includes("token has been expired or revoked")) {
    return true;
  }
  // Check for HTTP 401 from googleapis
  const anyErr = error as unknown as Record<string, unknown>;
  if (anyErr.code === 401 || anyErr.status === 401) {
    return true;
  }
  return false;
}

export class GmailClient {
  private oauth2Client: OAuth2Client | null = null;
  private gmail: ReturnType<typeof google.gmail> | null = null;
  private lastHistoryId: string | null = null;
  private accountId: string; // For multi-account support
  private cachedAccountInfo: { email: string; displayName: string | null } | null | undefined =
    undefined;
  private pendingOAuthServer: Server | null = null;
  private pendingOAuthReject: ((reason: Error) => void) | null = null;
  private pendingOAuthTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(accountId: string = "default") {
    this.accountId = accountId;
  }

  getAccountId(): string {
    return this.accountId;
  }

  /** Cancel an in-progress OAuth flow (e.g. user closed the browser window and wants to retry). */
  abortOAuth(): void {
    if (this.pendingOAuthServer) {
      this.pendingOAuthServer.closeAllConnections();
      this.pendingOAuthServer.close();
      this.pendingOAuthServer = null;
    }
    if (this.pendingOAuthReject) {
      this.pendingOAuthReject(new Error("Authorization cancelled"));
      this.pendingOAuthReject = null;
    }
  }

  async connect(): Promise<void> {
    const credentials = await this.loadCredentials();

    this.oauth2Client = new OAuth2Client(
      credentials.client_id,
      credentials.client_secret,
      "http://localhost:3847/oauth2callback",
    );

    // Persist silently-refreshed access tokens to disk.
    // The google-auth-library automatically refreshes access tokens when they expire,
    // but only in-memory. Without this listener, refreshed tokens are lost on restart.
    this.oauth2Client.on("tokens", (tokens) => {
      log.info(`[Gmail] Token refreshed for account ${this.accountId}, persisting to disk`);
      const tokensFile = getTokensFile(this.accountId);
      // Merge with existing tokens (refresh_token may not be in the event).
      // If the file can't be read (race with another write, missing, etc.),
      // fall back to writing just the new tokens.
      readFile(tokensFile, "utf-8")
        .then((content) => {
          const existing = JSON.parse(content);
          return { ...existing, ...tokens };
        })
        .catch(() => tokens)
        .then((merged) => writeFile(tokensFile, JSON.stringify(merged, null, 2)))
        .catch((err) => {
          log.error(
            { err: err },
            `[Gmail] Failed to persist refreshed tokens for ${this.accountId}`,
          );
        });
    });

    const tokens = await this.loadOrRefreshTokens();
    this.oauth2Client.setCredentials(tokens);

    this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client });
    log.info("Connected to Gmail API");
  }

  private async loadCredentials(): Promise<Credentials> {
    const credFile = getCredentialsFile();

    // If credentials.json exists on disk, use it (allows override with custom OAuth app)
    if (existsSync(credFile)) {
      const content = await readFile(credFile, "utf-8");
      const data = JSON.parse(content);

      // Handle both formats: direct or nested under "installed"/"web"
      if (data.installed) {
        return {
          client_id: data.installed.client_id,
          client_secret: data.installed.client_secret,
        };
      } else if (data.web) {
        return {
          client_id: data.web.client_id,
          client_secret: data.web.client_secret,
        };
      } else if (data.client_id && data.client_secret) {
        return data;
      }

      throw new Error("Invalid credentials file format");
    }

    // Fall back to bundled credentials (injected at build time)
    if (BUNDLED_CREDENTIALS) {
      return BUNDLED_CREDENTIALS;
    }

    throw new Error(
      `CREDENTIALS_REQUIRED: No credentials available. ` +
        `Place credentials.json in ${getConfigDir()}/ or build with MAIN_VITE_GOOGLE_CLIENT_ID and MAIN_VITE_GOOGLE_CLIENT_SECRET env vars.`,
    );
  }

  // Exposed via IPC for users who want to override bundled credentials with their own OAuth app
  async saveCredentials(clientId: string, clientSecret: string): Promise<void> {
    if (!clientId || !clientSecret) {
      throw new Error("Client ID and Client Secret are required");
    }

    await writeFile(
      getCredentialsFile(),
      JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret.trim() }, null, 2),
    );
  }

  hasCredentials(): boolean {
    return BUNDLED_CREDENTIALS !== null || existsSync(getCredentialsFile());
  }

  hasTokens(): boolean {
    return existsSync(getTokensFile(this.accountId));
  }

  private async loadOrRefreshTokens(): Promise<{ access_token: string; refresh_token: string }> {
    const tokensFile = getTokensFile(this.accountId);
    if (existsSync(tokensFile)) {
      const content = await readFile(tokensFile, "utf-8");
      const tokens = JSON.parse(content);

      // Check if access token is expired (or about to expire in the next 5 minutes)
      const expiryDate = tokens.expiry_date as number | undefined;
      const isExpired = expiryDate != null && expiryDate < Date.now() + 5 * 60 * 1000;

      if (isExpired && tokens.refresh_token) {
        log.info(`[Gmail] Access token expired for ${this.accountId}, attempting refresh`);
        try {
          // Use a temporary client to refresh since this.oauth2Client already exists
          this.oauth2Client!.setCredentials(tokens);
          const { credentials } = await this.oauth2Client!.refreshAccessToken();
          const merged = { ...tokens, ...credentials };
          await writeFile(tokensFile, JSON.stringify(merged, null, 2));
          log.info(`[Gmail] Token refresh successful for ${this.accountId}`);
          return merged as { access_token: string; refresh_token: string };
        } catch (err) {
          // Refresh failed — token is likely revoked (Google "testing" mode 7-day expiry)
          log.error({ err: err }, `[Gmail] Token refresh failed for ${this.accountId}`);
          throw err;
        }
      }

      return tokens;
    }

    return this.doOAuthFlow();
  }

  private async doOAuthFlow(): Promise<{ access_token: string; refresh_token: string }> {
    const oauth2Client = this.oauth2Client!;

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
    });

    log.info("\nOpening browser for Google authorization...");
    log.info("If browser doesn't open, visit this URL:\n");
    log.info(authUrl);
    log.info("");

    // Open browser using Electron's shell
    await shell.openExternal(authUrl);

    // Start local server to receive callback
    const code = await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        if (this.pendingOAuthTimeout) {
          clearTimeout(this.pendingOAuthTimeout);
          this.pendingOAuthTimeout = null;
        }
        this.pendingOAuthServer = null;
        this.pendingOAuthReject = null;
      };

      const server = createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:3847`);
        const code = url.searchParams.get("code");

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
          res.end(`
            <html>
              <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
                <div style="text-align: center;">
                  <h1>✓ Exo Connected</h1>
                  <p>You can close this tab and return to the application.</p>
                </div>
              </body>
            </html>
          `);
          server.closeAllConnections();
          server.close();
          cleanup();
          resolve(code);
        } else {
          res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
          res.end("Missing authorization code");
          server.closeAllConnections();
          server.close();
          cleanup();
          reject(new Error("Missing authorization code"));
        }
      });

      // Store references so abortOAuth() can cancel this flow
      this.pendingOAuthServer = server;
      this.pendingOAuthReject = (reason: Error) => {
        cleanup();
        reject(reason);
      };

      server.listen(3847, () => {
        log.info("Waiting for authorization...");
      });

      // Timeout after 5 minutes
      this.pendingOAuthTimeout = setTimeout(
        () => {
          server.closeAllConnections();
          server.close();
          cleanup();
          reject(new Error("Authorization timeout"));
        },
        5 * 60 * 1000,
      );
    });

    const { tokens } = await oauth2Client.getToken(code);

    await writeFile(getTokensFile(this.accountId), JSON.stringify(tokens, null, 2));
    log.info(`Authorization successful! Tokens saved for account: ${this.accountId}\n`);

    return tokens as { access_token: string; refresh_token: string };
  }

  async disconnect(): Promise<void> {
    this.oauth2Client = null;
    this.gmail = null;
    log.info("Disconnected from Gmail API");
  }

  /** Delete the stored token file for this account. */
  async removeTokens(): Promise<void> {
    const { unlink } = await import("fs/promises");
    const tokensFile = getTokensFile(this.accountId);
    try {
      await unlink(tokensFile);
      log.info(`[Gmail] Deleted token file for account ${this.accountId}`);
    } catch {
      // File may not exist, that's fine
    }
  }

  /**
   * Lightweight health check — attempts getProfile() to verify the token is valid.
   * Returns true if the token works, false if it's an auth error.
   * Throws for non-auth errors (network issues).
   */
  async checkTokenHealth(): Promise<boolean> {
    try {
      await this.getProfile();
      return true;
    } catch (err) {
      if (isAuthError(err)) {
        return false;
      }
      // Non-auth error (network, etc.) — don't treat as token failure
      throw err;
    }
  }

  /**
   * Re-run the full OAuth flow, save new tokens, and reconnect the client.
   * Works even if the initial connect() failed — initializes oauth2Client from credentials if needed.
   */
  async reauth(): Promise<void> {
    if (!this.oauth2Client) {
      const credentials = await this.loadCredentials();
      this.oauth2Client = new OAuth2Client(
        credentials.client_id,
        credentials.client_secret,
        "http://localhost:3847/oauth2callback",
      );
    }
    const tokens = await this.doOAuthFlow();
    this.oauth2Client.setCredentials(tokens);
    this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client });
    log.info(`[Gmail] Re-authenticated account ${this.accountId}`);
  }

  async listCapabilities(): Promise<string[]> {
    return ["search_emails", "read_email", "create_draft"];
  }

  async searchEmails(
    query: string,
    maxResults: number = 50,
    pageToken?: string,
  ): Promise<{ results: EmailSearchResult[]; nextPageToken?: string }> {
    const gmail = this.gmail!;

    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
      ...(pageToken ? { pageToken } : {}),
    });

    const messages = response.data.messages || [];
    return {
      results: messages.map((m) => ({
        id: m.id!,
        threadId: m.threadId!,
        snippet: "",
      })),
      nextPageToken: response.data.nextPageToken || undefined,
    };
  }

  /**
   * Resolve an RFC 5322 Message-ID to a Gmail message ID.
   * Uses Gmail's `rfc822msgid:` search operator. Returns null if not found.
   */
  async findMessageByRfc822Id(rfc822MessageId: string): Promise<string | null> {
    const gmail = this.gmail!;
    const response = await gmail.users.messages.list({
      userId: "me",
      q: `rfc822msgid:${rfc822MessageId}`,
      maxResults: 1,
    });
    const messages = response.data.messages || [];
    return messages.length > 0 ? messages[0].id! : null;
  }

  /**
   * Get emails by label ID (e.g., 'INBOX', 'SENT', 'TRASH')
   */
  async getEmailsByLabel(labelId: string, maxResults: number = 500): Promise<EmailSearchResult[]> {
    const gmail = this.gmail!;
    const allMessages: EmailSearchResult[] = [];
    let pageToken: string | undefined;
    const pageSize = Math.min(maxResults, 500); // Gmail API max per page is 500

    do {
      const response = await gmail.users.messages.list({
        userId: "me",
        labelIds: [labelId],
        maxResults: pageSize,
        pageToken,
      });

      const messages = response.data.messages || [];
      for (const m of messages) {
        allMessages.push({
          id: m.id!,
          threadId: m.threadId!,
          snippet: "",
        });
      }

      pageToken = response.data.nextPageToken || undefined;

      if (allMessages.length >= maxResults) {
        return allMessages.slice(0, maxResults);
      }

      if (allMessages.length % 500 === 0 && allMessages.length > 0) {
        log.info(`[Gmail] getEmailsByLabel(${labelId}): fetched ${allMessages.length} IDs...`);
      }
    } while (pageToken);

    return allMessages;
  }

  /**
   * Get the total number of messages with a given label.
   * Uses the labels.get endpoint which returns exact counts.
   */
  async getLabelCount(labelId: string): Promise<number> {
    const gmail = this.gmail!;
    const response = await gmail.users.labels.get({
      userId: "me",
      id: labelId,
    });
    return response.data.messagesTotal || 0;
  }

  /**
   * Search emails with pagination to fetch all results
   * @param query Gmail search query
   * @param maxTotal Maximum total results (0 = no limit)
   */
  async searchAllEmails(query: string, maxTotal: number = 0): Promise<EmailSearchResult[]> {
    const gmail = this.gmail!;
    const allMessages: EmailSearchResult[] = [];
    let pageToken: string | undefined;
    const pageSize = 500; // Gmail API max per page

    do {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: pageSize,
        pageToken,
      });

      const messages = response.data.messages || [];
      for (const m of messages) {
        allMessages.push({
          id: m.id!,
          threadId: m.threadId!,
          snippet: "",
        });
      }

      pageToken = response.data.nextPageToken || undefined;

      // Check if we've hit the max total
      if (maxTotal > 0 && allMessages.length >= maxTotal) {
        return allMessages.slice(0, maxTotal);
      }

      // Log progress for large syncs
      if (allMessages.length % 500 === 0 && allMessages.length > 0) {
        log.info(`[Gmail] Fetched ${allMessages.length} message IDs...`);
      }
    } while (pageToken);

    return allMessages;
  }

  /**
   * Fetch multiple messages in parallel with concurrency limit.
   * Uses Promise.allSettled so individual failures don't abort the batch.
   */
  async getMessages(messageIds: string[], concurrency: number = 10): Promise<Email[]> {
    const results: Email[] = [];
    for (let i = 0; i < messageIds.length; i += concurrency) {
      const chunk = messageIds.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map((id) => this.readEmail(id)));
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value) {
          results.push(result.value);
        }
      }
    }
    return results;
  }

  async readEmail(messageId: string): Promise<Email | null> {
    const gmail = this.gmail!;

    const response = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const message = response.data;
    const headers = message.payload?.headers || [];

    const getHeader = (name: string): string => {
      const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
      return header?.value || "";
    };

    const body = await this.extractBodyWithImages(message.payload!, message.id!);
    const attachments = this.extractAttachments(message.payload!);

    const cc = getHeader("cc");
    const bcc = getHeader("bcc");
    const messageIdHeader = getHeader("message-id");
    const inReplyToHeader = getHeader("in-reply-to");
    return {
      id: message.id!,
      threadId: message.threadId!,
      subject: getHeader("subject"),
      from: getHeader("from"),
      to: getHeader("to"),
      ...(cc && { cc }),
      ...(bcc && { bcc }),
      date: getHeader("date"),
      body,
      snippet: message.snippet || "",
      labelIds: message.labelIds || [],
      ...(attachments.length > 0 && { attachments }),
      ...(messageIdHeader && { messageIdHeader }),
      ...(inReplyToHeader && { inReplyTo: inReplyToHeader }),
    };
  }

  /**
   * Get all messages in a thread (including sent replies)
   */
  async getThread(threadId: string): Promise<Email[]> {
    const gmail = this.gmail!;

    const response = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    // Filter out DRAFT messages — our synced Gmail drafts show up here
    // and would otherwise be saved as regular thread members.
    const messages = (response.data.messages || []).filter((m) => !m.labelIds?.includes("DRAFT"));
    const emails: Email[] = [];

    for (const message of messages) {
      const headers = message.payload?.headers || [];

      const getHeader = (name: string): string => {
        const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
        return header?.value || "";
      };

      const body = await this.extractBodyWithImages(message.payload!, message.id!);
      const attachments = this.extractAttachments(message.payload!);

      const cc = getHeader("cc");
      const bcc = getHeader("bcc");
      const messageIdHeader = getHeader("message-id");
      const inReplyToHeader = getHeader("in-reply-to");
      emails.push({
        id: message.id!,
        threadId: message.threadId!,
        subject: getHeader("subject"),
        from: getHeader("from"),
        to: getHeader("to"),
        ...(cc && { cc }),
        ...(bcc && { bcc }),
        date: getHeader("date"),
        body,
        snippet: message.snippet || "",
        labelIds: message.labelIds || [],
        ...(attachments.length > 0 && { attachments }),
        ...(messageIdHeader && { messageIdHeader }),
        ...(inReplyToHeader && { inReplyTo: inReplyToHeader }),
      });
    }

    return emails;
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    if (!payload) return "";

    // Direct body
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, "base64").toString("utf-8");
    }

    // Multipart - prefer HTML for better rendering, fall back to plain text
    if (payload.parts) {
      // First try to find HTML content
      for (const part of payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
      }
      // Fall back to plain text
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
      }
      // Recurse into nested parts
      for (const part of payload.parts) {
        const nested = this.extractBody(part);
        if (nested) return nested;
      }
    }

    return "";
  }

  /**
   * Collect inline image parts from MIME tree (parts with Content-ID headers).
   * Returns a map from Content-ID (without angle brackets) to image metadata.
   */
  private collectInlineImages(
    payload: gmail_v1.Schema$MessagePart,
  ): Map<string, { mimeType: string; data?: string; attachmentId?: string }> {
    const images = new Map<string, { mimeType: string; data?: string; attachmentId?: string }>();

    const walk = (part: gmail_v1.Schema$MessagePart) => {
      const headers = part.headers || [];
      const contentId = headers.find((h) => h.name?.toLowerCase() === "content-id")?.value;

      if (contentId && part.mimeType?.startsWith("image/")) {
        // Content-ID is typically wrapped in angle brackets: <image001@domain>
        const cid = contentId.replace(/^<|>$/g, "");
        images.set(cid, {
          mimeType: part.mimeType,
          data: part.body?.data ?? undefined,
          attachmentId: part.body?.attachmentId ?? undefined,
        });
      }

      if (part.parts) {
        for (const child of part.parts) {
          walk(child);
        }
      }
    };

    walk(payload);
    return images;
  }

  /**
   * Extract attachment metadata from a Gmail message payload.
   * Recursively walks multipart MIME structure to find parts with a filename.
   */
  private extractAttachments(payload: gmail_v1.Schema$MessagePart): AttachmentMeta[] {
    const attachments: AttachmentMeta[] = [];
    if (!payload) return attachments;

    this.collectAttachments(payload, attachments);
    return attachments;
  }

  private collectAttachments(part: gmail_v1.Schema$MessagePart, result: AttachmentMeta[]): void {
    // A part is an attachment if it has a filename AND an attachmentId.
    // Inline parts (signatures, logos) have filenames but no attachmentId.
    const filename = part.filename;
    if (filename && filename.length > 0 && part.body?.attachmentId) {
      result.push({
        id: `${part.partId || "0"}-${filename}`,
        filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body?.size || 0,
        attachmentId: part.body?.attachmentId,
      });
    }

    // Recurse into nested parts
    if (part.parts) {
      for (const child of part.parts) {
        this.collectAttachments(child, result);
      }
    }
  }

  /**
   * Download attachment data from Gmail API.
   * Returns base64-encoded content.
   */
  async getAttachment(messageId: string, attachmentId: string): Promise<string> {
    const gmail = this.gmail!;
    const response = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    // Gmail returns base64url-encoded data
    return response.data.data || "";
  }

  /**
   * Replace cid: references in HTML with data: URIs using inline image data.
   * Falls back to fetching attachments from Gmail if not available inline.
   */
  private async resolveInlineImages(
    html: string,
    inlineImages: Map<string, { mimeType: string; data?: string; attachmentId?: string }>,
    messageId: string,
  ): Promise<string> {
    if (inlineImages.size === 0) return html;

    // Find all cid: references in the HTML
    const cidRefs = new Set<string>();
    const cidRegex = /cid:([^\s"'<>)]+)/g;
    let match;
    while ((match = cidRegex.exec(html)) !== null) {
      cidRefs.add(match[1]);
    }

    if (cidRefs.size === 0) return html;

    // Resolve each referenced CID to a data URI
    const replacements = new Map<string, string>();

    await Promise.all(
      [...cidRefs].map(async (cid) => {
        const imageInfo = inlineImages.get(cid);
        if (!imageInfo) return;

        let base64Data = imageInfo.data;

        // Fetch from Gmail API if data wasn't inline in the payload
        if (!base64Data && imageInfo.attachmentId) {
          try {
            base64Data = await this.getAttachment(messageId, imageInfo.attachmentId);
          } catch (err) {
            log.error({ err: err }, `[Gmail] Failed to fetch inline image ${cid}`);
            return;
          }
        }

        if (base64Data) {
          // Gmail uses URL-safe base64 without padding; convert to standard base64 for data URIs
          let standardBase64 = base64Data.replace(/-/g, "+").replace(/_/g, "/");
          const pad = standardBase64.length % 4;
          if (pad) standardBase64 += "=".repeat(4 - pad);
          replacements.set(`cid:${cid}`, `data:${imageInfo.mimeType};base64,${standardBase64}`);
        }
      }),
    );

    let result = html;
    for (const [from, to] of replacements) {
      result = result.split(from).join(to);
    }

    return result;
  }

  /**
   * Extract body and resolve inline CID images to data URIs.
   */
  private async extractBodyWithImages(
    payload: gmail_v1.Schema$MessagePart | undefined,
    messageId: string,
  ): Promise<string> {
    if (!payload) return "";
    let body = this.extractBody(payload);
    // Track which payload to use for inline image collection — if we fall back
    // to messages.get, we need the fresh payload (the original may be truncated).
    let imagePayload = payload;

    // When threads.get omits body.data for large messages, extractBody returns "".
    // Fall back to fetching the individual message which always includes body data.
    if (!body && this.hasHtmlPartWithoutData(payload)) {
      try {
        const gmail = this.gmail!;
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });
        if (msg.data.payload) {
          body = this.extractBody(msg.data.payload);
          imagePayload = msg.data.payload;
        }
      } catch (err) {
        log.error({ err: err }, `[GmailClient] Failed to fetch body for message ${messageId}`);
      }
    }

    if (!body || !/<[a-z][\s\S]*>/i.test(body)) return body; // skip for plain text

    const inlineImages = this.collectInlineImages(imagePayload);
    if (inlineImages.size === 0) return body;

    return this.resolveInlineImages(body, inlineImages, messageId);
  }

  /**
   * Check if the MIME tree contains a text/html part that has body.size but no body.data.
   * This happens when threads.get omits body data for large messages.
   */
  private hasHtmlPartWithoutData(payload: gmail_v1.Schema$MessagePart | null | undefined): boolean {
    if (!payload) return false;
    if (
      payload.mimeType === "text/html" &&
      payload.body &&
      (payload.body.size ?? 0) > 0 &&
      !payload.body.data
    ) {
      return true;
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (this.hasHtmlPartWithoutData(part)) return true;
      }
    }
    return false;
  }

  async createDraft(params: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    cc?: string[];
    bcc?: string[];
    inReplyTo?: string;
    references?: string;
  }): Promise<{ id: string }> {
    const gmail = this.gmail!;

    // Use cached account email from DB to avoid an unnecessary getProfile() API call
    const accountInfo = this.getAccountInfo();
    const email = accountInfo?.email || (await this.getProfile()).emailAddress;
    const from = this.getSenderAddress(email);

    // Use buildMimeMessage (nodemailer) for proper RFC 2822 formatting.
    // Manual header construction was missing MIME-Version, Content-Type, and
    // proper CRLF line endings, causing Gmail to classify drafts as forwards.
    const encodedMessage = await this.buildMimeMessage({
      from,
      to: [params.to],
      subject: params.subject,
      bodyText: params.body,
      cc: params.cc,
      bcc: params.bcc,
      inReplyTo: params.inReplyTo,
      references: params.references,
    });

    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw: encodedMessage,
          threadId: params.threadId,
        },
      },
    });

    return { id: response.data.id! };
  }

  /**
   * Extract data URI images from HTML, replace with cid: references,
   * and return nodemailer-compatible attachments.
   */
  private extractInlineImagesFromHtml(html: string): {
    html: string;
    attachments: Mail.Attachment[];
  } {
    const attachments: Mail.Attachment[] = [];
    let imageIndex = 0;

    // Match <img> src attributes with data URIs (backreference ensures matching quotes)
    const processed = html.replace(
      /(<img\s[^>]*src\s*=\s*)(["'])data:(image\/[^;]+);base64,([\s\S]*?)\2([^>]*>)/gi,
      (
        _match,
        prefix: string,
        quote: string,
        mimeType: string,
        rawBase64: string,
        suffix: string,
      ) => {
        const base64Data = rawBase64.replace(/\s+/g, "");
        if (!base64Data) return _match;
        imageIndex++;
        const cid = `inline-image-${imageIndex}@exo`;
        const ext = mimeType.split("/")[1] || "png";

        attachments.push({
          filename: `image${imageIndex}.${ext}`,
          content: Buffer.from(base64Data, "base64"),
          contentType: mimeType,
          cid,
          contentDisposition: "inline",
        });

        return `${prefix}${quote}cid:${cid}${quote}${suffix}`;
      },
    );

    return { html: processed, attachments };
  }

  /**
   * Build RFC 2822 MIME message using nodemailer
   */
  private async buildMimeMessage(options: ComposeMessageOptions): Promise<string> {
    // Create a transport that just builds the message
    const transport = createTransport({ streamTransport: true });

    // Format addresses with display names when available.
    // Returns nodemailer Address objects so it handles RFC 2822 quoting
    // (e.g. names with commas: "Doe, John") automatically.
    const formatAddresses = (
      addresses: string[],
    ): (string | { name: string; address: string })[] => {
      if (!options.recipientNames) return addresses;
      return addresses.map((addr) => {
        const name = options.recipientNames![extractEmail(addr).toLowerCase()];
        if (name) return { name, address: addr };
        return addr;
      });
    };

    const mailOptions: Mail.Options = {
      from: options.from,
      to: formatAddresses(options.to),
      subject: options.subject,
    };

    if (options.cc?.length) {
      mailOptions.cc = formatAddresses(options.cc);
    }
    if (options.bcc?.length) {
      mailOptions.bcc = formatAddresses(options.bcc);
    }

    // Set reply headers for threading
    if (options.inReplyTo) {
      mailOptions.inReplyTo = options.inReplyTo;
    }
    if (options.references) {
      mailOptions.references = options.references;
    }

    // Set body - prefer HTML with plain text fallback
    if (options.bodyHtml) {
      // Extract inline data URI images and convert to CID attachments
      const { html, attachments } = this.extractInlineImagesFromHtml(options.bodyHtml);
      mailOptions.html = html;
      if (attachments.length > 0) {
        mailOptions.attachments = attachments;
      }
      if (options.bodyText) {
        mailOptions.text = options.bodyText;
      }
    } else {
      mailOptions.text = options.bodyText || "";
    }

    // Add regular attachments, merging with any inline image attachments
    if (options.attachments?.length) {
      const regularAttachments = await Promise.all(
        options.attachments.map(async (att) => {
          if (att.path) {
            // Local file
            return {
              filename: att.filename,
              path: att.path,
              contentType: att.mimeType,
            };
          } else if (att.content) {
            // Base64-encoded content (forwarded attachments)
            return {
              filename: att.filename,
              content: Buffer.from(att.content, "base64"),
              contentType: att.mimeType,
            };
          }
          return { filename: att.filename, content: "", contentType: att.mimeType };
        }),
      );
      mailOptions.attachments = [...(mailOptions.attachments || []), ...regularAttachments];
    }

    // Build the message
    const info = await transport.sendMail(mailOptions);
    const messageBuffer = await new Promise<Buffer>((resolve, reject) => {
      const msg = info.message;
      if (Buffer.isBuffer(msg)) {
        resolve(msg);
        return;
      }
      const chunks: Buffer[] = [];
      msg.on("data", (chunk: Buffer) => chunks.push(chunk));
      msg.on("end", () => resolve(Buffer.concat(chunks)));
      msg.on("error", reject);
    });

    return messageBuffer.toString("base64url");
  }

  /**
   * Send a new email message
   */
  async sendMessage(options: SendMessageOptions): Promise<{ id: string; threadId: string }> {
    const gmail = this.gmail!;

    // Get sender address with display name if not explicitly provided
    const profile = await this.getProfile();
    const from = options.from || this.getSenderAddress(profile.emailAddress);

    const raw = await this.buildMimeMessage({
      ...options,
      from,
    });

    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: options.threadId,
      },
    });

    return {
      id: response.data.id!,
      threadId: response.data.threadId!,
    };
  }

  /**
   * Create a draft with full MIME support (HTML, attachments)
   */
  async createFullDraft(
    options: ComposeMessageOptions,
  ): Promise<{ id: string; messageId: string }> {
    const gmail = this.gmail!;

    // Get sender address with display name if not explicitly provided
    const profile = await this.getProfile();
    const from = options.from || this.getSenderAddress(profile.emailAddress);

    const raw = await this.buildMimeMessage({
      ...options,
      from,
    });

    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          threadId: options.threadId,
        },
      },
    });

    return {
      id: response.data.id!,
      messageId: response.data.message?.id || "",
    };
  }

  /**
   * Update an existing Gmail draft
   */
  async updateDraft(
    draftId: string,
    options: ComposeMessageOptions,
  ): Promise<{ id: string; messageId: string }> {
    const gmail = this.gmail!;

    // Get sender address with display name if not explicitly provided
    const profile = await this.getProfile();
    const from = options.from || this.getSenderAddress(profile.emailAddress);

    const raw = await this.buildMimeMessage({
      ...options,
      from,
    });

    const response = await gmail.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: {
        message: {
          raw,
          threadId: options.threadId,
        },
      },
    });

    return {
      id: response.data.id!,
      messageId: response.data.message?.id || "",
    };
  }

  /**
   * Send an existing draft
   */
  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    const gmail = this.gmail!;

    const response = await gmail.users.drafts.send({
      userId: "me",
      requestBody: {
        id: draftId,
      },
    });

    return {
      id: response.data.id!,
      threadId: response.data.threadId!,
    };
  }

  /**
   * List Gmail drafts
   */
  async listDrafts(maxResults: number = 100): Promise<GmailDraft[]> {
    const gmail = this.gmail!;

    const response = await gmail.users.drafts.list({
      userId: "me",
      maxResults,
    });

    const drafts = response.data.drafts || [];
    const fullDrafts: GmailDraft[] = [];

    for (const draft of drafts) {
      try {
        const fullDraft = await this.getDraft(draft.id!);
        if (fullDraft) {
          fullDrafts.push(fullDraft);
        }
      } catch (error) {
        log.error({ err: error }, `Failed to fetch draft ${draft.id}`);
      }
    }

    return fullDrafts;
  }

  /**
   * Get a single draft by ID
   */
  async getDraft(draftId: string): Promise<GmailDraft | null> {
    const gmail = this.gmail!;

    try {
      const response = await gmail.users.drafts.get({
        userId: "me",
        id: draftId,
        format: "full",
      });

      const message = response.data.message;
      if (!message) return null;

      const headers = message.payload?.headers || [];
      const getHeader = (name: string): string => {
        const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
        return header?.value || "";
      };

      const body = await this.extractBodyWithImages(message.payload, message.id!);

      return {
        id: response.data.id!,
        messageId: message.id!,
        threadId: message.threadId || undefined,
        to: getHeader("to")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        cc: getHeader("cc")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        bcc: getHeader("bcc")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        subject: getHeader("subject"),
        body,
        snippet: message.snippet || "",
      };
    } catch (error) {
      log.error({ err: error }, `Failed to get draft ${draftId}`);
      return null;
    }
  }

  /**
   * Delete a draft
   */
  async deleteDraft(draftId: string): Promise<void> {
    const gmail = this.gmail!;
    await gmail.users.drafts.delete({
      userId: "me",
      id: draftId,
    });
  }

  /**
   * Archive a message (remove INBOX label)
   */
  async archiveMessage(messageId: string): Promise<void> {
    const gmail = this.gmail!;
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        removeLabelIds: ["INBOX"],
      },
    });
  }

  /**
   * Archive multiple messages in a single API call using batchModify.
   * Gmail's batchModify supports up to 1000 message IDs per call.
   */
  async batchArchive(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const gmail = this.gmail!;
    // Gmail batchModify supports up to 1000 IDs per call — chunk if needed
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < messageIds.length; i += CHUNK_SIZE) {
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: messageIds.slice(i, i + CHUNK_SIZE),
          removeLabelIds: ["INBOX"],
        },
      });
    }
  }

  /**
   * Trash multiple messages using individual trash() calls with concurrency limiting.
   * Gmail has no batch trash endpoint, and batchModify with addLabelIds: ["TRASH"]
   * only adds the label without triggering the 30-day auto-delete behavior.
   * Returns list of message IDs that failed (empty array on full success).
   */
  async batchTrash(messageIds: string[]): Promise<{ failedIds: string[] }> {
    if (messageIds.length === 0) return { failedIds: [] };
    const failedIds: string[] = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < messageIds.length; i += CONCURRENCY) {
      const batch = messageIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((id) => this.trashMessage(id)));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "rejected") {
          failedIds.push(batch[j]);
        }
      }
    }
    return { failedIds };
  }

  /**
   * Restore a message to inbox (add INBOX label back)
   */
  async restoreToInbox(messageId: string): Promise<void> {
    const gmail = this.gmail!;
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: ["INBOX"],
      },
    });
  }

  /**
   * Move message to trash
   */
  async trashMessage(messageId: string): Promise<void> {
    const gmail = this.gmail!;
    await gmail.users.messages.trash({
      userId: "me",
      id: messageId,
    });
  }

  /**
   * Star/unstar a message
   */
  async setStarred(messageId: string, starred: boolean): Promise<void> {
    const gmail = this.gmail!;
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: starred ? ["STARRED"] : [],
        removeLabelIds: starred ? [] : ["STARRED"],
      },
    });
  }

  /**
   * Mark message as read/unread
   */
  async setRead(messageId: string, read: boolean): Promise<void> {
    const gmail = this.gmail!;
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: read ? [] : ["UNREAD"],
        removeLabelIds: read ? ["UNREAD"] : [],
      },
    });
  }

  /**
   * Mark all messages in a thread as read (removes UNREAD label from every message)
   */
  async markThreadAsRead(threadId: string): Promise<void> {
    const gmail = this.gmail!;
    await gmail.users.threads.modify({
      userId: "me",
      id: threadId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    });
  }

  /**
   * Get message headers for reply threading
   */
  async getMessageHeaders(
    messageId: string,
  ): Promise<{ messageId: string; references: string; subject: string } | null> {
    const gmail = this.gmail!;

    try {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "metadata",
        metadataHeaders: ["Message-ID", "References", "Subject"],
      });

      const headers = response.data.payload?.headers || [];
      const getHeader = (name: string): string => {
        const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
        return header?.value || "";
      };

      return {
        messageId: getHeader("message-id"),
        references: getHeader("references"),
        subject: getHeader("subject"),
      };
    } catch (error) {
      log.error({ err: error }, `Failed to get message headers for ${messageId}`);
      return null;
    }
  }

  // Get user profile (email address, etc.)
  async getProfile(): Promise<{ emailAddress: string; messagesTotal: number; historyId: string }> {
    const gmail = this.gmail!;
    const response = await gmail.users.getProfile({ userId: "me" });

    // Store historyId for incremental sync
    this.lastHistoryId = response.data.historyId || null;

    return {
      emailAddress: response.data.emailAddress!,
      messagesTotal: response.data.messagesTotal || 0,
      historyId: response.data.historyId || "",
    };
  }

  /**
   * Fetch the display name from Gmail send-as settings.
   * Separate from getProfile() to avoid adding latency to hot paths
   * (sendMessage, createDraft, sync, health checks) that don't need it.
   *
   * Falls back to the Google People API (own profile) if send-as has no name,
   * which is common for Google Workspace accounts.
   */
  async fetchDisplayName(): Promise<string | null> {
    try {
      const gmail = this.gmail!;

      // Try send-as settings first (the name shown on outgoing mail)
      const sendAsResponse = await gmail.users.settings.sendAs.list({ userId: "me" });
      const primarySendAs = sendAsResponse.data.sendAs?.find((s) => s.isPrimary);
      const sendAsName = primarySendAs?.displayName?.trim() || null;
      if (sendAsName) {
        log.info(`[GmailClient] Display name from send-as: "${sendAsName}"`);
        return sendAsName;
      }

      // Fallback: check all send-as aliases for one matching this account's email.
      // Use getProfile() instead of getAccountInfo() since the account may not
      // be in the DB yet during OAuth registration.
      const accountEmail = this.getAccountInfo()?.email || (await this.getProfile()).emailAddress;
      if (accountEmail) {
        const matchingAlias = sendAsResponse.data.sendAs?.find(
          (s) =>
            s.sendAsEmail?.toLowerCase() === accountEmail.toLowerCase() && s.displayName?.trim(),
        );
        if (matchingAlias?.displayName) {
          const name = matchingAlias.displayName.trim();
          log.info(`[GmailClient] Display name from send-as alias match: "${name}"`);
          return name;
        }
      }

      // Last resort: fetch name from OAuth2 userinfo (requires userinfo.profile scope)
      try {
        const oauth2 = google.oauth2({ version: "v2", auth: this.oauth2Client! });
        const userInfo = await oauth2.userinfo.get();
        const name = userInfo.data.name?.trim() || null;
        if (name) {
          log.info(`[GmailClient] Display name from userinfo: "${name}"`);
          return name;
        }
      } catch (userinfoError) {
        log.warn({ err: userinfoError }, "[GmailClient] Userinfo fallback failed");
      }

      log.warn("[GmailClient] No display name found from send-as or People API");
      return null;
    } catch (error) {
      log.warn({ err: error }, "[GmailClient] Failed to fetch send-as display name");
      return null;
    }
  }

  /** Clear cached account info so the next getAccountInfo() reads fresh from DB */
  clearAccountInfoCache(): void {
    this.cachedAccountInfo = undefined;
  }

  /**
   * Look up cached account info (email + display name) from the DB.
   * Cached on first use since accountId is immutable.
   */
  private getAccountInfo(): { email: string; displayName: string | null } | null {
    // Only use cache if we previously found a valid account.
    // Don't cache null (account-not-found) because the account may not be
    // saved to DB yet during registration — caching null would make the
    // stale result permanent.
    if (this.cachedAccountInfo === undefined || this.cachedAccountInfo === null) {
      const account = getAccounts().find((a) => a.id === this.accountId);
      if (account) {
        this.cachedAccountInfo = { email: account.email, displayName: account.displayName ?? null };
      } else {
        return null;
      }
    }
    return this.cachedAccountInfo;
  }

  /**
   * Get the formatted sender address for this account, including display name
   * if available. Returns RFC 5322 formatted "Display Name <email>" or just "email".
   */
  private getSenderAddress(email: string): string {
    const info = this.getAccountInfo();
    if (info?.displayName) {
      // RFC 5322: quote display name if it contains special characters
      const needsQuoting = /[",.<>@;:\\[\]()]/.test(info.displayName);
      const displayName = needsQuoting
        ? `"${info.displayName.replace(/["\\]/g, "\\$&")}"`
        : info.displayName;
      return `${displayName} <${email}>`;
    }
    return email;
  }

  // Get current history ID for sync
  getLastHistoryId(): string | null {
    return this.lastHistoryId;
  }

  setLastHistoryId(historyId: string | null): void {
    this.lastHistoryId = historyId;
  }

  // Get changes since last sync using History API (efficient incremental sync)
  async getHistoryChanges(startHistoryId: string): Promise<{
    newMessageIds: string[];
    deletedMessageIds: string[];
    readMessageIds: string[];
    unreadMessageIds: string[];
    historyId: string;
  }> {
    const gmail = this.gmail!;

    const newMessageIds: string[] = [];
    const deletedMessageIds: string[] = [];
    const readMessageIds: string[] = [];
    const unreadMessageIds: string[] = [];
    let latestHistoryId = startHistoryId;

    // Fetch history for a single label, accumulating into the shared arrays above
    const fetchLabel = async (labelId: string) => {
      let pageToken: string | undefined;
      do {
        const response = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
          labelId,
          pageToken,
        });

        const history = response.data.history || [];

        for (const item of history) {
          if (item.messagesAdded) {
            for (const msg of item.messagesAdded) {
              if (msg.message?.id && msg.message?.labelIds?.includes(labelId)) {
                newMessageIds.push(msg.message.id);
              }
            }
          }

          if (item.messagesDeleted) {
            for (const msg of item.messagesDeleted) {
              if (msg.message?.id) {
                deletedMessageIds.push(msg.message.id);
              }
            }
          }

          if (item.labelsRemoved) {
            for (const labelChange of item.labelsRemoved) {
              if (!labelChange.message?.id) continue;
              // Archived (INBOX label removed)
              if (labelChange.labelIds?.includes("INBOX")) {
                deletedMessageIds.push(labelChange.message.id);
              }
              // Marked as read (UNREAD label removed)
              if (labelChange.labelIds?.includes("UNREAD")) {
                readMessageIds.push(labelChange.message.id);
              }
            }
          }

          if (item.labelsAdded) {
            for (const labelChange of item.labelsAdded) {
              if (!labelChange.message?.id) continue;
              if (labelChange.labelIds?.includes("UNREAD")) {
                unreadMessageIds.push(labelChange.message.id);
              }
              // Detect draft-to-sent conversions: when a user sends our synced
              // Gmail draft, the History API reports it as labelsAdded (SENT)
              // rather than messagesAdded. Treat it as a new message so
              // incrementalSync can run draft cleanup on the thread.
              if (labelChange.labelIds?.includes("SENT")) {
                newMessageIds.push(labelChange.message.id);
              }
            }
          }
        }

        // Use the highest historyId across both calls
        const responseHistoryId = response.data.historyId || startHistoryId;
        if (responseHistoryId > latestHistoryId) {
          latestHistoryId = responseHistoryId;
        }
        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);
    };

    try {
      // Fetch INBOX and SENT history in parallel
      await Promise.all([fetchLabel("INBOX"), fetchLabel("SENT")]);

      this.lastHistoryId = latestHistoryId;

      // Dedupe; exclude messages already handled as new/deleted
      const newSet = new Set(newMessageIds);
      const deletedSet = new Set(deletedMessageIds);
      const filterHandled = (id: string) => !newSet.has(id) && !deletedSet.has(id);

      return {
        newMessageIds: [...newSet],
        deletedMessageIds: [...deletedSet],
        readMessageIds: [...new Set(readMessageIds)].filter(filterHandled),
        unreadMessageIds: [...new Set(unreadMessageIds)].filter(filterHandled),
        historyId: latestHistoryId,
      };
    } catch (error: unknown) {
      // History ID might be too old (404 error) - need full resync
      const errObj = error as { code?: number; status?: number };
      if (errObj.code === 404 || errObj.status === 404) {
        log.info("[Gmail] History ID expired, need full resync");
        throw new Error("HISTORY_EXPIRED");
      }
      throw error;
    }
  }

  async searchSentEmails(maxResults: number = 500): Promise<SentEmail[]> {
    const gmail = this.gmail!;

    const response = await gmail.users.messages.list({
      userId: "me",
      q: "in:sent",
      maxResults,
    });

    const messages = response.data.messages || [];
    const sentEmails: SentEmail[] = [];

    for (const m of messages) {
      try {
        const fullMessage = await gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "full",
        });

        const headers = fullMessage.data.payload?.headers || [];
        const getHeader = (name: string): string => {
          const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
          return header?.value || "";
        };

        const body = await this.extractBodyWithImages(fullMessage.data.payload, m.id!);

        sentEmails.push({
          id: m.id!,
          toAddress: getHeader("to"),
          subject: getHeader("subject"),
          body,
          date: getHeader("date"),
        });
      } catch (error) {
        log.error({ err: error }, `Failed to read sent email ${m.id}`);
      }
    }

    return sentEmails;
  }
}
