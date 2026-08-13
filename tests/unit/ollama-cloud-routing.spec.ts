/**
 * Unit tests for Ollama Cloud routing in LLM Service.
 *
 * Tests cover: provider-aware client routing, cache_control stripping,
 * cost recording (zero for Ollama), provider column recording, and
 * error handling when no Ollama key is configured.
 *
 * Strategy: Use _setClientForTesting() and _setOllamaClientForTesting()
 * to inject mock clients, and setAnthropicServiceDb() with an in-memory
 * SQLite database for cost tracking.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import {
  createMessage,
  _setClientForTesting,
  _setOllamaClientForTesting,
  setAnthropicServiceDb,
  type LlmCallRecord,
} from "../../src/main/services/llm-service";

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

// --- Mock client factory ---

interface MockCall {
  params: Record<string, unknown>;
  options?: Record<string, unknown>;
}

function createMockClient() {
  const calls: MockCall[] = [];

  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ params, options });
        return {
          id: "msg_test_123",
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Hello from mock" }],
          model: params.model as string,
          stop_reason: "end_turn" as const,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        };
      },
    },
  };

  return { client, calls };
}

function makeTestParams(model: string = "claude-sonnet-4-20250514") {
  return {
    model,
    max_tokens: 256,
    messages: [{ role: "user" as const, content: "Hello" }],
  };
}

// --- Tests ---

test.describe("Ollama Cloud routing", () => {
  test.skip(!!nativeModuleError, `Skipping: ${nativeModuleError}`);

  let testDb: DB;

  test.beforeEach(() => {
    testDb = new DatabaseCtor!(":memory:");
    setAnthropicServiceDb(testDb);
  });

  test.afterEach(() => {
    _setClientForTesting(null);
    _setOllamaClientForTesting(null);
    testDb?.close();
  });

  test("createMessage with provider=ollama-cloud uses the Ollama client", async () => {
    const anthropicMock = createMockClient();
    const ollamaMock = createMockClient();
    _setClientForTesting(anthropicMock.client);
    _setOllamaClientForTesting(ollamaMock.client);

    await createMessage(makeTestParams("minimax-m2.7:cloud"), {
      caller: "test-routing",
      provider: "ollama-cloud",
    });

    expect(ollamaMock.calls).toHaveLength(1);
    expect(anthropicMock.calls).toHaveLength(0);
  });

  test("createMessage with provider=anthropic uses the default client", async () => {
    const anthropicMock = createMockClient();
    const ollamaMock = createMockClient();
    _setClientForTesting(anthropicMock.client);
    _setOllamaClientForTesting(ollamaMock.client);

    await createMessage(makeTestParams(), {
      caller: "test-routing-default",
      provider: "anthropic",
    });

    expect(anthropicMock.calls).toHaveLength(1);
    expect(ollamaMock.calls).toHaveLength(0);
  });

  test("createMessage without provider uses the default Anthropic client", async () => {
    const anthropicMock = createMockClient();
    const ollamaMock = createMockClient();
    _setClientForTesting(anthropicMock.client);
    _setOllamaClientForTesting(ollamaMock.client);

    await createMessage(makeTestParams(), {
      caller: "test-routing-no-provider",
    });

    expect(anthropicMock.calls).toHaveLength(1);
    expect(ollamaMock.calls).toHaveLength(0);
  });

  test("createMessage with provider=ollama-cloud strips cache_control from system messages", async () => {
    const ollamaMock = createMockClient();
    _setOllamaClientForTesting(ollamaMock.client);

    const paramsWithCache = {
      model: "minimax-m2.7:cloud",
      max_tokens: 256,
      system: [
        {
          type: "text" as const,
          text: "You are a helpful assistant.",
          cache_control: { type: "ephemeral" as const },
        },
        {
          type: "text" as const,
          text: "Additional context.",
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: [{ role: "user" as const, content: "Hello" }],
    };

    await createMessage(paramsWithCache, {
      caller: "test-cache-strip",
      provider: "ollama-cloud",
    });

    expect(ollamaMock.calls).toHaveLength(1);
    const sentParams = ollamaMock.calls[0].params;
    const system = sentParams.system as Array<Record<string, unknown>>;
    for (const block of system) {
      expect(block).not.toHaveProperty("cache_control");
      // Text should still be present
      expect(block).toHaveProperty("text");
    }
  });

  test("createMessage with provider=ollama-cloud raises max_tokens to support thinking models", async () => {
    // Models like minimax-m2.7:cloud emit `thinking` blocks before `text`. With low
    // max_tokens (e.g., 256 from email-analyzer), thinking exhausts the budget and no
    // text is produced. We raise to a safe floor so text still comes through.
    const ollamaMock = createMockClient();
    _setOllamaClientForTesting(ollamaMock.client);

    await createMessage(
      {
        model: "minimax-m2.7:cloud",
        max_tokens: 256, // realistic low value from email-analyzer
        messages: [{ role: "user" as const, content: "Test" }],
      },
      { caller: "test-raise-tokens", provider: "ollama-cloud" },
    );

    expect(ollamaMock.calls[0].params.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  test("createMessage with provider=ollama-cloud preserves max_tokens when already high", async () => {
    const ollamaMock = createMockClient();
    _setOllamaClientForTesting(ollamaMock.client);

    await createMessage(
      {
        model: "minimax-m2.7:cloud",
        max_tokens: 8192,
        messages: [{ role: "user" as const, content: "Test" }],
      },
      { caller: "test-keep-tokens", provider: "ollama-cloud" },
    );

    expect(ollamaMock.calls[0].params.max_tokens).toBe(8192);
  });

  test("createMessage with provider=anthropic does NOT raise max_tokens", async () => {
    const anthropicMock = createMockClient();
    _setClientForTesting(anthropicMock.client);

    await createMessage(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 256,
        messages: [{ role: "user" as const, content: "Test" }],
      },
      { caller: "test-anthropic-tokens", provider: "anthropic" },
    );

    expect(anthropicMock.calls[0].params.max_tokens).toBe(256);
  });

  test("createMessage with provider=anthropic preserves cache_control in system messages", async () => {
    const anthropicMock = createMockClient();
    _setClientForTesting(anthropicMock.client);

    const paramsWithCache = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      system: [
        {
          type: "text" as const,
          text: "You are a helpful assistant.",
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: [{ role: "user" as const, content: "Hello" }],
    };

    await createMessage(paramsWithCache, {
      caller: "test-cache-preserve",
      provider: "anthropic",
    });

    const sentParams = anthropicMock.calls[0].params;
    const system = sentParams.system as Array<Record<string, unknown>>;
    expect(system[0]).toHaveProperty("cache_control");
  });

  test("createMessage with provider=ollama-cloud records cost_cents=0", async () => {
    const ollamaMock = createMockClient();
    _setOllamaClientForTesting(ollamaMock.client);

    await createMessage(makeTestParams("minimax-m2.7:cloud"), {
      caller: "test-zero-cost",
      provider: "ollama-cloud",
    });

    const row = testDb.prepare("SELECT cost_cents FROM llm_calls LIMIT 1").get() as {
      cost_cents: number;
    };

    expect(row).toBeTruthy();
    expect(row.cost_cents).toBe(0);
  });

  test("createMessage with provider=ollama-cloud records provider=ollama-cloud in llm_calls", async () => {
    const ollamaMock = createMockClient();
    _setOllamaClientForTesting(ollamaMock.client);

    await createMessage(makeTestParams("minimax-m2.7:cloud"), {
      caller: "test-provider-col",
      provider: "ollama-cloud",
    });

    const row = testDb.prepare("SELECT provider FROM llm_calls LIMIT 1").get() as {
      provider: string;
    };

    expect(row).toBeTruthy();
    expect(row.provider).toBe("ollama-cloud");
  });

  test("createMessage with provider=anthropic records provider=anthropic in llm_calls", async () => {
    const anthropicMock = createMockClient();
    _setClientForTesting(anthropicMock.client);

    await createMessage(makeTestParams(), {
      caller: "test-provider-anthropic",
      provider: "anthropic",
    });

    const row = testDb.prepare("SELECT provider FROM llm_calls LIMIT 1").get() as {
      provider: string;
    };

    expect(row).toBeTruthy();
    expect(row.provider).toBe("anthropic");
  });

  test("createMessage with provider=ollama-cloud throws when no key configured", async () => {
    // Don't set up any Ollama client or config — should throw
    _setOllamaClientForTesting(null);

    await expect(
      createMessage(makeTestParams("minimax-m2.7:cloud"), {
        caller: "test-no-key",
        provider: "ollama-cloud",
      }),
    ).rejects.toThrow(/Ollama Cloud API key not configured/);
  });
});
