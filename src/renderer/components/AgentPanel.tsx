import { memo, useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppStore } from "../store";
import type { ScopedAgentEvent, AgentTaskState, AgentTaskInfo } from "../../shared/agent-types";
import { AgentConfirmationDialog } from "./AgentConfirmationDialog";
import { trackEvent } from "../services/posthog";

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

/** Render accumulated text_delta events as markdown */
function TextBlock({ events }: { events: ScopedAgentEvent[] }) {
  const text = events
    .filter((e): e is ScopedAgentEvent & { type: "text_delta" } => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

  if (!text) return null;

  return (
    <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function UserMessageBlock({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 py-2">
      <div className="w-5 h-5 rounded-full bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center flex-shrink-0 mt-0.5">
        <svg
          className="w-3 h-3 text-purple-600 dark:text-purple-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
          />
        </svg>
      </div>
      <div className="flex-1 text-sm text-gray-800 dark:text-gray-200 font-medium">{text}</div>
    </div>
  );
}

/** Convert "mcp__server__select_query" or "select_query" → "Select Query" */
function humanizeToolName(name: string): string {
  // Strip MCP prefix: "mcp__server-name__tool_name" → "tool_name"
  const base = name.startsWith("mcp__") ? name.split("__").pop()! : name;
  return base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Heuristic: should this key/value pair render as a code block? */
function shouldRenderAsCode(key: string, value: string): boolean {
  const codeKeys = ["query", "sql", "code", "script", "command", "body"];
  if (codeKeys.some((k) => key.toLowerCase().includes(k))) return true;
  if (value.includes("\n") && value.length > 60) return true;
  const sqlKeywords =
    /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|JOIN|GROUP BY|ORDER BY|HAVING|UNION|WITH)\b/i;
  return sqlKeywords.test(value);
}

const SQL_KEYWORDS =
  /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|AS|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|WITH|COUNT|SUM|AVG|MIN|MAX|COALESCE|CAST|ASC|DESC)\b/gi;

function SqlHighlight({ code }: { code: string }) {
  // Split by SQL keywords, wrapping matches in colored spans
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset lastIndex for the global regex
  SQL_KEYWORDS.lastIndex = 0;

  while ((match = SQL_KEYWORDS.exec(code)) !== null) {
    if (match.index > lastIndex) {
      parts.push(code.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className="text-blue-400 font-semibold">
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < code.length) {
    parts.push(code.slice(lastIndex));
  }

  return <>{parts}</>;
}

/** Pick a tool icon based on tool name */
function ToolIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (
    lower.includes("query") ||
    lower.includes("sql") ||
    lower.includes("db") ||
    lower.includes("database")
  ) {
    // Database icon
    return (
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
      >
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
      </svg>
    );
  }
  if (lower.includes("search") || lower.includes("find") || lower.includes("lookup")) {
    // Search icon
    return (
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
      >
        <circle cx="11" cy="11" r="8" />
        <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
      </svg>
    );
  }
  // Default: wrench/tool icon
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085"
      />
    </svg>
  );
}

function ToolCallEvent({
  event,
  isDone,
  result,
}: {
  event: ScopedAgentEvent & { type: "tool_call_start" };
  isDone: boolean;
  result?: unknown;
}) {
  const [resultExpanded, setResultExpanded] = useState(false);
  const [inputExpanded, setInputExpanded] = useState(false);

  // Lazy: only stringify when the user expands the result section.
  // Tool results can be very large (e.g. 23MB email bodies) and JSON.stringify
  // is O(n) — computing this eagerly on mount causes visible lag.
  const resultStr = resultExpanded && result !== undefined ? JSON.stringify(result, null, 2) : "";
  const hasResult = result !== undefined;

  // Parse input into key-value pairs
  const inputObj: Record<string, unknown> =
    event.input && typeof event.input === "object" && !Array.isArray(event.input)
      ? (event.input as Record<string, unknown>)
      : {};
  const inputEntries = Object.entries(inputObj).filter(([, v]) => v !== undefined && v !== null);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden my-2">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
        <ToolIcon name={event.toolName} />
        <span className="text-xs font-medium">{humanizeToolName(event.toolName)}</span>
        {!isDone && (
          <svg
            className="w-3.5 h-3.5 text-blue-500 animate-spin ml-auto"
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
        )}
      </div>

      {/* Input parameters */}
      {inputEntries.length > 0 && (
        <div className="px-3 py-2 space-y-1.5">
          {inputEntries.map(([key, value]) => {
            // Cap display strings to avoid rendering multi-MB values in the DOM.
            // Trace replay already truncates stored events, but live runs may have large values.
            const INPUT_DISPLAY_LIMIT = 5_000;
            const rawStr = typeof value === "string" ? value : JSON.stringify(value, null, 2);
            const strValue =
              rawStr.length > INPUT_DISPLAY_LIMIT
                ? rawStr.slice(0, INPUT_DISPLAY_LIMIT) + "\n…[truncated]"
                : rawStr;
            const isCode = shouldRenderAsCode(key, strValue);
            const CODE_TRUNCATE_LIMIT = 200;
            const isTruncated = isCode && strValue.length > CODE_TRUNCATE_LIMIT;
            const displayValue =
              isTruncated && !inputExpanded ? strValue.slice(0, CODE_TRUNCATE_LIMIT) : strValue;

            return (
              <div key={key}>
                <span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium">
                  {key}
                </span>
                {isCode ? (
                  <>
                    <pre className="mt-0.5 text-xs bg-gray-900 dark:bg-gray-950 text-gray-300 rounded p-2 overflow-x-auto font-mono">
                      <SqlHighlight code={displayValue} />
                      {isTruncated && !inputExpanded && <span className="text-gray-500">...</span>}
                    </pre>
                    {isTruncated && (
                      <button
                        onClick={() => setInputExpanded(!inputExpanded)}
                        className="text-[10px] text-blue-500 hover:text-blue-400 mt-0.5"
                      >
                        {inputExpanded ? "Show less" : "Show more"}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-700 dark:text-gray-300 mt-0.5 break-words">
                    {strValue || <span className="text-gray-400 italic">empty</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Result section */}
      {isDone && hasResult && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setResultExpanded(!resultExpanded)}
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <svg
              className="w-3 h-3 text-green-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span>{resultExpanded ? "Hide Result" : "Show Result"}</span>
            <svg
              className={`w-3 h-3 ml-auto transition-transform ${resultExpanded ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {resultExpanded && (
            <pre className="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
              {resultStr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorBlock({
  message,
  onAuthRequest,
  onRetry,
}: {
  message: string;
  onAuthRequest?: () => void;
  onRetry?: () => void;
}) {
  if (message === "AGENT_AUTH_REQUIRED") {
    return (
      <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-700 dark:text-amber-300">
        <p className="mb-2">Agent authentication required.</p>
        <button
          onClick={onAuthRequest}
          className="px-3 py-1 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded transition-colors"
        >
          Sign in to agent service
        </button>
      </div>
    );
  }

  if (message === "OPENCLAW_NOT_CONFIGURED") {
    return (
      <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-700 dark:text-amber-300">
        <p>OpenClaw agent not configured. Enable it in Settings → Extensions.</p>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
      <p>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 px-3 py-1 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

function _DoneBlock({ summary }: { summary: string }) {
  return (
    <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-300">
      {summary}
    </div>
  );
}

/** Visual block for sub-agent events — renders as a distinct card with agent name header */
function SubAgentBlock({
  toolName,
  events,
  isDone,
  onAuthRequest,
}: {
  toolName: string;
  events: ScopedAgentEvent[];
  isDone: boolean;
  onAuthRequest?: (providerId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-purple-200 dark:border-purple-800/50 overflow-hidden my-2">
      {/* Agent header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300">
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
          />
        </svg>
        <span className="text-xs font-medium">{humanizeToolName(toolName)}</span>
        {!isDone && (
          <svg
            className="w-3.5 h-3.5 text-purple-500 animate-spin ml-auto"
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
        )}
      </div>
      {/* Nested event timeline */}
      <div className="px-3 py-2">
        <EventTimeline events={events} runFinished={isDone} onAuthRequest={onAuthRequest} />
      </div>
    </div>
  );
}

interface EventTimelineProps {
  events: ScopedAgentEvent[];
  runFinished: boolean;
  onAuthRequest?: (providerId: string) => void;
  onRetry?: () => void;
}

function EventTimeline({ events, runFinished, onAuthRequest, onRetry }: EventTimelineProps) {
  const renderedElements: React.ReactNode[] = [];
  let textBuffer: ScopedAgentEvent[] = [];
  const toolResults = new Map<string, unknown>();

  // Pre-scan: collect tool_call_end results
  for (const evt of events) {
    if (evt.type === "tool_call_end") {
      toolResults.set(evt.toolCallId, evt.result);
    }
  }

  // Identify sub-agent wrapper tool calls and collect their nested events.
  // A wrapper is a tool_call_start (without nestedRunId) whose subsequent events
  // (before its tool_call_end) include events with nestedRunId.
  const subAgentWrappers = new Map<
    string,
    { toolName: string; nestedEvents: ScopedAgentEvent[] }
  >();
  const nestedRunIds = new Set<string>();
  let candidateWrapperId: string | null = null;
  let candidateToolName = "";

  for (const evt of events) {
    if (evt.type === "tool_call_start" && !evt.nestedRunId) {
      candidateWrapperId = evt.toolCallId;
      candidateToolName = evt.toolName;
    }
    if (evt.nestedRunId && candidateWrapperId) {
      if (!subAgentWrappers.has(candidateWrapperId)) {
        subAgentWrappers.set(candidateWrapperId, { toolName: candidateToolName, nestedEvents: [] });
      }
      nestedRunIds.add(evt.nestedRunId);
      // Collect non-lifecycle nested events for rendering inside the block.
      // Strip nestedRunId so the inner EventTimeline renders them normally.
      if (evt.type !== "state" && evt.type !== "done") {
        const { nestedRunId: _, ...clean } = evt;
        subAgentWrappers.get(candidateWrapperId)!.nestedEvents.push(clean as ScopedAgentEvent);
      }
    }
    if (evt.type === "tool_call_end" && evt.toolCallId === candidateWrapperId) {
      candidateWrapperId = null;
    }
  }

  const flushText = () => {
    if (textBuffer.length > 0) {
      renderedElements.push(
        <TextBlock key={`text-${renderedElements.length}`} events={textBuffer} />,
      );
      textBuffer = [];
    }
  };

  for (const evt of events) {
    // Wrapper tool_call_start → render SubAgentBlock with collected nested events
    if (evt.type === "tool_call_start" && subAgentWrappers.has(evt.toolCallId)) {
      flushText();
      const wrapper = subAgentWrappers.get(evt.toolCallId)!;
      const isDone = runFinished || toolResults.has(evt.toolCallId);
      renderedElements.push(
        <SubAgentBlock
          key={`subagent-${evt.toolCallId}`}
          toolName={wrapper.toolName}
          events={wrapper.nestedEvents}
          isDone={isDone}
          onAuthRequest={onAuthRequest}
        />,
      );
      continue;
    }
    // Skip wrapper tool_call_end and all nested events (rendered inside SubAgentBlock)
    if (evt.type === "tool_call_end" && subAgentWrappers.has(evt.toolCallId)) continue;
    if (evt.nestedRunId) continue;

    if (evt.type === "text_delta") {
      textBuffer.push(evt);
      continue;
    }

    flushText();

    if (evt.type === "user_message") {
      renderedElements.push(
        <UserMessageBlock key={`user-${renderedElements.length}`} text={evt.text} />,
      );
    } else if (evt.type === "tool_call_start") {
      const isDone = runFinished || toolResults.has(evt.toolCallId);
      renderedElements.push(
        <ToolCallEvent
          key={`tool-${evt.toolCallId}`}
          event={evt}
          isDone={isDone}
          result={toolResults.get(evt.toolCallId)}
        />,
      );
    } else if (evt.type === "confirmation_required") {
      renderedElements.push(
        <AgentConfirmationDialog
          key={`confirm-${evt.toolCallId}`}
          toolCallId={evt.toolCallId}
          toolName={evt.toolName}
          description={evt.description}
          input={evt.input}
        />,
      );
    } else if (evt.type === "error") {
      // For auth errors, prefer sourceProviderId (the actual sub-agent) over
      // providerId (the parent orchestrator) so the auth handler routes correctly
      const authProviderId = evt.sourceProviderId ?? evt.providerId;
      renderedElements.push(
        <ErrorBlock
          key={`error-${renderedElements.length}`}
          message={evt.message}
          onAuthRequest={
            evt.message === "AGENT_AUTH_REQUIRED" && authProviderId && onAuthRequest
              ? () => onAuthRequest(authProviderId)
              : undefined
          }
          onRetry={runFinished && onRetry ? onRetry : undefined}
        />,
      );
    }
  }

  flushText();

  return <div className="space-y-2">{renderedElements}</div>;
}

/**
 * Build a conversation summary from the task's events for follow-up context.
 * This is included in the system prompt so the agent knows what it already did.
 */
function buildConversationHistory(task: AgentTaskInfo): string {
  const parts: string[] = [`User's original request: ${task.prompt}`, ""];

  for (const [, run] of Object.entries(task.runs)) {
    let assistantText = "";

    for (const event of run.events) {
      switch (event.type) {
        case "text_delta":
          assistantText += event.text;
          break;
        case "tool_call_start":
          if (assistantText) {
            parts.push(`Assistant: ${assistantText}`);
            assistantText = "";
          }
          parts.push(`[Tool call: ${event.toolName}(${JSON.stringify(event.input)})]`);
          break;
        case "tool_call_end": {
          const resultStr = JSON.stringify(event.result);
          // Truncate very long tool results
          const truncResult = resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr;
          parts.push(`[Tool result: ${truncResult}]`);
          break;
        }
        case "user_message":
          if (assistantText) {
            parts.push(`Assistant: ${assistantText}`);
            assistantText = "";
          }
          parts.push(`\nUser follow-up: ${event.text}`);
          break;
        case "done":
          if (assistantText) {
            parts.push(`Assistant: ${assistantText}`);
            assistantText = "";
          }
          break;
      }
    }

    if (assistantText) {
      parts.push(`Assistant: ${assistantText}`);
    }
  }

  return parts.join("\n");
}

/**
 * Agent tab content — renders inside EmailPreviewSidebar as a tab.
 * Shows the agent task timeline, follow-up input, and status for a specific email.
 *
 * Wrapped in memo to prevent parent re-renders (EmailPreviewSidebar) from triggering
 * a full virtual DOM diff of 1000+ EventTimeline elements. With a frozen emailId prop,
 * memo short-circuits the entire component tree when the parent re-renders due to j/k.
 */
export const AgentTabContent = memo(function AgentTabContent({ emailId }: { emailId: string }) {
  const task = useAppStore((s) => s.agentTasks[emailId]);
  const availableProviders = useAppStore((s) => s.availableProviders);
  const cancelAgentTask = useAppStore((s) => s.cancelAgentTask);
  const followUpAgentTask = useAppStore((s) => s.followUpAgentTask);
  const startAgentTask = useAppStore((s) => s.startAgentTask);
  const updateEmail = useAppStore((s) => s.updateEmail);
  const hasPendingDraft = useAppStore((s) => {
    const email = s.emails.find((e) => e.id === emailId);
    return email?.draft?.status === "pending";
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [followUpInput, setFollowUpInput] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Reset follow-up input when switching emails
  useEffect(() => {
    setFollowUpInput("");
  }, [emailId]);

  // Auto-scroll to bottom as new events arrive
  const eventCount = task
    ? Object.values(task.runs).reduce((sum, r) => sum + r.events.length, 0)
    : 0;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [eventCount]);

  // Don't auto-focus the input — it steals j/k keyboard navigation from the email list

  const handleAuth = useCallback(
    async (providerId: string) => {
      if (authenticating) return;
      setAuthenticating(true);
      try {
        const result = (await window.api?.agent?.authenticate?.(providerId)) as
          | { success: boolean; data?: { success: boolean } }
          | undefined;
        // Read fresh state to avoid stale closure if user switched emails during auth
        const currentTask = useAppStore.getState().agentTasks[emailId];
        if (result?.success && result.data?.success && currentTask) {
          // Auth succeeded — retry the agent command with a fresh task
          const newTaskId = crypto.randomUUID();
          const store = useAppStore.getState();
          store.startAgentTask(
            newTaskId,
            emailId,
            currentTask.providerIds,
            currentTask.prompt,
            currentTask.context,
          );
          await window.api?.agent?.run?.(
            newTaskId,
            currentTask.providerIds,
            currentTask.prompt,
            currentTask.context,
          );
        }
      } finally {
        setAuthenticating(false);
      }
    },
    [authenticating, emailId],
  );

  const handleRetry = useCallback(async () => {
    const currentTask = useAppStore.getState().agentTasks[emailId];
    if (!currentTask) return;

    const newTaskId = crypto.randomUUID();
    const store = useAppStore.getState();
    store.startAgentTask(
      newTaskId,
      emailId,
      currentTask.providerIds,
      currentTask.prompt,
      currentTask.context,
    );

    const result = (await window.api?.agent?.run?.(
      newTaskId,
      currentTask.providerIds,
      currentTask.prompt,
      currentTask.context,
    )) as { success: boolean; error?: string } | undefined;
    if (result && !result.success) {
      store.appendAgentEvent(newTaskId, {
        type: "error",
        message: result.error ?? "Failed to start agent task",
        providerId: currentTask.providerIds[0],
      });
    }
  }, [emailId]);

  const handleRegenerate = useCallback(async () => {
    if (regenerating) return;
    setRegenerating(true);
    try {
      // Clear in-memory draft so the email list updates immediately
      updateEmail(emailId, { draft: undefined });

      // Call backend to delete draft, clean up trace, and launch a new agent
      const result = (await window.api?.drafts?.rerunAgent?.(emailId)) as
        | { success: boolean; data?: { taskId: string }; error?: string }
        | undefined;

      if (result?.success && result.data) {
        const { taskId } = result.data;
        // Create the in-memory tracking entry so the Agent tab shows live events.
        // The real context is built by buildAgentDraftContext on the backend — this
        // is only for the store's tracking entry.
        const email = useAppStore.getState().emails.find((e) => e.id === emailId);
        startAgentTask(
          taskId,
          emailId,
          ["claude"],
          task?.prompt || "",
          task?.context || {
            accountId: email?.accountId || "",
            currentEmailId: emailId,
            currentThreadId: email?.threadId || "",
            userEmail: "",
          },
        );
        trackEvent("draft_regenerated", { source: "agent_panel" });
      } else {
        console.error("[AgentPanel] Regenerate failed:", result?.error);
      }
    } finally {
      setRegenerating(false);
    }
  }, [emailId, regenerating, updateEmail, startAgentTask, task]);

  const handleFollowUp = useCallback(async () => {
    const currentTask = useAppStore.getState().agentTasks[emailId];
    if (!followUpInput.trim() || !currentTask) return;

    const prompt = followUpInput.trim();
    setFollowUpInput("");

    // Extract providerConversationIds from existing runs for stateful providers
    // Also merge from context (persisted by followUpAgentTask on previous follow-ups)
    const providerConversationIds: Record<string, string> = {
      ...currentTask.context.providerConversationIds,
    };
    for (const [providerId, run] of Object.entries(currentTask.runs)) {
      if (run.providerConversationId) {
        providerConversationIds[providerId] = run.providerConversationId;
      }
    }

    console.log("[AgentPanel] Follow-up providerConversationIds:", providerConversationIds);

    const hasStatefulProvider = Object.keys(providerConversationIds).length > 0;

    // Build conversation history for stateless providers (e.g. Claude)
    const history = buildConversationHistory(currentTask);
    const compositePrompt = hasStatefulProvider
      ? prompt // Stateful providers have server-side history
      : [
          "Continue the following conversation. Here is what happened so far:",
          "",
          history,
          "",
          `User's new message: ${prompt}`,
          "",
          "Respond to the user's new message. You have access to the same tools as before.",
        ].join("\n");

    // Build updated context with conversation IDs and history
    const updatedContext = {
      ...currentTask.context,
      providerConversationIds: {
        ...currentTask.context.providerConversationIds,
        ...providerConversationIds,
      },
      conversationHistory: history,
    };

    // Generate new taskId and update the mapping before sending to backend
    const newTaskId = crypto.randomUUID();
    followUpAgentTask(emailId, prompt);
    useAppStore.getState().updateAgentTaskId(emailId, newTaskId);
    trackEvent("agent_follow_up", { source: "agent_panel" });

    // Await the IPC result — surface errors so the user doesn't see "Running" forever.
    const result = (await window.api?.agent?.run?.(
      newTaskId,
      currentTask.providerIds,
      compositePrompt,
      updatedContext,
    )) as { success: boolean; error?: string } | undefined;
    if (result && !result.success) {
      const store = useAppStore.getState();
      store.appendAgentEvent(newTaskId, {
        type: "error",
        message: result.error ?? "Failed to start agent task",
        providerId: currentTask.providerIds[0],
      });
    }
  }, [emailId, followUpInput, followUpAgentTask]);

  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500 p-4 gap-3">
        <span>No active agent task. Press Cmd+J to start.</span>
        {hasPendingDraft && (
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-lg transition-colors disabled:opacity-50"
          >
            {regenerating ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
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
            ) : (
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            )}
            Regenerate Draft
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Status + cancel header */}
      <div className="h-10 flex items-center justify-between px-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <StatusChip status={task.status} />
          {task.providerIds.length === 1 && (
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
              {availableProviders.find((p) => p.id === task.providerIds[0])?.name ??
                task.providerIds[0]}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(task.status === "completed" || task.status === "failed") && (
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="p-1 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 rounded transition-colors disabled:opacity-30"
              title="Regenerate draft"
            >
              {regenerating ? (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
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
              ) : (
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              )}
            </button>
          )}
          {task.status === "running" && (
            <button
              onClick={() => {
                window.api?.agent?.cancel?.(task.taskId);
                cancelAgentTask(task.taskId);
              }}
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
      </div>

      {/* Timeline / Events */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {Object.entries(task.runs).map(([providerId, run]) => {
          const provider = availableProviders.find((p) => p.id === providerId);
          const providerName = provider?.name ?? providerId;
          const runFinished =
            run.status === "completed" || run.status === "failed" || run.status === "cancelled";

          return (
            <div key={providerId}>
              {task.providerIds.length > 1 && (
                <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
                  {providerName}
                </div>
              )}
              <EventTimeline
                events={run.events}
                runFinished={runFinished}
                onAuthRequest={handleAuth}
                onRetry={task.status === "failed" ? handleRetry : undefined}
              />
            </div>
          );
        })}
      </div>

      {/* Follow-up input */}
      {(task.status === "completed" || task.status === "running" || task.status === "failed") && (
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={followUpInput}
              onChange={(e) => setFollowUpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  handleFollowUp();
                }
              }}
              placeholder={
                task.status === "running"
                  ? "Send when ready..."
                  : task.status === "failed"
                    ? "Try again or follow up..."
                    : "Follow up..."
              }
              disabled={task.status === "running"}
              className="flex-1 text-sm px-3 py-1.5 bg-gray-100 dark:bg-gray-700 rounded-lg outline-none text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-50"
            />
            <button
              onClick={handleFollowUp}
              disabled={!followUpInput.trim() || task.status === "running"}
              className="p-1.5 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 rounded-lg disabled:opacity-30 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export default AgentTabContent;
