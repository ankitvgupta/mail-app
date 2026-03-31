import type { DashboardEmail } from "../../shared/types";
import { groupByThread, type EmailThread } from "../store";

/**
 * Merge local and remote search results, deduplicate by email ID,
 * and sort by date descending (most recent first).
 *
 * Shared between the rendered list (App.tsx) and keyboard navigation
 * (useKeyboardShortcuts.ts) so they always agree on order.
 */
export function mergeAndSortSearchResults(
  localResults: readonly DashboardEmail[],
  remoteResults: readonly DashboardEmail[],
): DashboardEmail[] {
  const seen = new Set<string>();
  const merged: DashboardEmail[] = [];
  for (const email of localResults) {
    if (!seen.has(email.id)) {
      seen.add(email.id);
      merged.push(email);
    }
  }
  for (const email of remoteResults) {
    if (!seen.has(email.id)) {
      seen.add(email.id);
      merged.push(email);
    }
  }
  // Parse dates once (Schwartzian transform) to avoid O(N log N) Date constructions
  const decorated = merged.map((email) => ({ email, ts: new Date(email.date).getTime() }));
  decorated.sort((a, b) => b.ts - a.ts);
  return decorated.map((d) => d.email);
}

/**
 * Merge, deduplicate, and group search results into threads.
 * Uses the same groupByThread logic as the main inbox view.
 */
export function mergeAndThreadSearchResults(
  localResults: readonly DashboardEmail[],
  remoteResults: readonly DashboardEmail[],
  userEmails?: Set<string>,
): EmailThread[] {
  const merged = mergeAndSortSearchResults(localResults, remoteResults);
  const threads = groupByThread(merged, userEmails);
  // Re-sort by latest email date (including sent) for search results.
  // groupByThread sorts by latestReceivedDate (for inbox), but search results
  // should sort by overall recency to match the displayed time.
  threads.sort((a, b) => new Date(b.latestEmail.date).getTime() - new Date(a.latestEmail.date).getTime());
  return threads;
}
