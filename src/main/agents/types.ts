import { z } from "zod";
import type { McpServerConfig } from "../../shared/types";

// Re-export renderer-safe types from the shared module to maintain a single
// source of truth across the IPC boundary.
export type {
  AgentTaskState,
  AgentEvent,
  ScopedAgentEvent,
  AgentProviderConfig,
  AgentContext,
} from "../../shared/agent-types";

import type { AgentTaskState, AgentEvent, ScopedAgentEvent, AgentProviderConfig, AgentContext } from "../../shared/agent-types";

// --- Provider Interface ---

export interface AgentProvider {
  readonly config: AgentProviderConfig;

  /** Run the agent with a user prompt. Yields streaming events. */
  run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void>;

  /** Resume after approval or async tool completion (optional for remote providers). */
  resume?(params: AgentResumeParams): AsyncGenerator<AgentEvent, AgentRunResult, void>;

  /** Pass a tool approval decision to providers that need it (optional). */
  submitToolDecision?(params: AgentToolDecisionParams): Promise<void>;

  /** Cancel a running task. Must be idempotent. */
  cancel(taskId: string): void;

  /** Check if this provider is configured and available. */
  isAvailable(): Promise<boolean>;

  /** Update the framework config (e.g. new API key set at runtime). */
  updateConfig?(config: Partial<AgentFrameworkConfig>): void;

  /** If this provider can be used as a sub-agent tool by orchestrating agents.
   *  Returns the tool config, or null/undefined if not supported. */
  asSubAgentTool?(): SubAgentToolConfig | null;
}

// --- Run Parameters ---

export type ToolExecutorFn = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export interface AgentRunParams {
  taskId: string;
  prompt: string;
  context: AgentContext;
  tools: AgentToolSpec[];
  toolExecutor: ToolExecutorFn;
  /** Fetch a URL through the main process's Chromium networking stack (shared session/cookies). */
  netFetch: NetFetchProxyFn;
  signal: AbortSignal;
  /** Per-task model override. When set, takes precedence over the framework config model. */
  modelOverride?: string;
}

export interface AgentResumeParams {
  taskId: string;
  providerTaskId: string;
  signal: AbortSignal;
}

export interface AgentToolDecisionParams {
  taskId: string;
  providerTaskId: string;
  toolCallId: string;
  approved: boolean;
}

export interface AgentRunResult {
  state: Exclude<AgentTaskState, "running">;
  providerTaskId?: string;
}

/**
 * Minimal tool shape passed to providers. Providers use this to register
 * tools in their native format (Claude tool_use, MCP, etc.).
 * The full ToolDefinition lives in tools/types.ts.
 */
export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  /** Optional guidance appended to the orchestrating agent's system prompt.
   *  Set by sub-agent tools so the LLM knows when/how to use them. */
  systemPromptGuidance?: string;
}

/**
 * Configuration returned by AgentProvider.asSubAgentTool() for providers
 * that can be invoked as tools by an orchestrating agent (e.g. Claude).
 */
export interface SubAgentToolConfig {
  /** Tool name exposed to the LLM (e.g. "yc_agent_query") */
  name: string;
  /** Tool description for the LLM */
  description: string;
  /** Text appended to the orchestrating agent's system prompt */
  systemPromptGuidance: string;
  /** Zod schema for the tool input */
  inputSchema: z.ZodType<{ query: string; conversation_id?: string }>;
}

// --- Orchestrator Dependencies ---

/** Functions the orchestrator needs from the main process (via proxy in utility process). */
export interface OrchestratorDeps {
  emitToRenderer: (taskId: string, event: ScopedAgentEvent) => void;
  requestConfirmation: (details: ConfirmationDetails) => void;
  dbProxy: DbProxyFn;
  gmailProxy: GmailProxyFn;
  netFetchProxy: NetFetchProxyFn;
  config: AgentFrameworkConfig;
  /** Set the active taskId so proxy requests can be scoped for cancellation. */
  setActiveTaskId: (taskId: string | null) => void;
}

export interface ConfirmationDetails {
  toolCallId: string;
  toolName: string;
  input: unknown;
  description: string;
}

export type DbProxyFn = (method: string, ...args: unknown[]) => Promise<unknown>;
export type GmailProxyFn = (method: string, accountId: string, ...args: unknown[]) => Promise<unknown>;

/** Result of a proxied net.fetch call through the main process. */
export interface NetFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type NetFetchProxyFn = (
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<NetFetchResult>;

// --- Framework config (subset of app config relevant to agents) ---

export interface AgentFrameworkConfig {
  model: string;
  anthropicApiKey?: string;
  providers?: Record<string, ProviderSettings>;
  browserConfig?: {
    enabled: boolean;
    chromeDebugPort: number;
    chromeProfilePath?: string;
  };
  mcpServers?: Record<string, McpServerConfig>;
}

export interface ProviderSettings {
  enabled?: boolean;
  enabledTools?: string[];
  maxRiskLevel?: number;
  endpoint?: string;
  apiKey?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Model override for providers that support it (e.g. Cloclo). */
  model?: string;
  /** Extra CLI flags for providers that shell out to a CLI (e.g. Cloclo). */
  extraFlags?: string[];
}

// --- IPC message types (utility process <-> main process) ---

export type WorkerMessage =
  | { type: "init"; config: AgentFrameworkConfig }
  | { type: "db_response"; requestId: string; result: unknown }
  | { type: "db_error"; requestId: string; error: string }
  | { type: "gmail_response"; requestId: string; result: unknown }
  | { type: "gmail_error"; requestId: string; error: string }
  | { type: "net_fetch_response"; requestId: string; result: NetFetchResult }
  | { type: "net_fetch_error"; requestId: string; error: string }
  | { type: "run"; taskId: string; providerIds: string[]; prompt: string; context: AgentContext; modelOverride?: string }
  | { type: "cancel"; taskId: string }
  | { type: "confirm"; toolCallId: string; approved: boolean }
  | { type: "config_update"; config: Partial<AgentFrameworkConfig> }
  | { type: "list_providers" }
  | { type: "load_provider"; providerId: string; providerPath: string; config: AgentFrameworkConfig }
  | { type: "unload_provider"; providerId: string }
  | { type: "check_health"; providerId: string };

export type CoordinatorMessage =
  | { type: "db_request"; requestId: string; method: string; args: unknown[] }
  | { type: "gmail_request"; requestId: string; method: string; accountId: string; args: unknown[] }
  | { type: "net_fetch_request"; requestId: string; url: string; options: { method: string; headers?: Record<string, string>; body?: string } }
  | { type: "confirmation_request"; toolCallId: string; toolName: string; input: unknown; description: string }
  | { type: "providers_list"; providers: AgentProviderConfig[] }
  | { type: "provider_loaded"; providerId: string }
  | { type: "provider_load_error"; providerId: string; error: string }
  | { type: "provider_health"; providerId: string; status: "connected" | "not_configured" | "error"; message?: string };
