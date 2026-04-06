import { ipcMain } from "electron";
import { GmailClient } from "../services/gmail-client";
import { saveEmail, getEmailIds, getInboxEmails, getEmail, saveAccount, getAccounts } from "../db";
import { getConfig } from "./settings.ipc";
import type { IpcResponse, DashboardEmail } from "../../shared/types";
import { DEMO_INBOX_EMAILS, DEMO_EXPECTED_ANALYSIS } from "../demo/fake-inbox";
import { createLogger } from "../services/logger";

const log = createLogger("gmail-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

const gmailClients = new Map<string, GmailClient>();

// Track the client during OAuth — getClient() only adds to gmailClients after
// connect() resolves, but we need to abort the pending flow before that.
let pendingOAuthClient: GmailClient | null = null;

function resolveTargetAccountId(accountId?: string): string {
  const trimmedAccountId = accountId?.trim();
  const accounts = getAccounts();

  if (trimmedAccountId && accounts.some((account) => account.id === trimmedAccountId)) {
    return trimmedAccountId;
  }

  const fallbackAccount = accounts.find((account) => account.isPrimary) ?? accounts[0];
  const fallbackId = fallbackAccount?.id ?? "default";

  if (trimmedAccountId) {
    log.warn(
      `[Gmail] Requested account "${trimmedAccountId}" not found, falling back to "${fallbackId}"`,
    );
  }

  return fallbackId;
}

export async function getClient(accountId = "default"): Promise<GmailClient> {
  const existing = gmailClients.get(accountId);
  if (existing) {
    return existing;
  }

  const client = new GmailClient(accountId);
  await client.connect();
  gmailClients.set(accountId, client);
  return client;
}

export function registerGmailIpc(): void {
  // Check authentication status
  ipcMain.handle(
    "gmail:check-auth",
    async (): Promise<
      IpcResponse<{ hasCredentials: boolean; hasTokens: boolean; hasAnthropicKey: boolean }>
    > => {
      // In demo/test mode, always return authenticated
      if (useFakeData) {
        return {
          success: true,
          data: {
            hasCredentials: true,
            hasTokens: true,
            hasAnthropicKey: true,
          },
        };
      }

      try {
        const client = new GmailClient();
        const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY || getConfig().anthropicApiKey);
        return {
          success: true,
          data: {
            hasCredentials: client.hasCredentials(),
            hasTokens: client.hasTokens(),
            hasAnthropicKey,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Save credentials
  ipcMain.handle(
    "gmail:save-credentials",
    async (
      _,
      { clientId, clientSecret }: { clientId: string; clientSecret: string },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        const client = new GmailClient();
        await client.saveCredentials(clientId, clientSecret);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Cancel an in-progress OAuth flow
  ipcMain.handle("gmail:abort-oauth", async (): Promise<IpcResponse<void>> => {
    // Check the pending client first — during OAuth, the client isn't in the map yet
    if (pendingOAuthClient) {
      pendingOAuthClient.abortOAuth();
      pendingOAuthClient = null;
    }
    const existingClient = gmailClients.get("default");
    if (existingClient) {
      existingClient.abortOAuth();
    }
    return { success: true, data: undefined };
  });

  // Start OAuth flow
  ipcMain.handle("gmail:start-oauth", async (): Promise<IpcResponse<void>> => {
    if (useFakeData) {
      return { success: true, data: undefined };
    }

    try {
      // Abort any in-progress OAuth flow before starting a new one
      if (pendingOAuthClient) {
        pendingOAuthClient.abortOAuth();
        pendingOAuthClient = null;
      }
      const existingClient = gmailClients.get("default");
      if (existingClient) {
        existingClient.abortOAuth();
      }

      // Reset clients and start fresh OAuth — store in pendingOAuthClient
      // so abort-oauth can cancel the flow before connect() resolves
      gmailClients.clear();
      const client = new GmailClient("default");
      pendingOAuthClient = client;
      try {
        await client.connect();
      } finally {
        pendingOAuthClient = null;
      }
      gmailClients.set("default", client);

      // Get the user's profile to save the account
      const profile = await client.getProfile();
      const accountId = client.getAccountId();

      // Save the account to the database if not already saved
      const existingAccounts = getAccounts();
      const alreadyExists = existingAccounts.some(
        (a) => a.id === accountId || a.email === profile.emailAddress,
      );

      if (!alreadyExists) {
        const displayName = await client.fetchDisplayName();
        const isPrimary = existingAccounts.length === 0;
        saveAccount(accountId, profile.emailAddress, displayName ?? undefined, isPrimary);
        log.info(`[OAuth] Saved new account: ${profile.emailAddress} (${accountId})`);
      }

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Fetch emails (all inbox or demo data)
  ipcMain.handle(
    "gmail:fetch-unread",
    async (
      _,
      { maxResults, accountId }: { maxResults?: number; accountId?: string },
    ): Promise<IpcResponse<DashboardEmail[]>> => {
      // In demo/test mode, return fake emails merged with DB state (drafts, analysis)
      if (useFakeData) {
        const currentInbox = getInboxEmails(accountId || "default");
        const dbMap = new Map(currentInbox.map((e) => [e.id, e]));
        const fakeEmails: DashboardEmail[] = DEMO_INBOX_EMAILS.slice(0, maxResults || 100)
          .filter((email) => dbMap.has(email.id))
          .map((email) => {
            const dbEmail = dbMap.get(email.id)!;
            const expectedAnalysis = DEMO_EXPECTED_ANALYSIS[email.id];
            return {
              ...email,
              accountId: accountId || "default",
              analysis:
                dbEmail.analysis ??
                (expectedAnalysis
                  ? {
                      needsReply: expectedAnalysis.needsReply,
                      reason: expectedAnalysis.reason,
                      priority: expectedAnalysis.priority,
                      analyzedAt: Date.now(),
                    }
                  : undefined),
              draft: dbEmail.draft,
            };
          });
        return { success: true, data: fakeEmails };
      }

      try {
        const resolvedAccountId = resolveTargetAccountId(accountId);
        const client = await getClient(resolvedAccountId);

        // Search for all emails in inbox (most recent first)
        const { results: searchResults } = await client.searchEmails("in:inbox", maxResults || 100);

        // Get existing email IDs from DB (fast - just IDs, not full emails)
        const existingIds = getEmailIds(resolvedAccountId);

        // Fetch full email content for new emails only
        let newEmailCount = 0;
        for (const result of searchResults) {
          if (!existingIds.has(result.id)) {
            const email = await client.readEmail(result.id);
            if (email) {
              saveEmail(email, resolvedAccountId);
              newEmailCount++;
            }
          }
        }

        if (newEmailCount > 0) {
          log.info(`[Gmail] Fetched ${newEmailCount} new emails`);
        }

        // Get ALL inbox emails from DB (not just the ones from this API call)
        // Return ALL inbox emails from DB (not just the ones from this API call)
        // Analysis is handled by the prefetch service via processAllPending()
        return { success: true, data: getInboxEmails(resolvedAccountId) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get single email
  ipcMain.handle(
    "gmail:get-email",
    async (_, { emailId }: { emailId: string }): Promise<IpcResponse<DashboardEmail>> => {
      // In demo mode, find from fake emails
      if (useFakeData) {
        const email = DEMO_INBOX_EMAILS.find((e) => e.id === emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }
        const expectedAnalysis = DEMO_EXPECTED_ANALYSIS[email.id];
        return {
          success: true,
          data: {
            ...email,
            analysis: expectedAnalysis
              ? {
                  needsReply: expectedAnalysis.needsReply,
                  reason: expectedAnalysis.reason,
                  priority: expectedAnalysis.priority,
                  analyzedAt: Date.now(),
                }
              : undefined,
          },
        };
      }

      try {
        const email = getEmail(emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }
        return { success: true, data: email };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Create draft in Gmail
  ipcMain.handle(
    "gmail:create-draft",
    async (
      _,
      {
        emailId,
        body,
        cc,
        bcc,
        accountId,
      }: { emailId: string; body: string; cc?: string[]; bcc?: string[]; accountId?: string },
    ): Promise<IpcResponse<{ draftId: string }>> => {
      // In demo mode, simulate draft creation
      if (useFakeData) {
        log.info(`[DEMO] Creating draft for email ${emailId}`);
        log.info(`[DEMO] Draft body: ${body.substring(0, 100)}...`);
        if (cc?.length) {
          log.info(`[DEMO] CC: ${cc.join(", ")}`);
        }
        if (bcc?.length) {
          log.info(`[DEMO] BCC: ${bcc.join(", ")}`);
        }
        return { success: true, data: { draftId: `demo-draft-${Date.now()}` } };
      }

      try {
        const resolvedAccountId = resolveTargetAccountId(accountId);
        const client = await getClient(resolvedAccountId);
        const email = getEmail(emailId);

        if (!email) {
          return { success: false, error: "Email not found" };
        }

        const fromMatch = email.from.match(/<([^>]+)>/);
        const replyTo = fromMatch ? fromMatch[1] : email.from;

        // Format subject
        const subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;

        const result = await client.createDraft({
          to: replyTo,
          subject,
          body,
          threadId: email.threadId,
          cc,
          bcc,
        });

        // Update draft in database
        const { updateDraftStatus } = await import("../db");
        updateDraftStatus(emailId, "created", result.id);

        return { success: true, data: { draftId: result.id } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
