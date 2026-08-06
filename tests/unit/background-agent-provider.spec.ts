/**
 * Unit tests for resolveBackgroundAgentProviderId — which agent provider runs
 * the automatic new-email drafter and the "Regenerate draft" rerun path.
 *
 * Pure config-resolution tests — no DB, mocks, or native modules needed.
 */
import { test, expect } from "@playwright/test";
import {
  ConfigSchema,
  DEFAULT_BACKGROUND_AGENT_PROVIDER,
  resolveBackgroundAgentProviderId,
  applyAgentDrafterSelection,
  isAgentRuntimeAvailable,
} from "../../src/shared/types";
import { deriveTraceProviderIds } from "../../src/shared/agent-types";
import type { ScopedAgentEvent } from "../../src/shared/agent-types";

test.describe("ConfigSchema backgroundAgentProvider", () => {
  test("parses config with backgroundAgentProvider set", () => {
    const result = ConfigSchema.parse({ backgroundAgentProvider: "hostler" });
    expect(result.backgroundAgentProvider).toBe("hostler");
  });

  test("parses config without backgroundAgentProvider (undefined, resolver defaults to claude)", () => {
    const result = ConfigSchema.parse({});
    expect(result.backgroundAgentProvider).toBeUndefined();
  });
});

test.describe("resolveBackgroundAgentProviderId", () => {
  test("defaults to claude when unset", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: undefined,
      opencode: undefined,
      hostler: undefined,
    });
    expect(result).toBe(DEFAULT_BACKGROUND_AGENT_PROVIDER);
  });

  test("returns claude when explicitly selected", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "claude",
      opencode: { enabled: true },
      hostler: { enabled: true, apiKey: "cpk_123", harness: "opencode" },
    });
    expect(result).toBe("claude");
  });

  test("returns opencode when selected and enabled", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "opencode",
      opencode: { enabled: true },
      hostler: undefined,
    });
    expect(result).toBe("opencode");
  });

  test("falls back to claude when opencode selected but disabled", () => {
    // Disabling a provider must not strand background drafts on a dead
    // provider — they'd fail on every new email until the user also fixed
    // this setting.
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "opencode",
      opencode: { enabled: false },
      hostler: undefined,
    });
    expect(result).toBe("claude");
  });

  test("falls back to claude when opencode selected but config missing", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "opencode",
      opencode: undefined,
      hostler: undefined,
    });
    expect(result).toBe("claude");
  });

  test("returns hostler when selected, enabled, and keyed", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "hostler",
      opencode: undefined,
      hostler: { enabled: true, apiKey: "cpk_123", harness: "opencode" },
    });
    expect(result).toBe("hostler");
  });

  test("falls back to claude when hostler selected but disabled", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "hostler",
      opencode: undefined,
      hostler: { enabled: false, apiKey: "cpk_123", harness: "opencode" },
    });
    expect(result).toBe("claude");
  });

  test("falls back to claude when hostler selected but apiKey empty", () => {
    // Mirrors HostlerAgentProvider.isAvailable(): enabled && apiKey. An
    // enabled-but-keyless hostler would fail every run with an auth error.
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "hostler",
      opencode: undefined,
      hostler: { enabled: true, apiKey: "", harness: "opencode" },
    });
    expect(result).toBe("claude");
  });

  test("treats empty string as unset (hand-edited config)", () => {
    // "" would otherwise reach the orchestrator and throw "Unknown provider: ".
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "",
      opencode: undefined,
      hostler: undefined,
    });
    expect(result).toBe("claude");
  });

  test("falls back to claude when openclaw-agent selected but not configured", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "openclaw-agent",
      opencode: undefined,
      hostler: undefined,
      openclaw: { enabled: false, gatewayUrl: "", gatewayToken: "" },
    });
    expect(result).toBe("claude");
  });

  test("returns openclaw-agent when enabled with a gateway URL", () => {
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "openclaw-agent",
      opencode: undefined,
      hostler: undefined,
      openclaw: { enabled: true, gatewayUrl: "https://gw.example.com", gatewayToken: "t" },
    });
    expect(result).toBe("openclaw-agent");
  });

  test("passes through unknown provider ids unchanged", () => {
    // Installed/private providers have config gates we can't see here — the
    // orchestrator fails explicitly for ids that aren't registered.
    const result = resolveBackgroundAgentProviderId({
      backgroundAgentProvider: "my-installed-provider",
      opencode: undefined,
      hostler: undefined,
    });
    expect(result).toBe("my-installed-provider");
  });
});

test.describe("deriveTraceProviderIds", () => {
  const event = (overrides: Partial<ScopedAgentEvent>): ScopedAgentEvent =>
    ({ type: "text_delta", text: "x", ...overrides }) as ScopedAgentEvent;

  test("collects the single provider id from a stamped trace", () => {
    const events = [
      event({ providerId: "hostler" }),
      event({ providerId: "hostler" }),
      event({ providerId: "hostler" }),
    ];
    expect(deriveTraceProviderIds(events)).toEqual(["hostler"]);
  });

  test("falls back to claude for legacy traces with no stamped events", () => {
    const events = [event({}), event({})];
    expect(deriveTraceProviderIds(events)).toEqual(["claude"]);
  });

  test("ignores unstamped events when at least one event is stamped", () => {
    // Orchestrator-emitted confirmation_required events carry no providerId;
    // replayAgentTrace buckets them under providerIds[0].
    const events = [
      event({ providerId: "opencode" }),
      event({}),
      event({ providerId: "opencode" }),
    ];
    expect(deriveTraceProviderIds(events)).toEqual(["opencode"]);
  });

  test("preserves first-seen order for multi-provider traces", () => {
    const events = [
      event({ providerId: "claude" }),
      event({ providerId: "hostler" }),
      event({ providerId: "claude" }),
    ];
    expect(deriveTraceProviderIds(events)).toEqual(["claude", "hostler"]);
  });

  test("returns claude for an empty trace", () => {
    expect(deriveTraceProviderIds([])).toEqual(["claude"]);
  });
});

test.describe("applyAgentDrafterSelection", () => {
  test("selecting an external runtime routes background drafts there and leaves the Claude-runtime model untouched", () => {
    expect(applyAgentDrafterSelection("opencode")).toEqual({
      backgroundAgentProvider: "opencode",
    });
    expect(applyAgentDrafterSelection("hostler")).toEqual({
      backgroundAgentProvider: "hostler",
    });
  });

  test("selecting an LLM provider returns the runtime to the built-in Claude agent", () => {
    expect(applyAgentDrafterSelection("anthropic")).toEqual({
      backgroundAgentProvider: DEFAULT_BACKGROUND_AGENT_PROVIDER,
      agentDrafterProvider: "anthropic",
    });
    expect(applyAgentDrafterSelection("ollama-cloud")).toEqual({
      backgroundAgentProvider: DEFAULT_BACKGROUND_AGENT_PROVIDER,
      agentDrafterProvider: "ollama-cloud",
    });
  });

  test("unknown option values are an explicit no-op, not a misroute", () => {
    expect(applyAgentDrafterSelection("openclaw-agent")).toBeNull();
    expect(applyAgentDrafterSelection("")).toBeNull();
  });
});

test.describe("isAgentRuntimeAvailable", () => {
  test("mirrors the resolver gates for opencode", () => {
    expect(isAgentRuntimeAvailable("opencode", { opencode: { enabled: true } })).toBe(true);
    expect(isAgentRuntimeAvailable("opencode", { opencode: { enabled: false } })).toBe(false);
    expect(isAgentRuntimeAvailable("opencode", {})).toBe(false);
  });

  test("mirrors the resolver gates for hostler (needs enabled AND apiKey)", () => {
    expect(
      isAgentRuntimeAvailable("hostler", { hostler: { enabled: true, apiKey: "cpk_x" } }),
    ).toBe(true);
    expect(isAgentRuntimeAvailable("hostler", { hostler: { enabled: true } })).toBe(false);
    expect(
      isAgentRuntimeAvailable("hostler", { hostler: { enabled: false, apiKey: "cpk_x" } }),
    ).toBe(false);
  });

  test("the built-in Claude runtime is always available", () => {
    expect(isAgentRuntimeAvailable(DEFAULT_BACKGROUND_AGENT_PROVIDER, {})).toBe(true);
  });
});
