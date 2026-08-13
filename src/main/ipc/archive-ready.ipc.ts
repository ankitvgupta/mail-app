import { ipcMain, BrowserWindow } from "electron";
import { ArchiveReadyAnalyzer } from "../services/archive-ready-analyzer";
import {
  getEmailsByThread,
  getInboxEmails,
  saveArchiveReady,
  getArchiveReadyThreads,
  dismissArchiveReady,
  getAnalyzedArchiveThreadIds,
  getAccounts,
  updateEmailLabelIds,
} from "../db";
import { getConfig, getFeatureModelConfig } from "./settings.ipc";
import { getEmailSyncService } from "./sync.ipc";
import type { IpcResponse, DashboardEmail } from "../../shared/types";
import { createLogger } from "../services/logger";

const log = createLogger("archive-ready-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

let analyzer: ArchiveReadyAnalyzer | null = null;

function getAnalyzer(): ArchiveReadyAnalyzer {
  if (!analyzer) {
    const config = getConfig();
    const { model, provider } = getFeatureModelConfig("archiveReady");
    analyzer = new ArchiveReadyAnalyzer(model, config.archiveReadyPrompt, provider);
  }
  return analyzer;
}

export function resetArchiveReadyAnalyzer(): void {
  analyzer = null;
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

// Group emails into threads for analysis
function groupInboxEmailsByThread(accountId: string): Map<string, DashboardEmail[]> {
  const emails = getInboxEmails(accountId);
  const threadMap = new Map<string, DashboardEmail[]>();

  for (const email of emails) {
    const existing = threadMap.get(email.threadId) || [];
    existing.push(email);
    threadMap.set(email.threadId, existing);
  }

  return threadMap;
}

export type ArchiveReadyThread = {
  threadId: string;
  reason: string;
  analyzedAt: number;
  emails: DashboardEmail[];
  subject: string;
  latestDate: string;
  from: string;
};

export function registerArchiveReadyIpc(): void {
  // Get all threads that are ready for archiving
  ipcMain.handle(
    "archive-ready:get-threads",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<ArchiveReadyThread[]>> => {
      try {
        const readyRows = getArchiveReadyThreads(accountId);

        const result: ArchiveReadyThread[] = [];
        for (const row of readyRows) {
          const threadEmails = getEmailsByThread(row.threadId, accountId);
          if (threadEmails.length === 0) continue;

          // Sort by date, latest last
          threadEmails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
          const latest = threadEmails[threadEmails.length - 1];

          result.push({
            threadId: row.threadId,
            reason: row.reason,
            analyzedAt: row.analyzedAt,
            emails: threadEmails,
            subject: latest.subject.replace(/^(Re:\s*)+/i, ""),
            latestDate: latest.date,
            from: threadEmails[0].from,
          });
        }

        // Sort by latest date descending
        result.sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Analyze a single thread for archive-readiness
  ipcMain.handle(
    "archive-ready:analyze-thread",
    async (
      _,
      { threadId, accountId }: { threadId: string; accountId: string },
    ): Promise<IpcResponse<{ isReady: boolean; reason: string }>> => {
      if (useFakeData) {
        return {
          success: true,
          data: {
            isReady: true,
            reason: "Demo mode - marked as ready",
          },
        };
      }

      try {
        const threadEmails = getEmailsByThread(threadId, accountId);
        if (threadEmails.length === 0) {
          return { success: false, error: "Thread not found" };
        }

        // Get user email for context
        const accounts = getAccounts();
        const account = accounts.find((a) => a.id === accountId);
        const userEmail = account?.email;

        const analyzerInstance = getAnalyzer();
        const result = await analyzerInstance.analyzeThread(threadEmails, userEmail);

        saveArchiveReady(threadId, accountId, result.archive_ready, result.reason);

        return {
          success: true,
          data: { isReady: result.archive_ready, reason: result.reason },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Scan all inbox threads for archive-readiness
  ipcMain.handle(
    "archive-ready:scan",
    async (
      _,
      { accountId }: { accountId: string },
    ): Promise<IpcResponse<{ analyzed: number; ready: number }>> => {
      if (useFakeData) {
        return { success: true, data: { analyzed: 0, ready: 0 } };
      }

      try {
        const threadMap = groupInboxEmailsByThread(accountId);
        const alreadyAnalyzed = getAnalyzedArchiveThreadIds(accountId);

        // Compute threads that actually need analysis (only those in the current inbox)
        const threadsToAnalyze = [...threadMap.keys()].filter((tid) => !alreadyAnalyzed.has(tid));
        const total = threadsToAnalyze.length;

        // Get user email for context
        const accounts = getAccounts();
        const account = accounts.find((a) => a.id === accountId);
        const userEmail = account?.email;

        const analyzerInstance = getAnalyzer();
        let analyzed = 0;
        let ready = 0;
        const win = getMainWindow();

        for (const [threadId, emails] of threadMap) {
          // Skip already analyzed threads
          if (alreadyAnalyzed.has(threadId)) continue;

          try {
            // Emit progress
            if (win) {
              win.webContents.send("archive-ready:progress", {
                analyzed,
                total,
                current: emails[0]?.subject || threadId,
              });
            }

            const result = await analyzerInstance.analyzeThread(emails, userEmail);

            saveArchiveReady(threadId, accountId, result.archive_ready, result.reason);

            analyzed++;
            if (result.archive_ready) ready++;
          } catch (error) {
            log.error({ err: error, threadId }, "[ArchiveReady] Failed to analyze thread");
          }
        }

        // Emit completion
        if (win) {
          win.webContents.send("archive-ready:progress", {
            analyzed,
            total: analyzed,
            current: null,
            done: true,
          });
        }

        return { success: true, data: { analyzed, ready } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Dismiss a thread from archive-ready list (keep in inbox)
  ipcMain.handle(
    "archive-ready:dismiss",
    async (
      _,
      { threadId, accountId }: { threadId: string; accountId: string },
    ): Promise<IpcResponse<void>> => {
      try {
        dismissArchiveReady(threadId, accountId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Archive a single thread (all emails in it)
  ipcMain.handle(
    "archive-ready:archive-thread",
    async (
      _,
      { threadId, accountId }: { threadId: string; accountId: string },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        const threadEmails = getEmailsByThread(threadId, accountId);
        // Remove all emails in the thread (including SENT) so no ghost threads remain
        const removedIds = threadEmails.map((e) => e.id);
        for (const email of threadEmails) {
          updateEmailLabelIds(
            email.id,
            (email.labelIds || []).filter((l: string) => l !== "INBOX"),
          );
        }
        dismissArchiveReady(threadId, accountId);
        const win = getMainWindow();
        if (win && removedIds.length > 0) {
          win.webContents.send("sync:emails-removed", { accountId, emailIds: removedIds });
        }
        return { success: true, data: undefined };
      }

      try {
        const client = getEmailSyncService().getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: "Account not connected" };
        }

        const threadEmails = getEmailsByThread(threadId, accountId);
        const inboxEmails = threadEmails.filter((e) => e.labelIds && e.labelIds.includes("INBOX"));

        // Archive each email in the thread
        const archivedIds: string[] = [];
        for (const email of inboxEmails) {
          try {
            await client.archiveMessage(email.id);
            // Only update local DB after successful API call
            const labels = email.labelIds || [];
            updateEmailLabelIds(
              email.id,
              labels.filter((l: string) => l !== "INBOX"),
            );
            archivedIds.push(email.id);
          } catch (err) {
            log.error({ err, emailId: email.id }, "[ArchiveReady] Failed to archive email");
          }
        }

        // Only dismiss if at least one email was archived
        if (archivedIds.length > 0) {
          dismissArchiveReady(threadId, accountId);

          // Notify renderer: remove entire thread (including SENT emails) so no ghost thread remains
          const allThreadEmailIds = threadEmails.map((e) => e.id);
          const win = getMainWindow();
          if (win) {
            win.webContents.send("sync:emails-removed", {
              accountId,
              emailIds: allThreadEmailIds,
            });
          }
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

  // Archive all ready threads
  ipcMain.handle(
    "archive-ready:archive-all",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<{ archived: number }>> => {
      if (useFakeData) {
        const readyRows = getArchiveReadyThreads(accountId);
        const allRemovedIds: string[] = [];

        for (const row of readyRows) {
          const threadEmails = getEmailsByThread(row.threadId, accountId);
          // Remove all emails in thread (including SENT) so no ghost threads remain
          for (const email of threadEmails) {
            updateEmailLabelIds(
              email.id,
              (email.labelIds || []).filter((l: string) => l !== "INBOX"),
            );
            allRemovedIds.push(email.id);
          }
          dismissArchiveReady(row.threadId, accountId);
        }

        // Notify renderer so emails disappear from the inbox
        const win = getMainWindow();
        if (win && allRemovedIds.length > 0) {
          win.webContents.send("sync:emails-removed", { accountId, emailIds: allRemovedIds });
        }

        return { success: true, data: { archived: readyRows.length } };
      }

      try {
        const client = getEmailSyncService().getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: "Account not connected" };
        }

        const readyRows = getArchiveReadyThreads(accountId);
        let archived = 0;
        const allRemovedIds: string[] = [];

        for (const row of readyRows) {
          const threadEmails = getEmailsByThread(row.threadId, accountId);
          const inboxEmails = threadEmails.filter(
            (e) => e.labelIds && e.labelIds.includes("INBOX"),
          );

          let threadArchived = false;
          for (const email of inboxEmails) {
            try {
              await client.archiveMessage(email.id);
              // Only update local DB after successful API call
              const labels = email.labelIds || [];
              updateEmailLabelIds(
                email.id,
                labels.filter((l: string) => l !== "INBOX"),
              );
              threadArchived = true;
            } catch (err) {
              log.error({ err, emailId: email.id }, "[ArchiveReady] Failed to archive email");
            }
          }

          if (threadArchived) {
            // Collect ALL emails in thread for removal (including SENT) so no ghost threads
            for (const email of threadEmails) {
              allRemovedIds.push(email.id);
            }
            dismissArchiveReady(row.threadId, accountId);
            archived++;
          }
        }

        // Notify renderer of removal
        const win = getMainWindow();
        if (win && allRemovedIds.length > 0) {
          win.webContents.send("sync:emails-removed", {
            accountId,
            emailIds: allRemovedIds,
          });
        }

        return { success: true, data: { archived } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
