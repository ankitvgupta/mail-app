import { expect, test } from "@playwright/test";

import {
  OpenCodeInferenceService,
  type OpenCodeLauncher,
} from "../../src/main/services/opencode-inference-service";

type PromptInput = {
  sessionID: string;
  model?: { providerID: string; modelID: string };
  system?: string;
  tools: Record<string, boolean>;
  format:
    | { type: "text" }
    | { type: "json_schema"; schema: Record<string, unknown> };
  parts: Array<{ type: "text"; text: string }>;
};

type CreateInput = {
  title: string;
  permission: Array<{
    permission: string;
    pattern: string;
    action: "deny";
  }>;
};

type FakeOptions = {
  providerFailure?: boolean;
  toolFailure?: boolean;
  promptFailure?: Error;
  deleteFailure?: Error;
  deleteResponseFailure?: boolean;
  structured?: unknown;
  waitForAbort?: boolean;
  startup?: Promise<void>;
  startupFailures?: number;
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFake(options: FakeOptions = {}) {
  const calls = {
    launches: 0,
    closes: 0,
    providerLists: 0,
    toolLists: 0,
    creates: [] as CreateInput[],
    prompts: [] as PromptInput[],
    deletes: [] as string[],
  };

  const response = {
    info: {
      id: "assistant-1",
      role: "assistant" as const,
      providerID: "openai",
      modelID: "gpt-5.2",
      cost: 0.0123,
      tokens: {
        input: 120,
        output: 35,
        reasoning: 7,
        cache: { read: 10, write: 4 },
      },
      finish: "stop",
      ...(options.structured === undefined ? {} : { structured: options.structured }),
    },
    parts: [{ type: "text" as const, text: "hello" }],
  };

  const client = {
    provider: {
      list: async () => {
        calls.providerLists += 1;
        if (options.providerFailure) return { error: new Error("provider failure") };
        return {
          data: {
            all: [
              {
                id: "openai",
                name: "OpenAI",
                models: {
                  "gpt-5.2": { id: "gpt-5.2", name: "GPT 5.2" },
                  "gpt-5.1": { id: "gpt-5.1", name: "GPT 5.1" },
                },
              },
              {
                id: "anthropic",
                name: "Anthropic",
                models: {
                  "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet" },
                },
              },
              {
                id: "ollama",
                name: "Ollama",
                models: {
                  "local-only": { id: "local-only", name: "Local Only" },
                },
              },
            ],
            connected: ["openai", "anthropic"],
            default: {},
          },
        };
      },
    },
    tool: {
      ids: async () => {
        calls.toolLists += 1;
        return options.toolFailure
          ? { error: new Error("tool failure") }
          : { data: ["bash", "read", "write"] };
      },
    },
    session: {
      create: async (input: CreateInput) => {
        calls.creates.push(input);
        return { data: { id: `session-${calls.creates.length}` } };
      },
      prompt: async (input: PromptInput, requestOptions?: { signal?: AbortSignal }) => {
        calls.prompts.push(input);
        if (options.promptFailure) throw options.promptFailure;
        if (options.waitForAbort) {
          await new Promise<never>((_resolve, reject) => {
            const signal = requestOptions?.signal;
            const abort = () => reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return { data: response };
      },
      delete: async ({ sessionID }: { sessionID: string }) => {
        calls.deletes.push(sessionID);
        if (options.deleteFailure) throw options.deleteFailure;
        if (options.deleteResponseFailure) {
          return { error: new Error("cleanup response failure") };
        }
        return { data: true };
      },
    },
  };

  const launcher = (async () => {
    calls.launches += 1;
    if (calls.launches <= (options.startupFailures ?? 0)) {
      throw new Error("startup failed");
    }
    await options.startup;
    return {
      client,
      close: () => {
        calls.closes += 1;
      },
    };
  }) as unknown as OpenCodeLauncher;

  return {
    calls,
    service: new OpenCodeInferenceService(launcher),
  };
}

test("simultaneous first calls share one lazy launch", async () => {
  const startup = deferred();
  const { calls, service } = createFake({ startup: startup.promise });

  const first = service.listModels();
  const second = service.listModels();
  await expect.poll(() => calls.launches).toBe(1);
  startup.resolve();

  await Promise.all([first, second]);
  expect(calls.launches).toBe(1);
});

test("close during startup closes and rejects the stale handle", async () => {
  const startup = deferred();
  const { calls, service } = createFake({ startup: startup.promise });

  const stale = service.listModels();
  await expect.poll(() => calls.launches).toBe(1);
  service.close();
  startup.resolve();

  await expect(stale).rejects.toThrow(/changed during startup/);
  expect(calls.closes).toBe(1);
  await service.listModels();
  expect(calls.launches).toBe(2);
});

test("startup failure clears the shared promise so the next call retries", async () => {
  const { calls, service } = createFake({ startupFailures: 1 });

  await expect(service.listModels()).rejects.toThrow("startup failed");
  await service.listModels();

  expect(calls.launches).toBe(2);
});

test("listModels returns only connected providers sorted by provider and model name", async () => {
  const { service } = createFake();

  await expect(service.listModels()).resolves.toEqual([
    {
      providerId: "anthropic",
      providerName: "Anthropic",
      modelId: "claude-sonnet",
      modelName: "Claude Sonnet",
    },
    {
      providerId: "openai",
      providerName: "OpenAI",
      modelId: "gpt-5.1",
      modelName: "GPT 5.1",
    },
    {
      providerId: "openai",
      providerName: "OpenAI",
      modelId: "gpt-5.2",
      modelName: "GPT 5.2",
    },
  ]);
});

test("provider catalog failure is visible instead of becoming an empty catalog", async () => {
  const { service } = createFake({ providerFailure: true });

  await expect(service.listModels()).rejects.toThrow(/provider catalog/);
});

test("exact and unique bare selectors route through the shared catalog resolver", async () => {
  const { calls, service } = createFake();

  await service.complete({ selector: "openai/gpt-5.2", prompt: "exact" });
  await service.complete({ selector: "claude-sonnet", prompt: "bare" });

  expect(calls.prompts.map((prompt) => prompt.model)).toEqual([
    { providerID: "openai", modelID: "gpt-5.2" },
    { providerID: "anthropic", modelID: "claude-sonnet" },
  ]);
});

test("missing selectors fail visibly without cross-fallback or prompting", async () => {
  const { calls, service } = createFake();

  await expect(
    service.complete({ selector: "missing-model", prompt: "must not run" }),
  ).rejects.toThrow('OpenCode model "missing-model" is not available');
  expect(calls.toolLists).toBe(0);
  expect(calls.creates).toHaveLength(0);
  expect(calls.prompts).toHaveLength(0);
});

test("completion disables every discovered tool and denies every permission", async () => {
  const { calls, service } = createFake();

  await service.complete({ prompt: "hello" });

  expect(calls.creates).toHaveLength(1);
  expect(calls.creates[0].permission).toEqual([
    { permission: "*", pattern: "*", action: "deny" },
  ]);
  expect(calls.prompts[0].tools).toEqual({
    bash: false,
    read: false,
    write: false,
  });
  expect(calls.prompts[0].model).toBeUndefined();
});

test("tool catalog failure fails closed before session creation or prompting", async () => {
  const { calls, service } = createFake({ toolFailure: true });

  await expect(service.complete({ prompt: "must not run" })).rejects.toThrow(
    "OpenCode tool catalog could not be loaded",
  );
  expect(calls.creates).toHaveLength(0);
  expect(calls.prompts).toHaveLength(0);
});

test("JSON schema output and complete response accounting are preserved", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  };
  const structured = { answer: "hello" };
  const { calls, service } = createFake({ structured });

  await expect(
    service.complete({
      selector: "openai/gpt-5.2",
      system: "Return JSON",
      prompt: "hello",
      outputSchema: schema,
    }),
  ).resolves.toEqual({
    id: "assistant-1",
    text: "hello",
    structured,
    providerId: "openai",
    modelId: "gpt-5.2",
    finishReason: "stop",
    inputTokens: 120,
    outputTokens: 35,
    cacheReadTokens: 10,
    cacheWriteTokens: 4,
    reasoningTokens: 7,
    costDollars: 0.0123,
  });
  expect(calls.prompts[0]).toMatchObject({
    system: "Return JSON",
    format: { type: "json_schema", schema },
    parts: [{ type: "text", text: "hello" }],
  });
  expect(calls.deletes).toEqual(["session-1"]);
});

test("prompt failure still deletes the created session", async () => {
  const { calls, service } = createFake({ promptFailure: new Error("prompt failed") });

  await expect(service.complete({ prompt: "hello" })).rejects.toThrow("prompt failed");
  expect(calls.deletes).toEqual(["session-1"]);
});

test("abort still deletes the created session", async () => {
  const controller = new AbortController();
  const { calls, service } = createFake({ waitForAbort: true });

  const completion = service.complete({ prompt: "hello", signal: controller.signal });
  await expect.poll(() => calls.prompts.length).toBe(1);
  controller.abort(new Error("cancelled"));

  await expect(completion).rejects.toThrow("cancelled");
  expect(calls.deletes).toEqual(["session-1"]);
});

test("cleanup failure does not replace the original prompt failure", async () => {
  const { service } = createFake({
    promptFailure: new Error("original prompt failure"),
    deleteFailure: new Error("cleanup failure"),
  });

  await expect(service.complete({ prompt: "hello" })).rejects.toThrow(
    "original prompt failure",
  );
});

test("cleanup response failure is visible after a successful prompt", async () => {
  const { service } = createFake({ deleteResponseFailure: true });

  await expect(service.complete({ prompt: "hello" })).rejects.toThrow(
    "OpenCode session.delete failed",
  );
});

test("close shuts down the current server and forces the next call to relaunch", async () => {
  const { calls, service } = createFake();

  await service.listModels();
  service.close();
  await service.listModels();

  expect(calls.closes).toBe(1);
  expect(calls.launches).toBe(2);
});
