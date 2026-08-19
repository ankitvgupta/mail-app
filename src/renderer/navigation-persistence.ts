import type { DashboardEmail, NavigationStateSnapshot } from "../shared/types";

type AccountIdentity = {
  id: string;
  isPrimary: boolean;
};

export type RestoredNavigationState = {
  currentSplitId: string | null;
  selectedEmailId: string | null;
  selectedThreadId: string | null;
  focusedThreadEmailId: string | null;
  viewMode: "split" | "full";
};

// These virtual splits are available without account-specific split data.
// Custom splits must be reset if the account they belonged to disappears.
export const ALWAYS_VISIBLE_SPLITS = new Set([
  "__priority__",
  "__other__",
  "__archive-ready__",
  "__sent__",
]);

/** Resolve the account view, preferring the newer full navigation snapshot. */
export function resolveInitialAccountId(
  accounts: AccountIdentity[],
  lastSelectedAccountId: string | null | undefined,
  navigationState: NavigationStateSnapshot | undefined,
): string | null {
  const persistedAccountId = navigationState ? navigationState.accountId : lastSelectedAccountId;

  if (persistedAccountId === null && accounts.length > 1) return null;
  if (
    typeof persistedAccountId === "string" &&
    accounts.some((account) => account.id === persistedAccountId)
  ) {
    return persistedAccountId;
  }

  return accounts.find((account) => account.isPrimary)?.id ?? accounts[0]?.id ?? null;
}

/**
 * Validate a persisted selection against the freshly loaded cache. If the
 * exact message disappeared but its thread remains, restore the newest message
 * in that thread. If the thread is gone, fall back to split view.
 */
export function sanitizeNavigationState(
  navigationState: NavigationStateSnapshot | undefined,
  accountId: string | null,
  emails: DashboardEmail[],
): RestoredNavigationState | null {
  if (!navigationState) return null;

  const accountEmails =
    accountId === null ? emails : emails.filter((email) => email.accountId === accountId);
  const emailsById = new Map(accountEmails.map((email) => [email.id, email]));

  let selectedEmail = navigationState.selectedEmailId
    ? emailsById.get(navigationState.selectedEmailId)
    : undefined;

  const desiredThreadId = navigationState.selectedThreadId ?? selectedEmail?.threadId ?? null;
  const threadEmails = desiredThreadId
    ? accountEmails.filter((email) => email.threadId === desiredThreadId)
    : [];

  if (!selectedEmail && threadEmails.length > 0) {
    selectedEmail = [...threadEmails].sort(
      (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime(),
    )[0];
  }

  const selectedThreadId =
    desiredThreadId && threadEmails.length > 0
      ? desiredThreadId
      : selectedEmail?.threadId
        ? selectedEmail.threadId
        : null;
  const selectedEmailId = selectedEmail?.id ?? null;

  const persistedFocus = navigationState.focusedThreadEmailId
    ? emailsById.get(navigationState.focusedThreadEmailId)
    : undefined;
  const focusedThreadEmailId =
    persistedFocus && persistedFocus.threadId === selectedThreadId
      ? persistedFocus.id
      : selectedEmailId;
  const currentSplitId =
    navigationState.currentSplitId === null ||
    ALWAYS_VISIBLE_SPLITS.has(navigationState.currentSplitId)
      ? navigationState.currentSplitId
      : "__priority__";

  return {
    currentSplitId,
    selectedEmailId,
    selectedThreadId,
    focusedThreadEmailId,
    viewMode: navigationState.viewMode === "full" && selectedThreadId ? "full" : "split",
  };
}
