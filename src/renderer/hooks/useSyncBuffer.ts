/**
 * Buffers sync-driven store updates (new emails, removed emails, label changes,
 * analysis results) and flushes them as a single atomic Zustand setState call
 * during browser idle time.
 *
 * Why: Background sync fires IPC events every ~30s that directly mutate the
 * emails array, triggering full useThreadedEmails → useSplitFilteredThreads
 * recomputation. When this coincides with rapid j/k navigation the re-render
 * competes with the navigation update, producing perceptible lag.
 *
 * By buffering and flushing atomically during idle time — and holding off while
 * the user is actively navigating — we guarantee zero sync-related interruption
 * to inbox keyboard navigation.
 */

import { useAppStore } from "../store";
import { applyOptimisticReads } from "../optimistic-reads";
import type { DashboardEmail } from "../../shared/types";

// --- Pending update queues ---

let pendingAdds: DashboardEmail[] = [];
let pendingRemoveIds: string[] = [];
let pendingUpdates: Map<string, Partial<DashboardEmail>> = new Map();
let flushHandle: number | null = null;
// Track which timer API created flushHandle so we cancel with the right one.
let flushIsTimeout = false;

/**
 * Remove pending label updates for specific emails so that an optimistic
 * label change (e.g. mark-as-read) isn't overwritten by a stale buffered
 * sync update that hasn't flushed yet.
 */
export function clearPendingLabelUpdates(emailIds: Set<string>): void {
  for (const id of emailIds) {
    const pending = pendingUpdates.get(id);
    if (pending?.labelIds !== undefined) {
      delete pending.labelIds;
      if (Object.keys(pending).length === 0) {
        pendingUpdates.delete(id);
      }
    }
  }
  // Also scrub adds — re-emitted emails in pendingAdds could carry stale labels.
  // Remove UNREAD from their labelIds rather than clearing entirely, so other
  // labels (INBOX, CATEGORY_*, etc.) are preserved.
  for (const add of pendingAdds) {
    if (emailIds.has(add.id) && add.labelIds?.includes("UNREAD")) {
      add.labelIds = add.labelIds.filter((l) => l !== "UNREAD");
    }
  }
}

// --- Navigation hold-off ---

let lastNavigationTs = 0;
const NAVIGATION_COOLDOWN_MS = 150;

/** Cancel the current scheduled flush (if any), using the correct API. */
function cancelScheduledFlush(): void {
  if (flushHandle === null) return;
  if (flushIsTimeout) {
    clearTimeout(flushHandle);
  } else {
    cancelIdleCallback(flushHandle);
  }
  flushHandle = null;
}

/**
 * Call this on every j/k (or arrow) keypress so that the buffer flush is
 * deferred until the user stops navigating.
 */
export function markNavigationActive(): void {
  lastNavigationTs = Date.now();

  // If a flush is already scheduled, cancel and reschedule so we don't
  // flush mid-navigation.
  if (flushHandle !== null) {
    cancelScheduledFlush();
    scheduleFlush();
  }
}

// --- Buffer API (called from IPC event listeners) ---

export function bufferAddEmails(emails: DashboardEmail[]): void {
  for (const e of emails) pendingAdds.push(e);
  scheduleFlush();
}

export function bufferRemoveEmails(emailIds: string[]): void {
  for (const id of emailIds) pendingRemoveIds.push(id);
  scheduleFlush();
}

/**
 * Buffer one or more field-level updates for emails already in the store.
 * Merges updates for the same emailId so rapid-fire label changes (common
 * during incremental sync) collapse into a single write.
 */
export function bufferUpdateEmails(
  updates: { emailId: string; changes: Partial<DashboardEmail> }[],
): void {
  for (const { emailId, changes } of updates) {
    const existing = pendingUpdates.get(emailId);
    if (existing) {
      Object.assign(existing, changes);
    } else {
      pendingUpdates.set(emailId, { ...changes });
    }
  }
  scheduleFlush();
}

/**
 * Cancel any pending flush and drain all queues. Call this on teardown
 * (e.g. when the sync-listener useEffect unmounts) to prevent ghost flushes.
 */
export function cancelPendingFlush(): void {
  cancelScheduledFlush();
  pendingAdds = [];
  pendingRemoveIds = [];
  pendingUpdates = new Map();
}

// --- Flush logic ---

function hasPending(): boolean {
  return pendingAdds.length > 0 || pendingRemoveIds.length > 0 || pendingUpdates.size > 0;
}

function flush(): void {
  flushHandle = null;

  // If user is still navigating, defer.
  if (Date.now() - lastNavigationTs < NAVIGATION_COOLDOWN_MS) {
    if (hasPending()) scheduleFlush();
    return;
  }

  if (!hasPending()) return;

  // Drain queues into local variables and reset.
  const adds = pendingAdds;
  const removeIds = pendingRemoveIds;
  const updates = pendingUpdates;

  pendingAdds = [];
  pendingRemoveIds = [];
  pendingUpdates = new Map();

  // Single atomic setState — one re-render for everything.
  useAppStore.setState((state) => {
    let emails = state.emails;

    // Track whether the currently viewed email was removed by sync
    let selectedEmailRemoved = false;

    // 1. Removals
    if (removeIds.length > 0) {
      const idsToRemove = new Set(removeIds);
      if (state.selectedEmailId && idsToRemove.has(state.selectedEmailId)) {
        selectedEmailRemoved = true;
      }
      emails = emails.filter((e) => !idsToRemove.has(e.id));
    }

    // 2. In-place updates (label changes, analysis, etc.)
    if (updates.size > 0) {
      emails = emails.map((email) => {
        const changes = updates.get(email.id);
        return changes ? { ...email, ...changes } : email;
      });
    }

    // 3. Additions — deduplicate against current store AND pending removals
    // (emails the user archived/trashed optimistically but haven't been
    // confirmed by the server yet). Without this check, a sync-buffered add
    // could resurrect an email the user just removed.
    if (adds.length > 0) {
      const existingIds = new Set(emails.map((e) => e.id));
      const pendingRemovalIds = new Set(
        Array.from(state.pendingRemovals.values()).flatMap((arr) => arr.map((e) => e.id)),
      );
      // Also suppress emails pending in the undo action queue (archive/trash).
      // These have been optimistically removed from the store but the API calls
      // may not have completed yet — without this, sync resurrects them.
      for (const action of state.undoActionQueue) {
        if (action.type === "archive" || action.type === "trash" || action.type === "block") {
          for (const e of action.emails) {
            pendingRemovalIds.add(e.id);
          }
        }
      }
      // Also suppress emails being removed in this same flush batch.
      // When the archive IPC handler sends sync:emails-removed AND the
      // incremental sync sends sync:new-emails for the same email in the
      // same flush window, the remove fires first (step 1) but the add
      // would re-add it as "brand new" since it's no longer in the store.
      for (const id of removeIds) {
        pendingRemovalIds.add(id);
      }
      // Separate brand-new emails from re-emits (e.g. triage adding analysis
      // to emails already delivered via progressive loading).
      const brandNew: DashboardEmail[] = [];
      const reEmitUpdates = new Map<string, Partial<DashboardEmail>>();
      const seen = new Set<string>();

      for (const e of adds) {
        if (pendingRemovalIds.has(e.id) || seen.has(e.id)) continue;
        seen.add(e.id);

        if (existingIds.has(e.id)) {
          // Merge meaningful field updates (analysis, draft) for emails
          // already in the store — avoids dropping triage analysis.
          // NOTE: labelIds is deliberately NOT merged here because sync
          // re-emissions carry stale server labels that could overwrite
          // optimistic local updates (e.g. mark-as-read removing UNREAD).
          // Label updates go through bufferUpdateEmails instead.
          const changes: Partial<DashboardEmail> = {};
          if (e.analysis !== undefined) changes.analysis = e.analysis;
          if (e.draft !== undefined) changes.draft = e.draft;
          if (Object.keys(changes).length > 0) {
            reEmitUpdates.set(e.id, changes);
          }
        } else {
          brandNew.push(e);
          existingIds.add(e.id);
        }
      }

      // Apply in-place merges for re-emitted emails
      if (reEmitUpdates.size > 0) {
        emails = emails.map((email) => {
          const changes = reEmitUpdates.get(email.id);
          return changes ? { ...email, ...changes } : email;
        });
      }

      if (brandNew.length > 0) {
        emails = [...emails, ...brandNew];
      }
    }

    // If sync removed the email the user was viewing in full mode and it
    // wasn't re-added in the same flush (e.g. label change that triggers
    // both remove + add for the same ID), reset to split view so the inbox
    // list becomes visible again.
    // Apply optimistic mark-as-read guard — ensures no stale UNREAD labels
    // from sync events can revert emails the user just opened.
    emails = applyOptimisticReads(emails);

    if (selectedEmailRemoved && state.viewMode === "full") {
      const stillExists = emails.some((e) => e.id === state.selectedEmailId);
      if (!stillExists) {
        return {
          emails,
          viewMode: "split" as const,
          selectedEmailId: null,
          selectedThreadId: null,
        };
      }
    }

    return { emails };
  });
}

function scheduleFlush(): void {
  if (flushHandle !== null) return; // Already scheduled

  const msSinceNav = Date.now() - lastNavigationTs;

  if (msSinceNav < NAVIGATION_COOLDOWN_MS) {
    // User is actively navigating — wait until cooldown expires, then retry.
    const delay = NAVIGATION_COOLDOWN_MS - msSinceNav;
    flushHandle = window.setTimeout(() => {
      flushHandle = null;
      if (hasPending()) scheduleFlush();
    }, delay);
    flushIsTimeout = true;
  } else {
    // Idle-schedule the flush. The 300ms timeout is a safety cap — in practice
    // the callback fires much sooner during true idle time.
    flushHandle = requestIdleCallback(() => flush(), { timeout: 300 });
    flushIsTimeout = false;
  }
}
