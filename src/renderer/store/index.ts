import { useMemo } from "react";
import { create } from "zustand";
import { clearPendingLabelUpdates } from "../hooks-bridge";
import { applyOptimisticReads, addOptimisticReads } from "../optimistic-reads";
import type {
  DashboardEmail,
  ComposeMode,
  OutboxStats,
  InboxSplit,
  ThemePreference,
  InboxDensity,
  SnoozedEmail,
  ScheduledMessageStats,
  SendMessageOptions,
  LocalDraft,
} from "../../shared/types";
import { emailMatchesSplit } from "../utils/split-conditions";
import type {
  AgentProviderConfig,
  AgentTaskInfo,
  AgentProviderRun,
  AgentTaskHistoryEntry,
  ScopedAgentEvent,
  AgentContext,
} from "../../shared/agent-types";

export type SettingsTab =
  | "general"
  | "accounts"
  | "calendar"
  | "splits"
  | "signatures"
  | "prompts"
  | "style"
  | "assistant"
  | "memories"
  | "queue"
  | "agents"
  | "analytics"
  | "extensions";

// Draft content for undo-send restoration or local draft editing
export type RestoredDraft = {
  bodyHtml: string;
  bodyText: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  localDraftId?: string; // Set when editing a local_draft (compose_new_email)
  /** When true, skip auto-focusing the compose editor (e.g. auto-opened pre-existing drafts). */
  skipAutoFocus?: boolean;
};

// Compose state
export type ComposeState = {
  isOpen: boolean;
  mode: ComposeMode;
  replyToEmailId?: string;
  restoredDraft?: RestoredDraft;
} | null;

// Thread representation - a group of emails with the same threadId
export type EmailThread = {
  threadId: string;
  emails: DashboardEmail[];
  latestEmail: DashboardEmail;
  latestReceivedEmail: DashboardEmail;
  latestReceivedDate: number; // Timestamp of latest received (not sent) email, for inbox sorting
  subject: string;
  hasMultipleEmails: boolean;
  // Aggregated status
  isUnread: boolean;
  analysis?: DashboardEmail["analysis"];
  draft?: DashboardEmail["draft"];
  // True when the latest email in the thread is from the user (user already replied)
  userReplied: boolean;
  // Best sender to display (handles edge cases where latestReceivedEmail is from user)
  displaySender: string;
};

// Account representation
export type Account = {
  id: string;
  email: string;
  displayName?: string;
  isPrimary: boolean;
  isConnected: boolean;
};

// Sync status per account
export type SyncStatus = "idle" | "syncing" | "error";

// Agent draft queue item
export type AgentDraftItem = {
  emailId: string;
  subject: string;
  from: string;
  priority: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
};

// Prefetch progress
export type PrefetchProgress = {
  status: "idle" | "running" | "error";
  queueLength: number;
  currentTask?: {
    emailId: string;
    type: "analysis" | "sender-profile" | "agent-draft" | "archive-ready";
  };
  processed: {
    analysis: number;
    senderProfile: number;
    draft: number;
    extensionEnrichment: number;
    archiveReady?: number;
  };
  agentDrafts?: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    items: AgentDraftItem[];
  };
};

// Background sync progress (for all-mail sync enabling local search)
export type BackgroundSyncProgress = {
  accountId: string;
  status: "idle" | "running" | "completed" | "error";
  synced: number;
  total: number;
  error?: string;
};

// Undo send queue item
export type UndoSendItem = {
  id: string;
  sendOptions: SendMessageOptions & { accountId: string };
  recipients: string; // Display string e.g. "john@example.com"
  scheduledAt: number; // Timestamp when added
  delayMs: number; // Delay before actual send
  // Context for reopening the compose UI on undo
  composeContext?: {
    mode: ComposeMode;
    replyToEmailId?: string;
    threadId?: string;
    bodyHtml: string;
    bodyText: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    optimisticEmailId?: string; // Remove this phantom email from the store on undo
  };
};

// Undo archive/delete queue item
export type UndoActionItem = {
  id: string;
  type: "archive" | "trash" | "mark-unread" | "star" | "unstar" | "snooze";
  threadCount: number;
  accountId: string;
  emails: DashboardEmail[];
  scheduledAt: number;
  delayMs: number;
  // For label-based actions (mark-unread, star, unstar):
  // Previous labels per email ID for restoration on undo
  previousLabels?: Record<string, string[]>;
  // For archive actions from archive-ready view:
  // Thread IDs to remove from archive-ready set on execute
  archiveReadyThreadIds?: string[];
  // For snooze undo: thread IDs to unsnooze
  snoozedThreadIds?: string[];
};

interface AppState {
  emails: DashboardEmail[];
  selectedEmailId: string | null;
  selectedThreadId: string | null;
  // Tracks which email within an open thread the user has focused on (clicked/expanded).
  // Keyboard shortcuts (r, R, f, Enter) act on this email when in full view mode.
  focusedThreadEmailId: string | null;
  expandedThreads: Set<string>;
  isLoading: boolean;
  isAnalyzing: boolean;
  error: string | null;
  showSkipped: boolean;
  showSettings: boolean;
  settingsInitialTab: SettingsTab | undefined;

  // Multi-account state
  accounts: Account[];
  currentAccountId: string | null;
  syncStatuses: Map<string, SyncStatus>;

  // Prefetch state
  prefetchProgress: PrefetchProgress;

  // Background sync state (for all-mail sync)
  backgroundSyncProgress: Map<string, BackgroundSyncProgress>;

  // Compose state
  composeState: ComposeState;

  // Inline reply state — tracks whether an inline reply form is active,
  // so the global keyboard handler can close it on Escape before navigating away.
  isInlineReplyOpen: boolean;
  // Which email the inline reply is targeting. Promoted to the store (from local
  // state) so UndoSendToast can atomically update it when replacing optimistic
  // email IDs, preventing the InlineReply from unmounting.
  inlineReplyToEmailId: string | null;

  // Command palette state
  isCommandPaletteOpen: boolean;

  // Search state
  isSearchOpen: boolean;
  activeSearchQuery: string | null;
  activeSearchResults: DashboardEmail[];
  remoteSearchResults: DashboardEmail[];
  remoteSearchStatus: "idle" | "searching" | "complete" | "error";
  remoteSearchError: string | null;
  remoteSearchNextPageToken: string | null;
  remoteSearchLoadingMore: boolean;

  // View mode state
  viewMode: "split" | "full";

  // Sidebar tab state — which sidebar panel group is active
  sidebarTab: "sender" | "email" | "agent";
  availableSidebarTabs: ("sender" | "email" | "agent")[];

  // Network/offline state
  isOnline: boolean;
  outboxStats: OutboxStats;

  // Scheduled send state
  scheduledMessageStats: ScheduledMessageStats;

  // Inbox splits state
  splits: InboxSplit[];
  currentSplitId: string | null;

  // Theme state
  themePreference: ThemePreference;
  resolvedTheme: "light" | "dark";

  // Inbox density state
  inboxDensity: InboxDensity;

  // Keyboard binding preset
  keyboardBindings: "superhuman" | "gmail";

  // Archive-ready state
  archiveReadyThreadIds: Set<string>;
  archiveReadyReasons: Map<string, string>;

  // Recently replied state — threads keep their position for a grace period after replying
  recentlyRepliedThreadIds: Map<string, number>; // threadId -> timestamp of reply

  // Snooze state
  snoozedThreadIds: Set<string>;
  snoozedThreads: Map<string, SnoozedEmail>; // threadId -> SnoozedEmail
  recentlyUnsnoozedThreadIds: Set<string>; // Threads that just unsnoozed — exempt from exclusive split filtering
  unsnoozedReturnTimes: Map<string, number>; // threadId -> snoozeUntil timestamp (for chronological sorting)
  showSnoozeMenu: boolean;

  // Undo send state
  undoSendDelaySeconds: number;
  undoSendQueue: UndoSendItem[];

  // Draft-edit learned notifications
  draftEditLearned: {
    promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
    draftMemoriesCreated: number;
    draftMemoryIds: string[];
  } | null;
  // Analysis override learned notifications
  analysisOverrideLearned: {
    promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
    draftMemoriesCreated: number;
  } | null;
  highlightMemoryIds: string[];

  // Undo archive/delete state
  undoActionQueue: UndoActionItem[];

  // Auth state — accounts/extensions needing re-authentication
  expiredAccountIds: Set<string>;
  extensionAuthRequired: Map<string, { displayName: string; message?: string }>;
  agentAuthRequired: Map<string, { displayName: string; message?: string }>;

  // Pending removals — email data saved for restoration if offline action fails
  pendingRemovals: Map<string, DashboardEmail[]>;

  // Multi-select state for batch actions
  selectedThreadIds: Set<string>;
  lastSelectedThreadId: string | null; // Anchor for shift-click range selection

  // Agent state
  isAgentPaletteOpen: boolean;
  isAgentsSidebarOpen: boolean;
  selectedAgentIds: string[];
  defaultAgentIds: string[];
  availableProviders: AgentProviderConfig[];
  agentTasks: Record<string, AgentTaskInfo>; // keyed by emailId (or "__global__" for non-email tasks)
  agentTaskIdMap: Record<string, string>; // taskId -> emailId (or "__global__")
  agentTaskHistory: AgentTaskHistoryEntry[];
  globalAgentTaskKey: string | null; // non-null when a non-email agent task is active

  // Local drafts state (new emails composed by agent or user, not tied to threads)
  localDrafts: LocalDraft[];
  selectedDraftId: string | null;

  // Initial sync progress (for progress bar during first sync)
  syncProgress: Record<string, { fetched: number; total: number } | null>;

  // Sent emails state (separate from inbox emails for the Sent view)
  sentEmails: DashboardEmail[];

  setEmails: (emails: DashboardEmail[]) => void;
  addEmails: (emails: DashboardEmail[]) => void;
  removeEmails: (emailIds: string[]) => void;
  /** Atomically remove emails and update selection in one render — prevents flicker during archive/trash. */
  removeEmailsAndAdvance: (
    emailIds: string[],
    nextThreadId: string | null,
    nextEmailId: string | null,
  ) => void;
  setSelectedEmailId: (id: string | null) => void;
  setSelectedThreadId: (id: string | null) => void;
  setFocusedThreadEmailId: (id: string | null) => void;
  toggleThreadExpanded: (threadId: string) => void;
  setLoading: (loading: boolean) => void;
  setAnalyzing: (analyzing: boolean) => void;
  setError: (error: string | null) => void;
  setShowSkipped: (show: boolean) => void;
  setShowSettings: (show: boolean, initialTab?: SettingsTab) => void;
  updateEmail: (id: string, updates: Partial<DashboardEmail>) => void;
  // Multi-account actions
  setAccounts: (accounts: Account[]) => void;
  addAccount: (account: Account) => void;
  removeAccount: (accountId: string) => void;
  setCurrentAccountId: (accountId: string | null) => void;
  setSyncStatus: (accountId: string, status: SyncStatus) => void;
  getSyncStatus: (accountId: string) => SyncStatus;

  // Prefetch actions
  setPrefetchProgress: (progress: PrefetchProgress) => void;

  // Background sync actions
  setBackgroundSyncProgress: (progress: BackgroundSyncProgress) => void;
  getBackgroundSyncProgress: (accountId: string) => BackgroundSyncProgress | undefined;

  // Compose actions
  openCompose: (mode: ComposeMode, replyToEmailId?: string, restoredDraft?: RestoredDraft) => void;
  closeCompose: () => void;

  // Inline reply actions
  setInlineReplyOpen: (open: boolean) => void;
  setInlineReplyToEmailId: (id: string | null) => void;

  // Command palette actions
  openCommandPalette: () => void;
  closeCommandPalette: () => void;

  // Find-in-page
  isFindBarOpen: boolean;
  openFindBar: () => void;
  closeFindBar: () => void;

  // Search actions
  openSearch: () => void;
  closeSearch: () => void;
  setActiveSearch: (query: string, results: DashboardEmail[]) => void;
  setActiveSearchResults: (results: DashboardEmail[]) => void;
  clearActiveSearch: () => void;
  removeSearchResult: (emailId: string) => void;
  setRemoteSearchResults: (results: DashboardEmail[]) => void;
  setRemoteSearchError: (error: string) => void;
  setRemoteSearching: () => void;
  setRemoteSearchNextPageToken: (token: string | null) => void;
  appendRemoteSearchResults: (results: DashboardEmail[]) => void;
  setRemoteSearchLoadingMore: (loading: boolean) => void;

  // View mode actions
  setViewMode: (mode: "split" | "full") => void;

  // Sidebar tab actions
  setSidebarTab: (tab: "sender" | "email" | "agent") => void;
  cycleSidebarTab: () => void;
  setAvailableSidebarTabs: (tabs: ("sender" | "email" | "agent")[]) => void;

  // Network/offline actions
  setOnline: (online: boolean) => void;
  setOutboxStats: (stats: OutboxStats) => void;

  // Pending removal actions (for offline archive/trash restoration)
  savePendingRemoval: (emailId: string, emails: DashboardEmail[]) => void;
  restorePendingRemoval: (emailId: string) => void;
  clearPendingRemoval: (emailId: string) => void;

  // Multi-select actions
  toggleThreadSelected: (threadId: string) => void;
  setThreadsSelected: (threadIds: string[]) => void;
  clearSelectedThreads: () => void;
  selectAllThreads: (threadIds: string[]) => void;
  setLastSelectedThreadId: (threadId: string | null) => void;

  // Scheduled send actions
  setScheduledMessageStats: (stats: ScheduledMessageStats) => void;

  // Inbox splits actions
  setSplits: (splits: InboxSplit[]) => void;
  setCurrentSplitId: (id: string | null) => void;

  // Theme actions
  setThemePreference: (preference: ThemePreference) => void;
  setResolvedTheme: (theme: "light" | "dark") => void;

  // Inbox density actions
  setInboxDensity: (density: InboxDensity) => void;
  setKeyboardBindings: (bindings: "superhuman" | "gmail") => void;

  // Archive-ready actions
  setArchiveReadyThreads: (items: { threadId: string; reason: string }[]) => void;
  removeArchiveReadyThread: (threadId: string) => void;
  clearArchiveReadyThreads: () => void;

  // Recently replied actions
  addRecentlyRepliedThread: (threadId: string) => void;
  removeRecentlyRepliedThread: (threadId: string) => void;

  // Snooze actions
  addSnoozedThread: (snoozedEmail: SnoozedEmail) => void;
  removeSnoozedThread: (threadId: string) => void;
  setSnoozedThreads: (snoozedEmails: SnoozedEmail[]) => void;
  handleThreadUnsnoozed: (threadId: string, returnTime: number) => void;
  addRecentlyUnsnoozedThread: (threadId: string, returnTime?: number) => void;
  removeRecentlyUnsnoozedThread: (threadId: string) => void;
  setShowSnoozeMenu: (show: boolean) => void;

  // Draft-edit learned actions
  setDraftEditLearned: (data: {
    promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
    draftMemoriesCreated: number;
    draftMemoryIds: string[];
  }) => void;
  clearDraftEditLearned: () => void;
  // Analysis override learned actions
  setAnalysisOverrideLearned: (data: {
    promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
    draftMemoriesCreated: number;
  }) => void;
  clearAnalysisOverrideLearned: () => void;
  setHighlightMemoryIds: (ids: string[]) => void;

  // Undo send actions
  setUndoSendDelay: (seconds: number) => void;
  addUndoSend: (item: UndoSendItem) => void;
  removeUndoSend: (id: string) => void;

  // Undo archive/delete actions
  addUndoAction: (item: UndoActionItem) => void;
  removeUndoAction: (id: string) => void;

  // Auth actions
  addExpiredAccount: (accountId: string) => void;
  removeExpiredAccount: (accountId: string) => void;
  addExtensionAuthRequired: (extensionId: string, displayName: string, message?: string) => void;
  removeExtensionAuthRequired: (extensionId: string) => void;
  addAgentAuthRequired: (providerId: string, displayName: string, message?: string) => void;
  removeAgentAuthRequired: (providerId: string) => void;

  // Agent actions
  setAgentPaletteOpen: (open: boolean) => void;
  toggleAgentsSidebar: () => void;
  setSelectedAgentIds: (ids: string[]) => void;
  setDefaultAgentIds: (ids: string[]) => void;
  setAvailableProviders: (providers: AgentProviderConfig[]) => void;
  startAgentTask: (
    taskId: string,
    emailId: string,
    providerIds: string[],
    prompt: string,
    context: AgentContext,
  ) => void;
  followUpAgentTask: (emailId: string, prompt: string) => void;
  appendAgentEvent: (taskId: string, event: ScopedAgentEvent) => void;
  // Replay a full agent trace in a single store update (avoids O(n²) from N individual appendAgentEvent calls)
  replayAgentTrace: (
    taskId: string,
    emailId: string,
    providerIds: string[],
    prompt: string,
    context: AgentContext,
    events: ScopedAgentEvent[],
  ) => void;
  completeAgentTask: (taskId: string, summary: string) => void;
  cancelAgentTask: (taskId: string) => void;
  updateAgentTaskId: (emailId: string, newTaskId: string) => void;
  getAgentTaskForEmail: (emailId: string) => AgentTaskInfo | undefined;
  setGlobalAgentTaskKey: (key: string | null) => void;

  // Local drafts actions
  setLocalDrafts: (drafts: LocalDraft[]) => void;
  addLocalDraft: (draft: LocalDraft) => void;
  removeLocalDraft: (draftId: string) => void;
  updateLocalDraft: (draftId: string, updates: Partial<LocalDraft>) => void;
  setSelectedDraftId: (id: string | null) => void;

  // Initial sync progress actions
  setSyncProgress: (accountId: string, progress: { fetched: number; total: number } | null) => void;

  // Sent emails actions
  setSentEmails: (emails: DashboardEmail[]) => void;
  addSentEmails: (emails: DashboardEmail[]) => void;

  // Mark-as-read action (imperative — call from Enter/click handlers directly)
  markThreadAsRead: (threadId: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  emails: [],
  selectedEmailId: null,
  selectedThreadId: null,
  focusedThreadEmailId: null,
  expandedThreads: new Set(),
  isLoading: false,
  isAnalyzing: false,
  error: null,
  showSkipped: false,
  showSettings: false,
  settingsInitialTab: undefined,

  // Multi-account state
  accounts: [],
  currentAccountId: null,
  syncStatuses: new Map(),

  // Prefetch state
  prefetchProgress: {
    status: "idle",
    queueLength: 0,
    processed: { analysis: 0, senderProfile: 0, draft: 0, extensionEnrichment: 0 },
  },

  // Background sync state (for all-mail sync)
  backgroundSyncProgress: new Map(),

  // Initial sync progress
  syncProgress: {},

  // Compose state
  composeState: null,

  // Inline reply state
  isInlineReplyOpen: false,
  inlineReplyToEmailId: null,

  // Command palette state
  isCommandPaletteOpen: false,

  // Find-in-page state
  isFindBarOpen: false,

  // Search state
  isSearchOpen: false,
  activeSearchQuery: null,
  activeSearchResults: [],
  remoteSearchResults: [],
  remoteSearchStatus: "idle",
  remoteSearchError: null,
  remoteSearchNextPageToken: null,
  remoteSearchLoadingMore: false,

  // View mode state - split mode shows sidebar by default
  viewMode: "split",

  // Sidebar tab state
  sidebarTab: "sender",
  availableSidebarTabs: ["sender"],

  // Network/offline state
  isOnline: true,
  outboxStats: { pending: 0, sending: 0, failed: 0, total: 0 },

  // Scheduled send state
  scheduledMessageStats: { scheduled: 0, total: 0 },

  // Inbox splits state
  splits: [],
  currentSplitId: "__priority__",

  // Theme state
  themePreference: "system",
  resolvedTheme: "light",

  // Inbox density state
  inboxDensity: "compact",

  // Keyboard binding preset
  keyboardBindings: "superhuman",

  // Archive-ready state
  archiveReadyThreadIds: new Set(),
  archiveReadyReasons: new Map(),

  // Recently replied state
  recentlyRepliedThreadIds: new Map(),

  // Snooze state
  snoozedThreadIds: new Set(),
  snoozedThreads: new Map(),
  recentlyUnsnoozedThreadIds: new Set(),
  unsnoozedReturnTimes: new Map(),
  showSnoozeMenu: false,

  // Draft-edit learned state
  draftEditLearned: null,
  analysisOverrideLearned: null,
  highlightMemoryIds: [],

  // Undo send state
  undoSendDelaySeconds: 5,
  undoSendQueue: [],

  // Undo archive/delete state
  undoActionQueue: [],

  // Auth state
  expiredAccountIds: new Set(),
  extensionAuthRequired: new Map(),
  agentAuthRequired: new Map(),

  // Pending removals
  pendingRemovals: new Map(),

  // Multi-select state
  selectedThreadIds: new Set(),
  lastSelectedThreadId: null,

  // Agent state
  isAgentPaletteOpen: false,
  isAgentsSidebarOpen: false,
  selectedAgentIds: [],
  defaultAgentIds: [],
  availableProviders: [],
  agentTasks: {},
  agentTaskIdMap: {},
  agentTaskHistory: [],
  globalAgentTaskKey: null,

  // Local drafts
  localDrafts: [],
  selectedDraftId: null,

  // Sent emails
  sentEmails: [],

  setEmails: (emails) => {
    set((state) => {
      // Suppress emails pending in the undo action queue (archive/trash).
      // Any path that replaces the store (DB reload, fetch) could resurrect
      // emails the user just archived/trashed optimistically.
      const pendingIds = new Set<string>();
      for (const action of state.undoActionQueue) {
        if (action.type === "archive" || action.type === "trash") {
          for (const e of action.emails) pendingIds.add(e.id);
        }
      }
      // Also suppress from pendingRemovals (offline queue path)
      for (const arr of state.pendingRemovals.values()) {
        for (const e of arr) pendingIds.add(e.id);
      }
      const filtered = pendingIds.size > 0 ? emails.filter((e) => !pendingIds.has(e.id)) : emails;
      const patched = applyOptimisticReads(filtered);
      if (
        state.viewMode === "full" &&
        state.selectedEmailId &&
        state.emails.some((e) => e.id === state.selectedEmailId) &&
        !patched.some((e) => e.id === state.selectedEmailId)
      ) {
        return {
          emails: patched,
          viewMode: "split" as const,
          selectedEmailId: null,
          selectedThreadId: null,
        };
      }
      return { emails: patched };
    });
  },
  addEmails: (newEmails) => {
    set((state) => {
      // Suppress emails pending in the undo action queue (archive/trash).
      // Without this, any path that adds emails (DB reload, sync) could
      // resurrect emails the user just archived/trashed optimistically.
      const pendingIds = new Set<string>();
      for (const action of state.undoActionQueue) {
        if (action.type === "archive" || action.type === "trash") {
          for (const e of action.emails) pendingIds.add(e.id);
        }
      }
      for (const arr of state.pendingRemovals.values()) {
        for (const e of arr) pendingIds.add(e.id);
      }
      const filteredNewEmails =
        pendingIds.size > 0 ? newEmails.filter((e) => !pendingIds.has(e.id)) : newEmails;
      // Merge new emails: add new ones, update existing ones (e.g. triage adds analysis)
      const existingMap = new Map(state.emails.map((e) => [e.id, e]));
      const toAdd: DashboardEmail[] = [];
      for (const email of filteredNewEmails) {
        const existing = existingMap.get(email.id);
        if (existing) {
          // Merge: prefer new values but preserve fields that may have been
          // loaded separately (body from prefetch, analysis/draft from triage)
          existingMap.set(email.id, {
            ...existing,
            ...email,
            body: email.body || existing.body,
            analysis: email.analysis ?? existing.analysis,
            draft: email.draft ?? existing.draft,
          });
        } else {
          toAdd.push(email);
        }
      }
      let result: DashboardEmail[];
      if (toAdd.length === 0 && filteredNewEmails.every((e) => existingMap.has(e.id))) {
        // Only updates, rebuild from map
        result = state.emails.map((e) => existingMap.get(e.id) ?? e);
      } else {
        result = [...state.emails.map((e) => existingMap.get(e.id) ?? e), ...toAdd];
      }
      return { emails: applyOptimisticReads(result) };
    });
  },
  removeEmails: (emailIds) =>
    set((state) => {
      const idsToRemove = new Set(emailIds);
      const emails = state.emails.filter((e) => !idsToRemove.has(e.id));
      // If removing the currently selected email while in full view, reset to
      // split so the user isn't stuck on a blank detail pane. The explicit
      // removeEmailsAndAdvance path handles its own selection, but direct
      // removeEmails callers (e.g. UndoSendToast undo) may not.
      if (
        state.viewMode === "full" &&
        state.selectedEmailId &&
        idsToRemove.has(state.selectedEmailId)
      ) {
        return {
          emails,
          viewMode: "split" as const,
          selectedEmailId: null,
          selectedThreadId: null,
        };
      }
      return { emails };
    }),
  removeEmailsAndAdvance: (emailIds, nextThreadId, nextEmailId) =>
    set((state) => {
      const idsToRemove = new Set(emailIds);
      return {
        emails: state.emails.filter((e) => !idsToRemove.has(e.id)),
        selectedThreadId: nextThreadId,
        selectedEmailId: nextEmailId,
      };
    }),
  setSelectedEmailId: (id) => set({ selectedEmailId: id }),
  setSelectedThreadId: (id) => set({ selectedThreadId: id }),
  setFocusedThreadEmailId: (id) => set({ focusedThreadEmailId: id }),
  toggleThreadExpanded: (threadId) =>
    set((state) => {
      const newExpanded = new Set(state.expandedThreads);
      if (newExpanded.has(threadId)) {
        newExpanded.delete(threadId);
      } else {
        newExpanded.add(threadId);
      }
      return { expandedThreads: newExpanded };
    }),
  setLoading: (loading) => set({ isLoading: loading }),
  setAnalyzing: (analyzing) => set({ isAnalyzing: analyzing }),
  setError: (error) => set({ error }),
  setShowSkipped: (show) => set({ showSkipped: show }),
  setShowSettings: (show, initialTab) =>
    set({
      showSettings: show,
      settingsInitialTab: show ? initialTab : undefined,
      highlightMemoryIds: show ? get().highlightMemoryIds : [],
    }),
  updateEmail: (id, updates) =>
    set((state) => ({
      emails: state.emails.map((email) => (email.id === id ? { ...email, ...updates } : email)),
      sentEmails: state.sentEmails.map((email) =>
        email.id === id ? { ...email, ...updates } : email,
      ),
    })),
  // Multi-account actions
  setAccounts: (accounts) =>
    set({
      accounts,
      // Set current to primary or first account if not set
      currentAccountId:
        get().currentAccountId || accounts.find((a) => a.isPrimary)?.id || accounts[0]?.id || null,
    }),
  addAccount: (account) =>
    set((state) => {
      const exists = state.accounts.some((a) => a.id === account.id);
      if (exists) return state;
      return { accounts: [...state.accounts, account] };
    }),
  removeAccount: (accountId) =>
    set((state) => {
      const newAccounts = state.accounts.filter((a) => a.id !== accountId);
      const newSyncStatuses = new Map(state.syncStatuses);
      newSyncStatuses.delete(accountId);
      // If removing current account, switch to primary or first
      let newCurrentId = state.currentAccountId;
      if (state.currentAccountId === accountId) {
        newCurrentId = newAccounts.find((a) => a.isPrimary)?.id || newAccounts[0]?.id || null;
      }
      return {
        accounts: newAccounts,
        currentAccountId: newCurrentId,
        syncStatuses: newSyncStatuses,
      };
    }),
  setCurrentAccountId: (accountId) => {
    // Reset account-scoped and conditionally-rendered splits. Only preserve
    // virtual splits that are always visible regardless of account data.
    // Default to __priority__ when resetting (matches main's convention).
    const ALWAYS_VISIBLE_SPLITS = new Set([
      "__priority__",
      "__other__",
      "__archive-ready__",
      "__sent__",
    ]);
    const { currentSplitId } = get();
    const nextSplitId =
      currentSplitId !== null && !ALWAYS_VISIBLE_SPLITS.has(currentSplitId)
        ? "__priority__"
        : currentSplitId;
    set({
      currentAccountId: accountId,
      selectedEmailId: null,
      globalAgentTaskKey: null,
      currentSplitId: nextSplitId,
    });
  },
  setSyncStatus: (accountId, status) =>
    set((state) => {
      const newStatuses = new Map(state.syncStatuses);
      newStatuses.set(accountId, status);
      return { syncStatuses: newStatuses };
    }),
  getSyncStatus: (accountId) => get().syncStatuses.get(accountId) || "idle",

  // Prefetch actions
  setPrefetchProgress: (progress) => set({ prefetchProgress: progress }),

  // Background sync actions
  setBackgroundSyncProgress: (progress) =>
    set((state) => {
      const newProgress = new Map(state.backgroundSyncProgress);
      newProgress.set(progress.accountId, progress);
      return { backgroundSyncProgress: newProgress };
    }),
  getBackgroundSyncProgress: (accountId) => get().backgroundSyncProgress.get(accountId),

  // Initial sync progress actions
  setSyncProgress: (accountId, progress) =>
    set((state) => ({
      syncProgress: { ...state.syncProgress, [accountId]: progress },
    })),

  // Compose actions
  openCompose: (mode, replyToEmailId, restoredDraft) =>
    set({ composeState: { isOpen: true, mode, replyToEmailId, restoredDraft } }),
  closeCompose: () => set({ composeState: null }),

  // Inline reply actions
  setInlineReplyOpen: (open) => set({ isInlineReplyOpen: open }),
  setInlineReplyToEmailId: (id) => set({ inlineReplyToEmailId: id }),

  // Command palette actions
  openCommandPalette: () => set({ isCommandPaletteOpen: true }),
  closeCommandPalette: () => set({ isCommandPaletteOpen: false }),

  // Find-in-page actions
  openFindBar: () => set({ isFindBarOpen: true }),
  closeFindBar: () => set({ isFindBarOpen: false }),

  // Search actions
  openSearch: () => set({ isSearchOpen: true }),
  closeSearch: () => set({ isSearchOpen: false }),
  setActiveSearch: (query, results) =>
    set({
      activeSearchQuery: query,
      activeSearchResults: results,
      isSearchOpen: false,
      remoteSearchResults: [],
      remoteSearchStatus: "searching",
      remoteSearchError: null,
      remoteSearchNextPageToken: null,
      remoteSearchLoadingMore: false,
    }),
  setActiveSearchResults: (results) => set({ activeSearchResults: results }),
  clearActiveSearch: () =>
    set({
      activeSearchQuery: null,
      activeSearchResults: [],
      remoteSearchResults: [],
      remoteSearchStatus: "idle",
      remoteSearchError: null,
      remoteSearchNextPageToken: null,
      remoteSearchLoadingMore: false,
    }),
  removeSearchResult: (emailId) =>
    set((state) => ({
      activeSearchResults: state.activeSearchResults.filter((e) => e.id !== emailId),
      remoteSearchResults: state.remoteSearchResults.filter((e) => e.id !== emailId),
    })),
  setRemoteSearchResults: (results) =>
    set((state) => {
      // Deduplicate against local results
      const localIds = new Set(state.activeSearchResults.map((e) => e.id));
      const uniqueRemote = results.filter((e) => !localIds.has(e.id));
      return {
        remoteSearchResults: uniqueRemote,
        remoteSearchStatus: "complete",
        remoteSearchError: null,
      };
    }),
  setRemoteSearchError: (error) =>
    set({
      remoteSearchStatus: "error",
      remoteSearchError: error,
    }),
  setRemoteSearching: () =>
    set({
      remoteSearchStatus: "searching",
      remoteSearchResults: [],
      remoteSearchError: null,
    }),
  setRemoteSearchNextPageToken: (token) => set({ remoteSearchNextPageToken: token }),
  appendRemoteSearchResults: (results) =>
    set((state) => {
      // Deduplicate against existing local + remote results
      const existingIds = new Set([
        ...state.activeSearchResults.map((e) => e.id),
        ...state.remoteSearchResults.map((e) => e.id),
      ]);
      const uniqueNew = results.filter((e) => !existingIds.has(e.id));
      return {
        remoteSearchResults: [...state.remoteSearchResults, ...uniqueNew],
      };
    }),
  setRemoteSearchLoadingMore: (loading) => set({ remoteSearchLoadingMore: loading }),

  // View mode actions
  setViewMode: (mode) => set({ viewMode: mode }),

  // Sidebar tab actions
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  cycleSidebarTab: () =>
    set((state) => {
      const tabs = state.availableSidebarTabs;
      if (tabs.length <= 1) return state;
      const currentIndex = tabs.indexOf(state.sidebarTab);
      const nextIndex = (currentIndex + 1) % tabs.length;
      return { sidebarTab: tabs[nextIndex] };
    }),
  setAvailableSidebarTabs: (tabs) => set({ availableSidebarTabs: tabs }),

  // Network/offline actions
  setOnline: (online) => set({ isOnline: online }),
  setOutboxStats: (stats) => set({ outboxStats: stats }),

  // Pending removal actions
  savePendingRemoval: (emailId, emails) =>
    set((state) => {
      const next = new Map(state.pendingRemovals);
      next.set(emailId, emails);
      return { pendingRemovals: next };
    }),
  restorePendingRemoval: (emailId) =>
    set((state) => {
      const saved = state.pendingRemovals.get(emailId);
      if (!saved || saved.length === 0) return {};
      const next = new Map(state.pendingRemovals);
      next.delete(emailId);
      const existingIds = new Set(state.emails.map((e) => e.id));
      const toRestore = saved.filter((e) => !existingIds.has(e.id));
      return { pendingRemovals: next, emails: [...state.emails, ...toRestore] };
    }),
  clearPendingRemoval: (emailId) =>
    set((state) => {
      if (!state.pendingRemovals.has(emailId)) return {};
      const next = new Map(state.pendingRemovals);
      next.delete(emailId);
      return { pendingRemovals: next };
    }),

  // Multi-select actions
  toggleThreadSelected: (threadId) =>
    set((state) => {
      const next = new Set(state.selectedThreadIds);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return { selectedThreadIds: next, lastSelectedThreadId: threadId };
    }),
  setThreadsSelected: (threadIds) =>
    set(() => ({
      selectedThreadIds: new Set(threadIds),
      lastSelectedThreadId: threadIds.length > 0 ? threadIds[threadIds.length - 1] : null,
    })),
  clearSelectedThreads: () => set({ selectedThreadIds: new Set(), lastSelectedThreadId: null }),
  selectAllThreads: (threadIds) =>
    set(() => ({
      selectedThreadIds: new Set(threadIds),
      lastSelectedThreadId: threadIds.length > 0 ? threadIds[threadIds.length - 1] : null,
    })),
  setLastSelectedThreadId: (threadId) => set({ lastSelectedThreadId: threadId }),

  // Scheduled send actions
  setScheduledMessageStats: (stats) => set({ scheduledMessageStats: stats }),

  // Inbox splits actions
  setSplits: (splits) => set({ splits }),
  setCurrentSplitId: (id) => set({ currentSplitId: id }),

  // Theme actions
  setThemePreference: (preference) => set({ themePreference: preference }),
  setResolvedTheme: (theme) => set({ resolvedTheme: theme }),

  // Inbox density actions
  setInboxDensity: (density) => set({ inboxDensity: density }),
  setKeyboardBindings: (bindings) => set({ keyboardBindings: bindings }),

  // Archive-ready actions
  setArchiveReadyThreads: (items) =>
    set(() => {
      const newIds = new Set<string>();
      const newReasons = new Map<string, string>();
      for (const item of items) {
        newIds.add(item.threadId);
        newReasons.set(item.threadId, item.reason);
      }
      return { archiveReadyThreadIds: newIds, archiveReadyReasons: newReasons };
    }),
  removeArchiveReadyThread: (threadId) =>
    set((state) => {
      const newIds = new Set(state.archiveReadyThreadIds);
      newIds.delete(threadId);
      const newReasons = new Map(state.archiveReadyReasons);
      newReasons.delete(threadId);
      return { archiveReadyThreadIds: newIds, archiveReadyReasons: newReasons };
    }),
  clearArchiveReadyThreads: () =>
    set({ archiveReadyThreadIds: new Set(), archiveReadyReasons: new Map() }),

  // Recently replied actions
  addRecentlyRepliedThread: (threadId) =>
    set((state) => {
      const newMap = new Map(state.recentlyRepliedThreadIds);
      newMap.set(threadId, Date.now());
      return { recentlyRepliedThreadIds: newMap };
    }),
  removeRecentlyRepliedThread: (threadId) =>
    set((state) => {
      if (!state.recentlyRepliedThreadIds.has(threadId)) return state;
      const newMap = new Map(state.recentlyRepliedThreadIds);
      newMap.delete(threadId);
      return { recentlyRepliedThreadIds: newMap };
    }),

  // Snooze actions
  addSnoozedThread: (snoozedEmail) =>
    set((state) => {
      const newIds = new Set(state.snoozedThreadIds);
      newIds.add(snoozedEmail.threadId);
      const newMap = new Map(state.snoozedThreads);
      newMap.set(snoozedEmail.threadId, snoozedEmail);
      return { snoozedThreadIds: newIds, snoozedThreads: newMap };
    }),
  removeSnoozedThread: (threadId) =>
    set((state) => {
      const newIds = new Set(state.snoozedThreadIds);
      newIds.delete(threadId);
      const newMap = new Map(state.snoozedThreads);
      newMap.delete(threadId);
      return { snoozedThreadIds: newIds, snoozedThreads: newMap };
    }),
  setSnoozedThreads: (snoozedEmails) =>
    set((state) => {
      const newIds = new Set<string>();
      const newMap = new Map<string, SnoozedEmail>();
      for (const se of snoozedEmails) {
        newIds.add(se.threadId);
        newMap.set(se.threadId, se);
      }
      // Avoid creating new Set reference if contents are identical — prevents
      // useThreadedEmails memo invalidation on EmailList remount.
      const oldIds = state.snoozedThreadIds;
      const sameIds = oldIds.size === newIds.size && [...newIds].every((id) => oldIds.has(id));
      return {
        snoozedThreadIds: sameIds ? oldIds : newIds,
        snoozedThreads: newMap,
      };
    }),
  // Atomic remove-from-snoozed + add-to-recently-unsnoozed in a single set() call
  // to prevent race conditions where separate set() calls could be interleaved
  handleThreadUnsnoozed: (threadId, returnTime) =>
    set((state) => {
      const newSnoozedIds = new Set(state.snoozedThreadIds);
      newSnoozedIds.delete(threadId);
      const newSnoozedMap = new Map(state.snoozedThreads);
      newSnoozedMap.delete(threadId);
      const newRecentIds = new Set(state.recentlyUnsnoozedThreadIds);
      newRecentIds.add(threadId);
      const newReturnTimes = new Map(state.unsnoozedReturnTimes);
      newReturnTimes.set(threadId, returnTime);
      return {
        snoozedThreadIds: newSnoozedIds,
        snoozedThreads: newSnoozedMap,
        recentlyUnsnoozedThreadIds: newRecentIds,
        unsnoozedReturnTimes: newReturnTimes,
      };
    }),
  addRecentlyUnsnoozedThread: (threadId, returnTime) =>
    set((state) => {
      const newIds = new Set(state.recentlyUnsnoozedThreadIds);
      newIds.add(threadId);
      const newTimes = new Map(state.unsnoozedReturnTimes);
      if (returnTime !== undefined) {
        newTimes.set(threadId, returnTime);
      }
      return { recentlyUnsnoozedThreadIds: newIds, unsnoozedReturnTimes: newTimes };
    }),
  removeRecentlyUnsnoozedThread: (threadId) =>
    set((state) => {
      if (!state.recentlyUnsnoozedThreadIds.has(threadId)) return state;
      const newIds = new Set(state.recentlyUnsnoozedThreadIds);
      newIds.delete(threadId);
      const newTimes = new Map(state.unsnoozedReturnTimes);
      newTimes.delete(threadId);
      return { recentlyUnsnoozedThreadIds: newIds, unsnoozedReturnTimes: newTimes };
    }),
  setShowSnoozeMenu: (show) => set({ showSnoozeMenu: show }),

  // Draft-edit learned actions
  setDraftEditLearned: (data) => set({ draftEditLearned: data }),
  clearDraftEditLearned: () => set({ draftEditLearned: null }),
  // Analysis override learned actions
  setAnalysisOverrideLearned: (data) => set({ analysisOverrideLearned: data }),
  clearAnalysisOverrideLearned: () => set({ analysisOverrideLearned: null }),
  setHighlightMemoryIds: (ids) => set({ highlightMemoryIds: ids }),

  // Undo send actions
  setUndoSendDelay: (seconds) => set({ undoSendDelaySeconds: seconds }),
  addUndoSend: (item) => set((state) => ({ undoSendQueue: [...state.undoSendQueue, item] })),
  removeUndoSend: (id) =>
    set((state) => ({ undoSendQueue: state.undoSendQueue.filter((i) => i.id !== id) })),

  // Undo archive/delete actions — merges rapid-fire operations of the same
  // type into a single undo action so one toast shows "N threads archived"
  // instead of stacking separate toasts. The timer resets on each merge so
  // you get 5s after the last action. Different types (e.g. archive then
  // trash) or different accounts remain separate items.
  addUndoAction: (item) =>
    set((state) => {
      const existing = state.undoActionQueue.find(
        (i) =>
          i.type === item.type &&
          i.accountId === item.accountId &&
          // Don't merge into an item whose timer has already elapsed —
          // it is executing or about to execute; treat the new press as a fresh action.
          i.scheduledAt + i.delayMs > Date.now(),
      );
      if (existing) {
        const merged: UndoActionItem = {
          ...existing,
          emails: [...existing.emails, ...item.emails],
          threadCount: existing.threadCount + item.threadCount,
          scheduledAt: Date.now(),
          archiveReadyThreadIds:
            existing.archiveReadyThreadIds || item.archiveReadyThreadIds
              ? [...(existing.archiveReadyThreadIds || []), ...(item.archiveReadyThreadIds || [])]
              : undefined,
          previousLabels:
            existing.previousLabels || item.previousLabels
              ? { ...(existing.previousLabels || {}), ...(item.previousLabels || {}) }
              : undefined,
          snoozedThreadIds:
            existing.snoozedThreadIds || item.snoozedThreadIds
              ? [...(existing.snoozedThreadIds || []), ...(item.snoozedThreadIds || [])]
              : undefined,
        };
        return {
          undoActionQueue: state.undoActionQueue.map((i) => (i.id === existing.id ? merged : i)),
        };
      }
      return { undoActionQueue: [...state.undoActionQueue, item] };
    }),
  removeUndoAction: (id) =>
    set((state) => ({ undoActionQueue: state.undoActionQueue.filter((i) => i.id !== id) })),

  // Auth actions
  addExpiredAccount: (accountId) =>
    set((state) => {
      const newSet = new Set(state.expiredAccountIds);
      newSet.add(accountId);
      return { expiredAccountIds: newSet };
    }),
  removeExpiredAccount: (accountId) =>
    set((state) => {
      const newSet = new Set(state.expiredAccountIds);
      newSet.delete(accountId);
      return { expiredAccountIds: newSet };
    }),
  addExtensionAuthRequired: (extensionId, displayName, message) =>
    set((state) => {
      const newMap = new Map(state.extensionAuthRequired);
      newMap.set(extensionId, { displayName, message });
      return { extensionAuthRequired: newMap };
    }),
  removeExtensionAuthRequired: (extensionId) =>
    set((state) => {
      const newMap = new Map(state.extensionAuthRequired);
      newMap.delete(extensionId);
      return { extensionAuthRequired: newMap };
    }),
  addAgentAuthRequired: (providerId, displayName, message) =>
    set((state) => {
      const newMap = new Map(state.agentAuthRequired);
      newMap.set(providerId, { displayName, message });
      return { agentAuthRequired: newMap };
    }),
  removeAgentAuthRequired: (providerId) =>
    set((state) => {
      const newMap = new Map(state.agentAuthRequired);
      newMap.delete(providerId);
      return { agentAuthRequired: newMap };
    }),

  // Agent actions
  setAgentPaletteOpen: (open) => set({ isAgentPaletteOpen: open }),
  toggleAgentsSidebar: () => set((state) => ({ isAgentsSidebarOpen: !state.isAgentsSidebarOpen })),
  setSelectedAgentIds: (ids) => set({ selectedAgentIds: ids }),
  setDefaultAgentIds: (ids) => set({ defaultAgentIds: ids }),
  setAvailableProviders: (providers) => set({ availableProviders: providers }),

  startAgentTask: (taskId, emailId, providerIds, prompt, context) => {
    const runs: Record<string, AgentProviderRun> = {};
    for (const id of providerIds) {
      runs[id] = { status: "running", events: [] };
    }
    set((state) => {
      // Clean up old taskId mapping for this email to prevent stale event routing
      const newMap = { ...state.agentTaskIdMap };
      const oldTask = state.agentTasks[emailId];
      if (oldTask) {
        delete newMap[oldTask.taskId];
      }
      newMap[taskId] = emailId;
      return {
        agentTasks: {
          ...state.agentTasks,
          [emailId]: { taskId, emailId, providerIds, prompt, context, status: "running", runs },
        },
        agentTaskIdMap: newMap,
        sidebarTab: "agent" as const,
      };
    });
  },

  followUpAgentTask: (emailId, prompt) =>
    set((state) => {
      const task = state.agentTasks[emailId];
      if (!task) return {};

      // Extract providerConversationIds from runs and persist in context
      // so they survive across follow-up cycles
      const providerConversationIds: Record<string, string> = {
        ...task.context.providerConversationIds,
      };

      const updatedRuns = { ...task.runs };
      for (const [id, run] of Object.entries(updatedRuns)) {
        if (run.providerConversationId) {
          providerConversationIds[id] = run.providerConversationId;
        }
        updatedRuns[id] = {
          ...run,
          status: "running",
          events: [...run.events, { type: "user_message" as const, text: prompt, providerId: id }],
        };
      }

      const updatedContext = {
        ...task.context,
        providerConversationIds,
      };

      return {
        agentTasks: {
          ...state.agentTasks,
          [emailId]: { ...task, status: "running", context: updatedContext, runs: updatedRuns },
        },
      };
    }),

  appendAgentEvent: (taskId, event) =>
    set((state) => {
      const emailId = state.agentTaskIdMap[taskId];
      if (!emailId) return {};

      const task = state.agentTasks[emailId];
      if (!task) return {};

      const providerId = event.providerId ?? task.providerIds[0];
      if (!providerId) return {};

      const run = task.runs[providerId];
      if (!run) return {};

      const updatedRun: AgentProviderRun = { ...run, events: [...run.events, event] };

      // Capture remote conversation ID for follow-ups
      if (event.providerConversationId) {
        updatedRun.providerConversationId = event.providerConversationId;
      }

      // Nested sub-agent events (nestedRunId set) are appended to the events
      // array for rendering inside the parent tool call card, but must NOT
      // change the parent run's status — the sub-agent completing doesn't
      // mean the orchestrating agent (e.g. Claude) is done.
      if (!event.nestedRunId) {
        if (event.type === "confirmation_required") {
          updatedRun.pendingConfirmation = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            description: event.description,
            input: event.input,
          };
          updatedRun.status = "pending_approval";
        } else if (event.type === "state") {
          updatedRun.status = event.state;
          if (event.state !== "pending_approval") {
            updatedRun.pendingConfirmation = undefined;
          }
        } else if (event.type === "error") {
          updatedRun.status = "failed";
        } else if (event.type === "done") {
          updatedRun.status = "completed";
        }
      }

      const updatedRuns = { ...task.runs, [providerId]: updatedRun };

      // Derive overall task status from all runs
      const allRuns = Object.values(updatedRuns);
      let taskStatus = task.status;
      if (allRuns.every((r) => r.status === "completed")) {
        taskStatus = "completed";
      } else if (allRuns.some((r) => r.status === "failed")) {
        taskStatus = "failed";
      } else if (allRuns.some((r) => r.status === "pending_approval")) {
        taskStatus = "pending_approval";
      }

      return {
        agentTasks: {
          ...state.agentTasks,
          [emailId]: { ...task, runs: updatedRuns, status: taskStatus },
        },
      };
    }),

  replayAgentTrace: (taskId, emailId, providerIds, prompt, context, events) =>
    set((state) => {
      // Build runs with all events in one pass (avoids N separate appendAgentEvent calls)
      const runs: Record<string, AgentProviderRun> = {};
      for (const id of providerIds) {
        runs[id] = { status: "running", events: [] };
      }

      // Truncate large string values in events to prevent storing 100MB+ of
      // email body data. The full data lives in the DB; this is just for display.
      const MAX_STR_LEN = 5_000;
      const truncateValue = (val: unknown): unknown => {
        if (typeof val === "string") {
          return val.length > MAX_STR_LEN ? val.slice(0, MAX_STR_LEN) + "\n…[truncated]" : val;
        }
        if (Array.isArray(val)) return val.map(truncateValue);
        if (val && typeof val === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(val)) {
            out[k] = truncateValue(v);
          }
          return out;
        }
        return val;
      };

      for (const rawEvent of events) {
        // Shallow-clone and truncate large payloads in tool_call_start/end events
        let event = rawEvent;
        if (rawEvent.type === "tool_call_start" && rawEvent.input) {
          event = { ...rawEvent, input: truncateValue(rawEvent.input) };
        } else if (rawEvent.type === "tool_call_end" && rawEvent.result !== undefined) {
          event = { ...rawEvent, result: truncateValue(rawEvent.result) };
        }
        const providerId = event.providerId ?? providerIds[0];
        if (!providerId || !runs[providerId]) continue;
        const run = runs[providerId];
        run.events.push(event);

        if (event.providerConversationId) {
          run.providerConversationId = event.providerConversationId;
        }

        if (!event.nestedRunId) {
          if (event.type === "confirmation_required") {
            run.pendingConfirmation = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              description: event.description,
              input: event.input,
            };
            run.status = "pending_approval";
          } else if (event.type === "state") {
            run.status = event.state;
            if (event.state !== "pending_approval") {
              run.pendingConfirmation = undefined;
            }
          } else if (event.type === "error") {
            run.status = "failed";
          } else if (event.type === "done") {
            run.status = "completed";
          }
        }
      }

      // Derive overall task status
      const allRuns = Object.values(runs);
      let taskStatus: AgentTaskInfo["status"] = "running";
      if (allRuns.every((r) => r.status === "completed")) {
        taskStatus = "completed";
      } else if (allRuns.some((r) => r.status === "failed")) {
        taskStatus = "failed";
      } else if (allRuns.some((r) => r.status === "pending_approval")) {
        taskStatus = "pending_approval";
      }

      // Clean up old taskId mapping
      const newMap = { ...state.agentTaskIdMap };
      const oldTask = state.agentTasks[emailId];
      if (oldTask) {
        delete newMap[oldTask.taskId];
      }
      newMap[taskId] = emailId;

      return {
        agentTasks: {
          ...state.agentTasks,
          [emailId]: { taskId, emailId, providerIds, prompt, context, status: taskStatus, runs },
        },
        agentTaskIdMap: newMap,
        sidebarTab: "agent" as const,
      };
    }),

  completeAgentTask: (taskId, summary) =>
    set((state) => {
      const emailId = state.agentTaskIdMap[taskId];
      if (!emailId) return {};

      const task = state.agentTasks[emailId];
      if (!task || task.status === "completed") return {};

      const entry: AgentTaskHistoryEntry = {
        taskId: task.taskId,
        providerIds: task.providerIds,
        prompt: task.prompt,
        timestamp: Date.now(),
        status: "completed",
        summary,
      };
      return {
        agentTasks: {
          ...state.agentTasks,
          [emailId]: { ...task, status: "completed" },
        },
        agentTaskHistory: [...state.agentTaskHistory, entry],
        // Keep globalAgentTaskKey so the user can return to the completed task
        // from the inbox view (Esc back to no-email-selected state).
      };
    }),

  cancelAgentTask: (taskId) =>
    set((state) => {
      const emailId = state.agentTaskIdMap[taskId];
      if (!emailId) return {};

      const task = state.agentTasks[emailId];
      if (!task || task.status === "cancelled" || task.status === "completed") return {};

      const entry: AgentTaskHistoryEntry = {
        taskId: task.taskId,
        providerIds: task.providerIds,
        prompt: task.prompt,
        timestamp: Date.now(),
        status: "cancelled",
      };
      return {
        agentTasks: {
          ...state.agentTasks,
          [emailId]: { ...task, status: "cancelled" },
        },
        agentTaskHistory: [...state.agentTaskHistory, entry],
        // Keep globalAgentTaskKey so the user can return to the cancelled task
      };
    }),

  updateAgentTaskId: (emailId, newTaskId) =>
    set((state) => {
      const task = state.agentTasks[emailId];
      if (!task) return {};
      // Remove old mapping, add new one
      const { [task.taskId]: _, ...restMap } = state.agentTaskIdMap;
      return {
        agentTasks: {
          ...state.agentTasks,
          [emailId]: { ...task, taskId: newTaskId },
        },
        agentTaskIdMap: { ...restMap, [newTaskId]: emailId },
      };
    }),

  getAgentTaskForEmail: (emailId) => get().agentTasks[emailId],
  setGlobalAgentTaskKey: (key) => set({ globalAgentTaskKey: key }),

  // Local drafts actions
  setLocalDrafts: (drafts) => set({ localDrafts: drafts }),
  addLocalDraft: (draft) => set((state) => ({ localDrafts: [draft, ...state.localDrafts] })),
  removeLocalDraft: (draftId) =>
    set((state) => ({ localDrafts: state.localDrafts.filter((d) => d.id !== draftId) })),
  updateLocalDraft: (draftId, updates) =>
    set((state) => ({
      localDrafts: state.localDrafts.map((d) => (d.id === draftId ? { ...d, ...updates } : d)),
    })),
  setSelectedDraftId: (id) => set({ selectedDraftId: id }),

  // Sent emails actions
  setSentEmails: (emails) => set({ sentEmails: emails }),
  addSentEmails: (newEmails) =>
    set((state) => {
      const existingIds = new Set(state.sentEmails.map((e) => e.id));
      const uniqueNew = newEmails.filter((e) => !existingIds.has(e.id));
      if (uniqueNew.length === 0) return state;
      return { sentEmails: [...uniqueNew, ...state.sentEmails] };
    }),

  markThreadAsRead: (threadId) => {
    const state = get();
    const accountId = state.currentAccountId;
    if (!accountId) return;

    const threadEmails = state.emails.filter((e) => e.threadId === threadId);
    const unreadEmails = threadEmails.filter((e) => e.labelIds?.includes("UNREAD"));
    if (unreadEmails.length === 0) return;

    const unreadIds = new Set(unreadEmails.map((e) => e.id));

    // Register these IDs as optimistically read. This guard persists across
    // ANY store mutation (setEmails, addEmails, sync buffer flush) so stale
    // data from the DB or sync events can never revert the mark-as-read.
    addOptimisticReads(unreadIds);

    // Also clear any already-buffered stale label updates in the sync buffer.
    clearPendingLabelUpdates(unreadIds);

    // Optimistic store update — synchronous, before any rendering
    set((s) => ({
      emails: s.emails.map((email) =>
        unreadIds.has(email.id)
          ? { ...email, labelIds: (email.labelIds || ["INBOX"]).filter((l) => l !== "UNREAD") }
          : email,
      ),
      sentEmails: s.sentEmails.map((email) =>
        unreadIds.has(email.id)
          ? { ...email, labelIds: (email.labelIds || ["INBOX"]).filter((l) => l !== "UNREAD") }
          : email,
      ),
    }));

    // Fire-and-forget Gmail API calls
    for (const email of unreadEmails) {
      window.api.emails.setRead(email.id, accountId, true).catch((err: Error) => {
        console.error("Failed to mark email as read:", err);
      });
    }
  },
}));

// Expose store for E2E tests
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ = useAppStore;
}

/**
 * Collect a safe snapshot of app state for crash reporting.
 * Only includes aggregate/boolean values — no PII, no account IDs, no email content.
 */
export function getAppStateSnapshot(): Record<string, unknown> {
  const s = useAppStore.getState();
  const state: Record<string, unknown> = {};

  state.email_count = s.emails.length;
  state.has_selected_email = s.selectedEmailId != null;
  state.has_selected_thread = s.selectedThreadId != null;
  state.account_count = s.accounts.length;
  state.is_loading = s.isLoading;
  state.is_analyzing = s.isAnalyzing;
  state.has_error = s.error != null;
  state.show_settings = s.showSettings;
  state.view_mode = s.viewMode;
  state.is_online = s.isOnline;
  state.is_search_open = s.isSearchOpen;
  state.has_active_query = s.activeSearchQuery != null;
  state.compose_state = s.composeState ? "open" : null;
  state.is_inline_reply_open = s.isInlineReplyOpen;

  // Aggregate sync status counts only — no per-account IDs
  const syncValues = [...s.syncStatuses.values()];
  state.sync_account_count = syncValues.length;
  state.sync_status_summary = {
    syncing: syncValues.filter((v) => v === "syncing").length,
    idle: syncValues.filter((v) => v === "idle").length,
    error: syncValues.filter((v) => v === "error").length,
  };

  state.prefetch = {
    status: s.prefetchProgress.status,
    queue_length: s.prefetchProgress.queueLength,
    processed: s.prefetchProgress.processed,
  };

  if (s.outboxStats) {
    state.outbox = {
      pending: s.outboxStats.pending,
      sending: s.outboxStats.sending,
      failed: s.outboxStats.failed,
      total: s.outboxStats.total,
    };
  }

  state.expired_account_count = s.expiredAccountIds.size;

  return state;
}

// Check if an email is sent by the user (not received)
function isSentEmail(email: DashboardEmail, currentUserEmail?: string): boolean {
  // Check labelIds first (most reliable)
  if (email.labelIds?.includes("SENT")) {
    return true;
  }

  // Fall back to checking the from field
  if (!currentUserEmail) return false;
  const fromLower = email.from.toLowerCase();
  const userEmailLower = currentUserEmail.toLowerCase();
  // Extract email from "Name <email>" format if present
  const emailMatch = fromLower.match(/<([^>]+)>/) || [null, fromLower];
  const fromEmail = emailMatch[1] || fromLower;
  return fromEmail.trim() === userEmailLower.trim();
}

// Helper to group emails by thread
export function groupByThread(emails: DashboardEmail[], currentUserEmail?: string): EmailThread[] {
  const threadMap = new Map<string, DashboardEmail[]>();

  // Pre-compute timestamps once to avoid creating Date objects in every sort
  // comparison. With 1000+ emails and multiple sorts, this avoids tens of
  // thousands of redundant Date allocations per groupByThread call.
  const dateCache = new Map<string, number>();
  for (const email of emails) {
    dateCache.set(email.id, new Date(email.date).getTime());
  }

  // Group emails by threadId
  for (const email of emails) {
    const existing = threadMap.get(email.threadId) || [];
    existing.push(email);
    threadMap.set(email.threadId, existing);
  }

  // Convert to threads, sorted by date within each thread
  const threads: EmailThread[] = [];
  for (const [threadId, threadEmails] of threadMap) {
    // Sort emails within thread by date (oldest first for conversation view)
    threadEmails.sort((a, b) => dateCache.get(a.id)! - dateCache.get(b.id)!);

    const latestEmail = threadEmails[threadEmails.length - 1];

    // Find the latest RECEIVED email (not sent by user) for inbox sorting
    const receivedEmails = threadEmails.filter((e) => !isSentEmail(e, currentUserEmail));
    const latestReceivedEmail =
      receivedEmails.length > 0 ? receivedEmails[receivedEmails.length - 1] : latestEmail; // Fallback to latest if all are sent

    // Determine if the user was the last to reply
    const userReplied = isSentEmail(latestEmail, currentUserEmail);

    // Find the best sender to display - last person who isn't the current user.
    // Handles edge cases where latestReceivedEmail falls back to the user's own email
    // (e.g., thread with only sent emails, or emails missing SENT label).
    let displaySender: string;
    if (!isSentEmail(latestReceivedEmail, currentUserEmail)) {
      displaySender = latestReceivedEmail.from;
    } else {
      // latestReceivedEmail is from user - find any non-self email
      const nonSelfEmail = [...threadEmails]
        .reverse()
        .find((e) => !isSentEmail(e, currentUserEmail));
      if (nonSelfEmail) {
        displaySender = nonSelfEmail.from;
      } else {
        // All emails are from user - show the recipient instead
        displaySender = latestEmail.to;
      }
    }

    // Use the latest RECEIVED email's analysis/draft status for the thread
    // This ensures sent replies don't reset the thread's analyzed status
    // For drafts, check all emails in the thread — the agent may draft on
    // an email that isn't the latestReceivedEmail.
    const threadDraft = latestReceivedEmail.draft ?? threadEmails.find((e) => e.draft)?.draft;

    threads.push({
      threadId,
      emails: threadEmails,
      latestEmail,
      latestReceivedEmail,
      latestReceivedDate: dateCache.get(latestReceivedEmail.id)!,
      // Use oldest email's subject. Strip Re: if the oldest email is a reply
      // (has inReplyTo, or subject starts with Re: for pre-backfill data).
      // Fwd: is never stripped — a forward IS the original from the recipient's view.
      subject:
        threadEmails[0].inReplyTo || /^Re:\s/i.test(threadEmails[0].subject)
          ? threadEmails[0].subject.replace(/^(Re:\s*)+/i, "")
          : threadEmails[0].subject,
      hasMultipleEmails: threadEmails.length > 1,
      isUnread: threadEmails.some((e) => e.labelIds?.includes("UNREAD")),
      analysis: latestReceivedEmail.analysis,
      draft: threadDraft,
      userReplied,
      displaySender,
    });
  }

  // Sort threads by latest RECEIVED email date (most recent first)
  // This ensures sent replies don't bump threads to the top
  threads.sort((a, b) => b.latestReceivedDate - a.latestReceivedDate);

  return threads;
}

// Grace period (ms) before a recently-replied thread moves to "skipped".
// Keeps the thread in place so the user can naturally move to the next email.
const REPLY_GRACE_PERIOD_MS = 3 * 60 * 1000; // 3 minutes

// Selector for threaded and filtered emails
export function useThreadedEmails() {
  const emails = useAppStore((state) => state.emails);
  const currentAccountId = useAppStore((state) => state.currentAccountId);
  const accounts = useAppStore((state) => state.accounts);
  const snoozedThreadIds = useAppStore((state) => state.snoozedThreadIds);
  const recentlyRepliedThreadIds = useAppStore((state) => state.recentlyRepliedThreadIds);

  // Get current user's email for sent detection
  const currentAccount = accounts.find((a) => a.id === currentAccountId);
  const currentUserEmail = currentAccount?.email;

  // Memoize the expensive thread computation. j/k navigation only changes
  // selectedEmailId — none of these deps change, so the memo short-circuits
  // and avoids re-running groupByThread + categorization on every keypress.
  return useMemo(() => {
    // Filter emails by current account (if set) AND by INBOX label
    // Include emails without labelIds for backwards compatibility (older synced emails)
    // Exclude emails that explicitly have labelIds but don't include INBOX (archived/sent-only)
    const isInboxEmail = (e: DashboardEmail) => {
      if (!e.labelIds) return true; // No labels = legacy inbox email
      return e.labelIds.includes("INBOX");
    };

    const accountEmails = currentAccountId
      ? emails.filter(
          (e) =>
            e.accountId === currentAccountId && (isInboxEmail(e) || e.labelIds?.includes("SENT")),
        )
      : emails.filter((e) => isInboxEmail(e) || e.labelIds?.includes("SENT"));

    // Group into threads first, passing current user email for sent detection
    // Then filter out sent-only threads — threads where no email has the INBOX label.
    // Sent emails within inbox threads are kept (for conversation context), but threads
    // consisting solely of sent emails belong in the Sent view, not the inbox.
    const allThreads = groupByThread(accountEmails, currentUserEmail).filter((t) =>
      t.emails.some((e) => !e.labelIds || e.labelIds.includes("INBOX")),
    );

    // Separate snoozed threads from active threads
    const activeThreads = allThreads.filter((t) => !snoozedThreadIds.has(t.threadId));
    const snoozed = allThreads.filter((t) => snoozedThreadIds.has(t.threadId));

    // Check if a thread is within the reply grace period — if so, treat userReplied
    // as false for categorization so the thread doesn't immediately jump to "skipped".
    const now = Date.now();
    const isInGracePeriod = (threadId: string): boolean => {
      const repliedAt = recentlyRepliedThreadIds.get(threadId);
      if (repliedAt === undefined) return false;
      return now - repliedAt < REPLY_GRACE_PERIOD_MS;
    };

    // For categorization, override userReplied for threads in the grace period
    const effectiveUserReplied = (t: EmailThread): boolean =>
      t.userReplied && !isInGracePeriod(t.threadId);

    // Categorize active threads (not snoozed)
    // Threads where the user already replied (or sent) go straight to "skipped" —
    // they stay there until a new received email arrives or archive-ready re-analysis runs.
    // Exception: threads within the reply grace period keep their current position.
    const needsReply = activeThreads.filter(
      (t) => t.analysis?.needsReply && t.draft?.status !== "created" && !effectiveUserReplied(t),
    );
    const done = activeThreads.filter(
      (t) => t.analysis?.needsReply && t.draft?.status === "created" && !effectiveUserReplied(t),
    );
    const skipped = activeThreads.filter(
      (t) => (t.analysis && !t.analysis.needsReply) || effectiveUserReplied(t),
    );
    const unanalyzed = activeThreads.filter((t) => !t.analysis && !effectiveUserReplied(t));

    // Sort needsReply by priority (high > medium > low)
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const sortedNeedsReply = [...needsReply].sort((a, b) => {
      const aPriority = priorityOrder[a.analysis?.priority || "medium"] ?? 1;
      const bPriority = priorityOrder[b.analysis?.priority || "medium"] ?? 1;
      return aPriority - bPriority;
    });

    // Ordered threads: unanalyzed → needs reply (by priority) → done → skipped
    const threads = [...unanalyzed, ...sortedNeedsReply, ...done, ...skipped];

    return {
      threads,
      chronologicalThreads: activeThreads, // sorted by latestReceivedDate desc (from groupByThread)
      needsReply: sortedNeedsReply,
      done,
      skipped,
      skippedCount: skipped.length,
      unanalyzed,
      snoozed,
      snoozedCount: snoozed.length,
    };
  }, [emails, currentAccountId, currentUserEmail, snoozedThreadIds, recentlyRepliedThreadIds]);
}

function threadMatchesSplit(thread: EmailThread, split: InboxSplit): boolean {
  return emailMatchesSplit(thread.latestEmail, split);
}

// Selector for split-filtered threaded emails
// Applies the current split filter on top of useThreadedEmails results
export function useSplitFilteredThreads() {
  const baseResult = useThreadedEmails();
  const allSplits = useAppStore((state) => state.splits);
  const currentAccountId = useAppStore((state) => state.currentAccountId);
  const accounts = useAppStore((state) => state.accounts);
  const currentSplitId = useAppStore((state) => state.currentSplitId);
  const archiveReadyThreadIds = useAppStore((state) => state.archiveReadyThreadIds);
  const recentlyUnsnoozedThreadIds = useAppStore((state) => state.recentlyUnsnoozedThreadIds);
  const unsnoozedReturnTimes = useAppStore((state) => state.unsnoozedReturnTimes);
  const sentEmails = useAppStore((state) => state.sentEmails);

  return useMemo(() => {
    // Filter splits for current account
    const splits = allSplits.filter((s) => s.accountId === currentAccountId);

    // Helper to filter out threads matching exclusive splits (unless recently unsnoozed)
    const exclusiveSplits = splits.filter((s) => s.exclusive);
    const excludeExclusive = (threads: EmailThread[]) => {
      if (exclusiveSplits.length === 0) return threads;
      return threads.filter(
        (t) =>
          recentlyUnsnoozedThreadIds.has(t.threadId) ||
          !exclusiveSplits.some((s) => threadMatchesSplit(t, s)),
      );
    };

    // Handle snoozed virtual split — show snoozed threads as the main list
    if (currentSplitId === "__snoozed__") {
      return {
        threads: baseResult.snoozed,
        needsReply: [],
        done: [],
        skipped: [],
        skippedCount: 0,
        unanalyzed: [],
        snoozed: [],
        snoozedCount: 0,
      };
    }

    // Handle sent virtual split — show sent emails grouped by thread
    if (currentSplitId === "__sent__") {
      const currentAccount = accounts.find((a) => a.id === currentAccountId);
      const currentUserEmail = currentAccount?.email;
      const sentAccountEmails = currentAccountId
        ? sentEmails.filter((e) => e.accountId === currentAccountId)
        : sentEmails;
      const sentThreads = groupByThread(sentAccountEmails, currentUserEmail).sort(
        (a, b) => new Date(b.latestEmail.date).getTime() - new Date(a.latestEmail.date).getTime(),
      );

      return {
        threads: sentThreads,
        needsReply: [],
        done: [],
        skipped: [],
        skippedCount: 0,
        unanalyzed: [],
        snoozed: baseResult.snoozed,
        snoozedCount: baseResult.snoozedCount,
      };
    }

    // Handle archive-ready virtual split
    // Archive Ready is a strict subset of the "All" inbox — exclude threads
    // that belong to exclusive splits so they only appear in their own tab.
    if (currentSplitId === "__archive-ready__") {
      const filterByArchiveReady = (threads: EmailThread[]) =>
        excludeExclusive(threads).filter((t) => archiveReadyThreadIds.has(t.threadId));

      const threads = filterByArchiveReady(baseResult.threads);
      const needsReply = filterByArchiveReady(baseResult.needsReply);
      const done = filterByArchiveReady(baseResult.done);
      const skipped = filterByArchiveReady(baseResult.skipped);
      const unanalyzed = filterByArchiveReady(baseResult.unanalyzed);

      return {
        threads,
        needsReply,
        done,
        skipped,
        skippedCount: skipped.length,
        unanalyzed,
        snoozed: baseResult.snoozed,
        snoozedCount: baseResult.snoozedCount,
      };
    }

    // "All" tab (null): chronological order, no priority grouping.
    // Unsnoozed threads sort by their return time instead of received date.
    if (!currentSplitId) {
      let chronoThreads = excludeExclusive(baseResult.chronologicalThreads);

      // Re-sort with unsnoozed return times overriding the received date
      if (unsnoozedReturnTimes.size > 0) {
        chronoThreads = [...chronoThreads].sort((a, b) => {
          const aTime = unsnoozedReturnTimes.get(a.threadId) ?? a.latestReceivedDate;
          const bTime = unsnoozedReturnTimes.get(b.threadId) ?? b.latestReceivedDate;
          return bTime - aTime;
        });
      }

      const skipped = excludeExclusive(baseResult.skipped);
      return {
        threads: chronoThreads,
        needsReply: excludeExclusive(baseResult.needsReply),
        done: excludeExclusive(baseResult.done),
        skipped,
        skippedCount: skipped.length,
        unanalyzed: excludeExclusive(baseResult.unanalyzed),
        snoozed: baseResult.snoozed,
        snoozedCount: baseResult.snoozedCount,
      };
    }

    // "Priority" tab: only emails with a priority (high/medium/low) — subset of inbox
    if (currentSplitId === "__priority__") {
      const needsReply = excludeExclusive(baseResult.needsReply);
      const done = excludeExclusive(baseResult.done);
      const threads = [...needsReply, ...done];

      return {
        threads,
        needsReply,
        done,
        skipped: [],
        skippedCount: 0,
        unanalyzed: [],
        snoozed: baseResult.snoozed,
        snoozedCount: baseResult.snoozedCount,
      };
    }

    // "Other" tab: everything in All minus Priority (needsReply + done)
    if (currentSplitId === "__other__") {
      const priorityThreadIds = new Set(
        [...excludeExclusive(baseResult.needsReply), ...excludeExclusive(baseResult.done)].map(
          (t) => t.threadId,
        ),
      );

      let otherThreads = excludeExclusive(baseResult.chronologicalThreads).filter(
        (t) => !priorityThreadIds.has(t.threadId),
      );

      if (unsnoozedReturnTimes.size > 0) {
        otherThreads = [...otherThreads].sort((a, b) => {
          const aTime = unsnoozedReturnTimes.get(a.threadId) ?? a.latestReceivedDate;
          const bTime = unsnoozedReturnTimes.get(b.threadId) ?? b.latestReceivedDate;
          return bTime - aTime;
        });
      }

      const skipped = excludeExclusive(baseResult.skipped);
      const unanalyzed = excludeExclusive(baseResult.unanalyzed);
      return {
        threads: otherThreads,
        needsReply: [],
        done: [],
        skipped,
        skippedCount: skipped.length,
        unanalyzed,
        snoozed: baseResult.snoozed,
        snoozedCount: baseResult.snoozedCount,
      };
    }

    const currentSplit = splits.find((s) => s.id === currentSplitId);
    if (!currentSplit) {
      return baseResult;
    }

    // Apply split filter to each category
    const filterBySplit = (threads: EmailThread[]) =>
      threads.filter((t) => threadMatchesSplit(t, currentSplit));

    const threads = filterBySplit(baseResult.threads);
    const needsReply = filterBySplit(baseResult.needsReply);
    const done = filterBySplit(baseResult.done);
    const skipped = filterBySplit(baseResult.skipped);
    const unanalyzed = filterBySplit(baseResult.unanalyzed);

    return {
      threads,
      needsReply,
      done,
      skipped,
      skippedCount: skipped.length,
      unanalyzed,
      snoozed: baseResult.snoozed,
      snoozedCount: baseResult.snoozedCount,
    };
  }, [
    baseResult,
    allSplits,
    currentAccountId,
    accounts,
    currentSplitId,
    archiveReadyThreadIds,
    recentlyUnsnoozedThreadIds,
    unsnoozedReturnTimes,
    sentEmails,
  ]);
}

// Legacy selector for backwards compatibility
export function useFilteredEmails() {
  const emails = useAppStore((state) => state.emails);
  const showSkipped = useAppStore((state) => state.showSkipped);

  // Sort by date (most recent first)
  const sortedEmails = [...emails].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  // Separate emails by category
  const needsReply = sortedEmails.filter(
    (e) => e.analysis?.needsReply && e.draft?.status !== "created",
  );
  const done = sortedEmails.filter((e) => e.analysis?.needsReply && e.draft?.status === "created");
  const skipped = sortedEmails.filter((e) => e.analysis && !e.analysis.needsReply);
  const unanalyzed = sortedEmails.filter((e) => !e.analysis);

  return {
    needsReply,
    done,
    skipped: showSkipped ? skipped : [],
    skippedCount: skipped.length,
    unanalyzed,
  };
}
