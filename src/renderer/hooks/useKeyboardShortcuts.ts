import { useEffect, useRef } from "react";
import { useAppStore, useSplitFilteredThreads } from "../store";
import { batchArchive, batchTrash, batchMarkUnread, batchToggleStar } from "./useBatchActions";
import { markNavigationActive } from "./useSyncBuffer";
import { mergeAndThreadSearchResults } from "../utils/searchResults";
import { trackEvent } from "../services/posthog";

declare global {
  interface Window {
    api: {
      emails: {
        archive: (emailId: string, accountId: string) => Promise<unknown>;
        archiveThread: (threadId: string, accountId: string) => Promise<unknown>;
        trash: (emailId: string, accountId: string) => Promise<unknown>;
        setStarred: (emailId: string, accountId: string, starred: boolean) => Promise<unknown>;
        setRead: (emailId: string, accountId: string, read: boolean) => Promise<unknown>;
      };
      archiveReady: {
        archiveThread: (threadId: string, accountId: string) => Promise<unknown>;
      };
      compose: {
        deleteLocalDraft: (draftId: string) => Promise<unknown>;
      };
      sync: {
        now: (accountId: string) => Promise<void>;
      };
    };
  }
}

/** Custom event for navigating between messages within a thread (n/p keys). */
export type ThreadNavDirection = "next" | "prev";
export const THREAD_NAV_EVENT = "gmail-thread-nav";

type KeyboardMode = "normal" | "compose" | "search";

// Check if user is typing in an input field
function isInputFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tagName = active.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    active.getAttribute("contenteditable") === "true" ||
    active.classList.contains("ProseMirror")
  );
}

// Read current keyboard mode directly from store (no closure dependency)
function getKeyboardMode(): KeyboardMode {
  const { composeState, isSearchOpen, isCommandPaletteOpen, isAgentPaletteOpen } =
    useAppStore.getState();
  if (composeState?.isOpen) return "compose";
  if (isSearchOpen || isCommandPaletteOpen || isAgentPaletteOpen) return "search";
  return "normal";
}

interface UseKeyboardShortcutsOptions {
  onToggleShortcutHelp?: () => void;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}) {
  // Store onToggleShortcutHelp in a ref so the handler always has the latest
  const onToggleShortcutHelpRef = useRef(options.onToggleShortcutHelp);
  onToggleShortcutHelpRef.current = options.onToggleShortcutHelp;

  // Threads from hook (derived state for navigation order).
  // Uses split-filtered threads so j/k only navigates the current view.
  // Stored in a ref so the keydown handler always reads the latest value
  // without needing to re-register the event listener.
  const { threads } = useSplitFilteredThreads();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  // Track "g" prefix for two-key shortcuts (g i, g s, g d, g t)
  const gPrefixRef = useRef(false);
  const gPrefixTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Open find bar and ensure the input is focused — handles the case where
  // the bar is already open but input lost focus (standard Cmd+F UX).
  // The 100ms delay ensures the FindBar component has mounted (React render +
  // commit) before we query the DOM for the input element.
  function openAndFocusFindBar() {
    useAppStore.getState().openFindBar();
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="find-bar-input"]');
      if (input) {
        input.focus();
        input.select();
      }
    }, 100);
  }

  // Single event listener registered once. All state is read fresh from the
  // Zustand store via getState() at keypress time, eliminating stale closures.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Read ALL state fresh from the store at keypress time.
      // This is the critical fix: getState() always returns current state,
      // bypassing React's render cycle and avoiding stale closure bugs.
      const state = useAppStore.getState();
      const {
        selectedEmailId,
        selectedThreadId,
        focusedThreadEmailId,
        showSettings,
        viewMode,
        activeSearchQuery,
        activeSearchResults,
        remoteSearchResults,
        emails,
        accounts,
        currentAccountId,
        currentSplitId,
        keyboardBindings,
      } = state;

      const isGmail = keyboardBindings === "gmail";

      // Store actions are stable references — safe to read from getState()
      const {
        setSelectedEmailId,
        setSelectedThreadId,
        openCompose,
        openSearch,
        closeSearch,
        setShowSettings,
        removeEmailsAndAdvance,
        updateEmail,
        setViewMode,
        addEmails,
        removeSearchResult,
        clearActiveSearch,
        addUndoAction,
        markThreadAsRead,
      } = state;

      const mode = getKeyboardMode();
      const currentThreads = threadsRef.current;

      // Always allow Escape to close modals or go back in view modes
      if (e.key === "Escape") {
        // Find bar handles its own Escape via a capture-phase window listener.
        // Bail out here to avoid double-action (e.g. closing find bar AND
        // switching view mode) when a synthetic event from an iframe hits window.
        if (state.isFindBarOpen) return;

        // Overlays take priority — always dismissable regardless of compose mode.
        // Without this, compose mode's early return blocks the agent/command palette
        // from closing when compose is also open (e.g. Cmd+J on an open draft).
        if (state.isAgentPaletteOpen) {
          e.preventDefault();
          state.setAgentPaletteOpen(false);
          // Restore focus to compose editor so next Escape properly closes compose
          if (state.composeState?.isOpen) {
            setTimeout(() => document.querySelector<HTMLElement>(".ProseMirror")?.focus(), 0);
          }
          return;
        }
        if (state.isCommandPaletteOpen) {
          e.preventDefault();
          state.closeCommandPalette();
          if (state.composeState?.isOpen) {
            setTimeout(() => document.querySelector<HTMLElement>(".ProseMirror")?.focus(), 0);
          }
          return;
        }
        if (mode === "compose") {
          // New compose: always let the compose component handle Esc (it saves the draft)
          // Reply/forward compose (InlineReply): only defer when input is focused
          // so the first Esc blurs the editor, and the second Esc (unfocused) reaches
          // this handler to navigate back.
          const isNewCompose = state.composeState?.mode === "new";
          if (isNewCompose || isInputFocused()) {
            return;
          }
        }
        if (mode === "search") {
          e.preventDefault();
          closeSearch();
          return;
        }
        if (showSettings) {
          e.preventDefault();
          setShowSettings(false);
          return;
        }
        // Clear multi-select before other escape actions
        if (state.selectedThreadIds.size > 0) {
          e.preventDefault();
          state.clearSelectedThreads();
          return;
        }
        if (viewMode === "full") {
          e.preventDefault();
          setViewMode("split");
          return;
        }
        if (activeSearchQuery) {
          e.preventDefault();
          clearActiveSearch();
          return;
        }
        if (selectedEmailId) {
          e.preventDefault();
          setSelectedEmailId(null);
          setSelectedThreadId(null);
          return;
        }
        if (state.selectedDraftId) {
          e.preventDefault();
          state.setSelectedDraftId(null);
          return;
        }
      }

      // Cmd+J/K shortcuts work in ALL modes — even compose and search
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        state.setAgentPaletteOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        state.openCommandPalette();
        return;
      }

      // Cmd+F (macOS) / Ctrl+F (Windows/Linux) for find-in-page
      // Don't intercept Ctrl+F on macOS — it's Emacs cursor-forward in text inputs
      const isMac = navigator.platform.startsWith("Mac");
      if (e.key === "f" && (isMac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault();
        openAndFocusFindBar();
        return;
      }

      // In compose mode, only handle Cmd+Enter for send — except when the
      // editor isn't focused (e.g. auto-opened draft without focus), where
      // Enter should focus the editor and "b" should switch sidebar tabs.
      if (mode === "compose" && isInputFocused()) {
        return;
      }

      // In search mode, let the search component handle keys
      if (mode === "search") {
        return;
      }

      // Skip if user is typing in an input or the find bar is open
      // (findInPage steals focus to the match, so isInputFocused() may be false
      // even while the user is actively using the find bar)
      if (isInputFocused() || state.isFindBarOpen) {
        return;
      }

      // Cmd+, for settings
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setShowSettings(true);
        return;
      }

      // Cmd+A: select all threads (only when not viewing search results)
      // Use state.selectAllThreads directly — the const destructuring happens later in the function
      if ((e.metaKey || e.ctrlKey) && e.key === "a" && !activeSearchQuery) {
        e.preventDefault();
        state.selectAllThreads(currentThreads.map((t) => t.threadId));
        return;
      }

      // Let standard modifier shortcuts (Cmd+C, Cmd+V, Cmd+X, etc.) pass through.
      // Cmd/Ctrl always bail — these are OS-level shortcuts.
      if (e.metaKey || e.ctrlKey) {
        return;
      }
      // Alt-only combos bail too (prevent Alt+c from triggering compose, etc.),
      // but Alt+Shift is allowed through for international keyboard character input.
      if (e.altKey && !e.shiftKey) {
        return;
      }

      // Handle "g" prefix for go-to shortcuts
      if (gPrefixRef.current) {
        gPrefixRef.current = false;
        if (gPrefixTimeoutRef.current) {
          clearTimeout(gPrefixTimeoutRef.current);
          gPrefixTimeoutRef.current = null;
        }

        if (e.key === "i") {
          // g i → go to inbox (priority view)
          e.preventDefault();
          state.setCurrentSplitId("__priority__");
          // Clear selection — threads ref is stale until next render,
          // so selecting from it would pick from the wrong list.
          setSelectedThreadId(null);
          setSelectedEmailId(null);
          setViewMode("split");
          return;
        }

        if (e.key === "g") {
          // g g → go to top of current list (Vim-style)
          e.preventDefault();
          if (currentThreads.length > 0) {
            setSelectedThreadId(currentThreads[0].threadId);
            setSelectedEmailId(currentThreads[0].latestEmail.id);
          }
          return;
        }

        if (isGmail) {
          if (e.key === "d") {
            // g d → go to drafts (Gmail)
            e.preventDefault();
            state.setCurrentSplitId("__drafts__");
            setSelectedThreadId(null);
            setSelectedEmailId(null);
            setViewMode("split");
            return;
          }

          if (e.key === "t") {
            // g t → go to sent (Gmail)
            e.preventDefault();
            state.setCurrentSplitId("__sent__");
            setSelectedThreadId(null);
            setSelectedEmailId(null);
            setViewMode("split");
            return;
          }

          if (e.key === "s") {
            // g s → go to snoozed. In Gmail this goes to Starred, but this app
            // doesn't have a dedicated Starred view — Snoozed is the closest match.
            e.preventDefault();
            state.setCurrentSplitId("__snoozed__");
            setSelectedThreadId(null);
            setSelectedEmailId(null);
            setViewMode("split");
            return;
          }
        }

        return;
      }

      // Check for "g" prefix (Cmd/Ctrl always filtered; Alt-only without Shift filtered above)
      if (e.key === "g" && !e.shiftKey) {
        e.preventDefault();
        gPrefixRef.current = true;
        gPrefixTimeoutRef.current = setTimeout(() => {
          gPrefixRef.current = false;
        }, 1000);
        return;
      }

      // --- Helper: navigate list up/down (handles drafts + threads) ---
      const { localDrafts, selectedDraftId } = state;
      const { setSelectedDraftId } = state;

      const navigateList = (direction: "up" | "down") => {
        // Build combined nav list matching visual render order
        const items: (
          | { type: "draft"; draftId: string }
          | { type: "thread"; threadId: string; emailId: string }
        )[] = [];

        // Add drafts if we're in inbox view or drafts view
        const accountDrafts = localDrafts.filter(
          (d) => !currentAccountId || d.accountId === currentAccountId,
        );
        const isDraftsView = currentSplitId === "__drafts__";

        const isSnoozedView = currentSplitId === "__snoozed__";
        if (isDraftsView || (accountDrafts.length > 0 && currentSplitId !== "__archive-ready__")) {
          const draftsForNav = isSnoozedView
            ? accountDrafts.filter((d) => d.threadId && state.snoozedThreads.has(d.threadId))
            : accountDrafts;
          for (const d of draftsForNav) {
            items.push({ type: "draft", draftId: d.id });
          }
        }

        if (!isDraftsView) {
          for (const t of currentThreads) {
            items.push({ type: "thread", threadId: t.threadId, emailId: t.latestEmail.id });
          }
        }

        if (items.length === 0) return;

        // Find current index
        const currentIndex = items.findIndex((item) => {
          if (item.type === "draft") return item.draftId === selectedDraftId;
          if (item.type === "thread") return item.threadId === selectedThreadId;
          return false;
        });

        let newIndex: number;
        if (direction === "down") {
          newIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, items.length - 1);
        } else {
          newIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
        }

        const item = items[newIndex];
        if (!item) return;

        if (item.type === "draft") {
          setSelectedDraftId(item.draftId);
          setSelectedEmailId(null);
          setSelectedThreadId(null);
        } else {
          setSelectedDraftId(null);
          if (viewMode === "full") markThreadAsRead(item.threadId);
          setSelectedThreadId(item.threadId);
          setSelectedEmailId(item.emailId);
        }
      };

      // --- Helper: merge+dedup+thread search results (same order as rendered list) ---
      const currentUserEmail = accounts.find(
        (a: { id: string }) => a.id === currentAccountId,
      )?.email;
      const getSearchThreads = () =>
        mergeAndThreadSearchResults(activeSearchResults, remoteSearchResults, currentUserEmail);

      // --- Helper: navigate search results up/down (by thread) ---
      const navigateSearchResults = (direction: "up" | "down") => {
        const threads = getSearchThreads();
        if (threads.length === 0) return;
        const currentIndex = threads.findIndex((t) => t.threadId === selectedThreadId);
        let newIndex: number;
        if (direction === "down") {
          newIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, threads.length - 1);
        } else {
          newIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
        }
        const thread = threads[newIndex];
        if (thread) {
          addEmails(thread.emails);
          if (viewMode === "full") markThreadAsRead(thread.threadId);
          setSelectedEmailId(thread.latestEmail.id);
          setSelectedThreadId(thread.threadId);
        }
      };

      // --- Helper: get thread emails, falling back to search results if not in global store ---
      const getThreadEmails = (threadId: string) => {
        const storeEmails = emails.filter((item) => item.threadId === threadId);
        if (storeEmails.length > 0) return storeEmails;
        // Fallback: thread may only exist in search results, not yet in the global store
        const searchThread = getSearchThreads().find((t) => t.threadId === threadId);
        return searchThread?.emails ?? [];
      };

      // --- Helper: archive selected thread (all messages) ---
      const archiveSelected = () => {
        if (!selectedEmailId || !selectedThreadId || !currentAccountId) return;

        // Collect ALL emails in the thread for optimistic removal
        const threadEmails = getThreadEmails(selectedThreadId);
        const threadEmailIds = threadEmails.map((item) => item.id);

        const isArchiveReady = currentSplitId === "__archive-ready__";

        // Atomically remove + advance in one render to prevent flicker
        if (activeSearchQuery) {
          const searchThreadsList = getSearchThreads();
          const currentIndex = searchThreadsList.findIndex((t) => t.threadId === selectedThreadId);
          for (const emailId of threadEmailIds) {
            removeSearchResult(emailId);
          }
          const remaining = searchThreadsList.filter((t) => t.threadId !== selectedThreadId);
          if (remaining.length > 0) {
            const nextIndex = Math.min(currentIndex, remaining.length - 1);
            const next = remaining[nextIndex];
            addEmails(next.emails);
            if (viewMode === "full") markThreadAsRead(next.threadId);
            removeEmailsAndAdvance(threadEmailIds, next.threadId, next.latestEmail.id);
          } else {
            removeEmailsAndAdvance(threadEmailIds, null, null);
          }
          if (viewMode === "full") {
            setViewMode("split");
          }
        } else {
          const currentIndex = currentThreads.findIndex((t) => t.threadId === selectedThreadId);
          if (currentIndex >= 0 && currentThreads.length > 1) {
            const nextIndex = Math.min(currentIndex, currentThreads.length - 2);
            const nextThread = currentThreads.filter((t) => t.threadId !== selectedThreadId)[
              nextIndex
            ];
            if (viewMode === "full" && nextThread) markThreadAsRead(nextThread.threadId);
            removeEmailsAndAdvance(
              threadEmailIds,
              nextThread?.threadId ?? null,
              nextThread?.latestEmail.id ?? null,
            );
          } else {
            removeEmailsAndAdvance(threadEmailIds, null, null);
            if (viewMode === "full") {
              setViewMode("split");
            }
          }
        }

        // Queue with undo support (works for both normal and archive-ready views)
        addUndoAction({
          id: `archive-${selectedThreadId}-${Date.now()}`,
          type: "archive",
          threadCount: 1,
          accountId: currentAccountId,
          emails: [...threadEmails],
          scheduledAt: Date.now(),
          delayMs: 5000,
          // If archive-ready view, include thread ID so it gets cleaned up on execute
          archiveReadyThreadIds: isArchiveReady ? [selectedThreadId] : undefined,
        });
        // Tracks intent — user may still undo within 5 s
        trackEvent("email_archived", { thread_count: 1, source: "keyboard" });
      };

      // --- Helper: trash selected thread ---
      const trashSelected = () => {
        if (!selectedEmailId || !selectedThreadId || !currentAccountId) return;

        const threadEmails = getThreadEmails(selectedThreadId);
        const threadEmailIds = threadEmails.map((item) => item.id);

        // Atomically remove + advance in one render to prevent flicker
        if (activeSearchQuery) {
          const searchThreadsList = getSearchThreads();
          const currentIndex = searchThreadsList.findIndex((t) => t.threadId === selectedThreadId);
          for (const emailId of threadEmailIds) {
            removeSearchResult(emailId);
          }
          const remaining = searchThreadsList.filter((t) => t.threadId !== selectedThreadId);
          if (remaining.length > 0) {
            const nextIndex = Math.min(currentIndex, remaining.length - 1);
            const next = remaining[nextIndex];
            addEmails(next.emails);
            if (viewMode === "full") markThreadAsRead(next.threadId);
            removeEmailsAndAdvance(threadEmailIds, next.threadId, next.latestEmail.id);
          } else {
            removeEmailsAndAdvance(threadEmailIds, null, null);
          }
          if (viewMode === "full") {
            setViewMode("split");
          }
        } else {
          const currentIndex = currentThreads.findIndex((t) => t.threadId === selectedThreadId);
          if (currentIndex >= 0 && currentThreads.length > 1) {
            const nextIndex = Math.min(currentIndex, currentThreads.length - 2);
            const nextThread = currentThreads.filter((t) => t.threadId !== selectedThreadId)[
              nextIndex
            ];
            if (viewMode === "full" && nextThread) markThreadAsRead(nextThread.threadId);
            removeEmailsAndAdvance(
              threadEmailIds,
              nextThread?.threadId ?? null,
              nextThread?.latestEmail.id ?? null,
            );
          } else {
            removeEmailsAndAdvance(threadEmailIds, null, null);
            if (viewMode === "full") {
              setViewMode("split");
            }
          }
        }

        // Queue with undo support
        addUndoAction({
          id: `trash-${selectedThreadId}-${Date.now()}`,
          type: "trash",
          threadCount: 1,
          accountId: currentAccountId,
          emails: [...threadEmails],
          scheduledAt: Date.now(),
          delayMs: 5000,
        });
        // Tracks intent — user may still undo within 5 s
        trackEvent("email_trashed", { thread_count: 1, source: "keyboard" });
      };

      // --- Helper: mark selected thread as unread ---
      const markSelectedUnread = () => {
        if (!selectedThreadId || !currentAccountId) return;

        const threadEmails = emails.filter((item) => item.threadId === selectedThreadId);
        if (threadEmails.length === 0) return;

        const latestEmail = threadEmails.reduce((a, b) =>
          new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b,
        );

        const currentLabels = latestEmail.labelIds || ["INBOX"];

        // Optimistic update + undo — only if email was actually modified
        if (!currentLabels.includes("UNREAD")) {
          const previousLabels: Record<string, string[]> = { [latestEmail.id]: [...currentLabels] };
          updateEmail(latestEmail.id, { labelIds: [...currentLabels, "UNREAD"] });
          addUndoAction({
            id: `mark-unread-${selectedThreadId}-${Date.now()}`,
            type: "mark-unread",
            threadCount: 1,
            accountId: currentAccountId,
            emails: [latestEmail],
            scheduledAt: Date.now(),
            delayMs: 5000,
            previousLabels,
          });
        }

        if (viewMode === "full") {
          setViewMode("split");
        }
      };

      // --- Multi-select state ---
      const {
        selectedThreadIds,
        toggleThreadSelected,
        clearSelectedThreads: _clearSelectedThreads,
        selectAllThreads: _selectAllThreads,
      } = state;
      const isMultiSelect = selectedThreadIds.size > 0;

      // --- 'x': toggle current thread in multi-select ---
      if (e.key === "x" && selectedThreadId) {
        e.preventDefault();
        toggleThreadSelected(selectedThreadId);
        return;
      }

      // --- Shift+J/K/Arrow: extend selection up/down ---
      if (
        e.shiftKey &&
        (e.key === "J" || e.key === "K" || e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !activeSearchQuery
      ) {
        e.preventDefault();
        markNavigationActive();
        if (currentThreads.length === 0) return;
        const currentIndex = currentThreads.findIndex((t) => t.threadId === selectedThreadId);
        if (currentIndex < 0) return;

        const direction = e.key === "J" || e.key === "ArrowDown" ? 1 : -1;
        const nextIndex = currentIndex + direction;
        if (nextIndex < 0 || nextIndex >= currentThreads.length) return;

        const currentThread = currentThreads[currentIndex];
        const nextThread = currentThreads[nextIndex];

        // If no selection yet, select the current thread first as the anchor
        if (selectedThreadIds.size === 0) {
          toggleThreadSelected(currentThread.threadId);
        }

        // Toggle the next thread and move highlight to it
        if (!selectedThreadIds.has(nextThread.threadId)) {
          toggleThreadSelected(nextThread.threadId);
        } else if (selectedThreadIds.has(currentThread.threadId) && selectedThreadIds.size > 1) {
          // Moving back into already-selected territory: deselect current to shrink
          toggleThreadSelected(currentThread.threadId);
        }

        setSelectedThreadId(nextThread.threadId);
        setSelectedEmailId(nextThread.latestEmail.id);
        return;
      }

      // --- Helper: get ordered split IDs matching visible SplitTabs ---
      // Uses "__all__" sentinel for the All tab (currentSplitId === null).
      // Only includes __drafts__ / __snoozed__ when they have content (matching
      // SplitTabs.tsx conditional rendering). __sent__ is excluded because it's
      // a separate view that hides the tab bar entirely.
      const ALL_SENTINEL = "__all__";
      const getOrderedSplitIds = (): string[] => {
        const ids: string[] = ["__priority__", "__other__", "__archive-ready__"];
        // Custom splits sorted by order
        const customSplits = [...state.splits]
          .filter((s) => s.accountId === currentAccountId)
          .sort((a, b) => a.order - b.order);
        for (const s of customSplits) ids.push(s.id);
        // Conditional virtual tabs (only when visible in SplitTabs)
        const hasDrafts = state.localDrafts.some(
          (d) => !currentAccountId || d.accountId === currentAccountId,
        );
        if (hasDrafts) ids.push("__drafts__");
        // Only include snoozed when there are snoozed threads with loaded email data
        // for the current account (matches SplitTabs.tsx snoozedCount from useThreadedEmails)
        const hasSnoozed = state.emails.some(
          (e) =>
            state.snoozedThreadIds.has(e.threadId) &&
            (!currentAccountId || e.accountId === currentAccountId),
        );
        if (hasSnoozed) ids.push("__snoozed__");
        ids.push(ALL_SENTINEL);
        return ids;
      };

      // --- Helper: navigate to next/prev split tab ---
      const cycleSplit = (direction: "next" | "prev") => {
        const ids = getOrderedSplitIds();
        const currentIdx = ids.indexOf(currentSplitId ?? ALL_SENTINEL);
        const step = direction === "next" ? 1 : -1;
        const nextIdx = (currentIdx + step + ids.length) % ids.length;
        const nextId = ids[nextIdx];
        state.setCurrentSplitId(nextId === ALL_SENTINEL ? null : nextId);
      };

      // Normal mode shortcuts (single-key, no modifiers)
      switch (e.key) {
        // Navigation
        case "j":
        case "ArrowDown":
          // Skip Shift+Arrow — arrow keys don't change e.key when shift is held
          // (unlike j→J), so without this guard Shift+ArrowDown would navigate
          // instead of being a no-op like Shift+J in the switch.
          if (e.shiftKey && e.key.startsWith("Arrow")) break;
          e.preventDefault();
          // Defer any pending sync-driven store updates while navigating
          markNavigationActive();
          if (activeSearchQuery) {
            navigateSearchResults("down");
          } else {
            navigateList("down");
          }
          break;

        case "k":
        case "ArrowUp":
          if (e.shiftKey && e.key.startsWith("Arrow")) break;
          e.preventDefault();
          markNavigationActive();
          if (activeSearchQuery) {
            navigateSearchResults("up");
          } else {
            navigateList("up");
          }
          break;

        // n/p: next/prev message within a thread (Gmail only)
        case "n":
          if (isGmail && viewMode === "full" && selectedThreadId) {
            e.preventDefault();
            window.dispatchEvent(
              new CustomEvent(THREAD_NAV_EVENT, { detail: "next" as ThreadNavDirection }),
            );
          }
          break;

        case "p":
          if (isGmail && viewMode === "full" && selectedThreadId) {
            e.preventDefault();
            window.dispatchEvent(
              new CustomEvent(THREAD_NAV_EVENT, { detail: "prev" as ThreadNavDirection }),
            );
          }
          break;

        // ` / ~ : cycle through inbox split tabs (Gmail only)
        case "`":
          if (isGmail) {
            e.preventDefault();
            cycleSplit("next");
          }
          break;
        case "~":
          if (isGmail) {
            e.preventDefault();
            cycleSplit("prev");
          }
          break;

        case "o":
          // "o" is Gmail's open conversation key (Gmail only, same as Enter)
          if (!isGmail) break;
        // falls through to Enter handler

        case "Enter":
          if (activeSearchQuery && viewMode !== "full" && selectedThreadId) {
            const threads = getSearchThreads();
            const thread = threads.find((t) => t.threadId === selectedThreadId);
            if (thread) {
              e.preventDefault();
              addEmails(thread.emails);
              markThreadAsRead(thread.threadId);
              setViewMode("full");
            }
          } else if (selectedDraftId) {
            // Open a selected local draft in compose view
            const draft = localDrafts.find((d) => d.id === selectedDraftId);
            if (draft) {
              e.preventDefault();
              openCompose("new", undefined, {
                bodyHtml: draft.bodyHtml,
                bodyText: draft.bodyText ?? "",
                to: draft.to,
                cc: draft.cc,
                bcc: draft.bcc,
                subject: draft.subject,
                localDraftId: draft.id,
              });
              setViewMode("full");
            }
          } else if (viewMode === "full" && selectedEmailId) {
            e.preventDefault();
            // If the inline reply editor is already open (e.g. auto-opened draft),
            // focus it instead of opening a new compose that would discard the draft.
            if (state.isInlineReplyOpen || state.composeState?.isOpen) {
              const editor = document.querySelector<HTMLElement>(".ProseMirror");
              editor?.focus();
            } else {
              openCompose("reply-all", focusedThreadEmailId ?? selectedEmailId);
            }
          } else if (selectedThreadId && currentThreads.length > 0) {
            const thread = currentThreads.find((t) => t.threadId === selectedThreadId);
            if (thread) {
              e.preventDefault();
              markThreadAsRead(thread.threadId);
              setSelectedEmailId(thread.latestEmail.id);
              setViewMode("full");
            }
          }
          break;

        // Compose actions
        case "c":
          e.preventDefault();
          openCompose("new");
          setViewMode("full");
          break;

        case "r":
        case "R": {
          // In full view, prefer the focused email within the thread
          const replyTarget = (viewMode === "full" && focusedThreadEmailId) || selectedEmailId;
          if (replyTarget) {
            e.preventDefault();
            if (e.shiftKey) {
              // Shift+R: reply (single recipient)
              openCompose("reply", replyTarget);
            } else {
              // r: reply all (matches existing behavior)
              openCompose("reply-all", replyTarget);
            }
          }
          break;
        }

        // Gmail: "a" for reply-all (Gmail only)
        case "a":
        case "A": {
          if (isGmail && e.key === "a" && !e.shiftKey) {
            const replyAllTarget = (viewMode === "full" && focusedThreadEmailId) || selectedEmailId;
            if (replyAllTarget) {
              e.preventDefault();
              openCompose("reply-all", replyAllTarget);
            }
          }
          break;
        }

        case "f": {
          const forwardTarget = (viewMode === "full" && focusedThreadEmailId) || selectedEmailId;
          if (forwardTarget) {
            e.preventDefault();
            openCompose("forward", forwardTarget);
          }
          break;
        }

        // Email actions — batch-aware
        case "y":
          // "y" archives in Gmail mode only
          if (!isGmail) break;
        // falls through to "e" handler

        case "e":
          if (isMultiSelect) {
            e.preventDefault();
            batchArchive();
          } else if (selectedEmailId) {
            e.preventDefault();
            archiveSelected();
          }
          break;

        case "#":
        case "3":
          // "#" from Shift+3 — some platforms report e.key as "3" with shiftKey
          if (e.key === "3" && !e.shiftKey) break;
          if (selectedDraftId) {
            e.preventDefault();
            state.removeLocalDraft(selectedDraftId);
            window.api.compose.deleteLocalDraft(selectedDraftId);
            setSelectedDraftId(null);
          } else if (isMultiSelect) {
            e.preventDefault();
            batchTrash();
          } else if (selectedEmailId) {
            e.preventDefault();
            trashSelected();
          }
          break;

        // Mark as unread — batch-aware
        case "U":
          // Shift+U: Gmail only (lowercase u works in both)
          if (!isGmail) break;
        // falls through to "u" handler

        case "u":
          if (isMultiSelect) {
            e.preventDefault();
            batchMarkUnread();
          } else if (selectedThreadId) {
            e.preventDefault();
            markSelectedUnread();
          }
          break;

        // Shift+I: mark as read and return to list (Gmail only)
        case "I":
          if (isGmail && e.shiftKey) {
            if (selectedThreadId && currentAccountId) {
              e.preventDefault();
              markThreadAsRead(selectedThreadId);
              if (viewMode === "full") {
                setViewMode("split");
              }
            }
          }
          break;

        // Star — batch-aware; single-thread star is Gmail only
        case "s":
          if (isMultiSelect) {
            e.preventDefault();
            batchToggleStar();
          } else if (isGmail && selectedThreadId && currentAccountId) {
            e.preventDefault();
            const threadEmails = emails.filter((item) => item.threadId === selectedThreadId);
            if (threadEmails.length === 0) break;
            const latestEmail = threadEmails.reduce((a, b) =>
              new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b,
            );
            const currentLabels = latestEmail.labelIds || ["INBOX"];
            const isStarred = currentLabels.includes("STARRED");
            if (isStarred) {
              // Unstar: remove STARRED from all starred emails in thread
              const starredEmails = threadEmails.filter((item) =>
                item.labelIds?.includes("STARRED"),
              );
              const previousLabels: Record<string, string[]> = {};
              for (const email of starredEmails) {
                const labels = email.labelIds || ["INBOX"];
                previousLabels[email.id] = [...labels];
                state.updateEmail(email.id, {
                  labelIds: labels.filter((l: string) => l !== "STARRED"),
                });
              }
              addUndoAction({
                id: `unstar-${selectedThreadId}-${Date.now()}`,
                type: "unstar",
                threadCount: 1,
                accountId: currentAccountId,
                emails: starredEmails,
                scheduledAt: Date.now(),
                delayMs: 5000,
                previousLabels,
              });
            } else {
              // Star: add STARRED to latest email
              const previousLabels: Record<string, string[]> = {
                [latestEmail.id]: [...currentLabels],
              };
              state.updateEmail(latestEmail.id, { labelIds: [...currentLabels, "STARRED"] });
              addUndoAction({
                id: `star-${selectedThreadId}-${Date.now()}`,
                type: "star",
                threadCount: 1,
                accountId: currentAccountId,
                emails: [latestEmail],
                scheduledAt: Date.now(),
                delayMs: 5000,
                previousLabels,
              });
            }
          }
          break;

        // Snooze (batch-aware: opens snooze menu which handles batch via selectedThreadIds)
        case "h":
          if (isMultiSelect || selectedEmailId) {
            e.preventDefault();
            state.setShowSnoozeMenu(!state.showSnoozeMenu);
          }
          break;

        // Search (exclude Shift+/ which is "?" for help)
        case "/":
          if (!e.shiftKey) {
            e.preventDefault();
            openSearch();
          }
          break;

        // (Cmd+, for settings is handled above, before the switch)

        // Shift+G for bottom
        case "G":
          if (e.shiftKey && currentThreads.length > 0) {
            e.preventDefault();
            const lastThread = currentThreads[currentThreads.length - 1];
            setSelectedThreadId(lastThread.threadId);
            setSelectedEmailId(lastThread.latestEmail.id);
          }
          break;

        // Switch sidebar tab
        case "b":
          e.preventDefault();
          state.cycleSidebarTab();
          break;

        // z: undo last action (Gmail only — no modifier needed)
        case "z":
          if (isGmail && !e.shiftKey) {
            e.preventDefault();
            // Trigger the same undo mechanism as Cmd+Z in UndoActionToast
            window.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "z",
                metaKey: true,
                bubbles: true,
              }),
            );
          }
          break;

        // Shift+N: force refresh/sync current account (Gmail only)
        case "N":
          if (isGmail && e.shiftKey && currentAccountId) {
            e.preventDefault();
            window.api.sync.now(currentAccountId).catch(console.error);
          }
          break;

        // Help
        case "?":
          e.preventDefault();
          onToggleShortcutHelpRef.current?.();
          break;
      }

      // Cmd+K, Cmd+J, Cmd+,, and Cmd+A are handled above, before the switch
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (gPrefixTimeoutRef.current) {
        clearTimeout(gPrefixTimeoutRef.current);
      }
    };
  }, []);

  // Listen for Cmd+F routed from main process (Electron's default menu
  // captures Cmd+F before the renderer sees it, so the main process
  // intercepts it via before-input-event and sends find:open instead).
  useEffect(() => {
    window.api.find.onOpen(() => {
      openAndFocusFindBar();
    });
    return () => {
      window.api.find.removeOpenListener();
    };
  }, []);

  // Return current mode for components that need it
  return { mode: getKeyboardMode() };
}

// Available shortcuts for help display — varies by binding preset
export function getKeyboardShortcuts(bindings: "superhuman" | "gmail") {
  const isGmail = bindings === "gmail";
  return {
    navigation: [
      { key: "j / ↓", description: "Move down" },
      { key: "k / ↑", description: "Move up" },
      { key: isGmail ? "o / Enter" : "Enter", description: "Open conversation" },
      { key: "Escape", description: "Back / Deselect" },
      ...(isGmail
        ? [
            { key: "n", description: "Next message in thread" },
            { key: "p", description: "Previous message in thread" },
          ]
        : []),
      { key: "g i", description: "Go to inbox" },
      { key: "g g", description: "Go to top" },
      { key: "G", description: "Go to bottom" },
      ...(isGmail
        ? [
            { key: "g d", description: "Go to drafts" },
            { key: "g t", description: "Go to sent" },
            { key: "g s", description: "Go to snoozed (starred in Gmail)" },
            { key: "` / ~", description: "Next / previous section" },
          ]
        : []),
    ],
    actions: [
      { key: isGmail ? "e / y" : "e", description: "Archive" },
      { key: "#", description: "Delete" },
      { key: "u", description: "Mark unread" },
      ...(isGmail ? [{ key: "Shift+I", description: "Mark as read" }] : []),
      { key: "s", description: "Star / unstar" },
      { key: "h", description: "Snooze" },
      ...(isGmail
        ? [
            { key: "z", description: "Undo last action" },
            { key: "Shift+N", description: "Refresh" },
          ]
        : []),
      { key: "x", description: "Select / deselect thread" },
      { key: "Shift+J/K", description: "Extend selection down/up" },
      { key: "Cmd+A", description: "Select all threads" },
    ],
    compose: [
      { key: "c", description: "Compose new email" },
      { key: isGmail ? "r / a" : "r", description: "Reply all" },
      { key: "R", description: "Reply (single)" },
      { key: "f", description: "Forward" },
    ],
    search: [
      { key: "/", description: "Open search" },
      { key: "Cmd+F", description: "Find in page" },
      { key: "Cmd+K", description: "Command palette" },
      { key: "Cmd+J", description: "Agent action palette" },
    ],
    other: [
      { key: "b", description: "Switch sidebar tab" },
      { key: "Cmd+,", description: "Settings" },
      { key: "?", description: "Show shortcuts" },
    ],
  };
}
