import { useEffect, useRef, useCallback, useMemo } from "react";
import type { InboxDensity, SnoozedEmail, DashboardEmail, LocalDraft } from "../../shared/types";
import { useAppStore, useSplitFilteredThreads, type EmailThread } from "../store";
import { EmailRow } from "./EmailRow";
import { DraftRow } from "./DraftRow";
import { BatchActionBar } from "./BatchActionBar";
import { SplitTabs } from "./SplitTabs";
import {
  batchArchive,
  batchTrash,
  batchMarkUnread,
  batchToggleStar,
} from "../hooks/useBatchActions";
import { draftBodyToHtml } from "../../shared/draft-utils";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Check if bodyHtml already contains rich formatting tags (from TipTap or draftBodyToHtml).
 *  If so, use it directly instead of re-converting from bodyText. */
function hasRichFormatting(html: string): boolean {
  return /<(p|div|br|strong|em|ol|ul|li)\b/i.test(html);
}

const densityOrder: InboxDensity[] = ["default", "compact"];
const densityLabels: Record<InboxDensity, string> = {
  default: "Default",
  compact: "Compact",
};

export function EmailList() {
  const {
    selectedEmailId: _selectedEmailId,
    setSelectedEmailId,
    setSelectedThreadId,
    setViewMode,
    isLoading,
    prefetchProgress,
    syncProgress,
    inboxDensity,
    setInboxDensity,
    snoozedThreads,
    setSnoozedThreads,
    currentAccountId,
    selectedThreadIds,
    toggleThreadSelected,
    setThreadsSelected,
    clearSelectedThreads,
    selectAllThreads,
    currentSplitId,
    setCurrentSplitId,
    setArchiveReadyThreads,
    removeEmails,
    addUndoAction,
    selectedDraftId,
    setSelectedDraftId,
    removeRecentlyUnsnoozedThread,
    markThreadAsRead,
  } = useAppStore();
  const openCompose = useAppStore((s) => s.openCompose);
  const allLocalDrafts = useAppStore((s) => s.localDrafts);
  const unsnoozedReturnTimes = useAppStore((s) => s.unsnoozedReturnTimes);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const { threads } = useSplitFilteredThreads();

  const isArchiveReadyView = currentSplitId === "__archive-ready__";
  const isDraftsView = currentSplitId === "__drafts__";
  const isSnoozedView = currentSplitId === "__snoozed__";
  const _isPriorityView = currentSplitId === "__priority__";
  const isSentView = currentSplitId === "__sent__";

  // Filter local drafts for the current account
  const localDrafts = useMemo(
    () => allLocalDrafts.filter((d) => !currentAccountId || d.accountId === currentAccountId),
    [allLocalDrafts, currentAccountId],
  );

  // Threads with AI-generated drafts (for the Drafts tab).
  // Filter to drafts with body content — excludes placeholder shells still being generated.
  const threadsWithDrafts = useMemo(
    () => (isDraftsView ? threads.filter((t) => t.draft && t.draft.body) : []),
    [threads, isDraftsView],
  );

  const handleDraftClick = useCallback(
    (draft: LocalDraft) => {
      const restoredDraft = {
        bodyHtml: hasRichFormatting(draft.bodyHtml)
          ? draft.bodyHtml
          : draftBodyToHtml(draft.bodyText || draft.bodyHtml),
        bodyText: draft.bodyText ?? "",
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        localDraftId: draft.id,
      };

      // Forward drafts belong inline in their thread
      if (draft.isForward && draft.inReplyTo) {
        setSelectedDraftId(null);
        setSelectedEmailId(draft.inReplyTo);
        setSelectedThreadId(draft.threadId ?? null);
        openCompose("forward", draft.inReplyTo, restoredDraft);
      } else {
        setSelectedDraftId(draft.id);
        setSelectedEmailId(null);
        setSelectedThreadId(null);
        openCompose("new", undefined, restoredDraft);
      }
      setViewMode("full");
    },
    [openCompose, setSelectedEmailId, setSelectedThreadId, setSelectedDraftId, setViewMode],
  );

  // Load snoozed emails on mount / account switch.
  // Also processes any snoozes that expired while the app was closed.
  useEffect(() => {
    if (!currentAccountId) return;
    window.api.snooze
      .list(currentAccountId)
      .then((response: { success: boolean; data?: SnoozedEmail[]; expired?: SnoozedEmail[] }) => {
        if (response.success && response.data) {
          setSnoozedThreads(response.data);
        }
        // Process snoozes that expired while the app was closed —
        // adds them to recentlyUnsnoozedThreadIds so they sort correctly
        if (response.expired && response.expired.length > 0) {
          const store = useAppStore.getState();
          for (const email of response.expired) {
            store.handleThreadUnsnoozed(email.threadId, email.snoozeUntil);
          }
        }
      });
  }, [currentAccountId, setSnoozedThreads]);

  // Listen for snooze events from main process, filtered by current account.
  // Uses useAppStore.getState() inside callbacks so we don't need action refs
  // in the deps array — this prevents listener re-registration races.
  const currentAccountRef = useRef(currentAccountId);
  currentAccountRef.current = currentAccountId;

  useEffect(() => {
    window.api.snooze.onUnsnoozed((data: { emails: SnoozedEmail[] }) => {
      for (const email of data.emails) {
        if (email.accountId === currentAccountRef.current) {
          useAppStore.getState().handleThreadUnsnoozed(email.threadId, email.snoozeUntil);
        }
      }
    });
    window.api.snooze.onSnoozed((data: { snoozedEmail: SnoozedEmail }) => {
      if (data.snoozedEmail.accountId === currentAccountRef.current) {
        useAppStore.getState().addSnoozedThread(data.snoozedEmail);
      }
    });
    window.api.snooze.onManuallyUnsnoozed(
      (data: { threadId: string; accountId: string; snoozeUntil: number }) => {
        if (data.accountId === currentAccountRef.current) {
          useAppStore.getState().handleThreadUnsnoozed(data.threadId, data.snoozeUntil);
        }
      },
    );
    return () => {
      window.api.snooze.removeAllListeners();
    };
  }, []);

  // Load archive-ready threads on mount / account switch
  useEffect(() => {
    if (!currentAccountId) return;
    window.api.archiveReady
      .getThreads(currentAccountId)
      .then((result: { success: boolean; data?: Array<{ threadId: string; reason: string }> }) => {
        if (result.success && result.data) {
          const items = result.data.map((t: { threadId: string; reason: string }) => ({
            threadId: t.threadId,
            reason: t.reason,
          }));
          setArchiveReadyThreads(items);
        }
      });
  }, [currentAccountId, setArchiveReadyThreads]);

  // Listen for new archive-ready results from background prefetch
  const currentAccountRef2 = useRef(currentAccountId);
  currentAccountRef2.current = currentAccountId;

  useEffect(() => {
    window.api.archiveReady.onResult(
      (data: { threadId: string; accountId: string; isReady: boolean; reason: string }) => {
        if (data.accountId !== currentAccountRef2.current) return;
        if (data.isReady) {
          // Add single thread to the set
          useAppStore.setState((state) => {
            const newIds = new Set(state.archiveReadyThreadIds);
            newIds.add(data.threadId);
            const newReasons = new Map(state.archiveReadyReasons);
            newReasons.set(data.threadId, data.reason);
            return { archiveReadyThreadIds: newIds, archiveReadyReasons: newReasons };
          });
        } else {
          // Remove thread from archive-ready (new activity invalidated it)
          useAppStore.setState((state) => {
            if (!state.archiveReadyThreadIds.has(data.threadId)) return state;
            const newIds = new Set(state.archiveReadyThreadIds);
            newIds.delete(data.threadId);
            const newReasons = new Map(state.archiveReadyReasons);
            newReasons.delete(data.threadId);
            return { archiveReadyThreadIds: newIds, archiveReadyReasons: newReasons };
          });
        }
      },
    );

    return () => {
      window.api.archiveReady.removeAllListeners();
    };
  }, []);

  // Expire recently-replied grace periods.
  // When a thread is added to recentlyRepliedThreadIds, schedule its removal
  // after 3 minutes so the thread naturally moves to its correct category.
  const recentlyRepliedThreadIds = useAppStore((s) => s.recentlyRepliedThreadIds);
  const removeRecentlyRepliedThread = useAppStore((s) => s.removeRecentlyRepliedThread);
  useEffect(() => {
    if (recentlyRepliedThreadIds.size === 0) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const now = Date.now();
    const GRACE_MS = 3 * 60 * 1000;

    for (const [threadId, repliedAt] of recentlyRepliedThreadIds) {
      const remaining = Math.max(0, GRACE_MS - (now - repliedAt));
      timers.push(setTimeout(() => removeRecentlyRepliedThread(threadId), remaining));
    }

    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [recentlyRepliedThreadIds]);

  const handleArchiveAll = useCallback(() => {
    if (!currentAccountId || threads.length === 0) return;

    const archiveReadyThreadIds = threads.map((t) => t.threadId);
    const allEmailIds: string[] = [];
    const allEmails: DashboardEmail[] = [];
    const { emails: currentEmails } = useAppStore.getState();
    for (const thread of threads) {
      const threadEmails = currentEmails.filter((e) => e.threadId === thread.threadId);
      for (const email of threadEmails) {
        allEmailIds.push(email.id);
        allEmails.push(email);
      }
    }

    removeEmails(allEmailIds);
    setCurrentSplitId("__priority__");

    addUndoAction({
      id: `archive-all-${Date.now()}`,
      type: "archive",
      threadCount: threads.length,
      accountId: currentAccountId,
      emails: allEmails,
      scheduledAt: Date.now(),
      delayMs: 5000,
      archiveReadyThreadIds,
    });
  }, [currentAccountId, threads, removeEmails, setCurrentSplitId, addUndoAction]);

  const currentProgress = currentAccountId ? syncProgress[currentAccountId] : null;
  const isInitialSyncing = currentProgress && currentProgress.fetched < currentProgress.total;

  const isPrefetching = prefetchProgress.status === "running";
  const isAnalyzingTask = isPrefetching && prefetchProgress.currentTask?.type === "analysis";
  const agentDrafts = prefetchProgress.agentDrafts;
  const hasActiveAgentDrafts = agentDrafts && (agentDrafts.running > 0 || agentDrafts.queued > 0);

  // Ref for the list container to enable scrolling
  const listRef = useRef<HTMLDivElement>(null);

  const isMultiSelectActive = selectedThreadIds.size > 0;

  // Keep visible threads in a ref so getThreadRange always reads the latest list
  // without appearing in the useCallback deps. This prevents handleThreadClick
  // from getting a new reference when threads change, which matters because
  // the EmailRow memo comparator intentionally skips onClick.
  // In drafts view, only AI-draft threads are visible — use that subset for range selection.
  const visibleThreads = isDraftsView ? threadsWithDrafts : threads;
  const threadsRef = useRef(visibleThreads);
  useEffect(() => {
    threadsRef.current = visibleThreads;
  });

  // Shift+click range selection helper — stable ref avoids stale closure
  const getThreadRange = useCallback((fromId: string, toId: string): string[] => {
    const ts = threadsRef.current;
    const fromIndex = ts.findIndex((t) => t.threadId === fromId);
    const toIndex = ts.findIndex((t) => t.threadId === toId);
    if (fromIndex === -1 || toIndex === -1) return [toId];
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    return ts.slice(start, end + 1).map((t) => t.threadId);
  }, []);

  const handleThreadClick = useCallback(
    (thread: EmailThread, e: React.MouseEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isMeta) {
        toggleThreadSelected(thread.threadId);
        return;
      }

      if (isShift) {
        const {
          lastSelectedThreadId: anchor_,
          selectedThreadId: currentThreadId,
          selectedThreadIds: currentSelected,
        } = useAppStore.getState();
        const anchor = anchor_ || currentThreadId;
        if (anchor) {
          const range = getThreadRange(anchor, thread.threadId);
          const merged = new Set([...currentSelected, ...range]);
          setThreadsSelected(Array.from(merged));
          useAppStore.getState().setLastSelectedThreadId(thread.threadId);
        } else {
          toggleThreadSelected(thread.threadId);
        }
        return;
      }

      if (useAppStore.getState().selectedThreadIds.size > 0) {
        clearSelectedThreads();
      }
      setSelectedDraftId(null);
      setSelectedThreadId(thread.threadId);
      setSelectedEmailId(thread.latestEmail.id);
      markThreadAsRead(thread.threadId);
      setViewMode("full");
      removeRecentlyUnsnoozedThread(thread.threadId);
    },
    [
      toggleThreadSelected,
      getThreadRange,
      setThreadsSelected,
      clearSelectedThreads,
      setSelectedThreadId,
      setSelectedEmailId,
      setViewMode,
      removeRecentlyUnsnoozedThread,
      markThreadAsRead,
    ],
  );

  const handleCheckboxToggle = useCallback(
    (threadId: string) => {
      toggleThreadSelected(threadId);
    },
    [toggleThreadSelected],
  );

  // Row height depends on density
  const rowHeight = inboxDensity === "compact" ? 32 : 40;

  // Build a flat items array for the virtualizer: drafts at top + thread items
  type ListItem = { type: "draft"; draft: LocalDraft } | { type: "thread"; thread: EmailThread };

  const items = useMemo((): ListItem[] => {
    if (isDraftsView) return []; // Drafts view is non-virtualized
    const result: ListItem[] = [];
    // Drafts at top (except in archive-ready and sent views)
    if (localDrafts.length > 0 && !isArchiveReadyView && !isSentView) {
      const draftsToShow = isSnoozedView
        ? localDrafts.filter((d) => d.threadId && snoozedThreads.has(d.threadId))
        : localDrafts;
      for (const draft of draftsToShow) {
        result.push({ type: "draft", draft });
      }
    }
    for (const thread of threads) {
      result.push({ type: "thread", thread });
    }
    return result;
  }, [
    threads,
    localDrafts,
    isDraftsView,
    isArchiveReadyView,
    isSentView,
    isSnoozedView,
    snoozedThreads,
  ]);

  // Calculate initial scroll offset so the virtualizer renders the correct
  // rows on the very first frame (avoids a flash + re-render on mount).
  const initialSelectedIdx = useMemo(() => {
    if (!selectedThreadId) return -1;
    return items.findIndex(
      (item) => item.type === "thread" && item.thread.threadId === selectedThreadId,
    );
  }, []); // intentionally empty — only compute once on mount for initialOffset.
  // On first render items may be empty (sync still loading), so initialOffset
  // becomes undefined and the list starts at top. The effect-based scroll
  // below handles all subsequent selection changes.

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowHeight,
    overscan: 20,
    initialOffset:
      initialSelectedIdx > 0 ? Math.max(0, initialSelectedIdx * rowHeight - 300) : undefined,
  });

  // Scroll selected thread into view when selection changes (not on mount —
  // initialOffset handles that). items and virtualizer are read from the closure
  // and are always fresh for the render where selectedThreadId changed.
  useEffect(() => {
    if (!selectedThreadId) return;
    const idx = items.findIndex(
      (item) => item.type === "thread" && item.thread.threadId === selectedThreadId,
    );
    if (idx === -1) return;
    // align: "auto" is a no-op when the item is already visible, and scrolls
    // minimally when it's not. This avoids the overscan-inclusive range bug
    // where virtualizer.range includes rendered-but-not-visible overscan rows.
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedThreadId]);

  // Drafts view is non-virtualized, so the virtualizer scroll-to above is a no-op.
  // Use native scrollIntoView for j/k navigation of AI-draft threads.
  useEffect(() => {
    if (!isDraftsView || !selectedThreadId) return;
    const el = listRef.current?.querySelector(`[data-thread-id="${selectedThreadId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedThreadId, isDraftsView]);

  const cycleDensity = () => {
    const currentIndex = densityOrder.indexOf(inboxDensity);
    const nextIndex = (currentIndex + 1) % densityOrder.length;
    const next = densityOrder[nextIndex];
    setInboxDensity(next);
    window.api.settings.set({ inboxDensity: next });
  };

  // --- Batch action handlers ---
  const handleBatchSnooze = useCallback(() => {
    if (selectedThreadIds.size === 0) return;
    const firstThreadId = Array.from(selectedThreadIds)[0];
    const firstThread = threads.find((t) => t.threadId === firstThreadId);
    if (firstThread) {
      setSelectedThreadId(firstThread.threadId);
      setSelectedEmailId(firstThread.latestEmail.id);
      useAppStore.getState().setShowSnoozeMenu(true);
    }
  }, [selectedThreadIds, threads, setSelectedThreadId, setSelectedEmailId]);

  const handleSelectAll = useCallback(() => {
    const visibleThreads = isDraftsView ? threadsWithDrafts : threads;
    selectAllThreads(visibleThreads.map((t) => t.threadId));
  }, [threads, threadsWithDrafts, isDraftsView, selectAllThreads]);

  // Email list takes available width (flex-1)
  return (
    <div className="flex-1 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
      {/* Header - top-level mailbox tabs + actions */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              if (isSentView) setCurrentSplitId("__priority__");
            }}
            className={`px-2 py-1 text-sm font-medium rounded transition-colors focus:outline-none ${
              !isSentView
                ? "text-gray-900 dark:text-gray-100"
                : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
            }`}
          >
            Inbox
          </button>
          <button
            onClick={() => setCurrentSplitId("__sent__")}
            className={`px-2 py-1 text-sm font-medium rounded transition-colors inline-flex items-center gap-1 focus:outline-none ${
              isSentView
                ? "text-gray-900 dark:text-gray-100"
                : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
              />
            </svg>
            Sent
          </button>
        </div>
        <div className="flex items-center gap-2">
          {isArchiveReadyView && threads.length > 0 && (
            <button
              onClick={handleArchiveAll}
              className="px-2.5 py-1 text-xs font-medium text-white bg-green-600 dark:bg-green-500 hover:bg-green-700 dark:hover:bg-green-600 rounded transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              Archive All
            </button>
          )}
          {isAnalyzingTask && (
            <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Analyzing
            </span>
          )}
          {hasActiveAgentDrafts && (
            <span
              className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
              title={`${agentDrafts.running} drafting, ${agentDrafts.queued} queued`}
            >
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Drafting {agentDrafts.running}/{agentDrafts.running + agentDrafts.queued}
            </span>
          )}
          {/* Density toggle */}
          <button
            onClick={cycleDensity}
            title={`Density: ${densityLabels[inboxDensity]}`}
            className="p-1 rounded text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              {inboxDensity === "compact" ? (
                <>
                  <line x1="2" y1="4" x2="14" y2="4" />
                  <line x1="2" y1="6.5" x2="14" y2="6.5" />
                  <line x1="2" y1="9" x2="14" y2="9" />
                  <line x1="2" y1="11.5" x2="14" y2="11.5" />
                </>
              ) : (
                <>
                  <line x1="2" y1="4" x2="14" y2="4" />
                  <line x1="2" y1="8" x2="14" y2="8" />
                  <line x1="2" y1="12" x2="14" y2="12" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Split tabs - hidden in Sent view since sub-tabs are inbox-specific */}
      {!isSentView && <SplitTabs />}

      {/* Initial sync progress bar */}
      {isInitialSyncing && (
        <div className="px-4 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-750">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Loading inbox: {currentProgress.fetched.toLocaleString()} /{" "}
              {currentProgress.total.toLocaleString()}
            </span>
          </div>
          <div className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 dark:bg-blue-400 rounded-full transition-all duration-300"
              style={{
                width: `${Math.round((currentProgress.fetched / currentProgress.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Batch action bar - shown when threads are multi-selected */}
      <BatchActionBar
        selectedCount={selectedThreadIds.size}
        totalCount={isDraftsView ? threadsWithDrafts.length : threads.length}
        onArchive={batchArchive}
        onTrash={batchTrash}
        onMarkUnread={batchMarkUnread}
        onToggleStar={batchToggleStar}
        onSnooze={handleBatchSnooze}
        onSelectAll={handleSelectAll}
        onClearSelection={clearSelectedThreads}
      />

      {/* Thread list - flat, chronological */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {/* Drafts view: local drafts (compose sessions) + threads with AI-generated drafts */}
        {isDraftsView ? (
          <>
            {localDrafts.length === 0 && threadsWithDrafts.length === 0 && !isLoading && (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-500">
                <svg
                  className="w-12 h-12 mb-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
                <p className="text-sm">No drafts</p>
              </div>
            )}
            {localDrafts.map((draft) => (
              <DraftRow
                key={draft.id}
                draft={draft}
                isSelected={selectedDraftId === draft.id}
                density={inboxDensity}
                onClick={() => handleDraftClick(draft)}
              />
            ))}
            {threadsWithDrafts.map((thread) => (
              <div key={thread.threadId} data-thread-id={thread.threadId}>
                <EmailRow
                  thread={thread}
                  isSelected={selectedThreadId === thread.threadId}
                  isChecked={selectedThreadIds.has(thread.threadId)}
                  isMultiSelectActive={selectedThreadIds.size > 0}
                  density={inboxDensity}
                  onClick={(e) => handleThreadClick(thread, e)}
                  onCheckboxChange={() => toggleThreadSelected(thread.threadId)}
                />
              </div>
            ))}
          </>
        ) : items.length > 0 ? (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index];
              if (item.type === "draft") {
                return (
                  <div
                    key={`draft-${item.draft.id}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <DraftRow
                      draft={item.draft}
                      isSelected={selectedDraftId === item.draft.id}
                      density={inboxDensity}
                      onClick={() => handleDraftClick(item.draft)}
                    />
                  </div>
                );
              }
              const thread = item.thread;
              const isSelected = thread.threadId === selectedThreadId;
              const isChecked = selectedThreadIds.has(thread.threadId);
              return (
                <div
                  key={thread.threadId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <EmailRow
                    thread={thread}
                    isSelected={isSelected}
                    isChecked={isChecked}
                    isMultiSelectActive={isMultiSelectActive}
                    density={inboxDensity}
                    onClick={(e) => handleThreadClick(thread, e)}
                    onCheckboxChange={() => handleCheckboxToggle(thread.threadId)}
                    snoozeInfo={isSnoozedView ? snoozedThreads.get(thread.threadId) : undefined}
                    returnTime={unsnoozedReturnTimes.get(thread.threadId)}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          /* Empty state (only in inbox views) */
          !isLoading && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-500">
              <svg className="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isSnoozedView ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                ) : isSentView ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                  />
                )}
              </svg>
              <p className="text-sm">
                {isSnoozedView ? "No snoozed emails" : isSentView ? "No sent emails" : "Inbox zero"}
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
