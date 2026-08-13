import { useAppStore } from "../store";
import type { DashboardEmail } from "../../shared/types";
import { trackEvent } from "../services/posthog";

/**
 * Shared batch action functions that read current state from the store.
 * Safe to call from event handlers, useCallback bodies, or keyboard shortcuts.
 *
 * In unified ("All Inboxes") mode the selected threads can span multiple
 * accounts. Each action below groups threads by their owning accountId and
 * fires one undo action per account, since the undo IPC path is per-account.
 */

// Group selected threads by their owning account. Looks for thread emails in
// both `emails` (inbox) and `sentEmails` (sent view) so threads visible in
// either context get acted on. Threads whose emails aren't in the store at all
// (e.g. user just optimistically archived them then selected, or a race
// removed them) are logged and skipped — better than silently dropping the
// user's action.
function groupSelectedByAccount(): Map<string, { threadIds: string[]; emails: DashboardEmail[] }> {
  const { selectedThreadIds, emails, sentEmails } = useAppStore.getState();
  const result = new Map<string, { threadIds: string[]; emails: DashboardEmail[] }>();
  for (const threadId of selectedThreadIds) {
    // Search inbox first, then sent — covers both __sent__ split selections
    // and normal inbox selections.
    let threadEmails = emails.filter((e) => e.threadId === threadId);
    if (threadEmails.length === 0) {
      threadEmails = sentEmails.filter((e) => e.threadId === threadId);
    }
    if (threadEmails.length === 0) {
      console.warn(
        "[useBatchActions] thread not found in emails or sentEmails, skipping",
        threadId,
      );
      continue;
    }
    // All emails in a thread belong to the same account.
    const accountId = threadEmails[0].accountId;
    if (!accountId) {
      console.warn("[useBatchActions] thread without accountId, skipping batch action", threadId);
      continue;
    }
    const entry = result.get(accountId) ?? { threadIds: [], emails: [] };
    entry.threadIds.push(threadId);
    entry.emails.push(...threadEmails);
    result.set(accountId, entry);
  }
  return result;
}

export function batchArchive() {
  const { selectedThreadIds, removeEmails, clearSelectedThreads, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  const grouped = groupSelectedByAccount();
  if (grouped.size === 0) return;

  // Optimistic UI: remove every selected email up front.
  const allEmailIds = Array.from(grouped.values()).flatMap((g) => g.emails.map((e) => e.id));
  removeEmails(allEmailIds);
  clearSelectedThreads();

  // One undo entry per account so the per-account undo IPC stays correct.
  let i = 0;
  for (const [accountId, group] of grouped) {
    addUndoAction({
      id: `archive-batch-${Date.now()}-${i++}`,
      type: "archive",
      threadCount: group.threadIds.length,
      accountId,
      emails: [...group.emails],
      scheduledAt: Date.now(),
      delayMs: 5000,
    });
  }
  trackEvent("email_archived", {
    thread_count: selectedThreadIds.size,
    source: "batch",
    account_count: grouped.size,
  });
}

export function batchTrash() {
  const { selectedThreadIds, removeEmails, clearSelectedThreads, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  const grouped = groupSelectedByAccount();
  if (grouped.size === 0) return;

  const allEmailIds = Array.from(grouped.values()).flatMap((g) => g.emails.map((e) => e.id));
  removeEmails(allEmailIds);
  clearSelectedThreads();

  let i = 0;
  for (const [accountId, group] of grouped) {
    addUndoAction({
      id: `trash-batch-${Date.now()}-${i++}`,
      type: "trash",
      threadCount: group.threadIds.length,
      accountId,
      emails: [...group.emails],
      scheduledAt: Date.now(),
      delayMs: 5000,
    });
  }
  trackEvent("email_trashed", {
    thread_count: selectedThreadIds.size,
    source: "batch",
    account_count: grouped.size,
  });
}

export function batchToggleStar() {
  const { selectedThreadIds, clearSelectedThreads, updateEmail, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  const grouped = groupSelectedByAccount();
  if (grouped.size === 0) return;

  // Star/unstar decision is global across the selection: if any selected
  // thread is unstarred, the action stars everything; otherwise it unstars.
  const allThreadEmails = Array.from(grouped.values()).flatMap((g) => g.emails);
  const threadStarred = new Map<string, boolean>();
  for (const email of allThreadEmails) {
    const cur = threadStarred.get(email.threadId) ?? false;
    threadStarred.set(email.threadId, cur || !!email.labelIds?.includes("STARRED"));
  }
  const anyUnstarred = Array.from(threadStarred.values()).some((s) => !s);

  let i = 0;
  for (const [accountId, group] of grouped) {
    const changedEmails: DashboardEmail[] = [];
    const previousLabels: Record<string, string[]> = {};

    for (const email of group.emails) {
      const currentLabels = email.labelIds || ["INBOX"];
      if (anyUnstarred) {
        if (!currentLabels.includes("STARRED")) {
          previousLabels[email.id] = [...currentLabels];
          updateEmail(email.id, { labelIds: [...currentLabels, "STARRED"] });
          changedEmails.push(email);
        }
      } else if (currentLabels.includes("STARRED")) {
        previousLabels[email.id] = [...currentLabels];
        updateEmail(email.id, {
          labelIds: currentLabels.filter((l: string) => l !== "STARRED"),
        });
        changedEmails.push(email);
      }
    }

    if (changedEmails.length === 0) continue;
    const actionType = anyUnstarred ? "star" : "unstar";
    addUndoAction({
      id: `${actionType}-batch-${Date.now()}-${i++}`,
      type: actionType,
      threadCount: group.threadIds.length,
      accountId,
      emails: changedEmails,
      scheduledAt: Date.now(),
      delayMs: 5000,
      previousLabels,
    });
  }

  clearSelectedThreads();
  trackEvent(anyUnstarred ? "email_starred" : "email_unstarred", {
    thread_count: selectedThreadIds.size,
    account_count: grouped.size,
  });
}

export function batchMarkUnread() {
  const { selectedThreadIds, clearSelectedThreads, updateEmail, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  const grouped = groupSelectedByAccount();
  if (grouped.size === 0) return;

  let i = 0;
  let totalChanged = 0;
  for (const [accountId, group] of grouped) {
    const changedEmails: DashboardEmail[] = [];
    const previousLabels: Record<string, string[]> = {};

    // Mark only the latest email of each thread as unread (matches Gmail UX).
    const emailsByThread = new Map<string, DashboardEmail[]>();
    for (const email of group.emails) {
      const arr = emailsByThread.get(email.threadId) ?? [];
      arr.push(email);
      emailsByThread.set(email.threadId, arr);
    }
    for (const threadEmails of emailsByThread.values()) {
      const latestEmail = threadEmails.reduce((a, b) =>
        new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b,
      );
      const currentLabels = latestEmail.labelIds || ["INBOX"];
      if (!currentLabels.includes("UNREAD")) {
        previousLabels[latestEmail.id] = [...currentLabels];
        updateEmail(latestEmail.id, { labelIds: [...currentLabels, "UNREAD"] });
        changedEmails.push(latestEmail);
      }
    }

    if (changedEmails.length === 0) continue;
    totalChanged += changedEmails.length;
    addUndoAction({
      id: `mark-unread-batch-${Date.now()}-${i++}`,
      type: "mark-unread",
      threadCount: changedEmails.length,
      accountId,
      emails: changedEmails,
      scheduledAt: Date.now(),
      delayMs: 5000,
      previousLabels,
    });
  }

  clearSelectedThreads();
  if (totalChanged > 0) {
    trackEvent("email_marked_unread", {
      thread_count: totalChanged,
      account_count: grouped.size,
    });
  }
}
