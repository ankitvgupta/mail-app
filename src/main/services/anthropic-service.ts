/**
 * AnthropicService — Central wrapper for all Claude API calls.
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
import { createLogger } from "./logger";
import { randomUUID } from "crypto";

const log = createLogger("anthropic");

// Approximate pricing per million tokens. Last updated: 2026-03-29.
// These are approximate and will drift as Anthropic updates pricing.
// TODO: Make updatable without code changes (config file or API).
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-opus-4-20250514": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
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

interface CreateOptions {
  /** Which service is making this call, for cost attribution */
  caller: string;
  /** Optional email ID for tracing */
  emailId?: string;
  /** Optional account ID for attribution */
  accountId?: string;
  /** Timeout in milliseconds (default: none) */
  timeoutMs?: number;
}

// Anthropic client — can be replaced for testing
let _anthropicClient: Anthropic | null = null;

/**
 * Replace the Anthropic client for testing. Pass null to reset.
 * The mock must have a `messages.create()` method matching the SDK.
 */
export function _setClientForTesting(client: unknown): void {
  _anthropicClient = client as Anthropic;
}

function getClient(): Anthropic {
  return _anthropicClient || new Anthropic();
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
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
  `);
  _insertStmt = db.prepare(`
    INSERT INTO llm_calls (id, model, caller, email_id, account_id,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      cost_cents, duration_ms, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const inputCost =
    ((inputTokens - cacheReadTokens - cacheCreateTokens) * pricing.input) / 1_000_000;
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
): void {
  if (!_insertStmt) {
    log.warn("AnthropicService: database not initialized, skipping call recording");
    return;
  }

  const costCents = calculateCostCents(
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
  );

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
export function recordStreamingCall(
  model: string,
  caller: string,
  usage: Record<string, number>,
  durationMs: number,
  options?: { emailId?: string; accountId?: string },
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
 * Create a message using Claude API with retry and cost tracking.
 */
export async function createMessage(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  const { caller, emailId, accountId, timeoutMs } = options;
  const model = params.model;
  const startTime = Date.now();

  // Set up abort controller for timeout
  let abortController: AbortController | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) {
    abortController = new AbortController();
    timeoutHandle = setTimeout(() => abortController!.abort(), timeoutMs);
  }

  const client = getClient();
  let lastError: unknown = null;
  let totalAttempts = 0;

  try {
    // Determine max retries across all categories
    const maxPossibleRetries = Math.max(...Object.values(RETRY_CONFIGS).map((c) => c.maxRetries));

    for (let attempt = 0; attempt <= maxPossibleRetries; attempt++) {
      totalAttempts = attempt + 1;

      try {
        const response = await client.messages.create(params, {
          signal: abortController?.signal,
        });

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
    );

    throw lastError;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
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
