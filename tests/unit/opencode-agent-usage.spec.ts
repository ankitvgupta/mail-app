import { expect, test } from "@playwright/test";
import type { AssistantMessage, Event } from "@opencode-ai/sdk";

import {
  buildOpenCodeAgentConfig,
  createOpenCodeRunUsageTracker,
  OpenCodeAgentProvider,
  requestedOpenCodeModelLabel,
} from "../../src/main/agents/providers/opencode/opencode-agent-provider";
import type {
  AgentContext,
  AgentRunParams,
  AgentSessionStartFn,
} from "../../src/main/agents/types";
import {
  recordAgentSessionStart,
  setAnthropicServiceDb,
} from "../../src/main/services/llm-service";

type RecordedInsert = unknown[];

function useRecordingDb(): RecordedInsert[] {
  const inserts: RecordedInsert[] = [];
  setAnthropicServiceDb({
    exec: () => {},
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes("INSERT INTO llm_calls")) inserts.push(args);
      },
      get: () => undefined,
      all: () => [],
    }),
    transaction: <T>(fn: () => T) => fn,
  });
  return inserts;
}

function assistantSnapshot(
  id: string,
  overrides: {
    sessionID?: string;
    created?: number;
    completed?: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  },
): AssistantMessage {
  return {
    id,
    sessionID: overrides.sessionID ?? "session-1",
    role: "assistant",
    time: {
      created: overrides.created ?? 100,
      completed: overrides.completed ?? 200,
    },
    parentID: "user-1",
    modelID: "gpt-5.2",
    providerID: "openai",
    mode: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: overrides.cost,
    tokens: {
      input: overrides.input,
      output: overrides.output,
      reasoning: 0,
      cache: {
        read: overrides.cacheRead,
        write: overrides.cacheWrite,
      },
    },
  };
}

function messageUpdated(info: AssistantMessage): Event {
  return { type: "message.updated", properties: { info } };
}

function baseRunParams(recordSessionStart: AgentSessionStartFn): AgentRunParams {
  return {
    taskId: "task-1",
    prompt: "hello",
    context: { accountId: "account-1" } as AgentContext,
    tools: [],
    toolExecutor: async () => undefined,
    netFetch: async () => ({ status: 200, headers: {}, body: "" }),
    recordSessionStart,
    signal: new AbortController().signal,
  };
}

async function exhaustRun(
  provider: OpenCodeAgentProvider,
  params: AgentRunParams,
): Promise<{ state: string; events: Array<{ type: string; message?: string }> }> {
  const events: Array<{ type: string; message?: string }> = [];
  const run = provider.run(params);
  while (true) {
    const next = await run.next();
    if (next.done) return { state: next.value.state, events };
    events.push(next.value);
  }
}

test("OpenCode agent config preserves the mail bridge and delegates providers to global config", () => {
  expect(buildOpenCodeAgentConfig("http://127.0.0.1:4321/mcp")).toEqual({
    logLevel: "WARN",
    mcp: {
      "mail-app-tools": {
        type: "remote",
        url: "http://127.0.0.1:4321/mcp",
        enabled: true,
      },
    },
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  });
});

test("OpenCode availability needs no Exo-managed LLM credential", async () => {
  const provider = new OpenCodeAgentProvider({
    model: "claude-sonnet-4-6",
    opencode: { enabled: true },
  });

  await expect(provider.isAvailable()).resolves.toBe(true);
});

test("latest assistant snapshots are deduplicated and successful usage is recorded once", () => {
  const inserts = useRecordingDb();
  const tracker = createOpenCodeRunUsageTracker({
    sessionId: "session-1",
    accountId: "account-1",
    emailId: "email-1",
    recordSessionStart: recordAgentSessionStart,
  });

  tracker.observe(
    messageUpdated(
      assistantSnapshot("assistant-1", {
        input: 10,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        cost: 0.01,
      }),
    ),
  );
  tracker.observe(
    messageUpdated(
      assistantSnapshot("assistant-1", {
        input: 12,
        output: 4,
        cacheRead: 3,
        cacheWrite: 1,
        cost: 0.02,
      }),
    ),
  );
  tracker.observe(
    messageUpdated(
      assistantSnapshot("assistant-2", {
        created: 300,
        input: 5,
        output: 3,
        cacheRead: 2,
        cacheWrite: 4,
        cost: 0.03,
      }),
    ),
  );
  tracker.observe(
    messageUpdated(
      assistantSnapshot("other-session", {
        sessionID: "session-2",
        input: 999,
        output: 999,
        cacheRead: 999,
        cacheWrite: 999,
        cost: 99,
      }),
    ),
  );

  tracker.record({ durationMs: 125, success: true });
  tracker.record({ durationMs: 999, success: false, errorMessage: "duplicate" });

  expect(inserts).toHaveLength(1);
  expect(inserts[0].slice(1)).toEqual([
    "openai/gpt-5.2",
    "agent-run:opencode",
    "email-1",
    "account-1",
    17,
    7,
    5,
    5,
    5,
    125,
    1,
    null,
    "opencode",
    1,
    1,
  ]);
});

test("failed OpenCode runs include accumulated usage and the exact error", () => {
  const inserts = useRecordingDb();
  const tracker = createOpenCodeRunUsageTracker({
    sessionId: "session-1",
    recordSessionStart: recordAgentSessionStart,
  });
  tracker.observe(
    messageUpdated(
      assistantSnapshot("assistant-1", {
        input: 8,
        output: 1,
        cacheRead: 2,
        cacheWrite: 3,
        cost: 0.006,
      }),
    ),
  );

  tracker.record({ durationMs: 44, success: false, errorMessage: "quota exhausted" });

  expect(inserts).toHaveLength(1);
  expect(inserts[0].slice(1)).toEqual([
    "openai/gpt-5.2",
    "agent-run:opencode",
    null,
    null,
    8,
    1,
    2,
    3,
    0.6,
    44,
    0,
    "quota exhausted",
    "opencode",
    1,
    1,
  ]);
});

test("missing OpenCode usage and cost stay distinguishable from observed zero", () => {
  const inserts = useRecordingDb();
  const tracker = createOpenCodeRunUsageTracker({
    requestedModel: "opencode-default",
    recordSessionStart: recordAgentSessionStart,
  });

  tracker.record({ durationMs: 12, success: false, errorMessage: "startup failed" });
  tracker.record({ durationMs: 99, success: true });

  expect(inserts).toHaveLength(1);
  expect(inserts[0].slice(1)).toEqual([
    "opencode-default",
    "agent-run:opencode",
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    12,
    0,
    "startup failed",
    "opencode",
    0,
    0,
  ]);
});

test("early OpenCode startup failure records exactly one terminal failure", async () => {
  const provider = new OpenCodeAgentProvider({
    model: "claude-sonnet-4-6",
    opencode: { enabled: true },
  });
  Object.defineProperty(provider, "ensureServer", {
    value: async () => {
      throw new Error("server unavailable");
    },
  });
  const records: Parameters<AgentSessionStartFn>[0][] = [];

  const result = await exhaustRun(
    provider,
    baseRunParams((record) => {
      records.push(record);
    }),
  );

  expect(result.state).toBe("failed");
  expect(records).toEqual([
    expect.objectContaining({
      model: "opencode-default",
      success: false,
      errorMessage: "Failed to start OpenCode server: server unavailable",
    }),
  ]);
});

test("event stream ending without session idle records a failure with partial usage", async () => {
  const provider = new OpenCodeAgentProvider({
    model: "claude-sonnet-4-6",
    opencode: { enabled: true },
  });
  const stream = (async function* (): AsyncGenerator<Event> {
    yield messageUpdated(
      assistantSnapshot("assistant-1", {
        input: 8,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        cost: 0.004,
      }),
    );
  })();
  Object.defineProperty(provider, "ensureServer", {
    value: async () => ({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  name: "OpenAI",
                  models: { "gpt-5.2": { id: "gpt-5.2", name: "GPT-5.2" } },
                },
              ],
              connected: ["openai"],
              default: {},
            },
          }),
        },
        session: {
          create: async () => ({ data: { id: "session-1" } }),
          promptAsync: async () => ({ data: undefined }),
          messages: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
        },
        event: {
          subscribe: async () => ({ stream }),
        },
      },
      close: () => {},
      bridgeUrl: "http://127.0.0.1:4321/mcp",
    }),
  });
  const records: Parameters<AgentSessionStartFn>[0][] = [];

  const result = await exhaustRun(provider, {
    ...baseRunParams((record) => {
      records.push(record);
    }),
    modelOverride: "openai/gpt-5.2",
  });

  expect(result.state).toBe("failed");
  expect(result.events).toContainEqual(
    expect.objectContaining({
      type: "error",
      message: "OpenCode event stream ended before session completion",
    }),
  );
  expect(records).toEqual([
    expect.objectContaining({
      model: "openai/gpt-5.2",
      inputTokens: 8,
      outputTokens: 2,
      success: false,
      errorMessage: "OpenCode event stream ended before session completion",
    }),
  ]);
});

test("early route labels use exact requests and never invent a default model", () => {
  const config = {
    model: "claude-sonnet-4-6",
    opencode: { enabled: true, model: "anthropic/claude-sonnet-4-5" },
  };

  expect(requestedOpenCodeModelLabel(config, "openai/gpt-5.2")).toBe("openai/gpt-5.2");
  expect(requestedOpenCodeModelLabel(config, "bare-model")).toBe("opencode-default");
  expect(requestedOpenCodeModelLabel({ ...config, opencode: { enabled: true } }, " ")).toBe(
    "opencode-default",
  );
});
