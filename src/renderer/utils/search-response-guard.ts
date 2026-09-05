import { useAppStore } from "../store";

/** Query text can recur after a cancellation or account switch. Bind every
 * completion (including errors and pagination cleanup) to its search session. */
export function createSearchResponseGuard(): () => boolean {
  const { activeSearchRequestId, activeSearchQuery, currentAccountId } = useAppStore.getState();
  return () => {
    const current = useAppStore.getState();
    return (
      activeSearchQuery !== null &&
      current.activeSearchRequestId === activeSearchRequestId &&
      current.activeSearchQuery === activeSearchQuery &&
      current.currentAccountId === currentAccountId
    );
  };
}
