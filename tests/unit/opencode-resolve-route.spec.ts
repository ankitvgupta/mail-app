/**
 * Unit tests for OpenCodeAgentProvider's route resolution.
 *
 * Greptile flagged a priority inversion in an earlier version of resolveRoute()
 * where a bare-name runtimeOverride lost to a parsed settings override because
 * the implementation collapsed both inputs into a single ?? chain on the parsed
 * form first. These tests lock in the intended priority:
 *
 *   runtime override > settings.opencode.model > framework default
 *
 * Each tier accepts either `provider/model` (parsed) or bare `model` (paired
 * with the active provider), and the priority is preserved regardless of which
 * form each tier supplies.
 */
import { test, expect } from "@playwright/test";
import { resolveRoute } from "../../src/main/agents/providers/opencode/opencode-agent-provider";
import type { AgentFrameworkConfig } from "../../src/main/agents/types";

const baseOllama: AgentFrameworkConfig = {
  model: "claude-sonnet-4-6",
  ollamaCloud: { enabled: true, apiKey: "ollama-key", model: "kimi-k2.6:cloud" },
  opencode: { enabled: true },
};

const baseAnthropic: AgentFrameworkConfig = {
  model: "claude-sonnet-4-6",
  anthropicApiKey: "sk-anthropic",
  opencode: { enabled: true },
};

test.describe("resolveRoute - priority order", () => {
  test("runtime parsed override wins over settings parsed", () => {
    const cfg: AgentFrameworkConfig = {
      ...baseOllama,
      opencode: { enabled: true, model: "ollama-cloud/settings-model" },
    };
    expect(resolveRoute(cfg, "ollama-cloud/runtime-model")).toEqual({
      providerID: "ollama-cloud",
      modelID: "runtime-model",
    });
  });

  test("runtime bare override wins over settings parsed (the inversion bug)", () => {
    // This is the exact regression Greptile caught: bare runtime input,
    // parsed settings input — runtime must still win.
    const cfg: AgentFrameworkConfig = {
      ...baseOllama,
      opencode: { enabled: true, model: "ollama-cloud/settings-model" },
    };
    expect(resolveRoute(cfg, "qwen3:32b")).toEqual({
      providerID: "ollama-cloud",
      modelID: "qwen3:32b",
    });
  });

  test("settings parsed override wins over framework default", () => {
    const cfg: AgentFrameworkConfig = {
      ...baseOllama,
      opencode: { enabled: true, model: "ollama-cloud/settings-only" },
    };
    expect(resolveRoute(cfg, undefined)).toEqual({
      providerID: "ollama-cloud",
      modelID: "settings-only",
    });
  });

  test("settings bare override wins over framework default", () => {
    const cfg: AgentFrameworkConfig = {
      ...baseOllama,
      opencode: { enabled: true, model: "bare-from-settings" },
    };
    expect(resolveRoute(cfg, undefined)).toEqual({
      providerID: "ollama-cloud",
      modelID: "bare-from-settings",
    });
  });

  test("falls through to Ollama default when neither override is set", () => {
    expect(resolveRoute(baseOllama, undefined)).toEqual({
      providerID: "ollama-cloud",
      modelID: "kimi-k2.6:cloud",
    });
  });

  test("falls through to Anthropic default when Ollama is not configured", () => {
    expect(resolveRoute(baseAnthropic, undefined)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    });
  });

  test("returns undefined when no provider is configured", () => {
    const cfg: AgentFrameworkConfig = {
      model: "claude-sonnet-4-6",
      opencode: { enabled: true },
    };
    expect(resolveRoute(cfg, undefined)).toBeUndefined();
  });
});

test.describe("resolveRoute - input shape parsing", () => {
  test("ignores empty/whitespace runtime overrides", () => {
    // Whitespace-only override should fall through to settings or defaults
    // instead of being treated as a real override.
    const cfg: AgentFrameworkConfig = {
      ...baseOllama,
      opencode: { enabled: true, model: "ollama-cloud/from-settings" },
    };
    expect(resolveRoute(cfg, "   ")).toEqual({
      providerID: "ollama-cloud",
      modelID: "from-settings",
    });
  });

  test("parsed runtime override uses its providerID even if it differs from active", () => {
    // A user pinning "anthropic/claude-haiku-4-5" while Ollama is the active
    // framework provider should get the anthropic route — the override is
    // explicit, so we trust it.
    expect(resolveRoute(baseOllama, "anthropic/claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
  });

  test("bare-name override with no active provider returns undefined for that override", () => {
    // If neither Ollama nor Anthropic is configured, a bare-name override
    // can't be paired with anything. Falls through to undefined.
    const cfg: AgentFrameworkConfig = {
      model: "claude-sonnet-4-6",
      opencode: { enabled: true },
    };
    expect(resolveRoute(cfg, "qwen3:32b")).toBeUndefined();
  });
});
