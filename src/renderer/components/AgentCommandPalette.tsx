import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppStore } from "../store";
import type { AgentContext } from "../../shared/agent-types";
import { trackEvent } from "../services/posthog";

import type { DashboardEmail } from "../../shared/types";

/** Strip HTML tags and decode entities to get plain text for remote agents */
function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent?.trim() ?? "";
}

// --- Quick actions when an email IS selected ---
const EMAIL_QUICK_ACTIONS = [
  {
    id: "draft-reply",
    label: "Draft a reply to this thread",
    icon: "M3 10l9-7 9 7M3 10v10a1 1 0 001 1h16a1 1 0 001-1V10",
  },
  {
    id: "summarize",
    label: "Summarize this conversation",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
  {
    id: "lookup-sender",
    label: "Look up the sender",
    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  },
  {
    id: "archive-label",
    label: "Archive and label as handled",
    icon: "M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4",
  },
  {
    id: "find-related",
    label: "Find related emails from this sender",
    icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  },
];

// --- Quick actions when a local draft IS selected (built dynamically based on recipient count) ---
function getDraftQuickActions(recipientCount: number) {
  const actions = [
    {
      id: "refine-draft",
      label: "Refine this draft",
      icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    },
  ];
  if (recipientCount > 0) {
    actions.push({
      id: "lookup-recipient",
      label: recipientCount === 1 ? "Look up the recipient" : "Look up the recipients",
      icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
    });
  }
  actions.push(
    {
      id: "improve-subject",
      label: "Improve the subject line",
      icon: "M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z",
    },
    {
      id: "check-tone",
      label: "Check the tone and clarity",
      icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    },
  );
  return actions;
}

// --- Quick actions when NO email is selected (general-purpose) ---
const GENERAL_QUICK_ACTIONS = [
  {
    id: "compose-new",
    label: "Draft a new email",
    icon: "M3 10l9-7 9 7M3 10v10a1 1 0 001 1h16a1 1 0 001-1V10",
  },
  {
    id: "search-inbox",
    label: "Search my inbox",
    icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  },
  {
    id: "lookup-person",
    label: "Look up a person or company",
    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  },
  {
    id: "summarize-inbox",
    label: "Summarize my inbox",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
];

/**
 * Derive suggested actions based on the selected email's context.
 * These appear above quick actions when an email with analysis is selected.
 */
function getSuggestedActions(
  email: DashboardEmail | undefined,
): Array<{ id: string; label: string; icon: string }> {
  if (!email) return [];
  const suggestions: Array<{ id: string; label: string; icon: string }> = [];

  const analysis = email.analysis;
  if (analysis?.needsReply && !email.draft) {
    // High-priority email with no draft — suggest drafting
    if (analysis.priority === "high") {
      suggestions.push({
        id: "suggest-urgent-reply",
        label: "Draft an urgent reply to this email",
        icon: "M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
      });
    } else {
      suggestions.push({
        id: "suggest-reply",
        label: "Draft a reply",
        icon: "M3 10l9-7 9 7M3 10v10a1 1 0 001 1h16a1 1 0 001-1V10",
      });
    }
  }

  if (analysis && !analysis.needsReply) {
    // No reply needed — suggest archiving
    suggestions.push({
      id: "suggest-archive",
      label: "Archive this email (no reply needed)",
      icon: "M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4",
    });
  }

  if (email.draft && email.draft.status !== "created") {
    // Has a draft that hasn't been sent — suggest refining
    suggestions.push({
      id: "suggest-refine",
      label: "Refine the current draft",
      icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    });
  }

  return suggestions;
}

// detectProviderRouting removed — agent selection is now explicit via dropdown

function fuzzyMatch(text: string, query: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerText.includes(lowerQuery)) return true;
  const words = lowerQuery.split(/\s+/);
  return words.every((w) => lowerText.includes(w));
}

interface AgentCommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AgentCommandPalette({ isOpen, onClose }: AgentCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    selectedAgentIds,
    availableProviders,
    setSelectedAgentIds,
    setAvailableProviders,
    selectedEmailId,
    selectedThreadId,
    selectedDraftId,
    localDrafts,
    currentAccountId,
    accounts,
    emails,
    startAgentTask,
    setGlobalAgentTaskKey,
  } = useAppStore();

  const hasEmail = Boolean(selectedEmailId);

  // Get current email context
  const selectedEmail = useMemo(
    () => emails.find((e) => e.id === selectedEmailId),
    [emails, selectedEmailId],
  );

  // Get current draft context (local drafts from compose)
  const selectedDraft = useMemo(
    () => (selectedDraftId ? localDrafts.find((d) => d.id === selectedDraftId) : undefined),
    [localDrafts, selectedDraftId],
  );
  const hasDraft = Boolean(selectedDraft);

  const currentAccount = useMemo(
    () => accounts.find((a) => a.id === currentAccountId),
    [accounts, currentAccountId],
  );

  // Suggested actions based on email context
  const suggestedActions = useMemo(() => getSuggestedActions(selectedEmail), [selectedEmail]);

  // Pick the right quick actions depending on selection state
  const quickActions = hasEmail
    ? EMAIL_QUICK_ACTIONS
    : selectedDraft
      ? getDraftQuickActions(selectedDraft.to.length)
      : GENERAL_QUICK_ACTIONS;

  // Filter quick actions by query
  const filteredActions = useMemo(() => {
    const allActions = [...suggestedActions, ...quickActions];
    if (!query.trim()) return allActions;
    return allActions.filter((a) => fuzzyMatch(a.label, query));
  }, [query, suggestedActions, quickActions]);

  // When the palette opens, fetch real provider list from the backend if we don't have one yet.
  // Also auto-select "claude" when nothing is selected.
  useEffect(() => {
    if (!isOpen) return;

    if (selectedAgentIds.length === 0) {
      setSelectedAgentIds(["claude"]);
    }

    if (availableProviders.length === 0) {
      // Request provider list from backend; the onProviders listener in App.tsx
      // will update the store when the response arrives.
      window.api?.agent?.providers?.();
    }
  }, [
    isOpen,
    selectedAgentIds.length,
    availableProviders.length,
    setSelectedAgentIds,
    setAvailableProviders,
  ]);

  // Reset state when opened/closed
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleSubmit = useCallback(
    async (prompt: string) => {
      if (!prompt.trim()) return;
      if (selectedAgentIds.length === 0) return;

      const effectiveProviderIds = selectedAgentIds;
      const effectivePrompt = prompt;

      // Build context — include email metadata only when an email is selected
      const context: AgentContext = {
        accountId: currentAccountId ?? "",
        userEmail: currentAccount?.email ?? "",
        userName: currentAccount?.displayName,
      };

      // The task key is the emailId when an email is selected, draft key for
      // local drafts, or a global sentinel for general tasks.
      let taskKey: string;

      if (selectedEmailId && selectedEmail) {
        taskKey = selectedEmailId;
        context.currentEmailId = selectedEmailId;
        context.currentThreadId = selectedThreadId ?? undefined;
        context.emailSubject = selectedEmail.subject;
        context.emailFrom = selectedEmail.from;
        context.emailBody = selectedEmail.body ? stripHtml(selectedEmail.body) : undefined;
      } else if (selectedDraftId && selectedDraft) {
        taskKey = `draft:${selectedDraftId}`;
        context.currentDraftId = selectedDraftId;
        context.currentThreadId = selectedDraft.threadId;
        context.emailSubject = selectedDraft.subject;
        context.emailTo = selectedDraft.to.join(", ");
        context.emailBody =
          selectedDraft.bodyText || stripHtml(selectedDraft.bodyHtml) || undefined;
      } else {
        // Use a unique key per non-email run so multiple can coexist in agentTasks
        const globalTaskId = crypto.randomUUID();
        taskKey = globalTaskId;
        setGlobalAgentTaskKey(taskKey);
      }

      // Generate taskId on the frontend so the store mapping is populated
      // before any backend events arrive (avoids race condition).
      // For non-email runs, taskId === taskKey (both are the UUID).
      const taskId =
        taskKey.startsWith("draft:") || selectedEmailId ? crypto.randomUUID() : taskKey;
      startAgentTask(taskId, taskKey, effectiveProviderIds, effectivePrompt, context);

      // Create a session record so the command palette launch is tracked in session history
      const now = Date.now();
      useAppStore.getState().createSession({
        id: taskId,
        title:
          effectivePrompt.length > 40
            ? effectivePrompt.slice(0, 40).replace(/\s+\S*$/, "") + "..."
            : effectivePrompt,
        emailId: selectedEmailId || null,
        threadId: selectedThreadId || null,
        accountId: currentAccountId || "",
        providerIds: effectiveProviderIds,
        createdAt: now,
        updatedAt: now,
        status: "active",
        runs: Object.fromEntries(
          effectiveProviderIds.map((pid) => [pid, { status: "running" as const, events: [] }]),
        ),
      });

      trackEvent("agent_run_started", {
        source: "manual",
        provider_count: effectiveProviderIds.length,
      });

      // Close palette immediately for responsiveness
      onClose();

      // Await the IPC result — if the backend fails to start (missing worker, bad API key, etc.)
      // we need to surface the error so the user doesn't see "Running" forever.
      const result = (await window.api?.agent?.run?.(
        taskId,
        effectiveProviderIds,
        effectivePrompt,
        context,
      )) as { success: boolean; error?: string } | undefined;
      if (result && !result.success) {
        const store = useAppStore.getState();
        store.appendAgentEvent(taskId, {
          type: "error",
          message: result.error ?? "Failed to start agent task",
          providerId: effectiveProviderIds[0],
        });
        // Clean up the optimistically-created session so it doesn't linger as 'active'
        store.updateSessionInStore(taskId, { status: "failed" });
      }
    },
    [
      selectedAgentIds,
      currentAccountId,
      selectedEmailId,
      selectedDraftId,
      selectedThreadId,
      currentAccount,
      selectedEmail,
      selectedDraft,
      startAgentTask,
      setGlobalAgentTaskKey,
      onClose,
    ],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filteredActions.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (query.trim()) {
            handleSubmit(query);
          } else if (filteredActions[selectedIndex]) {
            handleSubmit(filteredActions[selectedIndex].label);
          }
          break;
      }
    },
    [filteredActions, selectedIndex, query, handleSubmit, onClose],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Palette panel */}
      <div className="relative w-full max-w-xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl dark:shadow-black/40 overflow-hidden border border-gray-200 dark:border-gray-700">
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <svg
            className="w-5 h-5 text-purple-500 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 14.5M14.25 3.104c.251.023.501.05.75.082M19.8 14.5l-2.425 2.425a2.25 2.25 0 00-.659 1.591v2.234"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              hasEmail
                ? "Ask agent about this email..."
                : hasDraft
                  ? "Ask agent about this draft..."
                  : "Ask agent anything..."
            }
            className="flex-1 text-base outline-none placeholder-gray-400 dark:text-gray-100 dark:placeholder-gray-500 bg-transparent"
          />
          <kbd className="px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
            esc
          </kbd>
        </div>

        {/* Agent selector + context indicator */}
        <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700/50 flex items-center gap-2 flex-wrap">
          {availableProviders.length > 0 ? (
            availableProviders.map((p) => {
              const isSelected = selectedAgentIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    // Single-select: clicking a provider selects it exclusively
                    setSelectedAgentIds([p.id]);
                  }}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full transition-colors ${
                    isSelected
                      ? "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 ring-1 ring-purple-300 dark:ring-purple-700"
                      : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                  }`}
                >
                  {p.icon && <span>{p.icon}</span>}
                  {p.name}
                </button>
              );
            })
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">No agents available</span>
          )}

          {selectedEmail ? (
            <>
              <span className="text-gray-300 dark:text-gray-600">|</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px]">
                {selectedEmail.subject}
              </span>
            </>
          ) : selectedDraft ? (
            <>
              <span className="text-gray-300 dark:text-gray-600">|</span>
              <span className="text-xs text-orange-500 dark:text-orange-400 truncate max-w-[200px]">
                Draft: {selectedDraft.subject || "(no subject)"}
              </span>
            </>
          ) : (
            <>
              <span className="text-gray-300 dark:text-gray-600">|</span>
              <span className="text-xs text-purple-500 dark:text-purple-400">No email context</span>
            </>
          )}
        </div>

        {/* Quick actions */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {filteredActions.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              No matching actions. Press Enter to send custom prompt.
            </div>
          ) : (
            <>
              {suggestedActions.length > 0 && !query.trim() && (
                <div className="px-4 py-1.5 text-xs font-medium text-purple-500 dark:text-purple-400 uppercase tracking-wider">
                  Suggested
                </div>
              )}
              {filteredActions.map((action, idx) => {
                const isSelected = idx === selectedIndex;
                const isSuggested = suggestedActions.some((s) => s.id === action.id);

                // Show "Quick Actions" header before the first non-suggested action
                const showQuickHeader =
                  !query.trim() &&
                  !isSuggested &&
                  (idx === 0 ||
                    suggestedActions.some((s) => s.id === filteredActions[idx - 1]?.id));

                return (
                  <div key={action.id}>
                    {showQuickHeader && (
                      <div className="px-4 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                        Quick Actions
                      </div>
                    )}
                    <button
                      data-index={idx}
                      onClick={() => handleSubmit(action.label)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full px-4 py-2 flex items-center gap-3 text-left text-sm transition-colors ${
                        isSelected
                          ? "bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                          : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      }`}
                    >
                      <svg
                        className={`w-5 h-5 flex-shrink-0 ${
                          isSuggested
                            ? "text-purple-400 dark:text-purple-500"
                            : "text-gray-400 dark:text-gray-500"
                        }`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d={action.icon} />
                      </svg>
                      <span className="flex-1">{action.label}</span>
                      {isSuggested && (
                        <span className="text-xs text-purple-400 dark:text-purple-500">
                          suggested
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <span>
            <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">&uarr;&darr;</kbd>{" "}
            navigate
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Enter</kbd> run
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

export default AgentCommandPalette;
