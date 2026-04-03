import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useAppStore,
  useThreadedEmails,
  type Account,
  type SyncStatus,
  type PrefetchProgress,
  type BackgroundSyncProgress,
} from "./store";
import { EmailList } from "./components/EmailList";
import { EmailDetail } from "./components/EmailDetail";
import { EmailPreviewSidebar } from "./components/EmailPreviewSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { SetupWizard } from "./components/SetupWizard";
import { SearchBar } from "./components/SearchBar";
import { CommandPalette } from "./components/CommandPalette";
import { AgentCommandPalette } from "./components/AgentCommandPalette";
import { AgentsSidebar } from "./components/AgentsSidebar";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { KeyboardHints } from "./components/KeyboardHints";
import { OfflineBanner } from "./components/OfflineBanner";
import { UpdateBanner } from "./components/UpdateBanner";
import { UndoSendToast } from "./components/UndoSendToast";
import { UndoActionToast } from "./components/UndoActionToast";
import { DraftEditLearnedToast } from "./components/DraftEditLearnedToast";
import { AnalysisOverrideLearnedToast } from "./components/AnalysisOverrideLearnedToast";
import { SnoozeMenu } from "./components/SnoozeMenu";
import { registerBundledExtensions } from "./extensions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import {
  bufferAddEmails,
  bufferRemoveEmails,
  bufferUpdateEmails,
  cancelPendingFlush,
} from "./hooks/useSyncBuffer";
import { confirmOptimisticReads } from "./optimistic-reads";
import {
  initPostHog,
  identifyUser,
  trackEvent,
  addBreadcrumb,
  captureException,
} from "./services/posthog";
import { LocalDraftSchema } from "../shared/types";
import type {
  DashboardEmail,
  OutboxStats,
  ScheduledMessageStats,
  ThemePreference,
  InboxDensity,
  ScheduledMessage,
  SnoozedEmail,
  IpcResponse,
  InboxSplit,
} from "../shared/types";
import type { ScopedAgentEvent, AgentProviderConfig } from "../shared/agent-types";
import { mergeAndThreadSearchResults } from "./utils/searchResults";
import type { EmailThread } from "./store";

function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function formatSearchDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMs < 0) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function SearchResultThreadRow({
  thread,
  isSelected,
  onClick,
}: {
  thread: EmailThread;
  isSelected: boolean;
  onClick: () => void;
}) {
  const senderName = thread.displaySender.split("<")[0].trim() || thread.displaySender;
  const latestEmail = thread.latestEmail;
  const snippet = latestEmail.snippet ? decodeHtmlEntities(latestEmail.snippet) : "";

  return (
    <button
      data-thread-id={thread.threadId}
      data-email-id={thread.latestEmail.id}
      data-selected={isSelected || undefined}
      onClick={onClick}
      className={`w-full h-8 px-3 gap-1.5 text-xs flex items-center text-left border-b border-gray-100 dark:border-gray-700/50 transition-colors cursor-pointer ${
        isSelected
          ? "bg-blue-600 text-white"
          : "hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-900 dark:text-gray-100"
      }`}
    >
      {/* Unread indicator */}
      <div className="w-5 flex-shrink-0 flex items-center justify-center">
        <div className="w-2 flex items-center justify-center">
          {thread.isUnread && (
            <div
              className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-white" : "bg-blue-500"}`}
            />
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex items-center gap-1.5 min-w-0 h-full text-left">
        {/* Sender name */}
        <span
          className={`w-28 truncate font-medium flex-shrink-0 ${
            isSelected
              ? "text-white"
              : thread.isUnread
                ? "text-gray-900 dark:text-gray-100"
                : "text-gray-600 dark:text-gray-400"
          }`}
        >
          {senderName}
        </span>

        {/* Sent badge - show if user replied (latest email is from user) */}
        {thread.userReplied && (
          <span
            className={`text-[9px] px-1 py-px rounded flex-shrink-0 uppercase font-medium ${
              isSelected
                ? "bg-white/20 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
            }`}
          >
            Sent
          </span>
        )}

        {/* Subject + Snippet */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <span
            className={`font-medium truncate ${
              isSelected
                ? "text-white"
                : thread.isUnread
                  ? "text-gray-900 dark:text-gray-100"
                  : "text-gray-700 dark:text-gray-300"
            }`}
          >
            {decodeHtmlEntities(thread.subject)}
          </span>
          <span
            className={`flex-shrink-0 ${isSelected ? "text-white/40" : "text-gray-300 dark:text-gray-600"}`}
          >
            —
          </span>
          {thread.draft ? (
            <>
              <span
                className={`flex-shrink-0 ${isSelected ? "text-green-200" : "text-green-600 dark:text-green-400"}`}
              >
                <svg
                  className="w-3 h-3 inline-block mr-0.5 -mt-px"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
                Draft
              </span>
              <span className={`truncate ${isSelected ? "text-white/60" : "text-gray-400"}`}>
                {(thread.draft.body ?? "")
                  .replace(/<[^>]*>/g, "")
                  .replace(/\n/g, " ")
                  .substring(0, 100)}
              </span>
            </>
          ) : (
            <span className={`truncate ${isSelected ? "text-white/60" : "text-gray-400"}`}>
              {snippet}
            </span>
          )}
        </div>

        {/* Time */}
        <span
          className={`w-9 text-[10px] text-right flex-shrink-0 tabular-nums ${
            isSelected ? "text-white/60" : "text-gray-400"
          }`}
        >
          {formatSearchDate(latestEmail.date)}
        </span>

        {/* Thread count badge */}
        {thread.hasMultipleEmails && (
          <span
            className={`text-[9px] min-w-[1rem] h-4 px-1 rounded-full flex items-center justify-center flex-shrink-0 ${
              isSelected
                ? "bg-white/20 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
            }`}
          >
            {thread.emails.length}
          </span>
        )}
      </div>
    </button>
  );
}

function SearchResultsView() {
  const {
    activeSearchQuery,
    activeSearchResults,
    remoteSearchResults,
    remoteSearchStatus,
    remoteSearchError: _remoteSearchError,
    clearActiveSearch,
    addEmails,
    setSelectedEmailId,
    setSelectedThreadId,
    setViewMode,
    selectedThreadId,
    setRemoteSearchResults,
    setRemoteSearchError,
    currentAccountId,
    accounts,
    isOnline,
    remoteSearchNextPageToken,
    remoteSearchLoadingMore,
  } = useAppStore();

  const currentUserEmail = accounts.find((a) => a.id === currentAccountId)?.email;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Scroll selected result into view
  useEffect(() => {
    if (!selectedThreadId) return;
    const el = document.querySelector(`[data-thread-id="${selectedThreadId}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedThreadId]);

  const handleThreadClick = useCallback(
    (thread: EmailThread) => {
      // Add all emails in the thread so the thread view works properly
      addEmails(thread.emails);
      setSelectedEmailId(thread.latestEmail.id);
      setSelectedThreadId(thread.threadId);
      setViewMode("full");
    },
    [addEmails, setSelectedEmailId, setSelectedThreadId, setViewMode],
  );

  const retryRemoteSearch = useCallback(() => {
    if (!activeSearchQuery || !currentAccountId || !isOnline) return;
    const query = activeSearchQuery;

    // Reset to searching state
    useAppStore.getState().setRemoteSearching();

    window.api.emails
      .searchRemote(query, currentAccountId, 500)
      .then(
        (response: {
          success: boolean;
          data?: { emails: DashboardEmail[]; nextPageToken?: string };
          error?: string;
        }) => {
          if (useAppStore.getState().activeSearchQuery !== query) return;
          if (response.success && response.data) {
            setRemoteSearchResults(response.data.emails);
            useAppStore
              .getState()
              .setRemoteSearchNextPageToken(response.data.nextPageToken ?? null);
          } else {
            setRemoteSearchError(response.error || "Gmail search failed");
          }
        },
      )
      .catch((err: Error) => {
        if (useAppStore.getState().activeSearchQuery !== query) return;
        setRemoteSearchError(err.message || "Gmail search failed");
      });
  }, [activeSearchQuery, currentAccountId, isOnline, setRemoteSearchResults, setRemoteSearchError]);

  // Load more results from Gmail when scrolled to bottom
  const loadMoreResults = useCallback(() => {
    const state = useAppStore.getState();
    const {
      activeSearchQuery: query,
      remoteSearchNextPageToken: pageToken,
      remoteSearchLoadingMore: loading,
      currentAccountId: accountId,
    } = state;
    if (!query || !pageToken || loading || !accountId) return;
    useAppStore.getState().setRemoteSearchLoadingMore(true);

    window.api.emails
      .searchRemote(query, accountId, 500, pageToken)
      .then(
        (response: {
          success: boolean;
          data?: { emails: DashboardEmail[]; nextPageToken?: string };
          error?: string;
        }) => {
          if (useAppStore.getState().activeSearchQuery !== query) return;
          if (response.success && response.data) {
            useAppStore.getState().appendRemoteSearchResults(response.data.emails);
            useAppStore
              .getState()
              .setRemoteSearchNextPageToken(response.data.nextPageToken ?? null);
          }
        },
      )
      .catch(() => {
        // Silently fail load-more — user can scroll down again to retry
      })
      .finally(() => {
        useAppStore.getState().setRemoteSearchLoadingMore(false);
      });
  }, []);

  // IntersectionObserver to detect scroll-to-bottom for infinite scroll.
  // Uses the scroll container as root so clipped elements are detected correctly.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMoreResults();
        }
      },
      { root, rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreResults, remoteSearchNextPageToken, remoteSearchLoadingMore]);

  // Merge local and remote results, deduplicate, and group into threads
  const searchThreads = useMemo(
    () => mergeAndThreadSearchResults(activeSearchResults, remoteSearchResults, currentUserEmail),
    [activeSearchResults, remoteSearchResults, currentUserEmail],
  );

  const hasMoreResults = !!remoteSearchNextPageToken && remoteSearchStatus === "complete";

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white dark:bg-gray-800">
      {/* Search header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <button
            onClick={clearActiveSearch}
            aria-label="Close search"
            className="p-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
          </button>
          <span
            data-testid="search-results-header"
            className="text-sm font-medium text-gray-900 dark:text-gray-100"
          >
            Search results for &quot;{activeSearchQuery}&quot;
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
            {searchThreads.length} result{searchThreads.length !== 1 ? "s" : ""}
            {(remoteSearchStatus === "searching" || remoteSearchLoadingMore) && (
              <svg className="w-3 h-3 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
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
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
          </span>
        </div>
      </div>

      {/* Search results list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {/* Searching spinner (no results yet) */}
        {remoteSearchStatus === "searching" && searchThreads.length === 0 && (
          <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
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
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span className="text-sm">Searching Gmail...</span>
            </div>
          </div>
        )}

        {/* Threaded results sorted by date */}
        {searchThreads.length > 0 && (
          <div>
            {searchThreads.map((thread) => (
              <SearchResultThreadRow
                key={thread.threadId}
                thread={thread}
                isSelected={thread.threadId === selectedThreadId}
                onClick={() => handleThreadClick(thread)}
              />
            ))}
          </div>
        )}

        {/* Still searching indicator (shown below results) */}
        {remoteSearchStatus === "searching" && searchThreads.length > 0 && (
          <div className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400 flex items-center justify-center gap-2 border-t border-gray-200 dark:border-gray-700">
            <svg
              className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
            >
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
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span>Searching Gmail for more results...</span>
          </div>
        )}

        {remoteSearchStatus === "error" && (
          <div className="px-3 py-2 flex items-center gap-2 text-xs border-t border-gray-200 dark:border-gray-700">
            <span className="text-red-600 dark:text-red-400">Gmail search failed</span>
            <button
              onClick={retryRemoteSearch}
              className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading more from Gmail indicator */}
        {remoteSearchLoadingMore && (
          <div className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400 flex items-center justify-center gap-2 border-t border-gray-200 dark:border-gray-700">
            <svg
              className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
            >
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
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span>Loading more from Gmail...</span>
          </div>
        )}

        {/* Infinite scroll sentinel + visible "more results" footer.
            The sentinel triggers auto-load via IntersectionObserver.
            The button provides a manual fallback. */}
        {hasMoreResults && !remoteSearchLoadingMore && (
          <div ref={sentinelRef} className="border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={loadMoreResults}
              className="w-full px-3 py-3 text-xs text-blue-600 dark:text-blue-400 flex items-center justify-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
            >
              <svg
                className="w-3.5 h-3.5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 14l-7 7m0 0l-7-7m7 7V3"
                />
              </svg>
              <span>Load more results from Gmail</span>
            </button>
          </div>
        )}

        {/* No results at all */}
        {searchThreads.length === 0 && remoteSearchStatus === "complete" && (
          <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400 text-sm">
            No results found for &quot;{activeSearchQuery}&quot;
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * After the inbox loads with body-less emails, backfill bodies in batches
 * so they're ready when the user clicks an email. Each batch is small enough
 * (~50 IDs → ~10-20ms) that it doesn't block the main thread.
 *
 * If called while a previous prefetch is still running, the previous one is
 * cancelled to avoid redundant IPC calls.
 */
let activePrefetchController: AbortController | null = null;

async function prefetchEmailBodies(emailIds: string[]): Promise<void> {
  // Cancel any in-flight prefetch run
  activePrefetchController?.abort();
  const controller = new AbortController();
  activePrefetchController = controller;

  const BATCH_SIZE = 50;
  const BATCH_DELAY_MS = 50;

  for (let i = 0; i < emailIds.length; i += BATCH_SIZE) {
    if (controller.signal.aborted) return;
    const batch = emailIds.slice(i, i + BATCH_SIZE);
    const result = (await window.api.sync.prefetchBodies(batch)) as {
      success: boolean;
      data?: Array<{ id: string; body: string }>;
    };
    if (controller.signal.aborted) return;
    if (result.success && result.data) {
      bufferUpdateEmails(result.data.map(({ id, body }) => ({ emailId: id, changes: { body } })));
    }
    // Yield to the event loop between batches to keep the UI responsive
    if (i + BATCH_SIZE < emailIds.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
}

export default function App() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [scheduledPanelOpen, setScheduledPanelOpen] = useState(false);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const scheduledPanelRef = useRef<HTMLDivElement>(null);
  const extensionsRegistered = useRef(false);

  const {
    setEmails,
    addEmails,
    setLoading,
    setError,
    showSettings,
    settingsInitialTab,
    setShowSettings,
    accounts,
    setAccounts,
    currentAccountId,
    setCurrentAccountId,
    setSyncStatus,
    setSyncProgress,
    getSyncStatus,
    setPrefetchProgress,
    setBackgroundSyncProgress,
    composeState,
    openCompose,
    isSearchOpen,
    openSearch,
    closeSearch,
    isCommandPaletteOpen,
    closeCommandPalette,
    isAgentPaletteOpen,
    setAgentPaletteOpen,
    isAgentsSidebarOpen,
    viewMode,
    setViewMode,
    activeSearchQuery,
    activeSearchResults: _activeSearchResults,
    clearActiveSearch: _clearActiveSearch,
    setSelectedEmailId: _setSelectedEmailId,
    expiredAccountIds,
    extensionAuthRequired,
    agentAuthRequired,
    addExpiredAccount,
    removeExpiredAccount,
    addExtensionAuthRequired,
    removeExtensionAuthRequired,
    addAgentAuthRequired,
    removeAgentAuthRequired,
    isOnline,
    outboxStats,
    scheduledMessageStats,
    setOnline,
    setOutboxStats,
    restorePendingRemoval,
    clearPendingRemoval,
    setScheduledMessageStats,
    resolvedTheme,
    setThemePreference,
    setResolvedTheme,
    setInboxDensity,
    setKeyboardBindings,
    setUndoSendDelay,
    setSentEmails,
    addSentEmails,
    setSplits,
    syncProgress,
  } = useAppStore();

  // Initialize keyboard shortcuts
  useKeyboardShortcuts({
    onToggleShortcutHelp: () => setShowShortcuts((prev) => !prev),
  });

  // Register bundled extension components (once on mount)
  useEffect(() => {
    if (!extensionsRegistered.current) {
      registerBundledExtensions();
      extensionsRegistered.current = true;
    }
  }, []);

  // Initialize theme and density from main process and listen for OS theme changes
  useEffect(() => {
    // Fetch persisted theme preference
    window.api.theme
      .get()
      .then(
        (result: {
          success: boolean;
          data?: { preference: ThemePreference; resolved: "light" | "dark" };
        }) => {
          if (result.success && result.data) {
            setThemePreference(result.data.preference);
            setResolvedTheme(result.data.resolved);
          }
        },
      );

    // Fetch persisted inbox density, undo send delay, and PostHog config
    window.api.settings.get().then(
      (result: {
        success: boolean;
        data?: {
          inboxDensity?: InboxDensity;
          undoSendDelay?: number;
          keyboardBindings?: "superhuman" | "gmail";
          posthog?: { enabled: boolean; sessionReplay?: boolean };
        };
      }) => {
        if (result.success && result.data) {
          if (result.data.inboxDensity) {
            setInboxDensity(result.data.inboxDensity);
          }
          if (result.data.keyboardBindings) {
            setKeyboardBindings(result.data.keyboardBindings);
          }
          if (result.data.undoSendDelay !== undefined) {
            setUndoSendDelay(result.data.undoSendDelay);
          }
          // Initialize PostHog analytics — API key is baked in at build time,
          // user can only toggle enabled/sessionReplay in settings
          const phConfig = result.data.posthog;
          const apiKey = import.meta.env.VITE_POSTHOG_API_KEY;
          const host = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
          // Default to disabled for existing users upgrading (no persisted config).
          // New users opt in during onboarding (SetupWizard defaults to enabled).
          const enabled = phConfig?.enabled ?? false;
          if (apiKey) {
            initPostHog({
              enabled,
              apiKey,
              host,
              sessionReplay: phConfig?.sessionReplay ?? false,
            });
          }
        }
      },
    );

    // Listen for theme changes (OS change when preference is "system", or explicit set)
    window.api.theme.onChange((data: { preference: string; resolved: string }) => {
      setThemePreference(data.preference as ThemePreference);
      setResolvedTheme(data.resolved as "light" | "dark");
    });

    return () => {
      window.api.theme.removeAllListeners();
    };
  }, [
    setThemePreference,
    setResolvedTheme,
    setInboxDensity,
    setKeyboardBindings,
    setUndoSendDelay,
  ]);

  // Toggle dark class on document.documentElement when resolvedTheme changes
  useEffect(() => {
    if (resolvedTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [resolvedTheme]);

  // Load inbox splits on mount (stored in electron-store, independent of sync)
  useEffect(() => {
    window.api.splits
      .getAll()
      .then((result: { success: boolean; data?: InboxSplit[] }) => {
        if (result.success && result.data) {
          setSplits(result.data);
        }
      })
      .catch((err: unknown) => {
        console.error("Failed to load splits on mount:", err);
      });
  }, [setSplits]);

  // Initialize sync and accounts
  const initializeSync = useCallback(async () => {
    try {
      const result = await window.api.sync.init();
      if (result.success && result.data) {
        const accountList: Account[] = result.data.map(
          (acc: { accountId: string; email: string; isConnected: boolean }) => ({
            id: acc.accountId,
            email: acc.email,
            isPrimary: false, // Will be set from accounts:list
            isConnected: acc.isConnected,
          }),
        );

        // Fetch full account info
        const accountsResult = await window.api.accounts.list();
        if (accountsResult.success && accountsResult.data) {
          const fullAccounts: Account[] = accountsResult.data.map(
            (acc: { id: string; email: string; isPrimary: boolean }) => ({
              id: acc.id,
              email: acc.email,
              isPrimary: acc.isPrimary,
              isConnected: accountList.find((a) => a.id === acc.id)?.isConnected ?? false,
            }),
          );
          setAccounts(fullAccounts);

          // Set current account to primary or first available
          const primaryAccount = fullAccounts.find((a) => a.isPrimary) || fullAccounts[0];
          if (primaryAccount) {
            setCurrentAccountId(primaryAccount.id);
            // Identify user in PostHog using primary email
            identifyUser(primaryAccount.email, {
              account_count: fullAccounts.length,
            });
            trackEvent("app_launched", {
              account_count: fullAccounts.length,
            });
          }
        }

        // Load cached emails for all accounts (including expired ones)
        const allEmails: DashboardEmail[] = [];
        const allSentEmails: DashboardEmail[] = [];
        for (const acc of accountList) {
          const [emailsResult, sentResult] = await Promise.all([
            window.api.sync.getEmails(acc.id),
            window.api.sync.getSentEmails(acc.id),
          ]);
          if (emailsResult.success && emailsResult.data) {
            allEmails.push(...emailsResult.data);
          }
          if (sentResult.success && sentResult.data) {
            allSentEmails.push(...sentResult.data);
          }
        }
        if (allEmails.length > 0) {
          // Use addEmails (merge) instead of setEmails (replace) because
          // progressive loading may already be adding emails to the store
          // concurrently via sync:new-emails → bufferAddEmails. A full
          // replace would wipe those progressive adds with a partial DB snapshot.
          addEmails(allEmails);

          // Backfill bodies in the background — emails were loaded without
          // body content to avoid blocking the main thread on SQLite overflow reads.
          prefetchEmailBodies(allEmails.map((e) => e.id)).catch((err) =>
            console.error("Body prefetch failed:", err),
          );
        }
        if (allSentEmails.length > 0) {
          setSentEmails(allSentEmails);
        }

        // Load local drafts (new emails composed by agent or user)
        const draftsResult = (await window.api.compose.listLocalDrafts()) as {
          success: boolean;
          data?: unknown[];
        };
        if (draftsResult.success && draftsResult.data) {
          const drafts = draftsResult.data.map((d) => LocalDraftSchema.parse(d));
          useAppStore.getState().setLocalDrafts(drafts);
        }
      }
    } catch (err) {
      console.error("Failed to initialize sync:", err);
      captureException(err instanceof Error ? err : new Error(String(err)), {
        context: "initializeSync",
      });
    }
  }, [setAccounts, setCurrentAccountId, addEmails, setSentEmails]);

  // Set up sync event listeners
  useEffect(() => {
    // Listen for new emails — buffered to avoid interrupting j/k navigation
    window.api.sync.onNewEmails((data: { accountId: string; emails: DashboardEmail[] }) => {
      addBreadcrumb("info", "New emails synced", { count: data.emails.length });
      bufferAddEmails(data.emails);
      // Also add sent emails to the sent view (no buffering needed — not in inbox navigation path)
      const sentInBatch = data.emails.filter((e) => e.labelIds?.includes("SENT"));
      if (sentInBatch.length > 0) {
        addSentEmails(sentInBatch);
      }
    });

    // Listen for new sent emails (from full sent sync, not added to inbox)
    window.api.sync.onNewSentEmails((data: { accountId: string; emails: DashboardEmail[] }) => {
      console.log(`[Sync] New sent emails from ${data.accountId}:`, data.emails.length);
      addSentEmails(data.emails);
    });

    // Listen for sync status changes (lightweight — no email list re-render)
    window.api.sync.onStatusChange((data: { accountId: string; status: string }) => {
      console.log(`[Sync] Status change for ${data.accountId}:`, data.status);
      setSyncStatus(data.accountId, data.status as SyncStatus);
    });

    // Listen for initial sync progress (fetched/total during first full sync)
    const syncApi = window.api.sync as {
      onSyncProgress?: (
        cb: (data: { accountId: string; fetched: number; total: number }) => void,
      ) => void;
    };
    syncApi.onSyncProgress?.((data) => {
      setSyncProgress(data.accountId, { fetched: data.fetched, total: data.total });
      if (data.fetched >= data.total) {
        setTimeout(() => setSyncProgress(data.accountId, null), 2000);
      }
    });

    // Listen for removed emails — buffered
    window.api.sync.onEmailsRemoved((data: { accountId: string; emailIds: string[] }) => {
      bufferRemoveEmails(data.emailIds);
    });

    // Listen for label updates (read/unread changes from Gmail web, mobile, etc.)
    // Buffered as a single batch instead of N individual updateEmail calls.
    window.api.sync.onEmailsUpdated(
      (data: { accountId: string; updates: { emailId: string; labelIds: string[] }[] }) => {
        console.log(`[Sync] Label updates from ${data.accountId}:`, data.updates.length);
        // Clear optimistic read guards for emails that sync confirms are now read
        const confirmedRead = data.updates
          .filter((u) => !u.labelIds.includes("UNREAD"))
          .map((u) => u.emailId);
        if (confirmedRead.length > 0) confirmOptimisticReads(confirmedRead);
        bufferUpdateEmails(
          data.updates.map((u) => ({ emailId: u.emailId, changes: { labelIds: u.labelIds } })),
        );
      },
    );

    // Listen for drafts removed during sync (user replied elsewhere or third-party reply).
    // Update store immediately (not buffered) so the draft editor reflects the change
    // if the user is actively viewing the thread.
    window.api.sync.onDraftsRemoved((data: { accountId: string; emailIds: string[] }) => {
      console.log(`[Sync] Drafts removed for ${data.accountId}:`, data.emailIds.length);
      const store = useAppStore.getState();
      for (const id of data.emailIds) {
        store.updateEmail(id, { draft: undefined });
      }
    });

    // Listen for prefetch progress updates (lightweight — no email list re-render)
    window.api.prefetch.onProgress((progress: PrefetchProgress) => {
      setPrefetchProgress(progress);
    });

    // Listen for emails being analyzed — buffered
    window.api.prefetch.onEmailAnalyzed((email: DashboardEmail) => {
      bufferUpdateEmails([{ emailId: email.id, changes: { analysis: email.analysis } }]);
      trackEvent("email_analyzed", {
        priority: email.analysis?.priority ?? "unknown",
        needs_reply: email.analysis?.needsReply ?? false,
      });
    });

    // Listen for prompt changes — clear stale analysis/draft data from UI.
    // Batched via buffer to avoid N individual re-renders.
    window.api.settings.onPromptsChanged((data: unknown) => {
      const {
        analysisChanged,
        draftChanged,
        archiveReadyChanged: _archiveReadyChanged,
        agentDrafterChanged,
      } = data as {
        analysisChanged: boolean;
        draftChanged: boolean;
        archiveReadyChanged: boolean;
        agentDrafterChanged: boolean;
      };
      const emails = useAppStore.getState().emails;
      const batch: { emailId: string; changes: Partial<DashboardEmail> }[] = [];
      for (const email of emails) {
        const updates: Partial<DashboardEmail> = {};
        if (analysisChanged && email.analysis) {
          updates.analysis = undefined;
        }
        if ((analysisChanged || draftChanged || agentDrafterChanged) && email.draft) {
          // Only clear AI-generated drafts, not user-edited ones
          if (email.draft.status === "pending") {
            updates.draft = undefined;
          }
        }
        if (Object.keys(updates).length > 0) {
          batch.push({ emailId: email.id, changes: updates });
        }
      }
      if (batch.length > 0) {
        bufferUpdateEmails(batch);
      }
    });

    // Listen for drafts saved by the agent — update the email in our list.
    // The auto-open effect in EmailDetail handles opening the editor when a draft appears.
    window.api.agent.onDraftSaved(
      (data: {
        emailId: string;
        draft: {
          body: string;
          status: string;
          createdAt: number;
          composeMode?: string;
          to?: string[];
          cc?: string[];
          bcc?: string[];
        };
      }) => {
        const store = useAppStore.getState();
        // Preserve existing draft fields (e.g. agentTaskId) by merging with existing draft
        const existingDraft = store.emails.find((e) => e.id === data.emailId)?.draft;
        store.updateEmail(data.emailId, {
          draft: {
            ...existingDraft,
            body: data.draft.body,
            status: data.draft.status as "pending" | "created" | "edited",
            createdAt: data.draft.createdAt,
            composeMode: data.draft.composeMode as "forward" | "reply" | "reply-all" | undefined,
            to: data.draft.to?.length ? data.draft.to : undefined,
            cc: data.draft.cc?.length ? data.draft.cc : undefined,
            bcc: data.draft.bcc?.length ? data.draft.bcc : undefined,
          },
        });
      },
    );

    // Listen for local drafts created or updated by the agent (compose_new_email / update_draft / forward_email tools)
    window.api.agent.onLocalDraftSaved?.((data: { draft: Record<string, unknown> }) => {
      const store = useAppStore.getState();
      const parsed = LocalDraftSchema.parse(data.draft);
      const exists = store.localDrafts.some((d) => d.id === parsed.id);
      if (exists) {
        store.updateLocalDraft(parsed.id, parsed);
      } else {
        store.addLocalDraft(parsed);
      }

      // Forward drafts belong inline in their thread — navigate there and open compose
      // Only navigate for NEW forward drafts; updates are synced via the useEffect in EmailDetail
      if (!exists && parsed.isForward && parsed.inReplyTo) {
        store.setSelectedEmailId(parsed.inReplyTo);
        store.setSelectedThreadId(parsed.threadId ?? null);
        store.setSelectedDraftId(null);
        store.openCompose("forward", parsed.inReplyTo, {
          bodyHtml: parsed.bodyHtml,
          bodyText: parsed.bodyText ?? "",
          to: parsed.to,
          cc: parsed.cc,
          bcc: parsed.bcc,
          subject: parsed.subject,
          localDraftId: parsed.id,
        });
        store.setViewMode("full");
      }
    });

    // Listen for provider list updates from the backend (wired to agent:providers IPC event)
    window.api.agent.onProviders((data: unknown) => {
      const parsed = data as { providers?: AgentProviderConfig[] };
      if (parsed?.providers) {
        useAppStore.getState().setAvailableProviders(parsed.providers);
      }
    });

    // Request the current provider list so the command palette has real data
    window.api.agent.providers?.();

    // Listen for streaming agent events — route to correct per-email task via taskId
    window.api.agent.onEvent((data: unknown) => {
      const parsed = data as { taskId?: string; event?: ScopedAgentEvent };
      if (
        typeof parsed?.taskId !== "string" ||
        !parsed.event ||
        typeof parsed.event.type !== "string"
      ) {
        console.warn("[AgentEvent] Malformed payload, ignoring:", data);
        return;
      }
      const { taskId, event } = parsed as { taskId: string; event: ScopedAgentEvent };
      const store = useAppStore.getState();

      // Auto-create tracking entry for auto-draft tasks (from PrefetchService).
      // These run in the main process without the renderer calling startAgentTask(),
      // so events would be silently dropped without this.
      if (!store.agentTaskIdMap[taskId]) {
        const match = taskId.match(/^auto-draft-(.+)-\d+$/);
        if (match) {
          const emailId = match[1];
          const email = store.emails.find((e) => e.id === emailId);
          if (email) {
            // Save sidebar tab — startAgentTask unconditionally sets it to "agent",
            // but background auto-drafts shouldn't steal focus from the user
            const prevTab = store.sidebarTab;
            store.startAgentTask(taskId, emailId, ["claude"], "", {
              accountId: email.accountId || "",
              currentEmailId: emailId,
              currentThreadId: email.threadId,
              userEmail: "",
            });
            trackEvent("agent_run_started", { source: "auto_draft", provider_count: 1 });
            // Restore tab if this auto-draft is for a different email than what the user is viewing
            if (store.selectedEmailId !== emailId && prevTab !== "agent") {
              useAppStore.getState().setSidebarTab(prevTab);
            }
          }
        }
      }

      useAppStore.getState().appendAgentEvent(taskId, event);
      if (event.type === "error" && event.message === "AGENT_AUTH_REQUIRED") {
        const providerId = event.sourceProviderId ?? event.providerId;
        if (providerId) {
          addAgentAuthRequired(providerId, "Custom Agent", "Sign in to agent service");
        }
      }
      if (event.type === "done") {
        // Re-read state after mutation — appendAgentEvent derives per-run status
        const updated = useAppStore.getState();
        const emailId = updated.agentTaskIdMap[taskId];
        const task = emailId ? updated.agentTasks[emailId] : undefined;
        const isAutoDraft = taskId.startsWith("auto-draft-");
        if (task?.status === "completed") {
          updated.completeAgentTask(taskId, event.summary);
          trackEvent("agent_run_completed", { source: isAutoDraft ? "auto_draft" : "manual" });
        } else if (task?.status === "failed") {
          trackEvent("agent_run_failed", { source: isAutoDraft ? "auto_draft" : "manual" });
        } else if (task?.status === "cancelled") {
          trackEvent("agent_run_cancelled", { source: isAutoDraft ? "auto_draft" : "manual" });
        }
      }
    });

    // Listen for background sync progress (all-mail sync for local search)
    window.api.backgroundSync.onProgress((progress: BackgroundSyncProgress) => {
      setBackgroundSyncProgress(progress);
      // Log progress for debugging
      if (progress.status === "running" && progress.synced % 100 === 0) {
        console.log(`[BackgroundSync] ${progress.accountId}: ${progress.synced}/${progress.total}`);
      }
      if (progress.status === "completed") {
        console.log(
          `[BackgroundSync] ${progress.accountId}: Completed - ${progress.synced} emails synced`,
        );
      }
    });

    // Listen for auth events
    window.api.auth.onTokenExpired((data: { accountId: string; email: string }) => {
      console.log("[Auth] Token expired for account");
      addExpiredAccount(data.accountId);
    });

    window.api.auth.onExtensionAuthRequired(
      (data: { extensionId: string; displayName: string; message?: string }) => {
        console.log(`[Auth] Extension auth required: ${data.displayName}`);
        addExtensionAuthRequired(data.extensionId, data.displayName, data.message);
      },
    );

    // Listen for network status changes
    window.api.network.onOnline(() => {
      console.log("[Network] Back online");
      setOnline(true);
    });
    window.api.network.onOffline(() => {
      console.log("[Network] Went offline");
      setOnline(false);
    });

    // Listen for outbox stats changes
    window.api.outbox.onStatsChanged((stats: OutboxStats) => {
      setOutboxStats(stats);
    });

    // Listen for outbox events
    window.api.outbox.onSent((data: { id: string; gmailId?: string }) => {
      console.log(`[Outbox] Message sent: ${data.id}`);
    });
    window.api.outbox.onFailed((data: { id: string; error: string; permanent: boolean }) => {
      console.log(`[Outbox] Message failed: ${data.id} - ${data.error}`);
      if (data.permanent) {
        setError(`Failed to send message: ${data.error}`);
      }
    });

    // Listen for permanently failed offline actions (archive/trash)
    // Restores the email back to the inbox when a queued action fails after retries
    window.api.sync.onActionFailed(
      (data: { emailId: string; accountId: string; action: string; error: string }) => {
        console.error(`[Sync] Action failed: ${data.action}`);
        addBreadcrumb("error", `Sync action failed: ${data.action}`);
        restorePendingRemoval(data.emailId);
        setError(`Failed to ${data.action} email: ${data.error}`);
      },
    );

    // When a queued action succeeds, clear the pending removal data
    window.api.sync.onActionSucceeded(
      (data: { emailId: string; accountId: string; action: string }) => {
        clearPendingRemoval(data.emailId);
      },
    );

    // Listen for scheduled send events
    window.api.scheduledSend.onStatsChanged((stats: { scheduled: number; total: number }) => {
      setScheduledMessageStats(stats);
    });
    window.api.scheduledSend.onSent((data: { id: string }) => {
      console.log(`[ScheduledSend] Message sent: ${data.id}`);
    });
    window.api.scheduledSend.onFailed((data: { id: string; error: string }) => {
      console.log(`[ScheduledSend] Message failed: ${data.id} - ${data.error}`);
      setError(`Scheduled message failed: ${data.error}`);
    });

    // Cleanup listeners and pending buffer flushes on unmount
    return () => {
      cancelPendingFlush();
      window.api.sync.removeAllListeners();
      window.api.prefetch.removeAllListeners();
      window.api.backgroundSync.removeAllListeners();
      window.api.auth.removeAllListeners();
      window.api.network.removeAllListeners();
      window.api.outbox.removeAllListeners();
      window.api.scheduledSend.removeAllListeners();
      window.api.agent.removeDraftSavedListeners();
      window.api.agent.removeAllListeners();
      window.api.settings.removePromptsChangedListener();
    };
  }, [
    setSyncStatus,
    setSyncProgress,
    setPrefetchProgress,
    setBackgroundSyncProgress,
    addExpiredAccount,
    addExtensionAuthRequired,
    addAgentAuthRequired,
    setOnline,
    setOutboxStats,
    setScheduledMessageStats,
    setError,
    restorePendingRemoval,
    clearPendingRemoval,
    addSentEmails,
  ]);

  // Listen for mailto: URLs from the main process (default mail app handler)
  useEffect(() => {
    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const handleMailto = (data: {
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      body: string;
    }) => {
      // Convert plain-text body to escaped HTML for the compose editor
      const bodyHtml = data.body
        ? data.body
            .split("\n")
            .map((line) => `<p>${line ? escapeHtml(line) : "<br>"}</p>`)
            .join("")
        : "";
      openCompose("new", undefined, {
        bodyHtml,
        bodyText: data.body || "",
        to: data.to.length > 0 ? data.to : undefined,
        cc: data.cc.length > 0 ? data.cc : undefined,
        bcc: data.bcc.length > 0 ? data.bcc : undefined,
        subject: data.subject || undefined,
      });
      setViewMode("full");
    };

    const unsub = window.api.defaultMailApp.onMailtoOpen(handleMailto);

    // Check for a pending mailto URL from cold start (pull-based to avoid race)
    window.api.defaultMailApp
      .getPending()
      .then(
        (
          data: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } | null,
        ) => {
          if (data) handleMailto(data);
        },
      )
      .catch(() => {});

    return unsub;
  }, [openCompose, setViewMode]);

  // Check auth status on mount
  useEffect(() => {
    window.api.gmail.checkAuth().then(
      (
        result: IpcResponse<{
          hasCredentials: boolean;
          hasTokens: boolean;
          hasAnthropicKey: boolean;
        }>,
      ) => {
        if (result.success) {
          // Credentials are always bundled at build time — only check API key and tokens
          setNeedsSetup(!result.data.hasAnthropicKey || !result.data.hasTokens);
        } else {
          setNeedsSetup(true);
        }
      },
    );
  }, []);

  // Set up navigator.onLine relay and fetch initial network/outbox status
  useEffect(() => {
    // Fetch initial network status
    window.api.network.getStatus().then((result: IpcResponse<boolean>) => {
      if (result.success) {
        setOnline(result.data);
      }
    });

    // Fetch initial outbox stats
    window.api.outbox.getStats().then((result: IpcResponse<OutboxStats>) => {
      if (result.success) {
        setOutboxStats(result.data);
      }
    });

    // Fetch initial scheduled send stats
    window.api.scheduledSend.stats().then((result: IpcResponse<ScheduledMessageStats>) => {
      if (result.success) {
        setScheduledMessageStats(result.data);
      }
    });

    // Relay navigator.onLine events to main process
    const handleOnline = () => {
      window.api.network.updateStatus(true);
    };
    const handleOffline = () => {
      window.api.network.updateStatus(false);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Send initial status
    window.api.network.updateStatus(navigator.onLine);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [setOnline, setOutboxStats]);

  // Initialize sync after auth is confirmed
  useEffect(() => {
    if (needsSetup === false) {
      initializeSync();
    }
  }, [needsSetup, initializeSync]);

  // Fetch emails query — disabled during progressive sync to prevent
  // setEmails (full replace) from wiping incrementally-loaded emails.
  const hasActiveProgressiveSync = Object.values(syncProgress).some(
    (p) => p !== null && p.fetched < p.total,
  );
  const { refetch: fetchEmails, isFetching } = useQuery({
    queryKey: ["emails", currentAccountId],
    queryFn: async () => {
      const result = await window.api.gmail.fetchUnread(100, currentAccountId ?? undefined);
      if (result.success) {
        setEmails(result.data);
        prefetchEmailBodies(result.data.map((e: DashboardEmail) => e.id)).catch(console.error);
        return result.data;
      }
      throw new Error(result.error);
    },
    enabled: needsSetup === false && !hasActiveProgressiveSync,
    // Disable auto-refetch on window focus — the sync loop + sync buffer
    // handle keeping emails up to date. Window-focus refetch does a full
    // setEmails from DB which overwrites optimistic label updates
    // (e.g. mark-as-read) that haven't been persisted yet.
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setLoading(isFetching);
  }, [isFetching, setLoading]);

  // Fetch scheduled messages list for the dropdown
  const fetchScheduledMessages = useCallback(async () => {
    const result = (await window.api.scheduledSend.list(currentAccountId ?? undefined)) as {
      success: boolean;
      data?: ScheduledMessage[];
    };
    if (result.success && result.data) {
      setScheduledMessages(result.data);
    }
  }, [currentAccountId]);

  // Re-fetch when stats change (panel is open)
  useEffect(() => {
    if (scheduledPanelOpen) {
      fetchScheduledMessages();
    }
  }, [scheduledPanelOpen, scheduledMessageStats, fetchScheduledMessages]);

  // Close scheduled panel on outside click
  useEffect(() => {
    if (!scheduledPanelOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (scheduledPanelRef.current && !scheduledPanelRef.current.contains(e.target as Node)) {
        setScheduledPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [scheduledPanelOpen]);

  const reloadSentEmailsForAccount = async (accountId: string) => {
    const sentResult = await window.api.sync.getSentEmails(accountId);
    if (sentResult.success && sentResult.data) {
      const otherAccountSent = useAppStore
        .getState()
        .sentEmails.filter((e) => e.accountId !== accountId);
      setSentEmails([...otherAccountSent, ...sentResult.data]);
    }
  };

  const handleRefresh = async () => {
    setError(null);
    try {
      if (currentAccountId) {
        // Use sync for multi-account support
        await window.api.sync.now(currentAccountId);
        // Reload emails from database after sync
        const result = await window.api.sync.getEmails(currentAccountId);
        if (result.success && result.data) {
          const otherAccountEmails = useAppStore
            .getState()
            .emails.filter((e) => e.accountId !== currentAccountId);
          setEmails([...otherAccountEmails, ...result.data]);
          prefetchEmailBodies(result.data.map((e: DashboardEmail) => e.id)).catch(console.error);
        }
        // Reload sent emails too
        await reloadSentEmailsForAccount(currentAccountId);
      } else {
        // Fallback to legacy fetch for default account
        await fetchEmails();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch emails");
    }
  };

  const handleReauth = async (accountId: string) => {
    try {
      const result = await window.api.auth.reauth(accountId);
      if ((result as Record<string, unknown>).success) {
        removeExpiredAccount(accountId);

        // Mark account as connected in the store
        const updatedAccounts = useAppStore
          .getState()
          .accounts.map((a) => (a.id === accountId ? { ...a, isConnected: true } : a));
        setAccounts(updatedAccounts);

        setCurrentAccountId(accountId);

        // Load emails from DB now that sync is running
        const emailsResult = await window.api.sync.getEmails(accountId);
        const er = emailsResult as Record<string, unknown>;
        if (er.success && er.data) {
          const otherAccountEmails = useAppStore
            .getState()
            .emails.filter((e) => e.accountId !== accountId);
          const loadedEmails = er.data as DashboardEmail[];
          setEmails([...otherAccountEmails, ...loadedEmails]);
          prefetchEmailBodies(loadedEmails.map((e) => e.id)).catch(console.error);
        }

        // Load sent emails
        await reloadSentEmailsForAccount(accountId);

        // Trigger a sync to pick up any new messages from Gmail
        window.api.sync.now(accountId).catch(console.error);
      } else {
        console.error("[Auth] Re-auth failed");
        addBreadcrumb("error", "Re-auth failed");
      }
    } catch (err) {
      console.error("[Auth] Re-auth error:", err);
      captureException(err instanceof Error ? err : new Error(String(err)), { context: "re-auth" });
    }
  };

  const handleSetupComplete = () => {
    setNeedsSetup(false);
  };

  // Show loading while checking auth
  if (needsSetup === null) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  // Show setup wizard if needed
  if (needsSetup) {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  // Get current account and its sync status
  const currentAccount = accounts.find((a) => a.id === currentAccountId);
  const currentSyncStatus = currentAccountId ? getSyncStatus(currentAccountId) : "idle";
  const isSyncing = currentSyncStatus === "syncing";
  const isCurrentAccountExpired =
    currentAccountId != null && expiredAccountIds.has(currentAccountId);

  // Build list of expired accounts with their email addresses for the banner
  const expiredAccounts = accounts.filter((a) => expiredAccountIds.has(a.id));

  // Handle account switch — instant because emails for all accounts are
  // already in the store from initial load + background sync. We just flip
  // currentAccountId and let useThreadedEmails filter; background sync
  // picks up anything new without blocking the UI.
  const handleAccountSwitch = (accountId: string) => {
    setCurrentAccountId(accountId);
    setAccountMenuOpen(false);

    trackEvent("account_switched", { account_count: accounts.length });

    // Backfill inbox/sent emails independently if missing for this account.
    const storeState = useAppStore.getState();
    if (!storeState.emails.some((e) => e.accountId === accountId)) {
      window.api.sync
        .getEmails(accountId)
        .then((result: IpcResponse<DashboardEmail[]>) => {
          if (result.success && result.data && result.data.length > 0) {
            addEmails(result.data);
            prefetchEmailBodies(result.data.map((e: DashboardEmail) => e.id)).catch(console.error);
          }
        })
        .catch(console.error);
    }
    if (!storeState.sentEmails.some((e) => e.accountId === accountId)) {
      window.api.sync
        .getSentEmails(accountId)
        .then((sentResult: IpcResponse<DashboardEmail[]>) => {
          if (sentResult.success && sentResult.data) {
            addSentEmails(sentResult.data);
          }
        })
        .catch(console.error);
    }

    // Trigger background sync to pick up any new emails (non-blocking)
    window.api.sync.now(accountId).catch(console.error);
  };

  const handleCancelScheduled = async (id: string) => {
    const result = (await window.api.scheduledSend.cancel(id)) as {
      success: boolean;
      data?: { draftId?: string };
      error?: string;
    };
    if (!result.success) {
      setError(result.error || "Failed to cancel scheduled message");
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900 relative">
      {/* Settings panel — rendered on top of inbox instead of replacing it,
          so the inbox stays mounted and avoids an IPC refetch on close. */}
      {showSettings && (
        <div className="absolute inset-0 z-50">
          <SettingsPanel onClose={() => setShowSettings(false)} initialTab={settingsInitialTab} />
        </div>
      )}

      {/* Offline Banner */}
      <OfflineBanner />

      {/* Titlebar */}
      <div className="titlebar-drag h-12 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4">
        <div className="flex items-center space-x-4">
          <div className="w-20" /> {/* Space for traffic lights */}
          <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Exo</h1>
          {/* Account Selector */}
          {accounts.length > 0 && (
            <div className="titlebar-no-drag relative">
              <button
                onClick={() => setAccountMenuOpen(!accountMenuOpen)}
                className="flex items-center space-x-2 px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                <span className="text-gray-700 dark:text-gray-300 truncate max-w-[200px]">
                  {currentAccount?.email || "Select account"}
                </span>
                {/* Sync status indicator */}
                {isSyncing && (
                  <svg
                    className="w-4 h-4 text-blue-500 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
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
                )}
                {!isSyncing && !isCurrentAccountExpired && currentSyncStatus === "idle" && (
                  <span className="w-2 h-2 rounded-full bg-green-500" title="Connected" />
                )}
                {isCurrentAccountExpired && (
                  <span className="w-2 h-2 rounded-full bg-amber-500" title="Session expired" />
                )}
                {!isCurrentAccountExpired && currentSyncStatus === "error" && (
                  <span className="w-2 h-2 rounded-full bg-red-500" title="Sync error" />
                )}
                <svg
                  className="w-4 h-4 text-gray-500 dark:text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {/* Account dropdown menu */}
              {accountMenuOpen && (
                <div className="absolute top-full left-0 mt-1 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg dark:shadow-black/40 z-50">
                  <div className="py-1">
                    {accounts.map((account) => (
                      <button
                        key={account.id}
                        onClick={() => handleAccountSwitch(account.id)}
                        className={`w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between ${
                          account.id === currentAccountId ? "bg-blue-50 dark:bg-blue-900/30" : ""
                        }`}
                      >
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              expiredAccountIds.has(account.id)
                                ? "bg-amber-500"
                                : account.isConnected
                                  ? "bg-green-500"
                                  : "bg-gray-400 dark:bg-gray-500"
                            }`}
                          />
                          <span className="truncate">{account.email}</span>
                        </div>
                        {account.isPrimary && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">Primary</span>
                        )}
                      </button>
                    ))}
                    <div className="border-t border-gray-200 dark:border-gray-700 mt-1 pt-1">
                      <button
                        onClick={() => {
                          setAccountMenuOpen(false);
                          setShowSettings(true);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        + Add account...
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {/* Update indicator — inline next to account picker */}
          <UpdateBanner />
        </div>
        <div className="titlebar-no-drag flex items-center space-x-2">
          {/* Search button */}
          <button
            onClick={openSearch}
            className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-1"
            title="Search (/)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </button>
          {/* Outbox badge (show when there are pending messages and online) */}
          {isOnline && outboxStats.pending > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 rounded-lg text-sm">
              <svg
                className="w-4 h-4 animate-pulse"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              <span>{outboxStats.pending} sending</span>
            </div>
          )}
          {/* Outbox badge for failed messages */}
          {outboxStats.failed > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 rounded-lg text-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <span>{outboxStats.failed} failed</span>
            </div>
          )}
          {/* Scheduled send badge (clickable) */}
          {scheduledMessageStats.scheduled > 0 && (
            <div className="relative" ref={scheduledPanelRef}>
              <button
                onClick={() => setScheduledPanelOpen(!scheduledPanelOpen)}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 rounded-lg text-sm hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                title="View scheduled messages"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span>{scheduledMessageStats.scheduled} scheduled</span>
                <svg
                  className={`w-3 h-3 transition-transform ${scheduledPanelOpen ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {/* Scheduled messages dropdown */}
              {scheduledPanelOpen && (
                <div className="absolute top-full right-0 mt-1 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg dark:shadow-black/40 z-50">
                  <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700">
                    <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Scheduled Messages
                    </h3>
                  </div>
                  {scheduledMessages.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                      No scheduled messages
                    </div>
                  ) : (
                    <div className="max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700/50">
                      {scheduledMessages.map((msg) => (
                        <div
                          key={msg.id}
                          className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                {msg.subject || "(no subject)"}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                                To: {msg.to.join(", ")}
                              </div>
                              <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                {new Date(msg.scheduledAt).toLocaleString([], {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}
                              </div>
                            </div>
                            <button
                              onClick={() => handleCancelScheduled(msg.id)}
                              className="flex-shrink-0 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                              title="Cancel and save as draft"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Compose button */}
          <button
            onClick={() => {
              openCompose("new");
              setViewMode("full");
            }}
            className="px-3 py-1.5 bg-blue-600 dark:bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors flex items-center gap-1"
            title="Compose (C)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Compose
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors focus:outline-none"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
          <button
            onClick={handleRefresh}
            disabled={isFetching || isSyncing}
            className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <svg
              className={`w-5 h-5 ${isFetching || isSyncing ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Auth banners */}
      {expiredAccounts.map((account) => (
        <div
          key={`auth-${account.id}`}
          className="flex items-center justify-between px-4 py-2 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 text-sm"
        >
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
            <svg
              className="w-4 h-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <span>
              <strong>{account.email}</strong> session expired
            </span>
          </div>
          <button
            onClick={() => handleReauth(account.id)}
            className="px-3 py-1 text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-200 dark:bg-amber-800 hover:bg-amber-300 dark:hover:bg-amber-700 rounded transition-colors"
          >
            Re-authenticate
          </button>
        </div>
      ))}
      {[...extensionAuthRequired.entries()].map(([extId, { displayName, message }]) => (
        <div
          key={`ext-auth-${extId}`}
          className="flex items-center justify-between px-4 py-2 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 text-sm"
        >
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
            <svg
              className="w-4 h-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <span>
              <strong>{displayName}</strong> needs authentication{message ? `: ${message}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                try {
                  await window.api.extensions.authenticate(extId);
                  removeExtensionAuthRequired(extId);
                } catch (err) {
                  console.error(`[Auth] Extension auth failed for ${extId}:`, err);
                }
              }}
              className="px-3 py-1 text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-200 dark:bg-amber-800 hover:bg-amber-300 dark:hover:bg-amber-700 rounded transition-colors"
            >
              Authenticate
            </button>
            <button
              onClick={() => removeExtensionAuthRequired(extId)}
              className="p-1 text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
              title="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      ))}
      {[...agentAuthRequired.entries()].map(([providerId, { displayName, message }]) => (
        <div
          key={`agent-auth-${providerId}`}
          className="flex items-center justify-between px-4 py-2 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 text-sm"
        >
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
            <svg
              className="w-4 h-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <span>
              <strong>{displayName}</strong> needs authentication{message ? `: ${message}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                try {
                  const result = (await window.api.agent.authenticate(providerId)) as
                    | { success: boolean; data?: { success: boolean } }
                    | undefined;
                  if (result?.success && result?.data?.success) {
                    removeAgentAuthRequired(providerId);
                  }
                } catch (err) {
                  console.error(`[Auth] Agent auth failed for ${providerId}:`, err);
                }
              }}
              className="px-3 py-1 text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-200 dark:bg-amber-800 hover:bg-amber-300 dark:hover:bg-amber-700 rounded transition-colors"
            >
              Authenticate
            </button>
            <button
              onClick={() => removeAgentAuthRequired(providerId)}
              className="p-1 text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
              title="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      ))}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Agents sidebar (collapsible left panel) */}
        {isAgentsSidebarOpen && <AgentsSidebar />}

        {/* Search results view (shown when search is active and not viewing a specific email) */}
        {activeSearchQuery && viewMode !== "full" && <SearchResultsView />}

        {/* Split mode: dense email list — kept mounted (hidden) in full mode AND
           during search to preserve useMemo caches (useThreadedEmails,
           useSplitFilteredThreads). Unmounting destroys the caches, so returning
           from search or full view forces a full recompute of groupByThread +
           categorization for 2500+ emails before the UI responds. */}
        <div
          className={viewMode === "split" && !activeSearchQuery ? "flex-1 flex flex-col" : ""}
          style={{ display: viewMode === "split" && !activeSearchQuery ? undefined : "none" }}
        >
          <EmailList />
        </div>

        {/* Full mode: full email detail view */}
        {viewMode === "full" && <EmailDetail isFullView />}

        {/* Preview sidebar — kept mounted across view mode transitions to avoid
            expensive unmount/remount of agent trace timelines */}
        {(!activeSearchQuery || viewMode === "full") && <EmailPreviewSidebar />}
      </div>

      {/* Keyboard hints bar */}
      <KeyboardHints />

      {/* Search Modal */}
      <SearchBar isOpen={isSearchOpen} onClose={closeSearch} />

      {/* Command Palette */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => {
          closeCommandPalette();
          // When closing a palette while compose is open, the palette's input is
          // removed and focus falls to <body>. Restore focus to the compose editor
          // so the next Escape properly closes compose via its container handler.
          if (composeState?.isOpen) {
            setTimeout(() => document.querySelector<HTMLElement>(".ProseMirror")?.focus(), 0);
          }
        }}
      />

      {/* Agent Command Palette */}
      <AgentCommandPalette
        isOpen={isAgentPaletteOpen}
        onClose={() => {
          setAgentPaletteOpen(false);
          if (composeState?.isOpen) {
            setTimeout(() => document.querySelector<HTMLElement>(".ProseMirror")?.focus(), 0);
          }
        }}
      />

      {/* Keyboard Shortcuts Help */}
      <ShortcutHelp isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {/* Undo Toasts (send + archive/delete) + Draft Edit Learning */}
      <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2">
        <UndoSendToast />
        <UndoActionToast />
        <DraftEditLearnedToast />
        <AnalysisOverrideLearnedToast />
      </div>

      {/* Global Snooze Menu Overlay */}
      <SnoozeOverlay />
    </div>
  );
}

function SnoozeOverlay() {
  const {
    selectedEmailId,
    selectedThreadId,
    currentAccountId,
    emails,
    setSelectedEmailId: _setSelectedEmailId2,
    setSelectedThreadId: _setSelectedThreadId2,
    setViewMode: _setViewMode2,
    selectedThreadIds,
    clearSelectedThreads,
    addUndoAction,
  } = useAppStore();
  const showSnoozeMenu = useAppStore((s) => s.showSnoozeMenu);
  const setShowSnoozeMenu = useAppStore((s) => s.setShowSnoozeMenu);
  const { threads: currentThreads } = useThreadedEmails();

  const selectedEmail = emails.find((e) => e.id === selectedEmailId);

  if (!showSnoozeMenu || !selectedEmail || !currentAccountId) return null;

  // Determine if we're in batch mode (any multi-select, even 1 thread via 'x')
  const isBatchSnooze = selectedThreadIds.size > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={(e) => {
        // Close when clicking the backdrop (not the menu itself)
        if (e.target === e.currentTarget) {
          setShowSnoozeMenu(false);
        }
      }}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40" />
      <div className="relative">
        <SnoozeMenu
          emailId={selectedEmail.id}
          threadId={selectedEmail.threadId}
          accountId={currentAccountId}
          onSnooze={(snoozedEmail: SnoozedEmail) => {
            if (isBatchSnooze) {
              // Batch snooze: snooze all selected threads using the same snoozeUntil time
              const snoozeUntil = snoozedEmail.snoozeUntil;
              const threadIdsToSnooze = Array.from(selectedThreadIds);

              // Close menu and clear selection immediately
              useAppStore.setState({
                selectedThreadId: null,
                selectedEmailId: null,
                showSnoozeMenu: false,
                viewMode: "split" as const,
              });
              clearSelectedThreads();

              // Snooze remaining threads (the first one was already snoozed by SnoozeMenu)
              const otherThreadIds = threadIdsToSnooze.filter(
                (tid) => tid !== snoozedEmail.threadId,
              );

              // Optimistically update snoozed state synchronously so undo can
              // immediately find and remove it (rAF would race with fast undo).
              useAppStore.setState((state) => {
                const newSnoozedIds = new Set(state.snoozedThreadIds);
                const newSnoozedMap = new Map(state.snoozedThreads);

                // Add first thread
                newSnoozedIds.add(snoozedEmail.threadId);
                newSnoozedMap.set(snoozedEmail.threadId, snoozedEmail);

                // Add remaining threads with unique ids and explicit accountId
                for (const tid of otherThreadIds) {
                  const thread = currentThreads.find((t) => t.threadId === tid);
                  if (thread) {
                    newSnoozedIds.add(tid);
                    newSnoozedMap.set(tid, {
                      id: `snooze-${tid}-${Date.now()}`,
                      emailId: thread.latestEmail.id,
                      threadId: tid,
                      accountId: currentAccountId,
                      snoozeUntil: snoozedEmail.snoozeUntil,
                      snoozedAt: snoozedEmail.snoozedAt,
                    });
                  }
                }

                return { snoozedThreadIds: newSnoozedIds, snoozedThreads: newSnoozedMap };
              });

              // Queue undo synchronously to avoid race with other actions in the rAF delay
              addUndoAction({
                id: `snooze-batch-${Date.now()}`,
                type: "snooze",
                threadCount: threadIdsToSnooze.length,
                accountId: currentAccountId,
                emails: [],
                scheduledAt: Date.now(),
                delayMs: 5000,
                snoozedThreadIds: threadIdsToSnooze,
              });

              // Fire API calls for remaining threads in background
              for (const tid of otherThreadIds) {
                const thread = currentThreads.find((t) => t.threadId === tid);
                if (thread) {
                  window.api.snooze
                    .snooze(thread.latestEmail.id, tid, currentAccountId, snoozeUntil)
                    .catch((err: unknown) =>
                      console.error("Batch snooze failed for thread", tid, err),
                    );
                }
              }
            } else {
              // Single thread snooze (original behavior)
              // Clear any multi-select state (e.g. user selected 1 thread via x/Cmd+click)
              clearSelectedThreads();
              const currentIndex = currentThreads.findIndex((t) => t.threadId === selectedThreadId);
              let nextThreadId: string | null = null;
              let nextEmailId: string | null = null;
              if (currentIndex >= 0 && currentThreads.length > 1) {
                const nextIndex = Math.min(currentIndex, currentThreads.length - 2);
                const nextThread = currentThreads.filter((t) => t.threadId !== selectedThreadId)[
                  nextIndex
                ];
                if (nextThread) {
                  nextThreadId = nextThread.threadId;
                  nextEmailId = nextThread.latestEmail.id;
                }
              }

              const snoozedThreadId = snoozedEmail.threadId;

              useAppStore.setState({
                selectedThreadId: nextThreadId,
                selectedEmailId: nextEmailId,
                showSnoozeMenu: false,
                viewMode: "split" as const,
              });

              useAppStore.setState((state) => {
                const newSnoozedIds = new Set(state.snoozedThreadIds);
                newSnoozedIds.add(snoozedEmail.threadId);
                const newSnoozedMap = new Map(state.snoozedThreads);
                newSnoozedMap.set(snoozedEmail.threadId, snoozedEmail);
                return { snoozedThreadIds: newSnoozedIds, snoozedThreads: newSnoozedMap };
              });

              // Queue undo synchronously to avoid race with other actions in the rAF delay
              addUndoAction({
                id: `snooze-${snoozedThreadId}-${Date.now()}`,
                type: "snooze",
                threadCount: 1,
                accountId: currentAccountId,
                emails: [],
                scheduledAt: Date.now(),
                delayMs: 5000,
                snoozedThreadIds: [snoozedThreadId],
              });
            }
          }}
          onClose={() => setShowSnoozeMenu(false)}
        />
      </div>
    </div>
  );
}
