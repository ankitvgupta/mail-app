import { useAppStore } from "../store";
import type { DashboardEmail } from "../../shared/types";
import { trackEvent } from "../services/posthog";

/**
 * Shared batch action functions that read current state from the store.
 * Safe to call from event handlers, useCallback bodies, or keyboard shortcuts.
 */

export function batchArchive() {
  const { selectedThreadIds, emails, removeEmails, clearSelectedThreads, addUndoAction, currentAccountId } = useAppStore.getState();
  const effectiveAccountId = currentAccountId ?? emails.find(e => selectedThreadIds.has(e.threadId))?.accountId ?? null;
  if (!effectiveAccountId || selectedThreadIds.size === 0) return;

  const threadIds = Array.from(selectedThreadIds);
  const allEmailIds: string[] = [];
  const emailsByThread = new Map<string, DashboardEmail[]>();
  for (const threadId of threadIds) {
    const threadEmails = emails.filter((e) => e.threadId === threadId);
    emailsByThread.set(threadId, threadEmails);
    for (const email of threadEmails) {
      allEmailIds.push(email.id);
    }
  }

  // Optimistic UI: remove all emails from selected threads
  const allEmails = threadIds.flatMap(tid => emailsByThread.get(tid) || []);
  removeEmails(allEmailIds);
  clearSelectedThreads();

  // Queue a single undo action for all threads
  addUndoAction({
    id: `archive-batch-${Date.now()}`,
    type: "archive",
    threadCount: threadIds.length,
    accountId: effectiveAccountId,
    emails: [...allEmails],
    scheduledAt: Date.now(),
    delayMs: 5000,
  });
  trackEvent("email_archived", { thread_count: threadIds.length, source: "batch" });
}

export function batchTrash() {
  const { selectedThreadIds, emails, removeEmails, clearSelectedThreads, addUndoAction, currentAccountId } = useAppStore.getState();
  const effectiveAccountId = currentAccountId ?? emails.find(e => selectedThreadIds.has(e.threadId))?.accountId ?? null;
  if (!effectiveAccountId || selectedThreadIds.size === 0) return;

  const threadIds = Array.from(selectedThreadIds);
  const allEmailIds: string[] = [];
  const emailsByThread = new Map<string, DashboardEmail[]>();
  for (const threadId of threadIds) {
    const threadEmails = emails.filter((e) => e.threadId === threadId);
    emailsByThread.set(threadId, threadEmails);
    for (const email of threadEmails) {
      allEmailIds.push(email.id);
    }
  }

  const allEmails = threadIds.flatMap(tid => emailsByThread.get(tid) || []);
  removeEmails(allEmailIds);
  clearSelectedThreads();

  // Queue a single undo action for all threads
  addUndoAction({
    id: `trash-batch-${Date.now()}`,
    type: "trash",
    threadCount: threadIds.length,
    accountId: effectiveAccountId,
    emails: [...allEmails],
    scheduledAt: Date.now(),
    delayMs: 5000,
  });
  trackEvent("email_trashed", { thread_count: threadIds.length, source: "batch" });
}

export function batchToggleStar() {
  const { selectedThreadIds, emails, clearSelectedThreads, updateEmail, addUndoAction, currentAccountId } = useAppStore.getState();
  const effectiveAccountId = currentAccountId ?? emails.find(e => selectedThreadIds.has(e.threadId))?.accountId ?? null;
  if (!effectiveAccountId || selectedThreadIds.size === 0) return;

  // Group emails by thread for the selected threads
  const selectedThreadEmails: Array<{ threadId: string; emails: typeof emails }> = [];
  for (const threadId of selectedThreadIds) {
    const threadEmails = emails.filter((e) => e.threadId === threadId);
    selectedThreadEmails.push({ threadId, emails: threadEmails });
  }

  // If any thread is unstarred, star all; otherwise unstar all
  const anyUnstarred = selectedThreadEmails.some(
    (t) => !t.emails.some((e) => e.labelIds?.includes("STARRED"))
  );

  const changedEmails: DashboardEmail[] = [];
  const previousLabels: Record<string, string[]> = {};

  for (const thread of selectedThreadEmails) {
    if (anyUnstarred) {
      for (const email of thread.emails) {
        const currentLabels = email.labelIds || ["INBOX"];
        if (!currentLabels.includes("STARRED")) {
          previousLabels[email.id] = [...currentLabels];
          updateEmail(email.id, { labelIds: [...currentLabels, "STARRED"] });
          changedEmails.push(email);
        }
      }
    } else {
      const starredEmails = thread.emails.filter((e) => e.labelIds?.includes("STARRED"));
      for (const email of starredEmails) {
        const currentLabels = email.labelIds || [];
        previousLabels[email.id] = [...currentLabels];
        const newLabels = currentLabels.filter((l: string) => l !== "STARRED");
        updateEmail(email.id, { labelIds: newLabels });
        changedEmails.push(email);
      }
    }
  }

  clearSelectedThreads();

  if (changedEmails.length > 0) {
    const actionType = anyUnstarred ? "star" : "unstar";
    addUndoAction({
      id: `${actionType}-batch-${Date.now()}`,
      type: actionType,
      threadCount: selectedThreadIds.size,
      accountId: effectiveAccountId,
      emails: changedEmails,
      scheduledAt: Date.now(),
      delayMs: 5000,
      previousLabels,
    });
    const changedThreadCount = new Set(changedEmails.map(e => e.threadId)).size;
    trackEvent(anyUnstarred ? "email_starred" : "email_unstarred", { thread_count: changedThreadCount });
  }
}

export function batchMarkUnread() {
  const { selectedThreadIds, emails, clearSelectedThreads, updateEmail, addUndoAction, currentAccountId } = useAppStore.getState();
  const effectiveAccountId = currentAccountId ?? emails.find(e => selectedThreadIds.has(e.threadId))?.accountId ?? null;
  if (!effectiveAccountId || selectedThreadIds.size === 0) return;

  const changedEmails: DashboardEmail[] = [];
  const previousLabels: Record<string, string[]> = {};

  for (const threadId of selectedThreadIds) {
    const threadEmails = emails.filter((e) => e.threadId === threadId);
    if (threadEmails.length === 0) continue;
    const latestEmail = threadEmails.reduce((a, b) =>
      new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b
    );
    const currentLabels = latestEmail.labelIds || ["INBOX"];
    // Only mark emails that aren't already unread
    if (!currentLabels.includes("UNREAD")) {
      previousLabels[latestEmail.id] = [...currentLabels];
      updateEmail(latestEmail.id, { labelIds: [...currentLabels, "UNREAD"] });
      changedEmails.push(latestEmail);
    }
  }

  clearSelectedThreads();

  if (changedEmails.length > 0) {
    addUndoAction({
      id: `mark-unread-batch-${Date.now()}`,
      type: "mark-unread",
      threadCount: changedEmails.length,
      accountId: effectiveAccountId,
      emails: changedEmails,
      scheduledAt: Date.now(),
      delayMs: 5000,
      previousLabels,
    });
    trackEvent("email_marked_unread", { thread_count: new Set(changedEmails.map(e => e.threadId)).size });
  }
}
