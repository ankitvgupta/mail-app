import { memo, useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useAppStore } from "../store";
import type { ScopedAgentEvent, AgentTaskState, AgentSession } from "../../shared/agent-types";
import { AgentConfirmationDialog } from "./AgentConfirmationDialog";
import { ChatMessage } from "./AgentPanel/ChatMessage";
import { CollapsedToolCalls } from "./AgentPanel/CollapsedToolCalls";
import { TypingIndicator } from "./AgentPanel/TypingIndicator";
import { ThreadBar } from "./AgentPanel/ThreadBar";
import { ChatInput } from "./AgentPanel/ChatInput";
import { SessionDropdown } from "./AgentPanel/SessionDropdown";
import { trackEvent } from "../services/posthog";

// ---------------------------------------------------------------------------
// Helpers kept from old implementation
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: AgentTaskState }) {
  const config: Record<AgentTaskState, { label: string; classes: string }> = {
    running: {
      label: "Running",
      classes: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300",
    },
    pending_approval: {
      label: "Awaiting Approval",
      classes: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300",
    },
    pending_async: {
      label: "Waiting",
      classes: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400",
    },
    completed: {
      label: "Completed",
      classes: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300",
    },
    failed: {
      label: "Failed",
      classes: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
    },
    cancelled: {
      label: "Cancelled",
      classes: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
    },
  };

  const { label, classes } = config[status];
  return <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${classes}`}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Event grouping for chat display
// ---------------------------------------------------------------------------

type ChatGroup =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tools"; events: ScopedAgentEvent[] }
  | { kind: "confirmation"; event: ScopedAgentEvent }
  | { kind: "error"; message: string };

function groupEventsForChat(events: ScopedAgentEvent[]): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let textBuffer = "";
  let toolBuffer: ScopedAgentEvent[] = [];

  function flushText() {
    if (textBuffer.trim()) {
      groups.push({ kind: "agent", text: textBuffer.trim() });
      textBuffer = "";
    }
  }

  function flushTools() {
    if (toolBuffer.length > 0) {
      groups.push({ kind: "tools", events: [...toolBuffer] });
      toolBuffer = [];
    }
  }

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        flushTools();
        textBuffer += (event as ScopedAgentEvent & { type: "text_delta" }).text;
        break;
      case "user_message":
        flushText();
        flushTools();
        groups.push({
          kind: "user",
          text: (event as ScopedAgentEvent & { type: "user_message" }).text,
        });
        break;
      case "tool_call_start":
      case "tool_call_end":
      case "tool_call_pending":
        flushText();
        toolBuffer.push(event);
        break;
      case "confirmation_required":
        flushText();
        flushTools();
        groups.push({ kind: "confirmation", event });
        break;
      case "error":
        flushText();
        flushTools();
        groups.push({
          kind: "error",
          message: (event as ScopedAgentEvent & { type: "error" }).message,
        });
        break;
      case "done":
        flushText();
        flushTools();
        break;
      case "state":
        break; // Skip in chat display
    }
  }
  flushText();
  flushTools();
  return groups;
}

/** Collect all events across all runs in a session or task, in order */
function collectAllEvents(
  runs: Record<string, { events: ScopedAgentEvent[] }>,
): ScopedAgentEvent[] {
  const all: ScopedAgentEvent[] = [];
  for (const run of Object.values(runs)) {
    all.push(...run.events);
  }
  return all;
}

// ---------------------------------------------------------------------------
// AgentTabContent — chat interface
// ---------------------------------------------------------------------------

export const AgentTabContent = memo(function AgentTabContent({ emailId }: { emailId: string }) {
  // Session-based state (new system)
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const agentSessions = useAppStore((s) => s.agentSessions);
  const currentAccountId = useAppStore((s) => s.currentAccountId);
  const selectedEmailId = useAppStore((s) => s.selectedEmailId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const emails = useAppStore((s) => s.emails);
  const availableProviders = useAppStore((s) => s.availableProviders);
  const selectedAgentIds = useAppStore((s) => s.selectedAgentIds);
  const startAgentTask = useAppStore((s) => s.startAgentTask);
  const createSession = useAppStore((s) => s.createSession);
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);
  const loadSessionList = useAppStore((s) => s.loadSessionList);
  const followUpAgentTask = useAppStore((s) => s.followUpAgentTask);

  // Legacy fallback state (old system)
  const legacyTask = useAppStore((s) => s.agentTasks[emailId]);
  const cancelAgentTask = useAppStore((s) => s.cancelAgentTask);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);

  // Determine active data source: session first, then legacy task
  const activeSession = activeSessionId ? agentSessions[activeSessionId] : null;

  // Load session list on mount and when account changes
  useEffect(() => {
    if (currentAccountId) {
      loadSessionList(currentAccountId);
    }
  }, [currentAccountId, loadSessionList]);

  // Compute chat groups from either session or legacy task
  const allEvents = useMemo(() => {
    if (activeSession) {
      return collectAllEvents(activeSession.runs);
    }
    if (legacyTask) {
      return collectAllEvents(legacyTask.runs);
    }
    return [];
  }, [activeSession, legacyTask]);

  const chatGroups = useMemo(() => groupEventsForChat(allEvents), [allEvents]);

  const currentStatus: AgentTaskState | null = activeSession
    ? activeSession.status === "active"
      ? "running"
      : activeSession.status === "failed"
        ? "failed"
        : activeSession.status === "cancelled"
          ? "cancelled"
          : "completed"
    : legacyTask
      ? legacyTask.status
      : null;

  const isRunning = currentStatus === "running";

  // Auto-scroll when new events arrive
  useEffect(() => {
    if (isScrolledToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allEvents.length, isScrolledToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsScrolledToBottom(atBottom);
  }, []);

  // Build thread context from emails in the store
  const buildThreadContext = useCallback((): string => {
    if (!selectedThreadId) return "";
    const threadEmails = emails
      .filter((e) => e.threadId === selectedThreadId)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (threadEmails.length === 0) return "";

    const parts = threadEmails.map((e) => {
      const from = e.from || "Unknown";
      const date = new Date(e.date).toLocaleString();
      const body = e.snippet || "(no content)";
      return `From: ${from}\nDate: ${date}\n${body}`;
    });

    return [
      "Here is the email thread for context:",
      "",
      ...parts.map((p, i) => `--- Message ${i + 1} ---\n${p}`),
      "",
    ].join("\n");
  }, [selectedThreadId, emails]);

  const handleSend = useCallback(
    async (message: string) => {
      const accountId = currentAccountId;
      if (!accountId) return;

      const providerIds =
        selectedAgentIds.length > 0
          ? selectedAgentIds
          : availableProviders.length > 0
            ? [availableProviders[0].id]
            : ["claude"];

      const threadContext = buildThreadContext();
      const fullPrompt = threadContext ? `${threadContext}\n\n${message}` : message;

      const context = {
        accountId,
        currentEmailId: selectedEmailId || undefined,
        currentThreadId: selectedThreadId || undefined,
        userEmail: "",
      };

      // Decide: follow up on existing session, or create new
      if (
        activeSession &&
        (activeSession.status === "completed" || activeSession.status === "failed")
      ) {
        // Follow-up on existing session — use legacy follow-up path for now
        // The session's taskId is also its ID
        followUpAgentTask(emailId, message);
        const newTaskId = crypto.randomUUID();
        useAppStore.getState().updateAgentTaskId(emailId, newTaskId);
        trackEvent("agent_follow_up", { source: "chat_panel" });

        const result = (await window.api?.agent?.run?.(
          newTaskId,
          providerIds,
          fullPrompt,
          context,
        )) as { success: boolean; error?: string } | undefined;

        if (result && !result.success) {
          useAppStore.getState().appendAgentEvent(newTaskId, {
            type: "error",
            message: result.error ?? "Failed to start agent task",
            providerId: providerIds[0],
          });
        }
      } else if (
        !activeSession &&
        legacyTask &&
        (legacyTask.status === "completed" || legacyTask.status === "failed")
      ) {
        // Follow-up on legacy task
        followUpAgentTask(emailId, message);
        const newTaskId = crypto.randomUUID();
        useAppStore.getState().updateAgentTaskId(emailId, newTaskId);
        trackEvent("agent_follow_up", { source: "chat_panel" });

        const result = (await window.api?.agent?.run?.(
          newTaskId,
          providerIds,
          fullPrompt,
          context,
        )) as { success: boolean; error?: string } | undefined;

        if (result && !result.success) {
          useAppStore.getState().appendAgentEvent(newTaskId, {
            type: "error",
            message: result.error ?? "Failed to start agent task",
            providerId: providerIds[0],
          });
        }
      } else {
        // Create new session
        const sessionId = crypto.randomUUID();
        const session: AgentSession = {
          id: sessionId,
          title: message.slice(0, 60) + (message.length > 60 ? "..." : ""),
          emailId: selectedEmailId,
          threadId: selectedThreadId,
          accountId,
          providerIds,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "active",
          runs: {},
        };
        createSession(session);
        trackEvent("agent_session_created", { source: "chat_panel" });

        // Also create legacy task so event routing works
        startAgentTask(sessionId, emailId, providerIds, message, context);

        const result = (await window.api?.agent?.run?.(
          sessionId,
          providerIds,
          fullPrompt,
          context,
        )) as { success: boolean; error?: string } | undefined;

        if (result && !result.success) {
          useAppStore.getState().appendAgentEvent(sessionId, {
            type: "error",
            message: result.error ?? "Failed to start agent task",
            providerId: providerIds[0],
          });
        }
      }
    },
    [
      currentAccountId,
      selectedAgentIds,
      availableProviders,
      buildThreadContext,
      selectedEmailId,
      selectedThreadId,
      activeSession,
      legacyTask,
      emailId,
      followUpAgentTask,
      createSession,
      startAgentTask,
    ],
  );

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
  }, [setActiveSessionId]);

  const handleCancel = useCallback(() => {
    if (activeSession) {
      window.api?.agent?.cancel?.(activeSession.id);
      cancelAgentTask(activeSession.id);
    } else if (legacyTask) {
      window.api?.agent?.cancel?.(legacyTask.taskId);
      cancelAgentTask(legacyTask.taskId);
    }
  }, [activeSession, legacyTask, cancelAgentTask]);

  // Empty state — no session or legacy task
  const hasContent = chatGroups.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Session dropdown */}
      <SessionDropdown onNewChat={handleNewChat} />

      {/* Status header (when running or has status) */}
      {currentStatus && (
        <div className="h-8 flex items-center justify-between px-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <StatusChip status={currentStatus} />
          {isRunning && (
            <button
              onClick={handleCancel}
              className="p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 rounded transition-colors"
              title="Cancel"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Scrollable message area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-1"
      >
        {!hasContent && (
          <div className="flex flex-col items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500 gap-2">
            <span>No messages yet.</span>
            <span className="text-xs">Type a message below or press Cmd+J</span>
          </div>
        )}

        {chatGroups.map((group, i) => {
          switch (group.kind) {
            case "user":
              return <ChatMessage key={`user-${i}`} role="user" content={group.text} />;
            case "agent":
              return <ChatMessage key={`agent-${i}`} role="agent" content={group.text} />;
            case "tools":
              return <CollapsedToolCalls key={`tools-${i}`} events={group.events} />;
            case "confirmation":
              return (
                <AgentConfirmationDialog
                  key={`confirm-${i}`}
                  toolCallId={
                    (group.event as ScopedAgentEvent & { type: "confirmation_required" }).toolCallId
                  }
                  toolName={
                    (group.event as ScopedAgentEvent & { type: "confirmation_required" }).toolName
                  }
                  description={
                    (group.event as ScopedAgentEvent & { type: "confirmation_required" })
                      .description
                  }
                  input={
                    (group.event as ScopedAgentEvent & { type: "confirmation_required" }).input
                  }
                />
              );
            case "error":
              return (
                <div
                  key={`error-${i}`}
                  className="px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300"
                >
                  {group.message}
                </div>
              );
          }
        })}

        {isRunning && <TypingIndicator />}
      </div>

      {/* Thread bar */}
      <ThreadBar />

      {/* Chat input */}
      <ChatInput
        onSend={handleSend}
        disabled={isRunning}
        placeholder={
          isRunning
            ? "Agent is working..."
            : hasContent
              ? "Follow up..."
              : "Ask about this thread..."
        }
      />
    </div>
  );
});

export default AgentTabContent;
