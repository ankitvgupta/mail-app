/**
 * Optimistic mark-as-read guard.
 *
 * Tracks email IDs that were optimistically marked as read but haven't been
 * confirmed by a sync round-trip yet. Any store mutation that writes emails
 * (setEmails, addEmails, sync buffer flush) must call applyOptimisticReads()
 * so stale data from the DB or sync events can't revert the optimistic update.
 *
 * Lives in its own module to avoid circular dependencies between store/ and hooks/.
 */

import type { DashboardEmail } from "../shared/types";

const optimisticReadIds = new Set<string>();

/** Strip UNREAD from emails that were optimistically marked as read. */
export function applyOptimisticReads(emails: DashboardEmail[]): DashboardEmail[] {
  if (optimisticReadIds.size === 0) return emails;
  let result = emails;
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    if (optimisticReadIds.has(email.id) && email.labelIds?.includes("UNREAD")) {
      if (result === emails) result = emails.slice();
      result[i] = { ...email, labelIds: email.labelIds.filter((label) => label !== "UNREAD") };
    }
  }
  return result;
}

/** Register email IDs as optimistically read. Persists until explicitly
 *  confirmed via confirmOptimisticReads (when sync delivers updated labels). */
export function addOptimisticReads(ids: Iterable<string>): void {
  for (const id of ids) optimisticReadIds.add(id);
}

/** Remove confirmed-read IDs from the optimistic set (called when sync
 *  delivers label updates that no longer include UNREAD). */
export function confirmOptimisticReads(ids: Iterable<string>): void {
  for (const id of ids) optimisticReadIds.delete(id);
}
