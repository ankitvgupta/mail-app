/**
 * LLM Service — Central wrapper for all LLM API calls.
 *
 * Supports multiple providers via the Anthropic SDK (both Anthropic's API
 * and Ollama Cloud's Anthropic-compatible endpoint).
 *
 * Three responsibilities:
 * 1. WRAP — Thin wrapper around anthropic.messages.create()
 * 2. RETRY — Exponential backoff on transient errors (non-blocking async setTimeout)
 * 3. RECORD — Every call logged to llm_calls table for cost tracking
 *
 * REDACTION: Never records email body/subject. Only IDs and metadata.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  Message,
} from "@anthropic-ai/sdk/resources/messages";
import type { LlmProvider } from "../../shared/types";
import { createLogger } from "./logger";
import { randomUUID } from "crypto";

const log = createLogger("llm");

// Approximate pricing per million tokens. Last updated: 2026-03-29.
// These are approximate and will drift as Anthropic updates pricing.
// TODO: Make updatable without code changes (config file or API).
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-opus-4-20250514": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  // Older model IDs that may still be in use
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
};

// Default pricing for unknown models (use Sonnet pricing as a reasonable middle)
const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit: { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 30000 },
  server_error: { maxRetries: 3, initialDelayMs: 2000, maxDelayMs: 30000 },
  connection: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
};

export interface LlmCallRecord {
  id: string;
  created_at: string;
  model: string;
  caller: string;
  email_id: string | null;
  account_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_cents: number;
  duration_ms: number;
  success: number;
  error_message: string | null;
}

export interface UsageStats {
  today: { totalCostCents: number; totalCalls: number };
  thisWeek: { totalCostCents: number; totalCalls: number };
  thisMonth: { totalCostCents: number; totalCalls: number };
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
}

export interface CreateOptions {
  /** Which service is making this call, for cost attribution */
  caller: string;
  /** Optional email ID for tracing */
  emailId?: string;
  /** Optional account ID for attribution */
  accountId?: string;
  /** Timeout in milliseconds (default: none) */
  timeoutMs?: number;
  /** LLM provider to use. Defaults to "anthropic". */
  provider?: LlmProvider;
  /**
   * Ollama thinking mode (only honored when provider === "ollama-cloud").
   * `false` → disable thinking (fastest; safe for non-reasoning models).
   * `true` → standard thinking (default).
   * `"low"` | `"medium"` | `"high"` → budget-constrained thinking effort.
   * `"max"` → maximum thinking effort on capable models (deepseek-v4-pro etc.).
   * Default: `true`. Reasoning-trained models (kimi-k2.6, gpt-oss, etc.) emit
   * chain-of-thought regardless of this flag; setting it to `true` makes Ollama
   * return that reasoning in `message.thinking` instead of dumping it into
   * `message.content`. With `false`, free-form writers (compose, refine) ship
   * the reasoning trace as the email body, and JSON-output callers (analyzer,
   * calendaring, archive-ready) fail JSON.parse ~66% of the time on kimi-k2.6.
   * Ignored for Anthropic.
   */
  think?: boolean | "low" | "medium" | "high" | "max";
}

// --- Anthropic client (api.anthropic.com) ---
let _anthropicClient: Anthropic | null = null;
let _defaultClient: Anthropic | null = null;

/**
 * Replace the Anthropic client for testing. Pass null to reset.
 * The mock must have a `messages.create()` method matching the SDK.
 */
export function _setClientForTesting(client: unknown): void {
  _anthropicClient = client as Anthropic;
}

/**
 * Reset the cached default client, forcing a fresh Anthropic() on next call.
 * Call this when the API key changes (e.g. via Settings).
 */
export function resetClient(): void {
  _defaultClient = null;
}

export function getClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;
  if (!_defaultClient) _defaultClient = new Anthropic();
  return _defaultClient;
}

// --- Ollama Cloud client (ollama.com, Anthropic-compatible endpoint) ---
let _ollamaClient: Anthropic | null = null;
let _ollamaApiKey: string | null = null;

/**
 * Configure the Ollama Cloud client. Call when the API key changes.
 */
export function setOllamaConfig(apiKey: string): void {
  _ollamaApiKey = apiKey || null;
  _ollamaClient = null; // Force re-creation on next use
}

/**
 * Reset the Ollama client, forcing re-creation on next call.
 */
export function resetOllamaClient(): void {
  _ollamaClient = null;
}

/**
 * Replace the Ollama client for testing. Pass null to reset.
 */
export function _setOllamaClientForTesting(client: unknown): void {
  _ollamaClient = client as Anthropic;
}

function getOllamaClient(): Anthropic {
  // In test mode, allow the injected mock client even without an API key
  if (_ollamaClient) return _ollamaClient;
  if (!_ollamaApiKey) {
    throw new Error(
      "Ollama Cloud API key not configured. Add your key in Settings → Extensions → Ollama Cloud.",
    );
  }
  // apiKey: null is intentional — the Anthropic SDK constructor falls back
  // to process.env.ANTHROPIC_API_KEY when apiKey is undefined. For users with
  // both keys configured, that env var is set, so omitting apiKey here would
  // silently leak the Anthropic key to ollama.com (the SDK sends X-Api-Key
  // alongside our Bearer authToken). Explicitly clearing it stops that.
  _ollamaClient = new Anthropic({
    baseURL: "https://ollama.com",
    authToken: _ollamaApiKey,
    apiKey: null,
  });
  return _ollamaClient;
}

/** Get the appropriate client for a provider. */
function getClientForProvider(provider: LlmProvider | undefined): Anthropic {
  if (provider === "ollama-cloud") return getOllamaClient();
  return getClient();
}

// Database handle — set via setDatabase() during app init
type DatabaseInstance = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
};

let _db: DatabaseInstance | null = null;
let _insertStmt: ReturnType<DatabaseInstance["prepare"]> | null = null;

/**
 * Set the database handle for recording LLM calls.
 * Must be called after initDatabase() during app startup.
 */
export function setAnthropicServiceDb(db: DatabaseInstance): void {
  _db = db;
  // Ensure llm_calls table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      caller TEXT NOT NULL,
      email_id TEXT,
      account_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_create_tokens INTEGER DEFAULT 0,
      cost_cents REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      provider TEXT DEFAULT 'anthropic'
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
  `);
  _insertStmt = db.prepare(`
    INSERT INTO llm_calls (id, model, caller, email_id, account_id,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      cost_cents, duration_ms, success, error_message, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const pricing = PRICING[model] || DEFAULT_PRICING;
  // input_tokens from the API already excludes cache tokens — they're separate fields
  const inputCost = (inputTokens * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  const cacheReadCost = (cacheReadTokens * pricing.cacheRead) / 1_000_000;
  const cacheWriteCost = (cacheCreateTokens * pricing.cacheWrite) / 1_000_000;
  // Convert dollars to cents
  return (inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100;
}

function recordCall(
  model: string,
  caller: string,
  emailId: string | null,
  accountId: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  durationMs: number,
  success: boolean,
  errorMessage: string | null,
  provider?: LlmProvider,
): void {
  if (!_insertStmt) {
    log.warn("LLM service: database not initialized, skipping call recording");
    return;
  }

  // Ollama Cloud is subscription-based — no per-token cost
  const costCents =
    provider === "ollama-cloud"
      ? 0
      : calculateCostCents(model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);

  try {
    _insertStmt.run(
      randomUUID(),
      model,
      caller,
      emailId,
      accountId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      costCents,
      durationMs,
      success ? 1 : 0,
      errorMessage,
      provider ?? "anthropic",
    );
  } catch (err) {
    // Recording failure must never break the LLM call
    log.error({ err }, "Failed to record LLM call to database");
  }
}

/**
 * Record a streaming call's cost after it completes.
 * Use this for calls that bypass createMessage() (e.g., anthropic.messages.stream()).
 */
/**
 * Record the start of an agent session: a single zero-token, zero-cost row
 * stamping which harness was selected and which LLM backend it routes to.
 *
 * This is the only signal we have for OpenCode-driven sessions — their
 * actual LLM calls happen inside the spawned `opencode` server (via its
 * bundled AI SDK adapter) and bypass createMessage()'s recording path.
 *
 * Caller convention: `agent-session-start:<harnessId>` (e.g. "agent-session-start:opencode")
 * so a `SELECT ... WHERE caller LIKE 'agent-session-start:%'` returns the
 * session log; harness, provider, and model live in dedicated columns so
 * filtering by any of them is trivial.
 */
export function recordAgentSessionStart(args: {
  harness: string;
  provider: LlmProvider;
  model: string;
  accountId?: string;
  emailId?: string;
}): void {
  recordCall(
    args.model,
    `agent-session-start:${args.harness}`,
    args.emailId ?? null,
    args.accountId ?? null,
    0,
    0,
    0,
    0,
    0,
    true,
    null,
    args.provider,
  );
}

export function recordStreamingCall(
  model: string,
  caller: string,
  usage: Record<string, number>,
  durationMs: number,
  options?: { emailId?: string; accountId?: string; provider?: LlmProvider },
): void {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheCreateTokens = usage.cache_creation_input_tokens || 0;
  recordCall(
    model,
    caller,
    options?.emailId || null,
    options?.accountId || null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    durationMs,
    true,
    null,
    options?.provider,
  );
}

function asyncSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryCategory(error: unknown): string | null {
  if (error instanceof Anthropic.RateLimitError) return "rate_limit";
  if (error instanceof Anthropic.InternalServerError) return "server_error";
  if (error instanceof Anthropic.APIConnectionError) return "connection";
  // Check for 529 overloaded (comes as APIError with status 529)
  if (error instanceof Anthropic.APIError && (error as { status?: number }).status === 529) {
    return "server_error";
  }
  return null;
}

/**
 * Adjust params for Ollama Cloud:
 * - Strip cache_control from system blocks AND from individual message content blocks
 *   (Ollama doesn't support prompt caching anywhere).
 * - Raise max_tokens to a high floor. Ollama models like minimax-m2.7:cloud emit
 *   long `thinking` blocks before their `text` block; with the small max_tokens our
 *   features set for Anthropic (e.g. 256 for analysis), the thinking budget consumes
 *   everything and the text block is never produced. Cost is $0 on Ollama (subscription),
 *   so raising the ceiling is free.
 */
const OLLAMA_MIN_MAX_TOKENS = 4096;

// Strip cache_control from a single block. The SDK union types (TextBlockParam,
// ContentBlockParam) don't have a string index signature, so we narrow via `unknown`
// rather than casting to Record<string, unknown>.
function stripCacheControlFromBlock<T>(block: T): T {
  if (typeof block !== "object" || block === null) return block;
  const obj = block as unknown as Record<string, unknown>;
  if (!("cache_control" in obj)) return block;
  const { cache_control: _, ...rest } = obj;
  return rest as unknown as T;
}

function adjustParamsForOllama(
  params: MessageCreateParamsNonStreaming,
): MessageCreateParamsNonStreaming {
  let next = params;

  if (next.system && Array.isArray(next.system)) {
    const system = next.system.map((block) => stripCacheControlFromBlock(block));
    next = { ...next, system };
  }

  // cache_control can also appear on individual user/assistant message content blocks
  // for multi-turn prompt caching. Strip those too — Ollama would reject them.
  if (Array.isArray(next.messages)) {
    const messages = next.messages.map((msg) => {
      if (Array.isArray(msg.content)) {
        const content = msg.content.map((block) => stripCacheControlFromBlock(block));
        return { ...msg, content };
      }
      return msg;
    });
    next = { ...next, messages };
  }

  if (typeof next.max_tokens === "number" && next.max_tokens < OLLAMA_MIN_MAX_TOKENS) {
    next = { ...next, max_tokens: OLLAMA_MIN_MAX_TOKENS };
  }

  return next;
}

// --- Native Ollama path (callOllamaNative) ---
//
// For non-agent features (analysis, drafts, etc.) we bypass the Anthropic SDK
// and hit Ollama's native /api/chat directly. The native endpoint accepts a
// `think` param that the Anthropic-compat /v1/messages endpoint does not —
// we need it because reasoning-trained models (kimi-k2.6, gpt-oss) emit CoT
// regardless of the flag, and only `think:true` makes Ollama return that CoT
// in `message.thinking` instead of dumping it into `message.content`. With
// `think:false`, writing callers ship the reasoning trace as the email body
// and JSON callers fail to parse.
//
// Synthesizes an Anthropic-style Message so downstream callers (which extract
// `.content[0].text`) don't need to change.
//
// The agent sidebar still goes through the Anthropic-compat endpoint because
// it's driven by the Claude Code subprocess which only speaks Anthropic
// protocol — we can't intercept its outgoing fetches without a proxy.

/** Flatten Anthropic-style system param (string | TextBlockParam[]) to plain text. */
function flattenSystemPrompt(system: MessageCreateParamsNonStreaming["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((block) => (typeof block === "string" ? block : block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** Flatten Anthropic-style message content (string | block[]) to plain text. */
function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "type" in block && block.type === "text") {
        return (block as { text: string }).text ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
}

/**
 * Synthesize an Anthropic-style Message from an Ollama /api/chat response so
 * downstream callers don't need to know which path was taken.
 */
function synthesizeAnthropicMessage(
  ollamaResponse: OllamaChatResponse,
  requestedModel: string,
): Message {
  const text = ollamaResponse.message?.content ?? "";
  const thinking = ollamaResponse.message?.thinking ?? "";
  const inputTokens = ollamaResponse.prompt_eval_count ?? 0;
  const outputTokens = ollamaResponse.eval_count ?? 0;

  const content: Message["content"] = [];
  if (thinking) {
    // Anthropic's thinking block shape — included so callers that look for
    // thinking text find it. Most downstream code just looks for type:"text".
    content.push({
      type: "thinking",
      thinking,
      signature: "",
    } as unknown as Message["content"][number]);
  }
  content.push({ type: "text", text, citations: null } as unknown as Message["content"][number]);

  return {
    id: `ollama-native-${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: ollamaResponse.model ?? requestedModel,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    } as Message["usage"],
  } as Message;
}

async function callOllamaNative(
  params: MessageCreateParamsNonStreaming,
  think: CreateOptions["think"],
  signal: AbortSignal | undefined,
): Promise<Message> {
  if (!_ollamaApiKey) {
    throw new Error(
      "Ollama Cloud API key not configured. Add your key in Settings → Extensions → Ollama Cloud.",
    );
  }

  // Tools aren't currently translated for the native path. No Ollama-routed
  // caller passes tools today (senderLookup uses Anthropic's web_search and
  // is pinned to anthropic). Throw explicitly so a future caller adding tools
  // sees a clear error instead of silently dropping them.
  if (params.tools && params.tools.length > 0) {
    throw new Error(
      "callOllamaNative: tools not supported on native /api/chat path. Caller must route to Anthropic or extend the translation layer.",
    );
  }

  const systemText = flattenSystemPrompt(params.system);
  const ollamaMessages: Array<{ role: string; content: string }> = [];
  if (systemText) ollamaMessages.push({ role: "system", content: systemText });
  for (const msg of params.messages) {
    ollamaMessages.push({ role: msg.role, content: flattenMessageContent(msg.content) });
  }

  const body: Record<string, unknown> = {
    model: params.model,
    stream: false,
    messages: ollamaMessages,
    options: {
      num_predict:
        typeof params.max_tokens === "number" ? params.max_tokens : OLLAMA_MIN_MAX_TOKENS,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
    },
  };
  // think: false is meaningful (turn thinking OFF for non-reasoning models)
  // so include it unless the caller omitted it entirely. Default to true:
  // reasoning models on Ollama (kimi-k2.6, gpt-oss) emit CoT regardless of
  // this flag, and only `true` causes the cloud to split the trace into a
  // separate `message.thinking` field so it doesn't pollute `message.content`.
  // See CreateOptions.think doc comment for details.
  if (think !== undefined) body.think = think;
  else body.think = true;

  const res = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${_ollamaApiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Map Ollama HTTP errors to Anthropic SDK error shapes so the retry
    // category detection in getRetryCategory() (which uses instanceof
    // Anthropic.APIError / AuthenticationError / RateLimitError) still works.
    // Use APIError.generate which accepts a generic status and headers: undefined.
    throw Anthropic.APIError.generate(res.status, undefined, errText, undefined);
  }

  const ollamaResponse = (await res.json()) as OllamaChatResponse;
  return synthesizeAnthropicMessage(ollamaResponse, params.model);
}

/**
 * Create a message using the configured LLM provider with retry and cost tracking.
 */
export async function createMessage(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  const { caller, emailId, accountId, timeoutMs, provider, think } = options;
  const isOllama = provider === "ollama-cloud";
  const model = params.model;
  const startTime = Date.now();

  // Strip cache_control for Ollama (unsupported)
  const effectiveParams = isOllama ? adjustParamsForOllama(params) : params;

  // For Ollama we use the SDK's retry-category logic but call our native path
  // instead of client.messages.create(). For Anthropic we use the SDK.
  // _testOllamaClient overrides the native path in unit tests.
  const client = isOllama ? null : getClientForProvider(provider);
  let lastError: unknown = null;
  let totalAttempts = 0;

  // Determine max retries across all categories
  const maxPossibleRetries = Math.max(...Object.values(RETRY_CONFIGS).map((c) => c.maxRetries));

  for (let attempt = 0; attempt <= maxPossibleRetries; attempt++) {
    totalAttempts = attempt + 1;

    // Per-attempt timeout so retries get fresh abort controllers
    let abortController: AbortController | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      abortController = new AbortController();
      timeoutHandle = setTimeout(() => abortController!.abort(), timeoutMs);
    }

    try {
      let response: Message;
      if (isOllama) {
        // Native /api/chat path — honors `think` config. Also lets the unit
        // test mock (set via _setOllamaClientForTesting) intercept via the
        // injected messages.create shim, for backwards-compat with existing tests.
        if (_ollamaClient) {
          response = await _ollamaClient.messages.create(effectiveParams, {
            signal: abortController?.signal,
          });
        } else {
          response = await callOllamaNative(effectiveParams, think, abortController?.signal);
        }
      } else {
        response = await client!.messages.create(effectiveParams, {
          signal: abortController?.signal,
        });
      }

      // Success — record and return
      const usage = response.usage as unknown as Record<string, number>;
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;
      const cacheCreateTokens = usage.cache_creation_input_tokens || 0;

      recordCall(
        model,
        caller,
        emailId || null,
        accountId || null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
        Date.now() - startTime,
        true,
        null,
        provider,
      );

      if (totalAttempts > 1) {
        log.info({ caller, model, attempts: totalAttempts }, "LLM call succeeded after retries");
      }

      return response;
    } catch (error) {
      lastError = error;
      const category = getRetryCategory(error);

      if (!category) {
        // Non-retryable error — fail immediately
        break;
      }

      const config = RETRY_CONFIGS[category];
      if (attempt >= config.maxRetries) {
        // Exhausted retries for this category
        break;
      }

      // Calculate delay with exponential backoff + jitter
      const baseDelay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs);
      const jitter = baseDelay * 0.1 * Math.random();
      const delay = baseDelay + jitter;

      log.warn(
        {
          caller,
          model,
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          category,
          delayMs: Math.round(delay),
        },
        "LLM call failed, retrying",
      );

      // Non-blocking sleep
      await asyncSleep(delay);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // All retries exhausted — record failure and throw
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  recordCall(
    model,
    caller,
    emailId || null,
    accountId || null,
    0,
    0,
    0,
    0,
    Date.now() - startTime,
    false,
    errMsg,
    provider,
  );

  throw lastError;
}

/**
 * Get usage statistics for cost visibility.
 */
export function getUsageStats(): UsageStats {
  if (!_db) {
    return {
      today: { totalCostCents: 0, totalCalls: 0 },
      thisWeek: { totalCostCents: 0, totalCalls: 0 },
      thisMonth: { totalCostCents: 0, totalCalls: 0 },
      byModel: [],
      byCaller: [],
    };
  }

  const today = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE date(created_at) = date('now')",
    )
    .get() as { cost: number; calls: number };

  const thisWeek = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-7 days')",
    )
    .get() as { cost: number; calls: number };

  const thisMonth = _db
    .prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days')",
    )
    .get() as { cost: number; calls: number };

  const byModel = _db
    .prepare(
      "SELECT model, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY model ORDER BY costCents DESC",
    )
    .all() as Array<{ model: string; costCents: number; calls: number }>;

  const byCaller = _db
    .prepare(
      "SELECT caller, COALESCE(SUM(cost_cents), 0) as costCents, COUNT(*) as calls FROM llm_calls WHERE created_at >= datetime('now', '-30 days') GROUP BY caller ORDER BY costCents DESC",
    )
    .all() as Array<{ caller: string; costCents: number; calls: number }>;

  return {
    today: { totalCostCents: today.cost, totalCalls: today.calls },
    thisWeek: { totalCostCents: thisWeek.cost, totalCalls: thisWeek.calls },
    thisMonth: { totalCostCents: thisMonth.cost, totalCalls: thisMonth.calls },
    byModel,
    byCaller,
  };
}

/**
 * Get recent call history for debugging.
 */
export function getCallHistory(limit: number = 50): LlmCallRecord[] {
  if (!_db) return [];

  return _db
    .prepare("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?")
    .all(limit) as LlmCallRecord[];
}
