import { ipcMain, BrowserWindow } from "electron";
import { GmailClient, isAuthError } from "../services/gmail-client";
import { emailSyncService, type SyncStatus, type AccountInfo } from "../services/email-sync";
import { prefetchService } from "../services/prefetch-service";
import { getExtensionHost } from "../extensions";
import { networkMonitor } from "../services/network-monitor";
import { outboxService } from "../services/outbox-service";
import { pendingActionsQueue } from "../services/pending-actions";
import { isNetworkError } from "../services/network-errors";
import {
  getAccounts,
  saveAccount,
  removeAccount,
  setPrimaryAccount,
  getInboxEmails,
  getSentEmails,
  saveEmail,
  searchEmails,
  getEmail,
  getEmailsByThread,
  getEmailsByIds,
  getEmailIds,
  getEmailBodies,
  updateEmailLabelIds,
  deleteEmail,
  saveArchiveReady,
  saveAnalysis,
  snoozeEmail,
  clearSnoozedEmails,
  saveCorrespondentProfile,
  updateAccountDisplayName,
  deleteAgentTrace,
  saveDraft,
  type AccountRecord,
} from "../db";
import { getOnboardingClient, clearOnboardingClient } from "./onboarding.ipc";
import { calendarSyncService } from "../services/calendar-sync";
import type { IpcResponse, DashboardEmail } from "../../shared/types";
import { createLogger } from "../services/logger";

const log = createLogger("sync-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

// Store active clients for each account
const activeClients: Map<string, GmailClient> = new Map();
// Track in-progress OAuth flow so it can be cancelled
let pendingAddClient: GmailClient | null = null;
let retryingConnections = false;

// Email data saved before optimistic trash deletion, keyed by emailId.
// Used to restore the email to DB if a queued trash action fails permanently.
const trashedEmailData: Map<string, DashboardEmail> = new Map();

// Service wrapper for accessing sync functionality from other IPC handlers
export const getEmailSyncService = () => ({
  getClientForAccount(accountId: string): GmailClient | null {
    return activeClients.get(accountId) || null;
  },
  syncService: emailSyncService,
});

/**
 * Retry connecting accounts that failed during init (e.g. app started offline).
 * Checks DB accounts against activeClients to find disconnected ones.
 */
async function retryFailedConnections(): Promise<void> {
  if (retryingConnections || useFakeData) return;
  retryingConnections = true;

  try {
    const dbAccounts = getAccounts();
    const disconnected = dbAccounts.filter((a) => !activeClients.has(a.id));

    if (disconnected.length === 0) return;

    log.info(`[Sync] Retrying ${disconnected.length} failed account connection(s)`);

    for (const account of disconnected) {
      try {
        const client = new GmailClient(account.id);
        await client.connect();

        const accountInfo = await emailSyncService.registerAccount(client);
        activeClients.set(account.id, client);
        emailSyncService.startSync(account.id);

        log.info(`[Sync] Reconnected account: ${accountInfo.email}`);

        // Notify renderer of the reconnection
        const window = getMainWindow();
        if (window) {
          window.webContents.send("sync:status-change", {
            accountId: account.id,
            status: "idle",
          });
        }
      } catch (err) {
        log.error({ err: err }, `[Sync] Retry failed for account ${account.id}`);
      }
    }
  } finally {
    retryingConnections = false;
  }
}

// Get the main window for sending IPC events
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

export function registerSyncIpc(): void {
  // When going online, reconnect failed accounts THEN process queues
  networkMonitor.on("online", async () => {
    await retryFailedConnections();
    outboxService.processQueue().catch((err) => log.error({ err }, "Unhandled error"));
    pendingActionsQueue.processQueue().catch((err) => log.error({ err }, "Unhandled error"));
  });

  // Give the pending actions queue access to Gmail clients
  pendingActionsQueue.setClientResolver((accountId) => activeClients.get(accountId) || null);

  // Forward permanent action failures to the renderer so it can restore emails,
  // and roll back the optimistic DB update
  pendingActionsQueue.on("action-failed", (...args: unknown[]) => {
    const data = args[0] as { emailId: string; accountId: string; action: string; error: string };
    log.error(
      `[Sync] Pending action permanently failed: ${data.action} ${data.emailId} - ${data.error}`,
    );

    // Roll back the optimistic DB change so the email isn't lost locally
    if (data.action === "archive") {
      const email = getEmail(data.emailId);
      if (email) {
        const labels = email.labelIds || [];
        if (!labels.includes("INBOX")) {
          updateEmailLabelIds(data.emailId, [...labels, "INBOX"]);
        }
      }
    } else if (data.action === "trash") {
      const saved = trashedEmailData.get(data.emailId);
      if (saved) {
        saveEmail(
          {
            id: saved.id,
            threadId: saved.threadId,
            subject: saved.subject,
            from: saved.from,
            to: saved.to,
            date: saved.date,
            body: saved.body || "",
            snippet: saved.snippet,
            labelIds: saved.labelIds,
          },
          data.accountId,
        );
        trashedEmailData.delete(data.emailId);
      }
    }

    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:action-failed", data);
    }
  });

  // When a queued action succeeds, clean up saved data and notify the renderer
  pendingActionsQueue.on("action-succeeded", (...args: unknown[]) => {
    const data = args[0] as { emailId: string; accountId: string; action: string };
    trashedEmailData.delete(data.emailId);
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:emails-removed", {
        accountId: data.accountId,
        emailIds: [data.emailId],
      });
      window.webContents.send("sync:action-succeeded", {
        emailId: data.emailId,
        accountId: data.accountId,
        action: data.action,
      });
    }
  });

  // Set up sync service callbacks
  emailSyncService.onNewEmailsReceived((accountId, emails) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:new-emails", { accountId, emails });
    }
  });

  emailSyncService.onNewSentEmailsReceived((accountId, emails) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:new-sent-emails", { accountId, emails });
    }
  });

  emailSyncService.onStatusChange((accountId, status) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:status-change", { accountId, status });
    }
  });

  emailSyncService.onEmailsRemovedCallback((accountId, emailIds) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:emails-removed", { accountId, emailIds });
    }
  });

  emailSyncService.onEmailsUpdatedCallback((accountId, updates) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:emails-updated", { accountId, updates });
    }
  });

  emailSyncService.onDraftsRemovedCallback((accountId, emailIds) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:drafts-removed", { accountId, emailIds });
    }
  });

  // Sync progress callback — fires when fetch progress changes during sync
  emailSyncService.onProgressChange((accountId, progress) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("sync:progress", { accountId, ...progress });
    }
  });

  // Auth error callback — fires when sync detects an expired/revoked token
  emailSyncService.onAuthError((accountId, email) => {
    const window = getMainWindow();
    if (window) {
      log.info(`[Auth] Sending token-expired event for ${email}`);
      window.webContents.send("auth:token-expired", { accountId, email, source: "gmail" });
    }
  });

  // Extension auth required callback
  const extensionHost = getExtensionHost();
  extensionHost.onAuthRequired((extensionId, displayName, message) => {
    const window = getMainWindow();
    if (window) {
      log.info(`[Auth] Sending extension-auth-required for ${displayName}`);
      window.webContents.send("auth:extension-auth-required", {
        extensionId,
        displayName,
        message,
      });
    }
  });

  // Re-authenticate a Gmail account (triggered by user clicking "Re-authenticate" in banner)
  ipcMain.handle(
    "auth:reauth",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<void>> => {
      try {
        const client = activeClients.get(accountId);
        if (!client) {
          return { success: false, error: "Account not connected" };
        }

        await client.reauth();

        // Re-register with sync service and restart sync
        await emailSyncService.registerAccount(client);
        emailSyncService.startSync(accountId);

        log.info(`[Auth] Re-authenticated account ${accountId}, sync restarted`);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get all accounts
  ipcMain.handle("accounts:list", async (): Promise<IpcResponse<AccountRecord[]>> => {
    if (useFakeData) {
      return {
        success: true,
        data: [{ id: "default", email: "me@example.com", isPrimary: true, addedAt: Date.now() }],
      };
    }

    try {
      const accounts = getAccounts();
      return { success: true, data: accounts };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Add a new account
  ipcMain.handle(
    "accounts:add",
    async (_, { accountId }: { accountId?: string }): Promise<IpcResponse<AccountInfo>> => {
      if (useFakeData) {
        return {
          success: true,
          data: { accountId: "demo", email: "me@example.com", isConnected: true },
        };
      }

      // Generate account ID before try block so it's accessible in catch for cleanup
      const id = accountId || `account-${Date.now()}`;

      try {
        const sendProgress = (phase: string) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send("accounts:add-progress", { phase });
          }
        };

        // Create client and connect
        sendProgress("Authorizing...");
        const client = new GmailClient(id);
        pendingAddClient = client;
        await client.connect();
        pendingAddClient = null;

        // Register with sync service (also gets email address)
        sendProgress("Connecting account...");
        const accountInfo = await emailSyncService.registerAccount(client);

        // Save to database
        const accounts = getAccounts();
        const isPrimary = accounts.length === 0;
        saveAccount(id, accountInfo.email, accountInfo.displayName, isPrimary);

        // Store client reference
        activeClients.set(id, client);

        // Start sync loop — fullSync will detect first-time sync (no history ID,
        // no stored emails) and run triage + progressive loading automatically.
        emailSyncService.startSync(id);

        // New account may have calendar scope — trigger sync
        calendarSyncService.syncNow();

        return { success: true, data: accountInfo };
      } catch (error) {
        // Clean up partial registration so retry doesn't leave orphaned state
        pendingAddClient = null;
        activeClients.delete(id);
        emailSyncService.unregisterAccount(id);
        try {
          removeAccount(id);
        } catch {
          /* may not have been saved yet */
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          success: false,
          error: message,
          cancelled: message === "Authorization cancelled",
        };
      }
    },
  );

  // Cancel an in-progress account add (e.g. user closed browser during OAuth)
  ipcMain.handle("accounts:cancel-add", async (): Promise<void> => {
    if (pendingAddClient) {
      pendingAddClient.abortOAuth();
    }
  });

  // Remove an account
  ipcMain.handle(
    "accounts:remove",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        // Stop syncing and unregister
        emailSyncService.unregisterAccount(accountId);

        // Remove from active clients and delete token file
        const client = activeClients.get(accountId);
        if (client) {
          await client.removeTokens();
          await client.disconnect();
          activeClients.delete(accountId);
        } else {
          // No active client, but still try to clean up tokens
          const orphanClient = new GmailClient(accountId);
          await orphanClient.removeTokens();
        }

        // Remove from database
        removeAccount(accountId);

        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Set primary account
  ipcMain.handle(
    "accounts:set-primary",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        setPrimaryAccount(accountId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Start sync for an account
  ipcMain.handle(
    "sync:start",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        emailSyncService.startSync(accountId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Stop sync for an account
  ipcMain.handle(
    "sync:stop",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        emailSyncService.stopSync(accountId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Trigger immediate sync
  ipcMain.handle(
    "sync:now",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        await emailSyncService.syncNow(accountId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get sync status
  ipcMain.handle(
    "sync:status",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<SyncStatus>> => {
      if (useFakeData) {
        return { success: true, data: "idle" };
      }

      try {
        const status = emailSyncService.getSyncStatus(accountId);
        return { success: true, data: status };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Set sync interval
  ipcMain.handle(
    "sync:set-interval",
    async (_, { intervalMs }: { intervalMs: number }): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        emailSyncService.setSyncInterval(intervalMs);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get emails for a specific account from the database
  ipcMain.handle(
    "sync:get-emails",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<DashboardEmail[]>> => {
      const t0 = performance.now();
      log.info(`[PERF] sync:get-emails START for ${accountId}`);

      if (useFakeData) {
        const { DEMO_INBOX_EMAILS, DEMO_EXPECTED_ANALYSIS } = await import("../demo/fake-inbox");
        // Use DB query (includes draft/analysis from DB joins), then overlay
        // fake email body/html content (not stored in demo DB) and expected analysis
        const currentInbox = getInboxEmails("default");
        const dbMap = new Map(currentInbox.map((e) => [e.id, e]));
        const fakeEmails: DashboardEmail[] = DEMO_INBOX_EMAILS.filter((email) =>
          dbMap.has(email.id),
        ).map((email) => {
          const dbEmail = dbMap.get(email.id)!;
          const expectedAnalysis = DEMO_EXPECTED_ANALYSIS[email.id];
          return {
            ...email,
            accountId: "default",
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
            // Preserve draft data from DB (includes agentTaskId)
            draft: dbEmail.draft,
          };
        });
        log.info(`[PERF] sync:get-emails END (demo) ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, data: fakeEmails };
      }

      try {
        // Only return inbox emails to keep memory usage low
        // Background-synced emails are in DB for search but not loaded into renderer
        const t1 = performance.now();
        const emails = getInboxEmails(accountId);
        log.info(
          `[PERF] sync:get-emails DB query took ${(performance.now() - t1).toFixed(1)}ms, returned ${emails.length} emails`,
        );
        log.info(`[PERF] sync:get-emails END total ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, data: emails };
      } catch (error) {
        log.info(`[PERF] sync:get-emails ERROR ${(performance.now() - t0).toFixed(1)}ms`);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get sent emails for a specific account from the database
  ipcMain.handle(
    "sync:get-sent-emails",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<DashboardEmail[]>> => {
      if (useFakeData) {
        const { DEMO_INBOX_EMAILS } = await import("../demo/fake-inbox");
        // In demo mode, return emails that have the SENT label
        const sentEmails: DashboardEmail[] = DEMO_INBOX_EMAILS.filter((email) =>
          email.labelIds?.includes("SENT"),
        ).map((email) => ({
          ...email,
          accountId: "default",
        }));
        return { success: true, data: sentEmails };
      }

      try {
        const emails = getSentEmails(accountId);
        return { success: true, data: emails };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Fetch email bodies for a batch of IDs (used by renderer to backfill
  // bodies after the initial body-less inbox load)
  ipcMain.handle(
    "sync:prefetch-bodies",
    async (
      _,
      { ids }: { ids: string[] },
    ): Promise<IpcResponse<Array<{ id: string; body: string }>>> => {
      try {
        const bodies = getEmailBodies(ids);
        return { success: true, data: bodies };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Initialize accounts on startup
  ipcMain.handle("sync:init", async (): Promise<IpcResponse<AccountInfo[]>> => {
    const t0 = performance.now();
    log.info(`[PERF] sync:init START`);

    if (useFakeData) {
      // In demo mode, ensure the demo account exists and populate with fake emails
      saveAccount("default", "me@example.com", undefined, true);
      const { DEMO_INBOX_EMAILS, DEMO_STYLE_SEED_EMAILS } = await import("../demo/fake-inbox");
      for (const email of DEMO_INBOX_EMAILS) {
        saveEmail(email, "default");
      }
      // Style seed emails are only in the DB (for style profiling), not shown in inbox
      for (const email of DEMO_STYLE_SEED_EMAILS) {
        saveEmail(email, "default");
      }
      log.info(
        `[Demo] Saved ${DEMO_INBOX_EMAILS.length + DEMO_STYLE_SEED_EMAILS.length} demo emails to database`,
      );

      // Save demo analysis data for each email so archive-ready checks pass
      const { DEMO_EXPECTED_ANALYSIS } = await import("../demo/fake-inbox");
      for (const [emailId, analysis] of Object.entries(DEMO_EXPECTED_ANALYSIS)) {
        saveAnalysis(emailId, analysis.needsReply, analysis.reason, analysis.priority ?? "low");
      }

      // Seed demo AI drafts so draft-edit learning can be tested
      const { DEMO_DRAFT_RESPONSES } = await import("../demo/fake-inbox");
      for (const [emailId, draftBody] of Object.entries(DEMO_DRAFT_RESPONSES)) {
        saveDraft(emailId, draftBody, "pending");
      }
      log.info(`[Demo] Saved ${Object.keys(DEMO_DRAFT_RESPONSES).length} demo drafts to database`);

      // Save demo archive-ready data so the Archive Ready view has content
      const demoArchiveReady = [
        {
          threadId: "thread-project-alpha",
          reason:
            "User confirmed availability and agreed on 7-week timeline - conversation is complete",
        },
        { threadId: "thread-github-ci", reason: "Automated CI notification - no response needed" },
        { threadId: "thread-newsletter", reason: "Newsletter subscription - informational only" },
        { threadId: "thread-amazon-ship", reason: "Shipping confirmation - no response needed" },
        { threadId: "thread-calendar", reason: "Calendar notification - no response needed" },
        { threadId: "thread-html-test", reason: "Product update newsletter - informational only" },
      ];
      for (const { threadId, reason } of demoArchiveReady) {
        saveArchiveReady(threadId, "default", true, reason);
      }
      log.info(`[Demo] Saved ${demoArchiveReady.length} demo archive-ready records`);

      // Clear stale snooze data (e.g. from previous e2e test runs sharing this DB)
      clearSnoozedEmails("default");

      // Seed demo snoozed emails so the Snoozed tab has content
      const demoSnoozed = [
        {
          id: "snooze-demo-1",
          emailId: "demo-010",
          threadId: "thread-lunch",
          snoozeUntil: Date.now() + 4 * 60 * 60 * 1000,
        },
        {
          id: "snooze-demo-2",
          emailId: "demo-meeting",
          threadId: "thread-meeting-request",
          snoozeUntil: Date.now() + 24 * 60 * 60 * 1000,
        },
      ];
      for (const s of demoSnoozed) {
        snoozeEmail(s.id, s.emailId, s.threadId, "default", s.snoozeUntil);
      }
      log.info(`[Demo] Saved ${demoSnoozed.length} demo snoozed records`);

      // Seed correspondent profiles for style testing contacts
      saveCorrespondentProfile({
        email: "dalton.caldwell@gmail.com",
        accountId: "default",
        displayName: "Dalton Caldwell",
        emailCount: 10,
        avgWordCount: 7,
        dominantGreeting: "hey",
        dominantSignoff: "none",
        formalityScore: 0.12,
        lastComputedAt: Date.now(),
      });
      saveCorrespondentProfile({
        email: "g.ralston@whitfield-partners.com",
        accountId: "default",
        displayName: "Dr. Geoff Ralston",
        emailCount: 10,
        avgWordCount: 120,
        dominantGreeting: "dear",
        dominantSignoff: "regards",
        formalityScore: 0.88,
        lastComputedAt: Date.now(),
      });
      log.info("[Demo] Saved 2 demo correspondent profiles for style testing");

      log.info(`[PERF] sync:init END (demo) ${(performance.now() - t0).toFixed(1)}ms`);
      return {
        success: true,
        data: [{ accountId: "default", email: "me@example.com", isConnected: true }],
      };
    }

    try {
      const t1 = performance.now();
      let accounts = getAccounts();
      log.info(`[PERF] sync:init getAccounts took ${(performance.now() - t1).toFixed(1)}ms`);
      const connectedAccounts: AccountInfo[] = [];

      // If no accounts in database, try to connect with default account
      // This handles the case where user completed OAuth before account saving was implemented
      if (accounts.length === 0) {
        try {
          const client = new GmailClient("default");
          await client.connect();

          // Get profile and save account
          const profile = await client.getProfile();
          const displayName = await client.fetchDisplayName();
          saveAccount("default", profile.emailAddress, displayName ?? undefined, true);
          log.info(`[Sync] Migrated existing OAuth to account: ${profile.emailAddress}`);

          // Refresh accounts list
          accounts = getAccounts();
        } catch (_err) {
          // No valid tokens - user needs to complete setup
          log.info("[Sync] No existing OAuth tokens found");
        }
      }

      log.info(`[Sync] Found ${accounts.length} accounts in database`);
      for (const account of accounts) {
        const tAccount = performance.now();
        log.info(`[PERF] sync:init connecting account ${account.id} START`);

        // Skip accounts already set up by the onboarding flow — they're
        // registered, synced, and have their sync loop running.
        if (emailSyncService.isAccountRegistered(account.id)) {
          const onboardingClient = getOnboardingClient(account.id);
          if (onboardingClient) {
            activeClients.set(account.id, onboardingClient);
            clearOnboardingClient(account.id);
            connectedAccounts.push({
              accountId: account.id,
              email: account.email,
              isConnected: true,
            });
            log.info(
              `[Sync] Account ${account.id} already registered (onboarding), reusing client`,
            );
            continue;
          }
          // Onboarding client not found — fall through to create a new client
          log.info(
            `[Sync] Account ${account.id} registered but onboarding client missing, creating new client`,
          );
        }

        try {
          // Create client for existing account
          const client = new GmailClient(account.id);
          const tConnect = performance.now();
          await client.connect();
          log.info(
            `[PERF] sync:init client.connect took ${(performance.now() - tConnect).toFixed(1)}ms`,
          );

          // Register and start syncing
          const tRegister = performance.now();
          const accountInfo = await emailSyncService.registerAccount(client);
          log.info(
            `[PERF] sync:init registerAccount took ${(performance.now() - tRegister).toFixed(1)}ms`,
          );
          activeClients.set(account.id, client);

          // Backfill display name for existing accounts that don't have one
          if (!account.displayName && accountInfo.displayName) {
            updateAccountDisplayName(account.id, accountInfo.displayName);
            client.clearAccountInfoCache();
            log.info(
              `[Sync] Backfilled display name for ${account.email}: ${accountInfo.displayName}`,
            );
          }

          const tStartSync = performance.now();
          emailSyncService.startSync(account.id);
          log.info(
            `[PERF] sync:init startSync took ${(performance.now() - tStartSync).toFixed(1)}ms`,
          );

          connectedAccounts.push(accountInfo);
          log.info(
            `[PERF] sync:init account ${account.id} total ${(performance.now() - tAccount).toFixed(1)}ms`,
          );
        } catch (err) {
          log.error({ err: err }, `[Sync] Failed to connect account ${account.id}`);

          // Still store the client reference so reauth can use it
          const client = new GmailClient(account.id);
          activeClients.set(account.id, client);

          connectedAccounts.push({
            accountId: account.id,
            email: account.email,
            isConnected: false,
          });

          // If this is an auth error, notify the renderer after init completes
          if (isAuthError(err)) {
            // Defer to after the response is sent so the renderer has set up listeners
            setTimeout(() => {
              const win = getMainWindow();
              if (win) {
                log.info(`[Auth] Sending startup token-expired for ${account.email}`);
                win.webContents.send("auth:token-expired", {
                  accountId: account.id,
                  email: account.email,
                  source: "gmail",
                });
              }
            }, 1000);
          }
        }
      }

      // After all accounts are connected, start background processing
      if (connectedAccounts.some((a) => a.isConnected)) {
        // Delay 3 seconds to let the UI fully load first
        // Skip if any account is doing a first-time sync — fullSync with
        // runTriage will handle queueing only the recent emails after triage.
        setTimeout(() => {
          if (emailSyncService.hasFirstSyncPending()) {
            log.info("[Prefetch] Skipping processAllPending — first-time sync in progress");
          } else {
            log.info("[PERF] prefetch starting (3s after sync:init)");
            prefetchService.processAllPending().catch((error) => {
              log.error({ err: error }, "[Sync] Error starting prefetch");
            });
          }
        }, 3000);

        // Process any queued outbox messages from previous session
        outboxService.processQueue().catch((err) => log.error({ err }, "Unhandled error"));

        // Trigger calendar sync now that accounts are connected
        // (the initial sync at startup may have found 0 accounts)
        calendarSyncService.syncNow();
      }

      log.info(`[PERF] sync:init END total ${(performance.now() - t0).toFixed(1)}ms`);
      return { success: true, data: connectedAccounts };
    } catch (error) {
      log.info(`[PERF] sync:init ERROR ${(performance.now() - t0).toFixed(1)}ms`);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Archive an email (offline-aware: queues when offline or on network error)
  ipcMain.handle(
    "emails:archive",
    async (_, { accountId, emailId }: { accountId: string; emailId: string }) => {
      // Optimistically update DB so the next sync doesn't re-add the email
      const email = getEmail(emailId);
      const previousLabels = email?.labelIds || [];
      if (email) {
        updateEmailLabelIds(
          emailId,
          previousLabels.filter((l: string) => l !== "INBOX"),
        );
      }

      if (useFakeData) {
        return { success: true, data: undefined };
      }

      // If offline, queue for later — DB already updated
      if (!networkMonitor.isOnline) {
        pendingActionsQueue.enqueue("archive", emailId, accountId);
        return { success: true, data: undefined, queued: true };
      }

      const client = activeClients.get(accountId);
      if (!client) {
        pendingActionsQueue.enqueue("archive", emailId, accountId);
        return { success: true, data: undefined, queued: true };
      }

      // Retry with exponential backoff for rate limit errors
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await client.archiveMessage(emailId);

          // Clean up agent trace data for this email's draft (if any)
          if (email?.draft?.agentTaskId) {
            try {
              deleteAgentTrace(email.draft.agentTaskId);
            } catch {
              /* non-critical */
            }
          }

          // Notify renderer of email removal
          const window = getMainWindow();
          if (window) {
            window.webContents.send("sync:emails-removed", { accountId, emailIds: [emailId] });
          }

          return { success: true, data: undefined };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const isRateLimit =
            msg.includes("Too many concurrent requests") ||
            msg.includes("Rate Limit") ||
            (error as { code?: number })?.code === 429;

          if (isNetworkError(error)) {
            pendingActionsQueue.enqueue("archive", emailId, accountId);
            networkMonitor.setOffline();
            return { success: true, data: undefined, queued: true };
          }

          if (isRateLimit && attempt < MAX_RETRIES) {
            // Exponential backoff: 1s, 2s, 4s
            const delay = 1000 * Math.pow(2, attempt);
            log.warn(
              `[Archive] Rate-limited for ${emailId}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          // Permanent failure — restore the INBOX label in DB
          log.error(`[Archive] Permanent failure for ${emailId}: ${msg}`);
          updateEmailLabelIds(emailId, previousLabels);
          return {
            success: false,
            error: msg,
          };
        }
      }

      // Should not reach here, but satisfy TypeScript
      return { success: false, error: "Max retries exceeded" };
    },
  );

  // Batch archive multiple emails in a single Gmail API call
  ipcMain.handle(
    "emails:batch-archive",
    async (_, { accountId, emailIds }: { accountId: string; emailIds: string[] }) => {
      log.info(`[Archive] Batch archive: ${emailIds.length} emails`);

      // Optimistically update DB for all emails
      const previousLabelsMap = new Map<string, string[]>();
      for (const emailId of emailIds) {
        const email = getEmail(emailId);
        if (email) {
          previousLabelsMap.set(emailId, email.labelIds || []);
          updateEmailLabelIds(
            emailId,
            (email.labelIds || []).filter((l: string) => l !== "INBOX"),
          );
        }
      }

      if (useFakeData) {
        return { success: true, data: undefined };
      }

      if (!networkMonitor.isOnline) {
        for (const emailId of emailIds) {
          pendingActionsQueue.enqueue("archive", emailId, accountId);
        }
        return { success: true, data: undefined, queued: true };
      }

      const client = activeClients.get(accountId);
      if (!client) {
        for (const emailId of emailIds) {
          pendingActionsQueue.enqueue("archive", emailId, accountId);
        }
        return { success: true, data: undefined, queued: true };
      }

      // Retry with exponential backoff for rate limit errors
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await client.batchArchive(emailIds);

          // Clean up agent trace data for archived emails
          for (const emailId of emailIds) {
            const email = getEmail(emailId);
            if (email?.draft?.agentTaskId) {
              try {
                deleteAgentTrace(email.draft.agentTaskId);
              } catch {
                /* non-critical */
              }
            }
          }

          // Notify renderer of email removal
          const window = getMainWindow();
          if (window) {
            window.webContents.send("sync:emails-removed", { accountId, emailIds });
          }

          return { success: true, data: undefined };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const isRateLimit =
            msg.includes("Too many concurrent requests") ||
            msg.includes("Rate Limit") ||
            (error as { code?: number })?.code === 429;

          if (isNetworkError(error)) {
            for (const emailId of emailIds) {
              pendingActionsQueue.enqueue("archive", emailId, accountId);
            }
            networkMonitor.setOffline();
            return { success: true, data: undefined, queued: true };
          }

          if (isRateLimit && attempt < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, attempt);
            log.warn(
              `[Archive] Batch archive rate-limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          // Permanent failure — restore INBOX labels
          log.error(`[Archive] Batch archive permanent failure: ${msg}`);
          for (const [emailId, labels] of previousLabelsMap) {
            updateEmailLabelIds(emailId, labels);
          }
          return { success: false, error: msg };
        }
      }

      return { success: false, error: "Max retries exceeded" };
    },
  );

  // Batch trash multiple emails in a single Gmail API call
  ipcMain.handle(
    "emails:batch-trash",
    async (_, { accountId, emailIds }: { accountId: string; emailIds: string[] }) => {
      log.info(`[Trash] Batch trash: ${emailIds.length} emails`);

      // Save email data before deleting so we can restore on permanent failure
      const emailDataMap = new Map<string, ReturnType<typeof getEmail>>();
      for (const emailId of emailIds) {
        const emailData = getEmail(emailId);
        if (emailData) emailDataMap.set(emailId, emailData);
        deleteEmail(emailId, accountId);
      }

      if (useFakeData) {
        return { success: true, data: undefined };
      }

      if (!networkMonitor.isOnline) {
        for (const emailId of emailIds) {
          if (emailDataMap.has(emailId)) trashedEmailData.set(emailId, emailDataMap.get(emailId)!);
          pendingActionsQueue.enqueue("trash", emailId, accountId);
        }
        return { success: true, data: undefined, queued: true };
      }

      const client = activeClients.get(accountId);
      if (!client) {
        for (const emailId of emailIds) {
          if (emailDataMap.has(emailId)) trashedEmailData.set(emailId, emailDataMap.get(emailId)!);
          pendingActionsQueue.enqueue("trash", emailId, accountId);
        }
        return { success: true, data: undefined, queued: true };
      }

      // batchTrash uses Promise.allSettled internally and returns partial failures
      const { failedIds } = await client.batchTrash(emailIds);

      // Notify renderer about successfully trashed emails
      const succeededIds = emailIds.filter((id) => !failedIds.includes(id));
      if (succeededIds.length > 0) {
        const window = getMainWindow();
        if (window) {
          window.webContents.send("sync:emails-removed", { accountId, emailIds: succeededIds });
        }
      }

      // Restore only the failed emails to DB
      if (failedIds.length > 0) {
        log.error(`[Trash] Batch trash: ${failedIds.length}/${emailIds.length} failed`);
        for (const emailId of failedIds) {
          const emailData = emailDataMap.get(emailId);
          if (emailData) {
            saveEmail(
              {
                id: emailData.id,
                threadId: emailData.threadId,
                subject: emailData.subject,
                from: emailData.from,
                to: emailData.to,
                date: emailData.date,
                body: emailData.body || "",
                snippet: emailData.snippet,
                labelIds: emailData.labelIds,
              },
              accountId,
            );
          }
        }
        return { success: false, error: `${failedIds.length} emails failed to trash`, failedIds };
      }

      return { success: true, data: undefined };
    },
  );

  // Archive all emails in a thread (offline-aware: queues when offline or on network error)
  ipcMain.handle(
    "emails:archive-thread",
    async (_, { accountId, threadId }: { accountId: string; threadId: string }) => {
      const threadEmails = getEmailsByThread(threadId, accountId);
      // Treat emails with no labelIds (NULL in DB) as inbox emails,
      // matching the getInboxEmails query: WHERE label_ids IS NULL OR label_ids LIKE '%"INBOX"%'
      const inboxEmails = threadEmails.filter((e) => !e.labelIds || e.labelIds.includes("INBOX"));

      // Optimistically update DB for all inbox emails
      const previousLabelsMap = new Map<string, string[]>();
      for (const email of inboxEmails) {
        previousLabelsMap.set(email.id, email.labelIds || []);
        updateEmailLabelIds(
          email.id,
          (email.labelIds || []).filter((l: string) => l !== "INBOX"),
        );
      }

      if (useFakeData) {
        return { success: true, data: undefined };
      }

      // If offline, queue each email for later — DB already updated
      if (!networkMonitor.isOnline) {
        for (const email of inboxEmails) {
          pendingActionsQueue.enqueue("archive", email.id, accountId);
        }
        return { success: true, data: undefined, queued: true };
      }

      try {
        const client = activeClients.get(accountId);
        if (!client) {
          for (const email of inboxEmails) {
            pendingActionsQueue.enqueue("archive", email.id, accountId);
          }
          return { success: true, data: undefined, queued: true };
        }

        const archivedIds: string[] = [];
        const failedIds: string[] = [];
        let anyQueued = false;
        for (let i = 0; i < inboxEmails.length; i++) {
          const email = inboxEmails[i];
          try {
            await client.archiveMessage(email.id);
            archivedIds.push(email.id);
          } catch (err) {
            if (isNetworkError(err)) {
              // Queue this and all remaining emails, then mark offline
              for (let j = i; j < inboxEmails.length; j++) {
                pendingActionsQueue.enqueue("archive", inboxEmails[j].id, accountId);
              }
              anyQueued = true;
              networkMonitor.setOffline();
              break;
            } else {
              // Permanent failure for this email — restore its INBOX label
              const prev = previousLabelsMap.get(email.id) || [];
              updateEmailLabelIds(email.id, prev);
              failedIds.push(email.id);
            }
          }
        }

        // Clean up agent traces for archived thread emails
        for (const email of threadEmails) {
          if (email.draft?.agentTaskId) {
            try {
              deleteAgentTrace(email.draft.agentTaskId);
            } catch {
              /* non-critical */
            }
          }
        }

        // Notify renderer: remove entire thread (including SENT) so no ghost threads remain
        if (archivedIds.length > 0) {
          const allThreadEmailIds = threadEmails.map((e) => e.id);
          const window = getMainWindow();
          if (window) {
            window.webContents.send("sync:emails-removed", {
              accountId,
              emailIds: allThreadEmailIds,
            });
          }
        }

        return { success: true, data: undefined, queued: anyQueued, failedIds, archivedIds };
      } catch (error) {
        // Restore all labels on catastrophic failure
        for (const [emailId, labels] of previousLabelsMap) {
          updateEmailLabelIds(emailId, labels);
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Trash an email (offline-aware: queues when offline or on network error)
  ipcMain.handle(
    "emails:trash",
    async (_, { accountId, emailId }: { accountId: string; emailId: string }) => {
      // Save email data before deleting so we can restore on permanent failure
      const emailData = getEmail(emailId);

      // Optimistically remove from DB so the next sync doesn't re-add the email
      deleteEmail(emailId, accountId);

      if (useFakeData) {
        return { success: true, data: undefined };
      }

      // If offline, queue for later — DB already updated
      if (!networkMonitor.isOnline) {
        if (emailData) trashedEmailData.set(emailId, emailData);
        pendingActionsQueue.enqueue("trash", emailId, accountId);
        return { success: true, data: undefined, queued: true };
      }

      try {
        const client = activeClients.get(accountId);
        if (!client) {
          if (emailData) trashedEmailData.set(emailId, emailData);
          pendingActionsQueue.enqueue("trash", emailId, accountId);
          return { success: true, data: undefined, queued: true };
        }

        await client.trashMessage(emailId);

        // Notify renderer of email removal
        const window = getMainWindow();
        if (window) {
          window.webContents.send("sync:emails-removed", { accountId, emailIds: [emailId] });
        }

        return { success: true, data: undefined };
      } catch (error) {
        if (isNetworkError(error)) {
          if (emailData) trashedEmailData.set(emailId, emailData);
          pendingActionsQueue.enqueue("trash", emailId, accountId);
          networkMonitor.setOffline();
          return { success: true, data: undefined, queued: true };
        }

        // Permanent failure — restore the email to DB
        if (emailData) {
          saveEmail(
            {
              id: emailData.id,
              threadId: emailData.threadId,
              subject: emailData.subject,
              from: emailData.from,
              to: emailData.to,
              date: emailData.date,
              body: emailData.body || "",
              snippet: emailData.snippet,
              labelIds: emailData.labelIds,
            },
            accountId,
          );
        }

        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Star/unstar an email
  ipcMain.handle(
    "emails:set-starred",
    async (
      _,
      { accountId, emailId, starred }: { accountId: string; emailId: string; starred: boolean },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        const client = activeClients.get(accountId);
        if (!client) {
          return { success: false, error: "Account not connected" };
        }

        await client.setStarred(emailId, starred);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Mark an email as read or unread
  ipcMain.handle(
    "emails:set-read",
    async (
      _,
      { accountId, emailId, read }: { accountId: string; emailId: string; read: boolean },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        const client = activeClients.get(accountId);
        if (!client) {
          return { success: false, error: "Account not connected" };
        }

        await client.setRead(emailId, read);

        // Update local DB label_ids
        const email = getEmail(emailId);
        if (email) {
          // Default to ["INBOX"] for legacy emails with no labels stored
          const currentLabels = email.labelIds || ["INBOX"];
          let newLabels: string[];
          if (read) {
            newLabels = currentLabels.filter((l) => l !== "UNREAD");
          } else {
            newLabels = currentLabels.includes("UNREAD")
              ? currentLabels
              : [...currentLabels, "UNREAD"];
          }
          log.info(
            `[SetRead] ${emailId} read=${read}: ${JSON.stringify(currentLabels)} → ${JSON.stringify(newLabels)}`,
          );
          updateEmailLabelIds(emailId, newLabels);
        }

        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get all messages in a thread (including sent replies)
  // DB-first: returns local data immediately, then background-refreshes from Gmail API.
  // This avoids a 500ms-3000ms Gmail API round-trip on every thread open.
  ipcMain.handle(
    "emails:get-thread",
    async (
      _,
      { accountId, threadId }: { accountId: string; threadId: string },
    ): Promise<IpcResponse<DashboardEmail[]>> => {
      if (useFakeData) {
        return { success: true, data: [] };
      }

      // First: try local DB (fast, 1-50ms)
      const dbEmails = getEmailsByThread(threadId, accountId);

      if (dbEmails.length > 0) {
        // Background refresh from Gmail API to pick up any missing thread members
        // (e.g., sent replies from other devices not yet synced)
        const client = activeClients.get(accountId);
        if (client) {
          client
            .getThread(threadId)
            .then((gmailEmails) => {
              // Re-query DB to avoid stale snapshot if background sync added emails
              const currentDbIds = new Set(getEmailsByThread(threadId, accountId).map((e) => e.id));
              const newEmails = gmailEmails.filter((e) => !currentDbIds.has(e.id));

              if (newEmails.length > 0) {
                // Save new emails to DB
                for (const email of newEmails) {
                  saveEmail(email, accountId);
                }

                // NOTE: No draft cleanup here. This path backfills historical
                // thread members for display — it can't distinguish genuinely
                // new activity from old emails not yet in the local DB.
                // incrementalSync (via History API) handles draft cleanup
                // correctly because it only sees truly new emails.

                // Push new thread members to renderer via existing event
                const window = getMainWindow();
                if (window) {
                  const dashboardNewEmails: DashboardEmail[] = newEmails.map((email) => ({
                    ...email,
                    accountId,
                    labelIds: email.labelIds,
                  }));
                  window.webContents.send("sync:new-emails", {
                    accountId,
                    emails: dashboardNewEmails,
                  });
                }
              }
            })
            .catch((err) => {
              log.error({ err: err }, "[Thread] Background refresh failed");
            });
        }

        return { success: true, data: dbEmails };
      }

      // Fallback: no DB data (e.g., thread from remote search not yet saved locally)
      try {
        const client = activeClients.get(accountId);
        if (!client) {
          return { success: false, error: "Account not connected" };
        }

        const emails = await client.getThread(threadId);

        // Save to DB for future fast access
        for (const email of emails) {
          saveEmail(email, accountId);
        }

        // Convert to DashboardEmail format
        const dashboardEmails: DashboardEmail[] = emails.map((email) => ({
          ...email,
          accountId,
          labelIds: email.labelIds,
        }));

        return { success: true, data: dashboardEmails };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Search all mail using local FTS5 index (instant search)
  ipcMain.handle(
    "emails:search",
    async (
      _,
      {
        accountId,
        query,
        maxResults = 50,
      }: { accountId: string; query: string; maxResults?: number },
    ): Promise<IpcResponse<DashboardEmail[]>> => {
      if (useFakeData) {
        const { DEMO_INBOX_EMAILS, DEMO_EXPECTED_ANALYSIS } = await import("../demo/fake-inbox");
        const q = query.toLowerCase();
        const filtered = DEMO_INBOX_EMAILS.filter((email) => {
          const bodyPlain = email.body.replace(/<[^>]*>/g, " ").toLowerCase();
          return (
            email.subject.toLowerCase().includes(q) ||
            bodyPlain.includes(q) ||
            email.from.toLowerCase().includes(q) ||
            email.to.toLowerCase().includes(q) ||
            (email.snippet?.toLowerCase().includes(q) ?? false)
          );
        })
          .slice(0, maxResults)
          .map((email): DashboardEmail => {
            const analysis = DEMO_EXPECTED_ANALYSIS[email.id];
            return {
              ...email,
              accountId: "default",
              analysis: analysis
                ? {
                    needsReply: analysis.needsReply,
                    reason: analysis.reason,
                    priority: analysis.priority,
                    analyzedAt: Date.now(),
                  }
                : undefined,
            };
          });
        return { success: true, data: filtered };
      }

      try {
        // Use local FTS5 search (instant)
        const searchResults = searchEmails(query, { accountId, limit: maxResults });
        const localIds = searchResults.map((r) => r.id);
        const dashboardEmails = getEmailsByIds(localIds);

        log.info(`[Search] Local FTS5 found ${dashboardEmails.length} results for "${query}"`);
        return { success: true, data: dashboardEmails };
      } catch (error) {
        log.error({ err: error }, "[Search] Error");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Remote Gmail API search — fetches results from Gmail, saves new ones to local DB
  ipcMain.handle(
    "emails:search-remote",
    async (
      _,
      {
        accountId,
        query,
        maxResults = 50,
        pageToken,
      }: { accountId: string; query: string; maxResults?: number; pageToken?: string },
    ): Promise<IpcResponse<{ emails: DashboardEmail[]; nextPageToken?: string }>> => {
      if (useFakeData) {
        return { success: true, data: { emails: [] } };
      }

      const client = activeClients.get(accountId);
      if (!client) {
        return { success: false, error: "Account not connected" };
      }

      try {
        // 1. Get message IDs from Gmail API (with optional page token for pagination)
        const { results: gmailResults, nextPageToken } = await client.searchEmails(
          query,
          maxResults,
          pageToken,
        );
        if (gmailResults.length === 0) {
          return { success: true, data: { emails: [] } };
        }

        // 2. Partition into already-local vs needs-fetch
        const localIdSet = getEmailIds(accountId);
        const needsFetch = gmailResults.filter((r) => !localIdSet.has(r.id));

        // 3. Batch fetch remote-only messages and save to local DB
        if (needsFetch.length > 0) {
          log.info(`[Search] Fetching ${needsFetch.length} remote emails for "${query}"`);
          const fetched = await client.getMessages(
            needsFetch.map((r) => r.id),
            25,
          );
          for (const email of fetched) {
            saveEmail(email, accountId);
          }
        }

        // 4. Return all Gmail results as DashboardEmails (now all are in local DB)
        const allIds = gmailResults.map((r) => r.id);
        const dashboardEmails = getEmailsByIds(allIds);

        log.info(
          `[Search] Remote search found ${dashboardEmails.length} results for "${query}" (${needsFetch.length} newly fetched)${nextPageToken ? " [more available]" : ""}`,
        );
        return { success: true, data: { emails: dashboardEmails, nextPageToken } };
      } catch (error) {
        log.error({ err: error }, "[Search] Remote search error");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
