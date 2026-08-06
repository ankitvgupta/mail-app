/**
 * Renderer-safe agent types. No Node.js or Electron imports.
 * These are the types used by the Zustand store and React components.
 */
import { DEFAULT_BACKGROUND_AGENT_PROVIDER } from "./types";

// Re-export event types that are safe for renderer
export type AgentTaskState =
  | "running"
  | "pending_approval"
  | "pending_async"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "user_message"; text: string }
  | { type: "tool_call_start"; toolName: string; toolCallId: string; input: unknown }
  | { type: "tool_call_end"; toolCallId: string; result: unknown }
  | {
      type: "tool_call_pending";
      toolCallId: string;
      toolName: string;
      pendingState: "pending_approval" | "pending_async";
      description?: string;
    }
  | { type: "state"; state: AgentTaskState; message?: string }
  | {
      type: "confirmation_required";
      toolCallId: string;
      toolName: string;
      input: unknown;
      description: string;
    }
  | { type: "error"; message: string }
  | { type: "done"; summary: string };

export type ScopedAgentEvent = AgentEvent & {
  providerId?: string;
  providerRunId?: string;
  /** Remote conversation ID for follow-up messages (e.g. remote agent conversation_id) */
  providerConversationId?: string;
  /** When set, this event is a nested sub-agent event inside a parent tool call.
   *  The renderer skips these in the main timeline and renders them inside
   *  the ToolCallEvent card that owns this nestedRunId. */
  nestedRunId?: string;
  /** The actual provider that produced this event — differs from providerId
   *  for nested sub-agent events where providerId is the parent (e.g. "claude")
   *  but sourceProviderId is the sub-agent (e.g. "custom-agent"). Used for auth routing. */
  sourceProviderId?: string;
};

export interface AgentProviderConfig {
  id: string;
  name: string;
  description: string;
  icon?: string;
  auth?: {
    type: "api_key" | "oauth" | "none";
    configKey?: string;
  };
}

export interface AgentContext {
  accountId: string;
  currentEmailId?: string;
  currentThreadId?: string;
  currentDraftId?: string;
  selectedEmailIds?: string[];
  userEmail: string;
  userName?: string;
  /** Email metadata for providers that don't have tool access (e.g. remote agents) */
  emailSubject?: string;
  emailFrom?: string;
  emailTo?: string;
  emailBody?: string;
  /** Existing remote conversation ID for follow-ups (skips starting a new conversation) */
  providerConversationIds?: Record<string, string>;
  /** Serialized conversation history for stateless providers (e.g. Claude) on follow-ups */
  conversationHistory?: string;
  /** Pre-built memory context string for injection into the agent system prompt */
  memoryContext?: string;
}

// --- Store-level types ---

export interface AgentTaskInfo {
  taskId: string;
  emailId: string;
  providerIds: string[];
  prompt: string;
  context: AgentContext;
  status: AgentTaskState;
  runs: Record<string, AgentProviderRun>;
}

export interface AgentProviderRun {
  providerConversationId?: string;
  status: AgentTaskState;
  events: ScopedAgentEvent[];
  pendingConfirmation?: PendingConfirmation;
}

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  description: string;
  input: unknown;
}

export interface AgentTaskHistoryEntry {
  taskId: string;
  providerIds: string[];
  prompt: string;
  timestamp: number;
  status: "completed" | "failed" | "cancelled";
  summary?: string;
}

export interface RemoteConversationView {
  providerId: string;
  providerConversationId: string;
  status: AgentTaskState;
  lastSyncedAt: number;
  messages: ScopedAgentEvent[];
}

/**
 * Unique provider ids present in a persisted agent trace, in first-seen order.
 * Used to rebuild the per-provider run map when replaying a trace —
 * replayAgentTrace drops events whose providerId isn't in this list. Traces
 * that predate provider stamping (no event carries a providerId) ran under
 * the claude provider, so fall back to it.
 */
export function deriveTraceProviderIds(events: ScopedAgentEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (typeof event.providerId === "string") ids.add(event.providerId);
  }
  return ids.size > 0 ? [...ids] : [DEFAULT_BACKGROUND_AGENT_PROVIDER];
}
