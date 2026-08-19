// Resolve the owning account for each thread in a batch snooze.
//
// In the "All Inboxes" view there is no active account filter, so each selected
// thread can belong to a different account. We map every thread to its own
// account (from its latest email) so the snooze IPC and the undo/unsnooze flow
// target the correct account per thread, falling back to the triggering email's
// account when a thread's account can't be resolved.

export interface ThreadAccountLookup {
  threadId: string;
  accountId: string | undefined;
}

/**
 * Build a `threadId -> accountId` map for a batch snooze.
 *
 * @param threadIds          all thread IDs being snoozed
 * @param lookup             resolves a thread ID to its latest email's account
 * @param triggerThreadId    the thread whose snooze opened the menu
 * @param triggerAccountId   that thread's account (already known)
 * @param fallbackAccountId  account to use when a thread can't be resolved
 */
export function buildSnoozeThreadAccounts(
  threadIds: string[],
  lookup: (threadId: string) => ThreadAccountLookup | undefined,
  triggerThreadId: string,
  triggerAccountId: string,
  fallbackAccountId: string,
): Record<string, string> {
  const map: Record<string, string> = {
    [triggerThreadId]: triggerAccountId || fallbackAccountId,
  };

  for (const threadId of threadIds) {
    if (map[threadId]) continue;
    const resolved = lookup(threadId)?.accountId ?? fallbackAccountId;
    if (resolved) map[threadId] = resolved;
  }

  return map;
}
