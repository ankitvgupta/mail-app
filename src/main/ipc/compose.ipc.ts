import { ipcMain, BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import { getEmailSyncService } from "./sync.ipc";
import {
  getEmail,
  getAccounts,
  saveLocalDraft,
  getLocalDraft,
  getLocalDrafts,
  deleteLocalDraft,
  updateLocalDraftGmailId,
  deleteArchiveReadyForThreads,
  getArchiveReadyForThread,
  getEmailsByThread,
  updateEmailLabelIds,
} from "../db";
import { networkMonitor } from "../services/network-monitor";
import { outboxService } from "../services/outbox-service";
import { prefetchService } from "../services/prefetch-service";
import { isNetworkError } from "../services/network-errors";
import { learnFromDraftEdit } from "../services/draft-edit-learner";
import type {
  IpcResponse,
  LocalDraft,
  GmailDraft,
  ComposeMode,
  ReplyInfo,
  SendMessageOptions,
  SendMessageResult,
} from "../../shared/types";
import { formatAddressesWithNames, extractThreadNames } from "../utils/address-formatting";
import { createLogger } from "../services/logger";

const log = createLogger("compose-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

/**
 * Queue a message to the outbox for offline sending
 */
function queueToOutbox(options: SendMessageOptions & { accountId: string }): SendMessageResult {
  // Pre-format addresses with display names so they're stored correctly
  const formattedTo = formatAddressesWithNames(options.to, options.recipientNames);
  const formattedCc = options.cc
    ? formatAddressesWithNames(options.cc, options.recipientNames)
    : undefined;
  const formattedBcc = options.bcc
    ? formatAddressesWithNames(options.bcc, options.recipientNames)
    : undefined;

  const id = outboxService.queue({
    accountId: options.accountId,
    type: options.threadId ? "reply" : "send",
    threadId: options.threadId,
    to: formattedTo,
    cc: formattedCc,
    bcc: formattedBcc,
    subject: options.subject,
    bodyHtml: options.bodyHtml || "",
    bodyText: options.bodyText,
    inReplyTo: options.inReplyTo,
    references: options.references,
    attachments: options.attachments,
  });
  return { id, threadId: options.threadId || "", queued: true };
}

/**
 * Escape HTML entities for safe display
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse a comma-separated address header into an array of bare email addresses.
 */
function parseAddressList(header: string): string[] {
  return header
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      const match = s.match(/<([^>]+)>/);
      return match ? match[1] : s;
    })
    .filter(Boolean);
}

/**
 * Extract reply info from an email for composing a reply.
 * userEmail is the current account's email so we can exclude the user from recipients.
 * The email body is HTML, so we need to properly quote it.
 */
function extractReplyInfo(
  email: ReturnType<typeof getEmail>,
  mode: ComposeMode,
  userEmail?: string,
): ReplyInfo | null {
  if (!email) return null;

  // Parse the From header to get email address
  const fromMatch = email.from.match(/<([^>]+)>/) || [null, email.from];
  const fromEmail = fromMatch[1] || email.from;

  const toAddresses = parseAddressList(email.to);
  const ccAddresses = email.cc ? parseAddressList(email.cc) : [];

  // For reply-all: CC = everyone from To + CC, minus the sender (already in To) and ourselves
  const cc: string[] = [];
  if (mode === "reply-all") {
    const exclude = new Set([fromEmail.toLowerCase()]);
    if (userEmail) exclude.add(userEmail.toLowerCase());

    const seen = new Set<string>();
    for (const addr of [...toAddresses, ...ccAddresses]) {
      const lower = addr.toLowerCase();
      if (!exclude.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        cc.push(addr);
      }
    }
  }

  // Build subject
  let subject = email.subject;
  if (mode === "forward") {
    if (!subject.toLowerCase().startsWith("fwd:")) {
      subject = `Fwd: ${subject}`;
    }
  } else {
    if (!subject.toLowerCase().startsWith("re:")) {
      subject = `Re: ${subject}`;
    }
  }

  // Build quoted body as proper HTML following Gmail's format:
  // - Reply: Uses <div class="gmail_quote"> wrapper with attribution line outside blockquote
  // - Forward: Uses <div class="gmail_quote"> without blockquote (no visual indentation)
  // See: https://github.com/nylas/nylas-mail/issues/1746
  const dateStr = new Date(email.date).toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const escapedFrom = escapeHtml(email.from);
  const escapedSubject = escapeHtml(email.subject);
  const escapedTo = escapeHtml(email.to);

  // Store original body for display (preserves all HTML)
  const originalBody = email.body ?? "";

  let quotedBody: string;
  let attribution: string;

  if (mode === "forward") {
    // Forward: Gmail uses a div wrapper without blockquote (no visual indentation)
    let attachmentLine = "";
    if (email.attachments?.length) {
      const names = email.attachments.map((a) => escapeHtml(a.filename)).join(", ");
      attachmentLine = `<br>Attachments: ${names}`;
    }
    attribution = `---------- Forwarded message ---------<br>From: <strong>${escapedFrom}</strong><br>Date: ${dateStr}<br>Subject: ${escapedSubject}<br>To: ${escapedTo}${attachmentLine}`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><br><br>${email.body ?? ""}</div>`;
  } else {
    // Reply: Gmail uses blockquote inside a gmail_quote wrapper for visual indentation
    // The attribution line comes before the blockquote, not inside it
    attribution = `On ${dateStr}, ${escapedFrom} wrote:`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${email.body ?? ""}</blockquote></div>`;
  }

  return {
    to: mode === "forward" ? [] : [fromEmail],
    cc,
    subject,
    threadId: email.threadId,
    inReplyTo: email.id, // Will be replaced with actual Message-ID header
    references: email.id, // Will be replaced with actual References chain
    quotedBody,
    originalBody,
    attribution,
    // Include attachment metadata when forwarding so they can be re-attached
    ...(mode === "forward" &&
      email.attachments?.length && {
        forwardedAttachments: email.attachments,
      }),
  };
}

// Delay before re-queuing archive-ready analysis after sending a reply.
// Matches the renderer grace period so the thread doesn't get recategorized
// while the user is still working through their inbox.
const REANALYSIS_DELAY_MS = 3 * 60 * 1000; // 3 minutes

// Track pending reanalysis timers so we can cancel stale ones.
// Exported so email-sync can skip redundant re-queues for threads already scheduled.
const pendingReanalysisTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Check if a thread already has a pending delayed reanalysis from a recent reply. */
export function hasPendingReanalysis(threadId: string): boolean {
  return pendingReanalysisTimers.has(threadId);
}

/**
 * Clear archive-ready status for a thread and schedule re-analysis.
 * Called after sending a reply. The re-analysis is delayed so the thread
 * keeps its position in the inbox while the user moves to the next email.
 */
function triggerThreadReanalysis(threadId: string, accountId: string): void {
  const existing = getArchiveReadyForThread(threadId, accountId);
  if (existing?.isReady) {
    deleteArchiveReadyForThreads([threadId], accountId);
    // Notify renderer to remove from archive-ready set
    import("./prefetch.ipc")
      .then(({ notifyArchiveReady }) => {
        notifyArchiveReady(threadId, accountId, false, "");
      })
      .catch((err) => log.error({ err }, "Unhandled error"));
  }

  // Cancel any previously pending reanalysis for this thread
  const existingTimer = pendingReanalysisTimers.get(threadId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Delay re-queue so the thread isn't immediately recategorized
  const timer = setTimeout(() => {
    pendingReanalysisTimers.delete(threadId);
    prefetchService.requeueArchiveReadyForThreads([threadId], accountId);
  }, REANALYSIS_DELAY_MS);

  pendingReanalysisTimers.set(threadId, timer);
}

/**
 * Mark all messages in a thread as read after sending a reply.
 * Uses Gmail's threads.modify API (single call for the whole thread),
 * then updates local DB to match. Fire-and-forget — errors are logged
 * but don't affect the send result.
 */
async function markThreadAsReadAfterSend(
  client: { markThreadAsRead(threadId: string): Promise<void> },
  threadId: string,
  accountId: string,
): Promise<void> {
  try {
    await client.markThreadAsRead(threadId);

    // Update local DB to remove UNREAD label from all thread messages
    const threadEmails = getEmailsByThread(threadId, accountId);
    for (const email of threadEmails) {
      const labels = email.labelIds || [];
      if (labels.includes("UNREAD")) {
        updateEmailLabelIds(
          email.id,
          labels.filter((l) => l !== "UNREAD"),
        );
      }
    }
  } catch (error) {
    // Non-critical — the send succeeded, read status will sync eventually
    log.error({ err: error }, "[Compose] Failed to mark thread as read after send");
  }
}

/** Notify renderer that draft-edit learning produced results */
function notifyDraftEditLearned(payload: {
  promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
  draftMemoriesCreated: number;
  draftMemoryIds: string[];
}): void {
  const windows = BrowserWindow.getAllWindows();
  const win = windows.length > 0 ? windows[0] : null;
  if (!win) return;
  win.webContents.send("draft-edit:learned", payload);
}

export function registerComposeIpc(): void {
  // Send a new message
  ipcMain.handle(
    "compose:send",
    async (
      _,
      options: SendMessageOptions & { accountId: string },
    ): Promise<IpcResponse<SendMessageResult>> => {
      if (useFakeData) {
        log.info({ to: options.to }, "[DEMO] Sending message");
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Still trigger draft-edit learning in demo mode so we can test it
        if (options.threadId && !options.isForward) {
          learnFromDraftEdit({
            threadId: options.threadId,
            accountId: options.accountId,
            sentBodyHtml: options.bodyHtml || "",
            sentBodyText: options.bodyText,
          })
            .then((result) => {
              if (result && (result.promoted.length > 0 || result.draftMemoriesCreated > 0)) {
                log.info(
                  `[DEMO] Draft edit learning: ${result.promoted.length} promoted, ${result.draftMemoriesCreated} draft memories created/voted`,
                );
                notifyDraftEditLearned({
                  promoted: result.promoted,
                  draftMemoriesCreated: result.draftMemoriesCreated,
                  draftMemoryIds: result.draftMemoryIds,
                });
              }
            })
            .catch((err) => {
              log.error({ err: err }, "[DEMO] Draft edit learning failed");
            });
        }
        return {
          success: true,
          data: { id: `demo-sent-${Date.now()}`, threadId: `demo-thread-${Date.now()}` },
        };
      }

      // Augment recipientNames from thread context so MIME addresses include display names.
      // Build a new options object to avoid mutating the IPC argument.
      if (options.threadId) {
        const threadEmails = getEmailsByThread(options.threadId, options.accountId);
        const threadNames = extractThreadNames(threadEmails);
        // Merge: renderer-provided names take priority over thread-derived names
        options = { ...options, recipientNames: { ...threadNames, ...options.recipientNames } };
      }

      // If we know we're offline, queue immediately
      if (!networkMonitor.isOnline) {
        log.info("[Compose] Offline, queueing message to outbox");
        const result = queueToOutbox(options);
        return { success: true, data: result };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(options.accountId);
        if (!client) {
          // No client - queue to outbox, will be sent when client is available
          log.info("[Compose] No client available, queueing to outbox");
          const result = queueToOutbox(options);
          return { success: true, data: result };
        }

        const result = await client.sendMessage(options);

        // After sending a reply, mark the thread as read and re-queue analysis
        // Skip for forwards — forwarding doesn't mean the user addressed the original conversation
        if (options.threadId && !options.isForward) {
          triggerThreadReanalysis(options.threadId, options.accountId);
          // Fire-and-forget: mark thread read so Gmail shows it as read
          markThreadAsReadAfterSend(client, options.threadId, options.accountId);
          // Fire-and-forget: learn from draft edits (compare AI draft vs what was sent)
          learnFromDraftEdit({
            threadId: options.threadId,
            accountId: options.accountId,
            sentBodyHtml: options.bodyHtml || "",
            sentBodyText: options.bodyText,
          })
            .then((result) => {
              if (result && (result.promoted.length > 0 || result.draftMemoriesCreated > 0)) {
                log.info(
                  `[Compose] Draft edit learning: ${result.promoted.length} promoted, ${result.draftMemoriesCreated} draft memories created/voted`,
                );
                notifyDraftEditLearned({
                  promoted: result.promoted,
                  draftMemoriesCreated: result.draftMemoriesCreated,
                  draftMemoryIds: result.draftMemoryIds,
                });
              }
            })
            .catch((err) => {
              log.error({ err: err }, "[Compose] Draft edit learning failed");
            });
        }

        return { success: true, data: { ...result, queued: false } };
      } catch (error) {
        // If network error, auto-queue instead of failing
        if (isNetworkError(error)) {
          log.info("[Compose] Network error during send, queueing to outbox");
          networkMonitor.setOffline(); // Update state since we now know
          const result = queueToOutbox(options);
          return { success: true, data: result };
        }

        // Non-network error (auth, invalid recipient) - return error
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to send message",
        };
      }
    },
  );

  // Save a draft locally
  ipcMain.handle(
    "compose:save-local-draft",
    async (
      _,
      draft: Omit<LocalDraft, "id" | "createdAt" | "updatedAt">,
    ): Promise<IpcResponse<LocalDraft>> => {
      try {
        const now = Date.now();
        const fullDraft: LocalDraft = {
          ...draft,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
        };

        saveLocalDraft(fullDraft);
        return { success: true, data: fullDraft };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to save draft",
        };
      }
    },
  );

  // Update an existing local draft
  ipcMain.handle(
    "compose:update-local-draft",
    async (
      _,
      { draftId, updates }: { draftId: string; updates: Partial<LocalDraft> },
    ): Promise<IpcResponse<LocalDraft>> => {
      try {
        const existing = getLocalDraft(draftId);
        if (!existing) {
          return { success: false, error: "Draft not found" };
        }

        const updated: LocalDraft = {
          ...existing,
          ...updates,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
        };

        saveLocalDraft(updated);
        return { success: true, data: updated };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to update draft",
        };
      }
    },
  );

  // Get a local draft
  ipcMain.handle(
    "compose:get-local-draft",
    async (_, { draftId }: { draftId: string }): Promise<IpcResponse<LocalDraft | null>> => {
      try {
        const draft = getLocalDraft(draftId);
        return { success: true, data: draft };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get draft",
        };
      }
    },
  );

  // List local drafts
  ipcMain.handle(
    "compose:list-local-drafts",
    async (_, { accountId }: { accountId?: string }): Promise<IpcResponse<LocalDraft[]>> => {
      try {
        const drafts = getLocalDrafts(accountId);
        return { success: true, data: drafts };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list drafts",
        };
      }
    },
  );

  // Delete a local draft
  ipcMain.handle(
    "compose:delete-local-draft",
    async (_, { draftId }: { draftId: string }): Promise<IpcResponse<void>> => {
      try {
        deleteLocalDraft(draftId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to delete draft",
        };
      }
    },
  );

  // Save draft to Gmail
  ipcMain.handle(
    "compose:save-gmail-draft",
    async (
      _,
      { localDraftId, accountId }: { localDraftId: string; accountId: string },
    ): Promise<IpcResponse<{ gmailDraftId: string }>> => {
      if (useFakeData) {
        log.info("[DEMO] Saving Gmail draft");
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { success: true, data: { gmailDraftId: `demo-gmail-draft-${Date.now()}` } };
      }

      try {
        const draft = getLocalDraft(localDraftId);
        if (!draft) {
          return { success: false, error: "Local draft not found" };
        }

        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        const result = await client.createFullDraft({
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          bodyText: draft.bodyText,
          threadId: draft.threadId,
          inReplyTo: draft.inReplyTo,
        });

        // Update local draft with Gmail ID
        updateLocalDraftGmailId(localDraftId, result.id);

        return { success: true, data: { gmailDraftId: result.id } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to save Gmail draft",
        };
      }
    },
  );

  // Send an existing Gmail draft
  ipcMain.handle(
    "compose:send-gmail-draft",
    async (
      _,
      { gmailDraftId, accountId }: { gmailDraftId: string; accountId: string },
    ): Promise<IpcResponse<{ id: string; threadId: string }>> => {
      if (useFakeData) {
        log.info({ gmailDraftId }, "[DEMO] Sending Gmail draft");
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          success: true,
          data: { id: `demo-sent-${Date.now()}`, threadId: `demo-thread-${Date.now()}` },
        };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        const result = await client.sendDraft(gmailDraftId);

        // Mark thread as read after sending a draft reply
        if (result.threadId) {
          markThreadAsReadAfterSend(client, result.threadId, accountId);
        }

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to send draft",
        };
      }
    },
  );

  // List Gmail drafts
  ipcMain.handle(
    "compose:list-gmail-drafts",
    async (
      _,
      { accountId, maxResults }: { accountId: string; maxResults?: number },
    ): Promise<IpcResponse<GmailDraft[]>> => {
      if (useFakeData) {
        return { success: true, data: [] };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        const drafts = await client.listDrafts(maxResults);
        return { success: true, data: drafts };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list Gmail drafts",
        };
      }
    },
  );

  // Get a Gmail draft
  ipcMain.handle(
    "compose:get-gmail-draft",
    async (
      _,
      { gmailDraftId, accountId }: { gmailDraftId: string; accountId: string },
    ): Promise<IpcResponse<GmailDraft | null>> => {
      if (useFakeData) {
        return { success: true, data: null };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        const draft = await client.getDraft(gmailDraftId);
        return { success: true, data: draft };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get Gmail draft",
        };
      }
    },
  );

  // Delete a Gmail draft
  ipcMain.handle(
    "compose:delete-gmail-draft",
    async (
      _,
      { gmailDraftId, accountId }: { gmailDraftId: string; accountId: string },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        log.info({ gmailDraftId }, "[DEMO] Deleting Gmail draft");
        return { success: true, data: undefined };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        await client.deleteDraft(gmailDraftId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to delete Gmail draft",
        };
      }
    },
  );

  // Get reply info for an email
  ipcMain.handle(
    "compose:get-reply-info",
    async (
      _,
      { emailId, mode, accountId }: { emailId: string; mode: ComposeMode; accountId: string },
    ): Promise<IpcResponse<ReplyInfo | null>> => {
      try {
        const email = getEmail(emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }

        const account = getAccounts().find((a) => a.id === accountId);
        const replyInfo = extractReplyInfo(email, mode, account?.email);

        // Try to get actual Message-ID and References headers from Gmail
        if (!useFakeData && replyInfo) {
          const syncService = getEmailSyncService();
          const client = syncService.getClientForAccount(accountId);
          if (client) {
            try {
              const headers = await client.getMessageHeaders(emailId);
              if (headers) {
                replyInfo.inReplyTo = headers.messageId;
                replyInfo.references = headers.references
                  ? `${headers.references} ${headers.messageId}`
                  : headers.messageId;
              }
            } catch {
              // Fall back to email ID if headers fetch fails
            }
          }
        }

        return { success: true, data: replyInfo };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get reply info",
        };
      }
    },
  );

  // Email actions (archive, trash, star, read)
  ipcMain.handle(
    "compose:archive",
    async (
      _,
      { messageId, accountId }: { messageId: string; accountId: string },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        log.info({ messageId }, "[DEMO] Archiving message");
        return { success: true, data: undefined };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        await client.archiveMessage(messageId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to archive message",
        };
      }
    },
  );

  ipcMain.handle(
    "compose:trash",
    async (
      _,
      { messageId, accountId }: { messageId: string; accountId: string },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        log.info({ messageId }, "[DEMO] Trashing message");
        return { success: true, data: undefined };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        await client.trashMessage(messageId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to trash message",
        };
      }
    },
  );

  ipcMain.handle(
    "compose:star",
    async (
      _,
      { messageId, accountId, starred }: { messageId: string; accountId: string; starred: boolean },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        log.info({ messageId, starred }, "[DEMO] Setting star");
        return { success: true, data: undefined };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        await client.setStarred(messageId, starred);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to star message",
        };
      }
    },
  );

  ipcMain.handle(
    "compose:mark-read",
    async (
      _,
      { messageId, accountId, read }: { messageId: string; accountId: string; read: boolean },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        log.info({ messageId, read }, "[DEMO] Setting read");
        return { success: true, data: undefined };
      }

      try {
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(accountId);
        if (!client) {
          return { success: false, error: `No client for account ${accountId}` };
        }

        await client.setRead(messageId, read);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to mark message as read",
        };
      }
    },
  );
}
