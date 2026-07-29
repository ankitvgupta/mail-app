# OpenCode as a Per-Feature AI Provider

**Status:** Approved design, awaiting implementation-plan approval
**Date:** 2026-07-29

## The outcome

When OpenCode is enabled, every user-visible row in **Settings → AI Models** can select OpenCode and an exact model from the providers already configured in OpenCode. Exo uses that provider/model for the selected feature, records the real route and usage, and surfaces configuration or inference failures instead of silently switching to Anthropic or Ollama Cloud.

This extends the provider path already used by Exo. It does not create a second feature framework or make Exo manage OpenCode credentials.

## Product decisions

- OpenCode owns its provider connections, authentication, and model catalog.
- Exo stores an exact OpenCode selector per feature in `provider/model` form.
- OpenCode is available for Analysis, Draft Generation, Draft Refinement, Scheduling Detection, Archive-Ready Analysis, Sender Lookup when Exa performs the search, Agent Drafter, and Agent Chat.
- Each feature can use a different OpenCode model.
- Agent Chat uses the OpenCode selection from its AI Models row as the default Cmd+J runtime. An explicit runtime choice in the command palette still overrides that default for that conversation.
- Agent Drafter uses the OpenCode selection from its AI Models row and keeps `backgroundAgentProvider` synchronized with that selection.
- Failures are visible. Exo does not cross-fallback from OpenCode to Anthropic or Ollama Cloud.
- Existing feature-specific safe parsing behavior remains. For example, a feature that already treats malformed structured output conservatively continues to do so after a successful OpenCode response.

## Configuration

Extend the existing provider and OpenCode configuration instead of introducing a parallel settings object:

```ts
export const LLM_PROVIDERS = [
  "anthropic",
  "ollama-cloud",
  "opencode",
] as const;

opencode: {
  enabled: boolean;
  model?: string; // legacy global override
  featureModels?: Record<string, string>; // exact provider/model selectors
}
```

`featureProviders[feature]` remains the source of truth for which provider a feature uses. When it is `opencode`, model resolution is:

1. `opencode.featureModels[feature]`
2. legacy `opencode.model`
3. OpenCode's configured default model

The legacy `opencode.model` field remains readable and editable during the transition; no destructive migration is needed. Saving an exact per-feature selection writes `featureModels` and leaves the legacy value intact for features without their own selection.

The third case stays unset in Exo: the inference request omits its explicit model and lets OpenCode choose its configured default. Exo then records the actual provider and model returned by OpenCode. This avoids a synchronous catalog lookup in `getFeatureModelConfig()`.

If a saved selector is no longer present in OpenCode's catalog, Exo preserves it and displays it as unavailable. It does not replace it with a different model.

Internal `styleInference` can use the same resolver if configured programmatically, but this project does not add a new visible row for it.

## Runtime architecture

### Shared feature calls

`getFeatureModelConfig()` returns the selected provider and exact model selector when one is configured; an empty OpenCode selector means “use OpenCode's default.” `createMessage()` keeps its current Anthropic-compatible input and output boundary and gains an OpenCode branch:

```text
feature caller
  → getFeatureModelConfig(feature)
  → createMessage(params, { provider: "opencode", ... })
  → lazy OpenCodeInferenceService
  → OpenCode local server
  → configured OpenCode provider/model
  → Anthropic-compatible Message
  → existing feature parser
```

`OpenCodeInferenceService` is a small main-process service that reuses the binary discovery, lazy server startup, SDK loading, and shutdown patterns already proven by `OpenCodeAgentProvider`. It uses the installed OpenCode SDK's v2 client because that client exposes structured-output formats and returned usage/cost metadata. It starts only on the first OpenCode feature call or model-catalog request and reuses the server while Exo is running.

Each one-shot feature call:

1. Creates an isolated OpenCode session.
2. Sends the existing system and user content to the exact provider/model.
3. Enumerates the server's tool IDs, passes each one as disabled on the prompt, and denies OpenCode permissions for bash, edit, fetch, and other side effects.
4. Converts the final text, usage, finish state, and model metadata to Exo's existing `Message` shape.
5. Deletes the session in `finally`, whether the call succeeds, fails, aborts, or times out.

Session deletion is lifecycle cleanup, not a promise of secure erasure from OpenCode's local database or an upstream provider's logs.

The service accepts an injected client in tests, matching the existing `llm-service` test seam. No new dependency or generic provider abstraction is needed.

### Agent Drafter and Agent Chat

Agent Drafter and Agent Chat continue through the existing agent worker and `OpenCodeAgentProvider`; they do not use the tool-disabled one-shot service.

The agent provider changes its server configuration so it honors OpenCode's global providers and credentials instead of registering only Exo's Anthropic or Ollama Cloud settings. It stops injecting Exo's provider credentials and `disabled_providers`, while retaining the mail MCP bridge and Exo permission gate. A run receives the exact per-feature selector as `modelOverride`.

Two lazy OpenCode server processes are acceptable:

- the main process owns stateless, tool-disabled feature calls and catalog discovery;
- the agent worker owns conversational, tool-enabled agent sessions.

Keeping these lifecycles separate avoids new cross-process request routing and preserves the current worker fault boundary.

## Model discovery and settings UI

Add a narrow settings IPC method that asks the main-process OpenCode service for `provider.list()`, filters the result to OpenCode's `connected` provider IDs, and returns their models. The response contains only:

```ts
type OpenCodeModelOption = {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
};
```

Exo does not read, copy, expose, or persist OpenCode's `auth.json`. The OpenCode subprocess resolves its own global configuration and credentials. Catalog results are kept in renderer state only and refreshed on demand.

Every visible AI Models row receives an OpenCode option when OpenCode is enabled. Selecting it shows a searchable native input backed by `<datalist>` options, avoiding another UI dependency. The field stores the exact `provider/model` value, permits an exact manual selector, and provides:

- provider-prefixed model labels sorted by provider;
- a **Refresh models** action;
- a loading state;
- a clear startup or catalog error;
- an unavailable marker for a saved model that disappeared.

If OpenCode is disabled, an existing saved selection remains visible but unavailable, with a link to enable OpenCode in Extensions.

Sender Lookup only offers OpenCode when `senderLookupProvider === "exa"`, because Exa supplies the search results and the selected LLM only extracts them. With Anthropic's bundled web-search backend selected, the UI explains that sender lookup must remain on Anthropic.

## Structured output

Structured callers may add their existing Zod schema to `CreateOptions`. The OpenCode branch converts it with the installed Zod 4 `z.toJSONSchema()` support and sends `format: { type: "json_schema", schema }` through the installed OpenCode v2 client. Text-only callers do not provide a schema.

The returned structured value is serialized into the existing message text boundary, then processed by the current Zod validation and conservative feature fallback. This keeps parsing behavior centralized in current feature code while giving OpenCode a constrained generation target.

Schema translation or validation failure is recorded and surfaced with the feature name and selected model. Exo does not retry the request on another provider.

## Retry, timeout, and failure behavior

- OpenCode owns retries within the selected provider. Exo does not wrap it in the Anthropic/Ollama retry loop.
- Exo applies the existing per-call timeout and abort signal to the OpenCode request.
- Startup, catalog, missing-auth, missing-model, model-rejection, timeout, malformed-response, and session-cleanup failures are logged with actionable context.
- The original inference error remains primary if session cleanup also fails; cleanup failure is logged separately.
- No error path changes `featureProviders`, `featureModels`, or the saved model.
- No OpenCode failure silently invokes Anthropic or Ollama Cloud.

The UI uses the current feature failure surface where one exists. Background work logs and exposes the same failure through its existing status/error channel.

## Usage and observability

OpenCode feature calls write normal `llm_calls` rows with:

- `provider = "opencode"`;
- the exact `provider/model` selector;
- actual input and output tokens returned by OpenCode;
- actual cost when OpenCode returns it;
- caller, account, email, duration, success, and error details.

`recordCall()` accepts an optional provider-reported cost override, converted from OpenCode's dollar value to the table's `cost_cents`, instead of applying Anthropic's fallback price table to an arbitrary OpenCode model.

For Agent Drafter and Agent Chat, the provider aggregates the completed OpenCode assistant messages for that run and sends exact route, token, cache, and cost totals back through the existing worker-to-main recording channel. Failed runs record the route and any usage accumulated before failure. This replaces the current zero-token session-start approximation and stops collapsing non-Ollama OpenCode routes to Anthropic.

If OpenCode does not provide a usage or cost field, Exo records the available values without inventing an estimate.

Logs must not include credentials, full OpenCode configuration, or email/prompt content beyond the app's existing logging policy.

## Lifecycle and concurrency

- Server startup is lazy, idempotent, and guarded against configuration changes during startup.
- Changing OpenCode enablement or model routing invalidates the relevant lazy server configuration.
- One-shot sessions are independent and may run concurrently.
- App shutdown closes both the main-process service and the existing worker provider.
- A catalog refresh reuses the main-process server; it does not spawn a server per row.

## Expected code areas

The implementation should stay within existing paths where possible:

- `src/shared/types.ts` for provider/config schema changes;
- `src/main/ipc/settings.ipc.ts` for routing and model-catalog IPC;
- `src/main/services/llm-service.ts` for the OpenCode `createMessage()` branch and recording;
- one main-process OpenCode inference service beside the existing OpenCode provider;
- `src/main/agents/providers/opencode/opencode-agent-provider.ts` for global-provider routing and exact model overrides;
- `src/main/agents/agent-coordinator.ts` and agent types for per-feature model propagation;
- `src/renderer/components/SettingsPanel.tsx` for provider/model controls;
- preload/API typing only as required for the catalog method.

Do not add a new provider framework, credential store, model database, catalog dependency, or auth UI.

## Verification

### Automated checks

- Model resolution tests cover per-feature selector, legacy fallback, OpenCode default, disabled OpenCode, and missing saved models.
- `createMessage()` tests cover text conversion, structured output, exact route, usage/cost recording, abort, timeout, visible startup/auth/model errors, and session cleanup on every exit.
- Agent-provider tests cover global OpenCode configuration, Agent Drafter and Agent Chat overrides, and exact completed-run recording.
- Settings tests cover OpenCode on every visible row, catalog refresh, saved unavailable model, disabled state, Agent Drafter synchronization, Agent Chat defaulting, and Sender Lookup's Exa gate.
- One Playwright settings flow selects different OpenCode models for two features, saves, closes, reopens, and verifies both values.
- Existing typecheck, lint, focused tests, packaged-provider smoke, and full pre-PR suite remain green.

### Installed-app proof

Build and run the packaged macOS app containing this branch. In that installed runtime:

1. Confirm OpenCode and its configured models appear on every eligible AI Models row.
2. Run one structured feature and one text feature through different OpenCode models.
3. Run Agent Drafter through its selected OpenCode model.
4. Start Agent Chat with Cmd+J and confirm its selected OpenCode model is the default.
5. Inspect `llm_calls` and logs to verify exact provider/model, tokens, cost when supplied, success/failure, and no fallback.
6. Exercise an unavailable model or missing credential and confirm the failure is visible and the saved selection is unchanged.

## Out of scope

- Managing OpenCode authentication inside Exo.
- Copying Exo's Anthropic or Ollama credentials into OpenCode.
- Persisting or pricing the OpenCode catalog.
- Guessing capability tiers or mapping arbitrary models to Haiku/Sonnet/Opus.
- Automatic provider or model fallback.
- Tool-enabled one-shot feature calls.
- Making Sender Lookup use OpenCode while Anthropic's bundled search backend is selected.
- Consolidating the main and worker OpenCode servers into a new IPC service.
