# OpenCode Per-Feature Provider Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode a first-class per-feature provider across Exo's AI Models settings, one-shot feature inference, Agent Drafter, and Agent Chat.

**Architecture:** Extend the existing `featureProviders → getFeatureModelConfig() → createMessage()` path with an OpenCode branch backed by one lazy, tool-disabled main-process OpenCode v2 server. Keep tool-enabled agent sessions in the existing worker `OpenCodeAgentProvider`, but let both paths use OpenCode's own connected providers, credentials, defaults, and exact per-feature model selectors.

**Tech Stack:** Electron, React 18, TypeScript, Zod 4, `@opencode-ai/sdk` 1.15.10 v1/v2 clients, TanStack Query, SQLite, Playwright.

## Global Constraints

- OpenCode owns provider authentication and configuration; Exo must not read, copy, expose, or persist OpenCode's `auth.json`.
- Store exact OpenCode selectors as `provider/model` in `opencode.featureModels`.
- Resolve OpenCode models in this order: per-feature selector, legacy `opencode.model`, then OpenCode's default.
- Preserve unavailable saved selectors and surface them; never silently replace them.
- Never cross-fallback from OpenCode to Anthropic or Ollama Cloud.
- Keep existing feature-specific conservative parsing fallbacks after a successful response.
- Disable every OpenCode tool and deny every OpenCode permission for one-shot feature calls.
- Keep the existing mail MCP tools and Exo permission gate for Agent Drafter and Agent Chat.
- Sender Lookup may use OpenCode only when Exa supplies search results.
- Use the installed Zod and OpenCode dependencies; add no package.
- Keep the main-process and worker OpenCode servers separate.
- Use Node.js `22.22.0` for install, tests, build, and packaging.
- Do not push, open a PR, or replace `/Applications/Exo.app` without the user's explicit authorization at that execution stage.

---

### Task 1: Add OpenCode configuration and deterministic model routing

**Files:**

- Modify: `src/shared/types.ts:300-665`
- Modify: `src/main/ipc/settings.ipc.ts:175-255`
- Modify: `src/main/ipc/settings.ipc.ts:353-575`
- Create: `tests/unit/opencode-config.spec.ts`
- Modify: `tests/unit/background-agent-provider.spec.ts:190-235`

**Interfaces:**

- Consumes: existing `ModelConfig`, `featureProviders`, `ConfigSchema`, and `applyAgentDrafterSelection()`.
- Produces: `OpenCodeModelOption`, `OpenCodeRoute`, `parseOpenCodeModelSelector()`, `resolveOpenCodeRoute()`, `getOpenCodeModelSelector()`, and OpenCode-aware `getFeatureModelConfig()`.

- [ ] **Step 1: Write failing schema and route-resolution tests**

Create `tests/unit/opencode-config.spec.ts` with focused tests:

```ts
import { test, expect } from "@playwright/test";
import {
  ConfigSchema,
  LlmProviderSchema,
  parseOpenCodeModelSelector,
  resolveOpenCodeRoute,
  type OpenCodeModelOption,
} from "../../src/shared/types";

const models: OpenCodeModelOption[] = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    modelId: "claude-sonnet-4-5",
    modelName: "Claude Sonnet 4.5",
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "gpt-5.2",
    modelName: "GPT-5.2",
  },
];

test("opencode is a valid LLM provider", () => {
  expect(LlmProviderSchema.parse("opencode")).toBe("opencode");
});

test("ConfigSchema preserves legacy and per-feature OpenCode models", () => {
  const cfg = ConfigSchema.parse({
    opencode: {
      enabled: true,
      model: "anthropic/claude-sonnet-4-5",
      featureModels: {
        analysis: "openai/gpt-5.2",
        drafts: "anthropic/claude-sonnet-4-5",
      },
    },
  });
  expect(cfg.opencode?.featureModels?.analysis).toBe("openai/gpt-5.2");
  expect(cfg.opencode?.model).toBe("anthropic/claude-sonnet-4-5");
});

test("exact selectors split on the first slash", () => {
  expect(parseOpenCodeModelSelector("openrouter/openai/gpt-5.2")).toEqual({
    providerID: "openrouter",
    modelID: "openai/gpt-5.2",
  });
});

test("blank selector delegates to the OpenCode default", () => {
  expect(resolveOpenCodeRoute("", models)).toBeUndefined();
});

test("legacy bare selector resolves only when unique", () => {
  expect(resolveOpenCodeRoute("gpt-5.2", models)).toEqual({
    providerID: "openai",
    modelID: "gpt-5.2",
  });
  expect(() =>
    resolveOpenCodeRoute("same-id", [
      { ...models[0], modelId: "same-id" },
      { ...models[1], modelId: "same-id" },
    ]),
  ).toThrow(/ambiguous/i);
});

test("missing legacy selector fails visibly", () => {
  expect(() => resolveOpenCodeRoute("removed-model", models)).toThrow(/not available/i);
});

test("missing exact selector fails visibly", () => {
  expect(() => resolveOpenCodeRoute("openai/removed-model", models)).toThrow(/not available/i);
});
```

Update the Agent Drafter selection test to require:

```ts
expect(applyAgentDrafterSelection("opencode")).toEqual({
  backgroundAgentProvider: "opencode",
  agentDrafterProvider: "opencode",
});
```

- [ ] **Step 2: Run the focused tests and verify the new expectations fail**

Run:

```bash
npx playwright test --project=unit tests/unit/opencode-config.spec.ts tests/unit/background-agent-provider.spec.ts
```

Expected: failure because `opencode` is not an `LlmProvider`, the model types/helpers do not exist, and the Agent Drafter selection does not synchronize `featureProviders.agentDrafter`.

- [ ] **Step 3: Add the shared OpenCode types and pure selector resolver**

Implement in `src/shared/types.ts`:

```ts
export const LLM_PROVIDERS = ["anthropic", "ollama-cloud", "opencode"] as const;
export const LlmProviderSchema = z.enum(LLM_PROVIDERS);

export type OpenCodeModelOption = {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
};

export type OpenCodeRoute = {
  providerID: string;
  modelID: string;
};

export function parseOpenCodeModelSelector(
  selector: string | undefined,
): OpenCodeRoute | undefined {
  const value = selector?.trim();
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  };
}

export function resolveOpenCodeRoute(
  selector: string | undefined,
  models: OpenCodeModelOption[],
): OpenCodeRoute | undefined {
  const value = selector?.trim();
  if (!value) return undefined;
  const exact = parseOpenCodeModelSelector(value);
  if (exact) {
    const available = models.some(
      (model) => model.providerId === exact.providerID && model.modelId === exact.modelID,
    );
    if (available) return exact;
    throw new Error(`OpenCode model "${value}" is not available from a connected provider`);
  }
  const matches = models.filter((model) => model.modelId === value);
  if (matches.length === 1) {
    return { providerID: matches[0].providerId, modelID: matches[0].modelId };
  }
  if (matches.length === 0) {
    throw new Error(`OpenCode model "${value}" is not available from a connected provider`);
  }
  throw new Error(`OpenCode model "${value}" is ambiguous; select an exact provider/model`);
}
```

Extend the existing inline `opencode` schema with:

```ts
featureModels: z.record(z.string(), z.string()).optional(),
```

Return `agentDrafterProvider: "opencode"` from the OpenCode external-runtime branch of `applyAgentDrafterSelection()`. Leave Hostler's branch unchanged.

- [ ] **Step 4: Route features through per-feature, legacy, and default selectors**

Add to `src/main/ipc/settings.ipc.ts`:

```ts
export function getOpenCodeModelSelector(feature: keyof ModelConfig): string {
  const opencode = getConfig().opencode;
  return opencode?.featureModels?.[feature] ?? opencode?.model ?? "";
}
```

Extend `getFeatureModelConfig()`:

```ts
if (provider === "opencode") {
  return { provider, model: getOpenCodeModelSelector(feature) };
}
```

Remove the Anthropic/Ollama credential gate from `getBackgroundAgentProviderId()`. OpenCode availability is `enabled + bundled binary`; its subprocess owns credentials and reports missing auth/model failures.

- [ ] **Step 5: Deep-merge OpenCode settings and propagate the full config**

In `settings:set`, preserve fields owned by the other settings surface:

```ts
if ("opencode" in config) {
  const incoming = config.opencode;
  const existing = currentConfig.opencode;
  newConfig = {
    ...newConfig,
    opencode: incoming
      ? {
          enabled: incoming.enabled ?? existing?.enabled ?? false,
          model: incoming.model ?? existing?.model,
          featureModels: incoming.featureModels ?? existing?.featureModels,
        }
      : undefined,
  };
}
```

Propagate `featureModels` through `agentCoordinator.updateConfig({ opencode: ... })`, and include `"featureProviders" in config` in that update condition so the worker sees Agent Drafter/Chat routing changes immediately.

- [ ] **Step 6: Re-run focused tests**

```bash
npx playwright test --project=unit tests/unit/opencode-config.spec.ts tests/unit/background-agent-provider.spec.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/ipc/settings.ipc.ts tests/unit/opencode-config.spec.ts tests/unit/background-agent-provider.spec.ts
git commit -m "Add per-feature OpenCode model routing"
```

---

### Task 2: Build the lazy, tool-disabled OpenCode inference service

**Files:**

- Create: `src/main/services/opencode-inference-service.ts`
- Modify: `src/main/agents/providers/opencode/opencode-agent-provider.ts:741-875`
- Create: `tests/unit/opencode-inference-service.spec.ts`

**Interfaces:**

- Consumes: `resolveOpencodeBinary()`, `resolveOpenCodeRoute()`, OpenCode v2 `provider.list`, `tool.ids`, `session.create`, `session.prompt`, and `session.delete`.
- Produces: `OpenCodeInferenceService.complete()`, `.listModels()`, `.close()`, `OpenCodeInferenceRequest`, and `OpenCodeInferenceResult`.

- [ ] **Step 1: Write failing service tests with an injected launcher**

Create a fake v2 client that records calls and returns:

```ts
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
  },
  parts: [{ type: "text" as const, text: "hello" }],
};
```

Cover these behaviors:

- two simultaneous first calls invoke the launcher once;
- `close()` during startup invalidates and closes the stale handle instead of publishing it;
- `listModels()` returns only models from `connected` provider IDs;
- exact and unique legacy bare selectors resolve correctly;
- the prompt sends every returned tool ID as `false`;
- failure to load tool IDs fails closed before prompting;
- the session receives `[{ permission: "*", pattern: "*", action: "deny" }]`;
- `format: { type: "json_schema", schema }` is sent when requested;
- response text, structured value, route, tokens, cache tokens, finish reason, and dollar cost are preserved;
- `session.delete()` runs on success, prompt failure, and abort;
- a cleanup error is secondary to the original prompt error;
- `close()` closes the server and clears the lazy handle.

- [ ] **Step 2: Run the service tests and verify they fail**

```bash
npx playwright test --project=unit tests/unit/opencode-inference-service.spec.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Export the existing binary resolver**

Add `export` to the current `resolveOpencodeBinary(): string | null` declaration without changing its memoized development or packaged resolution body.

- [ ] **Step 4: Define the narrow service boundary**

Create these public types:

```ts
export type OpenCodeInferenceRequest = {
  selector?: string;
  system?: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type OpenCodeInferenceResult = {
  id: string;
  text: string;
  structured?: unknown;
  providerId: string;
  modelId: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costDollars?: number;
};

type OpenCodeClient = ReturnType<typeof OpenCodeV2Client.createOpencodeClient>;
type OpenCodeClientLike = {
  provider: Pick<OpenCodeClient["provider"], "list">;
  tool: Pick<OpenCodeClient["tool"], "ids">;
  session: Pick<OpenCodeClient["session"], "create" | "prompt" | "delete">;
};

type OpenCodeHandle = {
  client: OpenCodeClientLike;
  close: () => void;
};

export type OpenCodeLauncher = () => Promise<OpenCodeHandle>;
```

The tests may cast their deliberately partial fake through `unknown` to `OpenCodeClientLike`; production remains checked against the installed SDK without using `any`.

- [ ] **Step 5: Implement the production v2 launcher**

Use the existing CJS-safe dynamic import pattern with the v2 exports:

```ts
import type * as OpenCodeV2Client from "@opencode-ai/sdk/v2/client";
import type * as OpenCodeV2Server from "@opencode-ai/sdk/v2/server";

const importDynamic = new Function("s", "return import(s)") as (
  specifier: string,
) => Promise<unknown>;

async function launchOpenCode(): Promise<OpenCodeHandle> {
  const binPath = resolveOpencodeBinary();
  if (!binPath) throw new Error("Bundled OpenCode executable was not found");
  const binDir = dirname(binPath);
  const currentPath = process.env.PATH ?? "";
  if (!currentPath.split(pathDelimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${pathDelimiter}${currentPath}`;
  }

  const serverModule = (await importDynamic(
    "@opencode-ai/sdk/v2/server",
  )) as typeof OpenCodeV2Server;
  const clientModule = (await importDynamic(
    "@opencode-ai/sdk/v2/client",
  )) as typeof OpenCodeV2Client;
  const server = await serverModule.createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 30_000,
    config: { logLevel: "WARN" },
  });
  const client = clientModule.createOpencodeClient({ baseUrl: server.url });
  return { client, close: () => server.close() };
}
```

Do not pass `provider`, provider keys, `disabled_providers`, or MCP configuration. That allows OpenCode to load its own global provider/auth configuration.

- [ ] **Step 6: Implement catalog filtering, routing, and isolated completion**

`listModels()` must require a successful `provider.list()` response, then flatten `data.all`, restricted to `data.connected`, into `OpenCodeModelOption[]`, sorted by provider name then model name. Do not turn provider-list errors into an empty catalog.

Reuse the existing OpenCode agent provider's generation-guard pattern: capture `configGeneration` before launching, publish the handle only if the generation still matches, close a stale handle, and clear the shared startup promise on failure. `close()` increments the generation before clearing/closing handles so an in-flight launch cannot republish itself.

`complete()` must:

```ts
const models = await this.listModels();
const route = resolveOpenCodeRoute(request.selector, models);
const toolResponse = await client.tool.ids();
const toolIds = toolResponse.data;
if (!toolIds) throw new Error("OpenCode tool catalog could not be loaded");
const tools = Object.fromEntries(toolIds.map((id) => [id, false]));
const created = await client.session.create({
  title: `exo-feature:${randomUUID()}`,
  permission: [{ permission: "*", pattern: "*", action: "deny" }],
});
const sessionId = created.data?.id;
if (!sessionId) throw new Error("OpenCode session.create returned no id");
```

Then call:

```ts
const prompted = await client.session.prompt(
  {
    sessionID: sessionId,
    ...(route ? { model: route } : {}),
    system: request.system,
    tools,
    format: request.outputSchema
      ? { type: "json_schema", schema: request.outputSchema }
      : { type: "text" },
    parts: [{ type: "text", text: request.prompt }],
  },
  { signal: request.signal },
);
if (!prompted.data) throw new Error("OpenCode session.prompt returned no response");
```

Extract `prompted.data.info.structured` when present; otherwise concatenate its text parts. Delete with `client.session.delete({ sessionID: sessionId })` in `finally`. If deletion fails after a prompt failure, log cleanup separately and rethrow the prompt failure.

Export the singleton used by IPC and `createMessage()`:

```ts
export const openCodeInferenceService = new OpenCodeInferenceService();
```

- [ ] **Step 7: Re-run service and binary tests**

```bash
npx playwright test --project=unit tests/unit/opencode-inference-service.spec.ts tests/unit/opencode-binary-resolution.spec.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/services/opencode-inference-service.ts src/main/agents/providers/opencode/opencode-agent-provider.ts tests/unit/opencode-inference-service.spec.ts
git commit -m "Add tool-disabled OpenCode inference service"
```

---

### Task 3: Route `createMessage()` through OpenCode and record real usage

**Files:**

- Modify: `src/main/services/llm-service.ts:1-375`
- Modify: `src/main/services/llm-service.ts:600-745`
- Modify: `tests/unit/llm-service.spec.ts`

**Interfaces:**

- Consumes: `OpenCodeInferenceService.complete()` and existing Anthropic-compatible `MessageCreateParamsNonStreaming`.
- Produces: OpenCode-compatible `CreateOptions.outputSchema`, an Anthropic-compatible `Message`, and `llm_calls` rows with exact route/tokens/cost.

- [ ] **Step 1: Add failing OpenCode adapter and recording tests**

Inject a fake service result:

```ts
{
  id: "assistant-1",
  text: "{\"needs_reply\":true,\"reason\":\"Direct question\"}",
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
}
```

Assert:

- `createMessage(..., { provider: "opencode" })` calls the fake exactly once;
- no Anthropic/Ollama retry client is called;
- system and message text are flattened without cache-control metadata;
- Zod schema is converted with `z.toJSONSchema()` and forwarded;
- returned `Message.model` is `openai/gpt-5.2`;
- returned usage matches OpenCode tokens;
- the DB row has `provider = "opencode"`, exact model, and `cost_cents = 1.23`;
- a service rejection creates one failed row and is rethrown;
- OpenCode calls with `params.tools` fail explicitly before inference.

- [ ] **Step 2: Run the focused LLM tests and verify they fail**

```bash
npx playwright test --project=unit tests/unit/llm-service.spec.ts
```

- [ ] **Step 3: Add the OpenCode schema and test seam**

Import runtime `z` from `zod` and add:

```ts
outputSchema?: z.ZodType;
```

Place that property at the end of the existing `CreateOptions` interface.

Add:

```ts
type OpenCodeServiceLike = Pick<OpenCodeInferenceService, "complete">;
let openCodeService: OpenCodeServiceLike = openCodeInferenceService;

export function _setOpenCodeServiceForTesting(service?: OpenCodeServiceLike): void {
  openCodeService = service ?? openCodeInferenceService;
}
```

Add `provider: string` to `LlmCallRecord`; the database query already returns that column and the OpenCode tests inspect it.

- [ ] **Step 4: Allow provider-reported cost without changing existing pricing**

Extend `recordCall()` with a final optional `costCentsOverride?: number`. Add it after `provider` and calculate:

```ts
const costCents =
  costCentsOverride ??
  (provider === "ollama-cloud"
    ? 0
    : calculateCostCents(model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens));
```

Existing Anthropic and Ollama callers continue unchanged.

- [ ] **Step 5: Add the OpenCode early branch before the retry loop**

Reject tool-bearing requests, flatten the current system/messages using the existing text helpers, create one timeout controller, and call the service once:

```ts
if (provider === "opencode") {
  if (params.tools?.length) {
    throw new Error("OpenCode feature inference does not support tools");
  }
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = timeoutMs ? setTimeout(() => controller?.abort(), timeoutMs) : undefined;
  try {
    const result = await openCodeService.complete({
      selector: params.model || undefined,
      system: flattenSystemPrompt(params.system),
      prompt: params.messages
        .map(
          (message) => `${message.role.toUpperCase()}:\n${flattenMessageContent(message.content)}`,
        )
        .join("\n\n"),
      outputSchema: options.outputSchema
        ? (z.toJSONSchema(options.outputSchema) as Record<string, unknown>)
        : undefined,
      signal: controller?.signal,
    });
    const resolvedModel = `${result.providerId}/${result.modelId}`;
    const text = result.structured === undefined ? result.text : JSON.stringify(result.structured);
    const response = {
      id: result.id,
      type: "message",
      role: "assistant",
      model: resolvedModel,
      content: [{ type: "text", text, citations: null }],
      container: null,
      stop_details: null,
      stop_reason: result.finishReason === "length" ? "max_tokens" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cache_creation_input_tokens: result.cacheWriteTokens,
        cache_read_input_tokens: result.cacheReadTokens,
        server_tool_use: null,
        service_tier: null,
      },
    } as Message;
    recordCall(
      resolvedModel,
      caller,
      emailId ?? null,
      accountId ?? null,
      result.inputTokens,
      result.outputTokens,
      result.cacheReadTokens,
      result.cacheWriteTokens,
      Date.now() - startTime,
      true,
      null,
      "opencode",
      result.costDollars === undefined ? undefined : result.costDollars * 100,
    );
    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    recordCall(
      params.model || "opencode-default",
      caller,
      emailId ?? null,
      accountId ?? null,
      0,
      0,
      0,
      0,
      Date.now() - startTime,
      false,
      errorMessage,
      "opencode",
    );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

When `result.structured` exists, serialize it as the text block. Use `result.providerId/result.modelId` for the recorded and returned model. Map cache read/write values to the existing Anthropic usage fields. Do not enter `RETRY_CONFIGS`.

- [ ] **Step 6: Re-run LLM tests**

```bash
npx playwright test --project=unit tests/unit/llm-service.spec.ts
```

Expected: all tests pass, including existing Anthropic/Ollama retry tests.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/llm-service.ts tests/unit/llm-service.spec.ts
git commit -m "Route feature inference through OpenCode"
```

---

### Task 4: Constrain structured features and remove hidden provider fallbacks

**Files:**

- Modify: `src/main/services/email-analyzer.ts:170-220`
- Modify: `src/main/services/calendaring-agent.ts:1-70`
- Modify: `src/main/services/archive-ready-analyzer.ts:1-80`
- Modify: `src/main/services/analysis-edit-learner.ts:285-500`
- Modify: `src/extensions/mail-ext-web-search/src/web-search-provider.ts:1-520`
- Modify: `tests/unit/email-analyzer.spec.ts`
- Modify: `tests/unit/calendaring-agent.spec.ts`
- Modify: `tests/unit/archive-ready.spec.ts`
- Modify: `tests/unit/sender-lookup.spec.ts`

**Interfaces:**

- Consumes: `CreateOptions.outputSchema` and each feature's existing Zod schema.
- Produces: native OpenCode JSON-schema requests while preserving every current parser and conservative fallback.

- [ ] **Step 1: Add failing assertions for structured options and Sender Lookup behavior**

Construct the analyzer, calendaring, and archive-ready services with `provider: "opencode"`, inject the fake OpenCode service via `_setOpenCodeServiceForTesting()`, and assert each captured `complete()` request contains its expected converted JSON schema.

Add a Sender Lookup case where:

```ts
getSearchConfig: () => ({
  provider: "exa",
  exaApiKey: "",
  anthropicConfigured: true,
}),
getParsingModelConfig: () => ({
  provider: "opencode",
  model: "openai/gpt-5.2",
}),
```

Assert the provider logs/skips the lookup and does not invoke Anthropic web search.

- [ ] **Step 2: Run the four focused suites and verify the assertions fail**

```bash
npx playwright test --project=unit tests/unit/email-analyzer.spec.ts tests/unit/calendaring-agent.spec.ts tests/unit/archive-ready.spec.ts tests/unit/sender-lookup.spec.ts
```

- [ ] **Step 3: Pass existing schemas to structured feature calls**

Pass these exact options:

```ts
{ caller: "email-analyzer", emailId: email.id, accountId, provider: this.provider, outputSchema: AnalysisResultSchema }
{ caller: "calendaring-agent", emailId: email.id, provider: this.provider, outputSchema: CalendaringResultSchema }
{ caller: "archive-ready-analyzer", provider: this.provider, outputSchema: ArchiveReadyResultSchema }
```

Import `CalendaringResultSchema` from shared types. Keep all three services' existing `JSON.parse` + Zod/conservative fallback code unchanged.

- [ ] **Step 4: Generalize analysis-learning model selection**

Replace each Ollama-only branch with its existing pinned Anthropic model and the configured model for every non-Anthropic provider:

```ts
const { provider, model: configuredModel } = getFeatureModelConfig("analysis");
const model = provider === "anthropic" ? "claude-sonnet-4-20250514" : configuredModel;
```

Use `claude-sonnet-4-20250514` in `analyzeOverride()`, `claude-sonnet-4-5-20250929` in `matchAnalysisDraftMemories()`, and `claude-haiku-4-5-20251001` in `classifyScope()`. This prevents an OpenCode route from receiving a hardcoded bare Claude ID.

Import `z` and define:

```ts
const AnalysisObservationResponseSchema = z.array(
  z.object({
    scope: z.string(),
    scopeValue: z.string().nullable(),
    content: z.string(),
    emailContext: z.string().optional(),
  }),
);
const AnalysisMatchResponseSchema = z.array(
  z.object({
    observationIndex: z.number().int().nonnegative(),
    matchedDraftMemoryId: z.string().nullable(),
  }),
);
const AnalysisScopeResponseSchema = z.object({
  scope: z.string(),
  scopeValue: z.string().nullable(),
});
```

Pass the matching schema as `outputSchema` at the three callsites and keep `parseJsonArray()` / `normalizeScope()` as the final trust-boundary validation.

- [ ] **Step 5: Constrain Exa profile extraction and prohibit cross-fallback**

Add a local response schema:

```ts
const SenderProfileResponseSchema = z.object({
  name: z.string(),
  summary: z.string(),
  title: z.string().optional(),
  company: z.string().optional(),
  linkedinUrl: z.string().optional(),
});
```

Pass it to `lookupViaExa()`'s `createMessage()` options.

When Exa is selected but its key is missing:

```ts
const parsingModel = deps.getParsingModelConfig();
if (parsingModel.provider !== "anthropic") {
  context.logger.error(
    "Sender Lookup requires an Exa API key when its parsing model is not Anthropic",
  );
  return null;
}
```

Retain the existing Anthropic fallback only when the selected parsing provider is Anthropic. Exa request and OpenCode inference failures continue through the existing logged `null` enrichment path; neither invokes another LLM provider.

- [ ] **Step 6: Re-run the focused suites**

```bash
npx playwright test --project=unit tests/unit/email-analyzer.spec.ts tests/unit/calendaring-agent.spec.ts tests/unit/archive-ready.spec.ts tests/unit/sender-lookup.spec.ts
```

Expected: all tests pass and existing malformed-output fallbacks remain covered.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/email-analyzer.ts src/main/services/calendaring-agent.ts src/main/services/archive-ready-analyzer.ts src/main/services/analysis-edit-learner.ts src/extensions/mail-ext-web-search/src/web-search-provider.ts tests/unit/email-analyzer.spec.ts tests/unit/calendaring-agent.spec.ts tests/unit/archive-ready.spec.ts tests/unit/sender-lookup.spec.ts
git commit -m "Constrain OpenCode structured feature output"
```

---

### Task 5: Expose connected OpenCode models through narrow IPC

**Files:**

- Modify: `src/main/ipc/settings.ipc.ts:335-355`
- Modify: `src/preload/index.ts:225-265`
- Modify: `src/shared/types.ts:975-990`
- Modify: `src/main/index.ts:1-45`
- Modify: `src/main/index.ts:640-660`
- Modify: `tests/unit/opencode-config.spec.ts`

**Interfaces:**

- Consumes: `OpenCodeInferenceService.listModels()` and `.close()`.
- Produces: `settings:list-opencode-models` returning `IpcResponse<OpenCodeModelOption[]>`.

- [ ] **Step 1: Add a failing preload/channel contract test**

Read `src/preload/index.ts` and `src/shared/types.ts` as source text and assert they contain:

```ts
listOpenCodeModels: (): Promise<unknown> => ipcRenderer.invoke("settings:list-opencode-models");
```

The shared-types source assertion must require `"settings:list-opencode-models": void` in `IpcChannels`.

- [ ] **Step 2: Run the contract test and verify it fails**

```bash
npx playwright test --project=unit tests/unit/opencode-config.spec.ts
```

- [ ] **Step 3: Register the catalog handler**

In `registerSettingsIpc()`:

```ts
ipcMain.handle(
  "settings:list-opencode-models",
  async (): Promise<IpcResponse<OpenCodeModelOption[]>> => {
    try {
      const config = getConfig();
      if (!config.opencode?.enabled) {
        return { success: false, error: "Enable OpenCode in Settings → Extensions first" };
      }
      return { success: true, data: await openCodeInferenceService.listModels() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Could not load OpenCode models",
      };
    }
  },
);
```

Add the preload method and channel type. Return model/provider IDs and names only.

- [ ] **Step 4: Close the main-process server before app shutdown**

In `settings:set`, compare the prior and validated `opencode.enabled` values. When they differ, call `openCodeInferenceService.close()` so disabling OpenCode releases the subprocess and enabling it starts from a fresh lazy handle on demand.

Import `openCodeInferenceService` in `src/main/index.ts` and call:

```ts
void openCodeInferenceService.close();
```

at the start of `before-quit`, before database/log shutdown.

- [ ] **Step 5: Re-run the contract and service tests**

```bash
npx playwright test --project=unit tests/unit/opencode-config.spec.ts tests/unit/opencode-inference-service.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/settings.ipc.ts src/preload/index.ts src/shared/types.ts src/main/index.ts tests/unit/opencode-config.spec.ts
git commit -m "Expose connected OpenCode models"
```

---

### Task 6: Make agent sessions use OpenCode's global providers and record actual usage

**Files:**

- Modify: `src/main/agents/types.ts:1-205`
- Modify: `src/main/agents/agent-worker.ts:95-165`
- Modify: `src/main/agents/orchestrator.ts:225-250`
- Modify: `src/main/agents/agent-coordinator.ts:55-110`
- Modify: `src/main/agents/agent-coordinator.ts:220-240`
- Modify: `src/main/agents/agent-coordinator.ts:365-425`
- Modify: `src/main/agents/providers/opencode/opencode-agent-provider.ts:130-720`
- Modify: `src/main/ipc/agent.ipc.ts:1-70`
- Modify: `src/main/services/llm-service.ts:300-345`
- Modify: `tests/unit/opencode-resolve-route.spec.ts`
- Modify: `tests/unit/background-agent-provider.spec.ts`
- Create: `tests/unit/opencode-agent-usage.spec.ts`

**Interfaces:**

- Consumes: exact per-feature OpenCode selectors, connected OpenCode catalog, and v1 `message.updated` assistant metadata.
- Produces: global-config agent routing, Agent Drafter/Chat model overrides, and one actual-usage `llm_calls` record per OpenCode run.

- [ ] **Step 1: Write failing global-config, model-override, and usage tests**

Cover:

- `buildOpenCodeAgentConfig(bridgeUrl)` contains the mail MCP bridge and no `provider` or `disabled_providers`;
- `OpenCodeAgentProvider.isAvailable()` needs only `opencode.enabled` and a resolvable binary;
- an exact runtime selector wins over legacy `opencode.model`;
- blank selection omits `body.model` so OpenCode chooses its default;
- unique legacy bare models resolve through the connected catalog;
- Agent Drafter defaults to `opencode.featureModels.agentDrafter`;
- Agent Chat uses `opencode.featureModels.agentChat` only when `providerIds` selects OpenCode;
- a palette override back to Claude receives the normal Anthropic model, not the OpenCode selector;
- repeated snapshots for the same assistant message are counted once using the latest values;
- completed and failed OpenCode runs report actual tokens/cache/cost/route once.

- [ ] **Step 2: Run focused agent tests and verify they fail**

```bash
npx playwright test --project=unit tests/unit/opencode-resolve-route.spec.ts tests/unit/background-agent-provider.spec.ts tests/unit/opencode-agent-usage.spec.ts
```

- [ ] **Step 3: Stop injecting Exo LLM credentials into the agent server**

Extract and export:

```ts
export function buildOpenCodeAgentConfig(bridgeUrl: string): Config {
  return {
    logLevel: "WARN",
    mcp: {
      "mail-app-tools": { type: "remote", url: bridgeUrl, enabled: true },
    },
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  };
}
```

Delete the custom Anthropic/Ollama `provider` registration and `computeDisabledProviders()`. Limit server invalidation to the `opencode` config key. Change `isAvailable()` to enabled + binary only.

- [ ] **Step 4: Resolve each run against OpenCode's connected catalog**

After the server is ready, call `client.provider.list()`, flatten connected models to `OpenCodeModelOption[]`, and resolve:

```ts
const selector = modelOverride?.trim() || this.frameworkConfig.opencode?.model || "";
const route = resolveOpenCodeRoute(selector, connectedModels);
```

Pass `model: route` only when defined. OpenCode's default handles the blank case.

- [ ] **Step 5: Send the correct per-feature model override**

Include `opencode.featureModels` in `AgentFrameworkConfig`.

In `AgentCoordinator.runAgent()`, when no explicit override is supplied and the sole provider is OpenCode, use `getOpenCodeModelSelector("agentDrafter")`.

In `agent.ipc.ts`, select:

```ts
const selectedProvider = providerIds[0];
const modelOverride =
  selectedProvider === "opencode"
    ? getOpenCodeModelSelector("agentChat")
    : (resolveAgentOllamaConfig(getConfig())?.model ?? getModelIdForFeature("agentChat"));
```

This preserves palette overrides: choosing Claude never sends an OpenCode model to the Claude provider.

- [ ] **Step 6: Replace the zero-token OpenCode approximation with completed-run usage**

Extend the existing `AgentSessionStartFn` arguments without renaming the callback across the worker boundary:

```ts
export type AgentSessionStartFn = (args: {
  harness: string;
  provider: LlmProvider;
  model: string;
  accountId?: string;
  emailId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  costDollars?: number;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string;
}) => void;
```

Keep Claude/Hostler's current zero-token start behavior through `recordSessionStart`. For OpenCode, maintain a `Map<messageId, AssistantMessage>` from `message.updated` events, replacing each snapshot. At every terminal return, sum the latest snapshots and invoke `recordSessionStart` once using actual provider/model, tokens, cache, dollars, duration, success, and error.

Change `recordAgentSessionStart()` to accept these optional values and pass `costDollars * 100` as the `recordCall()` override. Use caller `agent-run:<harness>`.

- [ ] **Step 7: Re-run focused agent tests**

```bash
npx playwright test --project=unit tests/unit/opencode-resolve-route.spec.ts tests/unit/background-agent-provider.spec.ts tests/unit/opencode-agent-usage.spec.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/agents/types.ts src/main/agents/agent-worker.ts src/main/agents/orchestrator.ts src/main/agents/agent-coordinator.ts src/main/agents/providers/opencode/opencode-agent-provider.ts src/main/ipc/agent.ipc.ts src/main/services/llm-service.ts tests/unit/opencode-resolve-route.spec.ts tests/unit/background-agent-provider.spec.ts tests/unit/opencode-agent-usage.spec.ts
git commit -m "Use global OpenCode agent models and usage"
```

---

### Task 7: Add OpenCode to every eligible AI Models row

**Files:**

- Create: `src/renderer/components/OpenCodeModelInput.tsx`
- Modify: `src/renderer/components/SettingsPanel.tsx:1-330`
- Modify: `src/renderer/components/SettingsPanel.tsx:430-485`
- Modify: `src/renderer/components/SettingsPanel.tsx:1270-1540`
- Modify: `src/renderer/App.tsx:700-780`
- Modify: `src/renderer/components/AgentCommandPalette.tsx:150-245`
- Modify: `tests/e2e/settings.spec.ts:430-570`
- Modify: `tests/packaged/smoke.spec.ts:210-285`

**Interfaces:**

- Consumes: `settings.listOpenCodeModels()`, `opencode.featureModels`, existing `defaultAgentIds`, and existing staged Save Changes flow.
- Produces: native searchable model fields, refresh/error/unavailable states, Agent Drafter synchronization, and Agent Chat's Cmd+J default.

- [ ] **Step 1: Add a failing deterministic Playwright flow**

Before Settings mounts, replace `settings:list-opencode-models` in the Electron main process with:

```ts
{
  success: true,
  data: [
    {
      providerId: "openai",
      providerName: "OpenAI",
      modelId: "gpt-5.2",
      modelName: "GPT-5.2",
    },
    {
      providerId: "anthropic",
      providerName: "Anthropic",
      modelId: "claude-sonnet-4-5",
      modelName: "Claude Sonnet 4.5",
    },
  ],
}
```

Set OpenCode enabled and Exa selected. Assert:

- all eight visible rows have an enabled OpenCode option;
- Analysis saves `openai/gpt-5.2`;
- Draft Generation saves `anthropic/claude-sonnet-4-5`;
- closing/reopening Settings preserves both;
- a saved removed selector remains in the input with an “unavailable” warning;
- leaving Exa resets Sender Lookup from OpenCode to Anthropic;
- selecting OpenCode for Agent Drafter saves both `backgroundAgentProvider = "opencode"` and `featureProviders.agentDrafter = "opencode"`;
- selecting OpenCode for Agent Chat makes Cmd+J preselect OpenCode;
- clicking Claude in the palette overrides that conversation;
- reopening Cmd+J returns to the configured OpenCode default.

- [ ] **Step 2: Run the Settings flow and verify it fails**

```bash
npx playwright test --project=e2e tests/e2e/settings.spec.ts
```

- [ ] **Step 3: Build the native model input**

`OpenCodeModelInput` uses `<input list>` and `<datalist>`:

```tsx
interface OpenCodeModelInputProps {
  value: string;
  onChange: (value: string) => void;
  models: OpenCodeModelOption[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  ariaLabel: string;
}

export function OpenCodeModelInput({
  value,
  onChange,
  models,
  loading,
  error,
  onRefresh,
  ariaLabel,
}: OpenCodeModelInputProps) {
  const listId = useId();
  const available = models.some((model) => `${model.providerId}/${model.modelId}` === value);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <input
          list={listId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="OpenCode default"
          aria-label={ariaLabel}
        />
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh models"}
        </button>
      </div>
      <datalist id={listId}>
        {models.map((model) => (
          <option
            key={`${model.providerId}/${model.modelId}`}
            value={`${model.providerId}/${model.modelId}`}
          >
            {model.providerName} — {model.modelName}
          </option>
        ))}
      </datalist>
      {error && <p role="alert">{error}</p>}
      {value && !loading && !error && !available && (
        <p className="text-amber-600">Saved model is unavailable in OpenCode.</p>
      )}
    </div>
  );
}
```

Use the existing field/button classes from `SettingsPanel`; do not introduce a component library.

- [ ] **Step 4: Fetch the catalog with TanStack Query and stage per-feature values**

Add:

```ts
const [openCodeModels, setOpenCodeModels] = useState<Record<string, string>>({});
const openCodeCatalog = useQuery({
  queryKey: ["opencode-models"],
  enabled: generalConfig?.opencode?.enabled === true,
  queryFn: async () => {
    const result = (await window.api.settings.listOpenCodeModels()) as IpcResponse<
      OpenCodeModelOption[]
    >;
    if (!result.success) throw new Error(result.error);
    return result.data;
  },
});
```

Hydrate `openCodeModels` once from `generalConfig.opencode?.featureModels`. Save only:

```ts
opencode: { featureModels: openCodeModels },
```

so the main-process deep merge preserves Extensions-owned `enabled` and legacy `model`.

- [ ] **Step 5: Render OpenCode for every eligible row**

Always render:

```tsx
<option value="opencode" disabled={!generalConfig?.opencode?.enabled}>
  OpenCode
</option>
```

except Sender Lookup when its backend is not Exa. If a disabled saved OpenCode value exists, retain the disabled option and show the Extensions enablement link.

Render:

- Anthropic tier select for `provider === "anthropic"`;
- `OllamaModelSelect` for `provider === "ollama-cloud"`;
- `OpenCodeModelInput` for `provider === "opencode"`;
- the existing Extensions model link only for Hostler.

When Sender Lookup leaves Exa, reset both Ollama and OpenCode selections to Anthropic.

- [ ] **Step 6: Make the existing Agent Chat default store effective**

Select `setDefaultAgentIds` from the existing app store. When `App.tsx` loads settings, call:

```ts
setDefaultAgentIds([
  result.data.featureProviders?.agentChat === "opencode" && result.data.opencode?.enabled
    ? "opencode"
    : "claude",
]);
```

After Settings saves successfully, update the same store field from the staged selection.

In `AgentCommandPalette`, consume `defaultAgentIds` and on every open set:

```ts
setSelectedAgentIds(defaultAgentIds.length ? defaultAgentIds : ["claude"]);
```

The user may click a different provider before submitting; reopening the palette restores the configured default.

- [ ] **Step 7: Extend packaged smoke coverage**

In the isolated packaged profile, enable OpenCode, save one OpenCode feature selector, restart, open Settings, and assert the Analysis and Agent Chat provider controls show OpenCode. Keep the existing bundled-binary and Cmd+J provider checks.

- [ ] **Step 8: Re-run E2E and packaged-source tests**

```bash
npx playwright test --project=e2e tests/e2e/settings.spec.ts
npx playwright test --project=unit tests/unit/opencode-config.spec.ts
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/components/OpenCodeModelInput.tsx src/renderer/components/SettingsPanel.tsx src/renderer/App.tsx src/renderer/components/AgentCommandPalette.tsx tests/e2e/settings.spec.ts tests/packaged/smoke.spec.ts
git commit -m "Add per-feature OpenCode model controls"
```

---

### Task 8: Verify the complete adapter and prove the packaged runtime

**Files:**

- Review every changed source and test file.
- Update: `docs/superpowers/specs/2026-07-29-opencode-feature-provider-adapter-design.md` only if implementation reveals a factual mismatch.

**Interfaces:**

- Consumes: the complete implementation from Tasks 1-7.
- Produces: green local gates, a packaged artifact, installed-runtime evidence, and a review-ready branch.

- [ ] **Step 1: Run formatting and static gates**

```bash
npm run format:check
npm run typecheck
npm run lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 2: Run focused OpenCode coverage**

```bash
npx playwright test --project=unit tests/unit/opencode-config.spec.ts tests/unit/opencode-inference-service.spec.ts tests/unit/llm-service.spec.ts tests/unit/opencode-resolve-route.spec.ts tests/unit/opencode-agent-usage.spec.ts tests/unit/background-agent-provider.spec.ts tests/unit/email-analyzer.spec.ts tests/unit/calendaring-agent.spec.ts tests/unit/archive-ready.spec.ts tests/unit/sender-lookup.spec.ts
npx playwright test --project=e2e tests/e2e/settings.spec.ts
```

Expected: all tests pass with no retries or teardown failures.

- [ ] **Step 3: Run the full baseline suite**

```bash
npm test
```

Expected: all unit, integration, and E2E tests pass. Treat any failure as a failure, not flakiness.

- [ ] **Step 4: Build and package with Node 22**

```bash
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack
EXO_PACKAGED_BINARY=release/mac-arm64/Exo.app/Contents/MacOS/Exo npx playwright test --project=packaged
```

Expected: build, package, and packaged smoke all pass.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add -u
git diff --cached --check
git commit -m "Finish OpenCode provider verification"
```

Skip this commit when verification required no source change.

- [ ] **Step 6: Request authorization for external publication and installation**

Before pushing, opening/updating a PR, or replacing `/Applications/Exo.app`, ask the user for explicit authorization. Do not combine that request with unrelated decisions.

- [ ] **Step 7: After authorization, push and open/update the draft PR**

Push `codex/opencode-feature-adapter-design` to `upstream-pr`, open its draft PR against `ankitvgupta/exo:main`, and start the required full pre-PR gate immediately:

```bash
git push -u upstream-pr codex/opencode-feature-adapter-design
/opt/homebrew/bin/gh pr create --repo ankitvgupta/exo --base main --head mickn:codex/opencode-feature-adapter-design --draft --fill
npm run pre-pr
/opt/homebrew/bin/gh pr checks codex/opencode-feature-adapter-design --repo ankitvgupta/exo
```

After `pre-pr` is running, add the design, architecture, test evidence, and UI screenshots to the PR body. If a draft PR for this branch already exists, replace `pr create` with `/opt/homebrew/bin/gh pr view codex/opencode-feature-adapter-design --repo ankitvgupta/exo`; do not create a duplicate. If `Verify pre-pr report` raced the report update, verify the marker and rerun only the failed workflow job. Then run the required `/review` and `/reviewloop` workflow until major findings are fixed and CI is green.

- [ ] **Step 8: After installation authorization, replace the app safely**

Quit only the running Exo process by its verified PID. Preserve a rollback copy of `/Applications/Exo.app`, replace only the app bundle with `release/mac-arm64/Exo.app`, and leave `~/Library/Application Support/exo` untouched.

Compare SHA-256 values for packaged and installed `Contents/Resources/app.asar`, launch `/Applications/Exo.app`, and verify the live PID's executable path points to that bundle.

- [ ] **Step 9: Prove the installed behavior**

In the installed app:

1. Confirm all eight eligible AI Models rows expose OpenCode and connected models.
2. Run Email Analysis through one OpenCode model and Draft Generation through another.
3. Run Agent Drafter through its selected OpenCode model.
4. Open Cmd+J and confirm Agent Chat defaults to OpenCode; override it once in the palette.
5. Query `llm_calls` read-only and verify provider, exact model, tokens, cost when supplied, duration, and success/error.
6. Select an unavailable model or temporarily use a missing credential and confirm the error is visible, no Anthropic/Ollama call occurs, and the saved selector remains unchanged.

Capture screenshots of loaded, disabled/unavailable, and error states for the PR.
