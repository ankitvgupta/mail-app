/**
 * Unit tests for AnthropicService — the centralized Claude API wrapper.
 *
 * Tests cover: happy path, retry logic, cost recording, timeout,
 * error recording, and query functions (getUsageStats, getCallHistory).
 *
 * Strategy: Use _setClientForTesting() to inject a mock client, and
 * setAnthropicServiceDb() with an in-memory SQLite database for cost tracking.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  createMessage,
  _setClientForTesting,
  _setOllamaClientForTesting,
  _setOpenCodeServiceForTesting,
  setAnthropicServiceDb,
  getUsageStats,
  getCallHistory,
  recordAgentSessionStart,
  type LlmCallRecord,
} from "../../src/main/services/llm-service";
import type { OpenCodeInferenceRequest } from "../../src/main/services/opencode-inference-service";

const require = createRequire(import.meta.url);

// --- Database setup ---

type DB = BetterSqlite3.Database;
let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const testDb = new DatabaseCtor!(":memory:");
  testDb.close();
} catch (e: unknown) {
  const err = e as Error;
  if (
    err.message?.includes("NODE_MODULE_VERSION") ||
    err.message?.includes("did not self-register")
  ) {
    nativeModuleError = err.message.split("\n")[0];
  } else {
    throw e;
  }
}

// --- Mock Anthropic client ---

interface MockCall {
  params: Record<string, unknown>;
  options?: Record<string, unknown>;
}

function createMockClient(
  behavior: "success" | "rate-limit-then-success" | "server-error-then-success" | "always-fail",
  failCount: number = 1,
) {
  const calls: MockCall[] = [];
  let callIndex = 0;

  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ params, options });
        callIndex++;

        if (behavior === "success") {
          return makeSuccessResponse(params.model as string);
        }

        if (behavior === "rate-limit-then-success") {
          if (callIndex <= failCount) {
            throw new Anthropic.RateLimitError(
              429,
              { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
              "Rate limited",
              new Headers(),
            );
          }
          return makeSuccessResponse(params.model as string);
        }

        if (behavior === "server-error-then-success") {
          if (callIndex <= failCount) {
            throw new Anthropic.InternalServerError(
              500,
              { type: "error", error: { type: "server_error", message: "Server error" } },
              "Server error",
              new Headers(),
            );
          }
          return makeSuccessResponse(params.model as string);
        }

        if (behavior === "always-fail") {
          throw new Anthropic.BadRequestError(
            400,
            { type: "error", error: { type: "invalid_request_error", message: "Bad request" } },
            "Bad request",
            new Headers(),
          );
        }

        throw new Error("Unknown behavior");
      },
    },
  };

  return { client, calls };
}

function makeSuccessResponse(model: string = "claude-sonnet-4-20250514") {
  return {
    id: "msg_test_123",
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Hello, world!" }],
    model,
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    },
  };
}

function makeTestParams(model: string = "claude-sonnet-4-20250514") {
  return {
    model,
    max_tokens: 256,
    messages: [{ role: "user" as const, content: "Hello" }],
  };
}

// --- Tests ---

test.describe("AnthropicService", () => {
  // Skip all tests if native module is unavailable
  test.skip(!!nativeModuleError, `Skipping: ${nativeModuleError}`);

  let testDb: DB;

  test.beforeEach(() => {
    // Fresh in-memory DB for each test
    testDb = new DatabaseCtor!(":memory:");
    setAnthropicServiceDb(testDb);
  });

  test.afterEach(() => {
    _setClientForTesting(null);
    _setOllamaClientForTesting(null);
    _setOpenCodeServiceForTesting();
    testDb?.close();
  });

  test("routes one structured request through OpenCode and records its reported usage", async () => {
    const anthropicMock = createMockClient("success");
    const ollamaMock = createMockClient("success");
    const requests: OpenCodeInferenceRequest[] = [];
    _setClientForTesting(anthropicMock.client);
    _setOllamaClientForTesting(ollamaMock.client);
    _setOpenCodeServiceForTesting({
      complete: async (request) => {
        requests.push(request);
        return {
          id: "assistant-1",
          text: '{"needs_reply":true,"reason":"Direct question"}',
          structured: { needs_reply: true, reason: "Direct question" },
          providerId: "openai",
          modelId: "gpt-5.2",
          finishReason: "stop",
          inputTokens: 120,
          outputTokens: 35,
          cacheReadTokens: 10,
          cacheWriteTokens: 4,
          reasoningTokens: 7,
          costDollars: 0.0123,
        };
      },
    });
    const outputSchema = z.object({
      needs_reply: z.boolean(),
      reason: z.string(),
    });

    const result = await createMessage(
      {
        model: "openai/gpt-5.2",
        max_tokens: 256,
        system: [
          {
            type: "text",
            text: "System one",
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: "System two",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "First",
                cache_control: { type: "ephemeral" },
              },
              { type: "text", text: "Second" },
            ],
          },
          { role: "assistant", content: "Prior reply" },
        ],
      },
      {
        caller: "test-opencode",
        emailId: "email-123",
        accountId: "acct-456",
        provider: "opencode",
        outputSchema,
      },
    );

    expect(requests).toEqual([
      {
        selector: "openai/gpt-5.2",
        system: "System one\n\nSystem two",
        prompt: "USER:\nFirst\n\nSecond\n\nASSISTANT:\nPrior reply",
        outputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            needs_reply: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["needs_reply", "reason"],
          additionalProperties: false,
        },
        signal: undefined,
      },
    ]);
    expect(anthropicMock.calls).toHaveLength(0);
    expect(ollamaMock.calls).toHaveLength(0);
    expect(result.model).toBe("openai/gpt-5.2");
    expect(result.content).toEqual([
      {
        type: "text",
        text: '{"needs_reply":true,"reason":"Direct question"}',
        citations: null,
      },
    ]);
    expect(result.usage).toEqual({
      input_tokens: 120,
      output_tokens: 35,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 10,
      server_tool_use: null,
      service_tier: null,
    });

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;
    expect(row.provider).toBe("opencode");
    expect(row.model).toBe("openai/gpt-5.2");
    expect(row.caller).toBe("test-opencode");
    expect(row.email_id).toBe("email-123");
    expect(row.account_id).toBe("acct-456");
    expect(row.input_tokens).toBe(120);
    expect(row.output_tokens).toBe(35);
    expect(row.cache_read_tokens).toBe(10);
    expect(row.cache_create_tokens).toBe(4);
    expect(row.cost_cents).toBeCloseTo(1.23, 8);
    expect(row.success).toBe(1);
    expect(row.error_message).toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.usage_available).toBe(1);
    expect(row.cost_available).toBe(1);
  });

  test("agent accounting flags distinguish missing usage and cost from observed zero", () => {
    recordAgentSessionStart({
      harness: "opencode",
      provider: "opencode",
      model: "opencode-default",
      durationMs: 15,
      success: false,
      errorMessage: "startup failed",
    });

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;
    expect(row.input_tokens).toBe(0);
    expect(row.cost_cents).toBe(0);
    expect(row.usage_available).toBe(0);
    expect(row.cost_available).toBe(0);
  });

  test("records zero cost when OpenCode does not report cost", async () => {
    _setOpenCodeServiceForTesting({
      complete: async () => ({
        id: "assistant-no-cost",
        text: "Done",
        providerId: "openai",
        modelId: "gpt-5.2",
        finishReason: "stop",
        inputTokens: 120,
        outputTokens: 35,
        cacheReadTokens: 10,
        cacheWriteTokens: 4,
        reasoningTokens: 7,
      }),
    });

    await createMessage(makeTestParams("openai/gpt-5.2"), {
      caller: "test-opencode-no-cost",
      provider: "opencode",
    });

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;
    expect(row.cost_cents).toBe(0);
    expect(row.usage_available).toBe(1);
    expect(row.cost_available).toBe(0);
  });

  test("records one failed OpenCode call and rethrows the service error", async () => {
    const failure = new Error("OpenCode unavailable");
    let calls = 0;
    _setOpenCodeServiceForTesting({
      complete: async () => {
        calls += 1;
        throw failure;
      },
    });

    let thrown: unknown;
    try {
      await createMessage(makeTestParams("openai/gpt-5.2"), {
        caller: "test-opencode-error",
        provider: "opencode",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(calls).toBe(1);
    const rows = testDb.prepare("SELECT * FROM llm_calls").all() as LlmCallRecord[];
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("opencode");
    expect(rows[0].model).toBe("openai/gpt-5.2");
    expect(rows[0].success).toBe(0);
    expect(rows[0].error_message).toBe("OpenCode unavailable");
    expect(rows[0].input_tokens).toBe(0);
    expect(rows[0].output_tokens).toBe(0);
    expect(rows[0].usage_available).toBe(0);
    expect(rows[0].cost_available).toBe(0);
  });

  test("rejects OpenCode tools before inference", async () => {
    let calls = 0;
    _setOpenCodeServiceForTesting({
      complete: async () => {
        calls += 1;
        throw new Error("OpenCode should not be called");
      },
    });

    await expect(
      createMessage(
        {
          ...makeTestParams("openai/gpt-5.2"),
          tools: [
            {
              name: "lookup",
              description: "Look something up",
              input_schema: { type: "object", properties: {} },
            },
          ],
        },
        { caller: "test-opencode-tools", provider: "opencode" },
      ),
    ).rejects.toThrow("OpenCode feature inference does not support tools");

    expect(calls).toBe(0);
  });

  test("createMessage wraps SDK call and returns response", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    const result = await createMessage(makeTestParams(), { caller: "test" });

    expect(result.id).toBe("msg_test_123");
    expect(result.content[0]).toEqual({ type: "text", text: "Hello, world!" });
    expect(result.usage.input_tokens).toBe(100);
  });

  test("retries on rate limit error and eventually succeeds", async () => {
    const { client, calls } = createMockClient("rate-limit-then-success", 2);
    _setClientForTesting(client);

    const result = await createMessage(makeTestParams(), { caller: "test-retry" });

    expect(result.id).toBe("msg_test_123");
    // Should have made 3 calls: 2 failures + 1 success
    expect(calls.length).toBe(3);
  });

  test("retries on internal server error (up to 3x)", async () => {
    const { client, calls } = createMockClient("server-error-then-success", 2);
    _setClientForTesting(client);

    const result = await createMessage(makeTestParams(), { caller: "test-server-retry" });

    expect(result.id).toBe("msg_test_123");
    expect(calls.length).toBe(3);
  });

  test("marks usage and cost unavailable after exhausting retries", async () => {
    const { client, calls } = createMockClient("server-error-then-success", 99);
    _setClientForTesting(client);
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
      realSetTimeout(handler, 0, ...args)) as typeof globalThis.setTimeout;

    try {
      await expect(
        createMessage(makeTestParams(), { caller: "test-exhausted-retries" }),
      ).rejects.toThrow("Server error");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(calls).toHaveLength(4);
    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;
    expect(row.success).toBe(0);
    expect(row.usage_available).toBe(0);
    expect(row.cost_available).toBe(0);
  });

  test("does not retry on non-retryable API errors (fails immediately)", async () => {
    const { client, calls } = createMockClient("always-fail");
    _setClientForTesting(client);

    await expect(createMessage(makeTestParams(), { caller: "test-no-retry" })).rejects.toThrow(
      "Bad request",
    );

    // Should have made exactly 1 call — no retries
    expect(calls.length).toBe(1);
  });

  test("records successful call to llm_calls table with correct values", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    await createMessage(makeTestParams(), {
      caller: "test-cost",
      emailId: "email-123",
      accountId: "acct-456",
    });

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;

    expect(row).toBeTruthy();
    expect(row.model).toBe("claude-sonnet-4-20250514");
    expect(row.caller).toBe("test-cost");
    expect(row.email_id).toBe("email-123");
    expect(row.account_id).toBe("acct-456");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.cache_read_tokens).toBe(20);
    expect(row.cache_create_tokens).toBe(10);
    expect(row.success).toBe(1);
    expect(row.error_message).toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("cost calculation accounts for cache discounts correctly", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    await createMessage(makeTestParams("claude-sonnet-4-20250514"), { caller: "test-cost-math" });

    const row = testDb.prepare("SELECT cost_cents FROM llm_calls LIMIT 1").get() as {
      cost_cents: number;
    };

    // Sonnet pricing: input=$3/M, output=$15/M, cacheRead=$0.3/M, cacheWrite=$3.75/M
    // usage: 100 input (non-cached), 50 output, 20 cacheRead, 10 cacheWrite
    // API input_tokens already excludes cache tokens — they're separate fields
    // inputCost = 100 * 3.0 / 1_000_000 = 0.0003
    // outputCost = 50 * 15.0 / 1_000_000 = 0.00075
    // cacheReadCost = 20 * 0.3 / 1_000_000 = 0.000006
    // cacheWriteCost = 10 * 3.75 / 1_000_000 = 0.0000375
    // total $ = 0.0003 + 0.00075 + 0.000006 + 0.0000375 = 0.0010935
    // total cents = 0.10935
    expect(row.cost_cents).toBeCloseTo(0.10935, 4);
  });

  test("timeout via AbortController aborts the request", async () => {
    // Create a client that takes too long
    const client = {
      messages: {
        create: async (_params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          // Wait for abort signal or a long time
          return new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Should have been aborted")), 10000);
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted", "AbortError"));
            });
          });
        },
      },
    };
    _setClientForTesting(client);

    await expect(
      createMessage(makeTestParams(), { caller: "test-timeout", timeoutMs: 50 }),
    ).rejects.toThrow(/abort/i);
  });

  test("records failed call with error_message", async () => {
    const { client } = createMockClient("always-fail");
    _setClientForTesting(client);

    await expect(
      createMessage(makeTestParams(), { caller: "test-error-record" }),
    ).rejects.toThrow();

    const row = testDb.prepare("SELECT * FROM llm_calls LIMIT 1").get() as LlmCallRecord;

    expect(row).toBeTruthy();
    expect(row.success).toBe(0);
    expect(row.error_message).toContain("Bad request");
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.usage_available).toBe(0);
    expect(row.cost_available).toBe(0);
  });

  test("getUsageStats returns correct aggregation", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    // Make a few calls
    await createMessage(makeTestParams(), { caller: "analyzer" });
    await createMessage(makeTestParams(), { caller: "analyzer" });
    await createMessage(makeTestParams(), { caller: "drafter" });

    const stats = getUsageStats();

    expect(stats.today.totalCalls).toBe(3);
    expect(stats.today.totalCostCents).toBeGreaterThan(0);
    expect(stats.thisWeek.totalCalls).toBe(3);
    expect(stats.thisMonth.totalCalls).toBe(3);

    // byCaller should have 2 entries
    expect(stats.byCaller).toHaveLength(2);
    const analyzerEntry = stats.byCaller.find((e) => e.caller === "analyzer");
    expect(analyzerEntry?.calls).toBe(2);
    const drafterEntry = stats.byCaller.find((e) => e.caller === "drafter");
    expect(drafterEntry?.calls).toBe(1);
  });

  test("getCallHistory returns records in descending order", async () => {
    const { client } = createMockClient("success");
    _setClientForTesting(client);

    await createMessage(makeTestParams(), { caller: "first" });
    await createMessage(makeTestParams(), { caller: "second" });
    await createMessage(makeTestParams(), { caller: "third" });

    const history = getCallHistory(10);

    expect(history).toHaveLength(3);
    // Most recent first
    expect(history[0].caller).toBe("third");
    expect(history[1].caller).toBe("second");
    expect(history[2].caller).toBe("first");
  });

  test("getUsageStats returns zeroes when no calls recorded", () => {
    const stats = getUsageStats();

    expect(stats.today.totalCalls).toBe(0);
    expect(stats.today.totalCostCents).toBe(0);
    expect(stats.byModel).toHaveLength(0);
    expect(stats.byCaller).toHaveLength(0);
  });

  test("getCallHistory returns empty array when no calls recorded", () => {
    const history = getCallHistory();
    expect(history).toHaveLength(0);
  });
});
