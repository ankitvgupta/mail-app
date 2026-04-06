import { useMemo } from "react";
import { useAppStore, useThreadedEmails, type EmailThread } from "../store";
import type { InboxSplit } from "../../shared/types";
import { emailMatchesSplit } from "../utils/split-conditions";

function threadMatchesSplit(thread: EmailThread, split: InboxSplit): boolean {
  return emailMatchesSplit(thread.latestEmail, split);
}

interface TabProps {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}

function Tab({ active, onClick, count, children }: TabProps) {
  return (
    <button
      onClick={onClick}
      className={`
        px-3 py-2 text-sm font-medium whitespace-nowrap
        border-b-2 transition-colors focus:outline-none
        ${
          active
            ? "border-blue-500 dark:border-blue-400 text-blue-600 dark:text-blue-400"
            : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600"
        }
      `}
    >
      {children}
      {count !== undefined && (
        <span
          className={`ml-1.5 text-xs ${active ? "text-blue-500 dark:text-blue-400" : "text-gray-400"}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function SplitTabs() {
  const allSplits = useAppStore((state) => state.splits);
  const currentAccountId = useAppStore((state) => state.currentAccountId);
  const currentSplitId = useAppStore((state) => state.currentSplitId);
  const setCurrentSplitId = useAppStore((state) => state.setCurrentSplitId);
  const archiveReadyThreadIds = useAppStore((state) => state.archiveReadyThreadIds);
  const recentlyUnsnoozedThreadIds = useAppStore((state) => state.recentlyUnsnoozedThreadIds);
  const localDrafts = useAppStore((state) => state.localDrafts);
  const { threads, needsReply, done, snoozedCount } = useThreadedEmails();

  // Filter splits for current account
  const splits = useMemo(
    () => allSplits.filter((s) => s.accountId === currentAccountId),
    [allSplits, currentAccountId],
  );

  // Shared predicate: threads NOT matching any exclusive split (unless recently unsnoozed)
  const isNonExclusive = useMemo(() => {
    const exclusiveSplits = splits.filter((s) => s.exclusive);
    return (t: EmailThread) =>
      recentlyUnsnoozedThreadIds.has(t.threadId) ||
      !exclusiveSplits.some((s) => threadMatchesSplit(t, s));
  }, [splits, recentlyUnsnoozedThreadIds]);

  const archiveReadyCount = useMemo(
    () => threads.filter((t) => archiveReadyThreadIds.has(t.threadId) && isNonExclusive(t)).length,
    [threads, archiveReadyThreadIds, isNonExclusive],
  );

  // Count both local drafts (compose sessions) and AI-generated drafts (on emails)
  const emailDraftsCount = useMemo(
    () => threads.filter((t) => t.draft && t.draft.body).length,
    [threads],
  );
  const localDraftsCount = useMemo(
    () => localDrafts.filter((d) => !currentAccountId || d.accountId === currentAccountId).length,
    [localDrafts, currentAccountId],
  );
  const draftsCount = emailDraftsCount + localDraftsCount;

  // Calculate thread counts for each split
  const counts = useMemo(() => {
    const map = new Map<string | null, number>();

    const inboxCount = threads.filter(isNonExclusive).length;
    map.set(null, inboxCount); // "All" tab
    // "Priority" tab: only emails with a priority (needsReply + done)
    const priorityThreads = [...needsReply, ...done].filter(isNonExclusive);
    const priorityCount = priorityThreads.length;
    map.set("__priority__", priorityCount);
    // "Other" tab: everything in All minus Priority
    const priorityThreadIds = new Set(priorityThreads.map((t) => t.threadId));
    const otherCount = threads
      .filter(isNonExclusive)
      .filter((t) => !priorityThreadIds.has(t.threadId)).length;
    map.set("__other__", otherCount);

    for (const split of splits) {
      const matchingThreads = threads.filter((t) => threadMatchesSplit(t, split));
      map.set(split.id, matchingThreads.length);
    }

    return map;
  }, [threads, needsReply, done, splits, isNonExclusive]);

  // Sort splits by order
  const sortedSplits = useMemo(() => [...splits].sort((a, b) => a.order - b.order), [splits]);

  // Always show the tab bar — Priority, Other, Archive Ready always visible; All on the far right
  return (
    <div className="flex h-10 border-b border-gray-200 dark:border-gray-700 px-2 overflow-x-auto">
      {/* Primary tabs: Priority, Other */}
      <Tab
        active={currentSplitId === "__priority__"}
        onClick={() => setCurrentSplitId("__priority__")}
        count={counts.get("__priority__")}
      >
        Priority
      </Tab>
      <Tab
        active={currentSplitId === "__other__"}
        onClick={() => setCurrentSplitId("__other__")}
        count={counts.get("__other__")}
      >
        Other
      </Tab>

      {/* Middle tabs: Archive Ready, custom splits, conditional tabs */}
      <Tab
        active={currentSplitId === "__archive-ready__"}
        onClick={() => setCurrentSplitId("__archive-ready__")}
        count={archiveReadyCount}
      >
        <span className="inline-flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
            />
          </svg>
          Archive Ready
        </span>
      </Tab>

      {/* Custom splits */}
      {sortedSplits.map((split) => (
        <Tab
          key={split.id}
          active={currentSplitId === split.id}
          onClick={() => setCurrentSplitId(split.id)}
          count={counts.get(split.id)}
        >
          {split.icon && <span className="mr-1">{split.icon}</span>}
          {split.name}
        </Tab>
      ))}

      {/* Conditional virtual tabs */}
      {draftsCount > 0 && (
        <Tab
          active={currentSplitId === "__drafts__"}
          onClick={() => setCurrentSplitId("__drafts__")}
          count={draftsCount}
        >
          <span className="inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
            Drafts
          </span>
        </Tab>
      )}
      {snoozedCount > 0 && (
        <Tab
          active={currentSplitId === "__snoozed__"}
          onClick={() => setCurrentSplitId("__snoozed__")}
          count={snoozedCount}
        >
          <span className="inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            Snoozed
          </span>
        </Tab>
      )}

      {/* All tab on the far right */}
      <Tab
        active={currentSplitId === null}
        onClick={() => setCurrentSplitId(null)}
        count={counts.get(null)}
      >
        All
      </Tab>
    </div>
  );
}
