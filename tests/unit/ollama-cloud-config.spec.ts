/**
 * Unit tests for Ollama Cloud configuration types and Zod schemas.
 *
 * These are pure schema validation tests — no DB, mocks, or native modules needed.
 */
import { test, expect } from "@playwright/test";
import {
  ConfigSchema,
  LlmProviderSchema,
  OllamaCloudConfigSchema,
  resolveAgentOllamaConfig,
  DEFAULT_OLLAMA_MODEL,
} from "../../src/shared/types";

test.describe("Ollama Cloud config schemas", () => {
  test("ConfigSchema parses config with ollamaCloud field", () => {
    const raw = {
      ollamaCloud: {
        apiKey: "test-key-123",
        defaultModel: "minimax-m2.7:cloud",
      },
    };

    const result = ConfigSchema.parse(raw);

    expect(result.ollamaCloud).toBeDefined();
    expect(result.ollamaCloud!.apiKey).toBe("test-key-123");
    expect(result.ollamaCloud!.defaultModel).toBe("minimax-m2.7:cloud");
  });

  test("ConfigSchema parses config without ollamaCloud field", () => {
    const raw = {
      maxEmails: 100,
    };

    const result = ConfigSchema.parse(raw);

    expect(result.ollamaCloud).toBeUndefined();
    // Other defaults should still apply
    expect(result.maxEmails).toBe(100);
  });

  test("ConfigSchema parses featureProviders with ollama-cloud values", () => {
    const raw = {
      featureProviders: {
        analysis: "ollama-cloud",
        drafts: "anthropic",
        refinement: "ollama-cloud",
      },
    };

    const result = ConfigSchema.parse(raw);

    expect(result.featureProviders).toBeDefined();
    expect(result.featureProviders!["analysis"]).toBe("ollama-cloud");
    expect(result.featureProviders!["drafts"]).toBe("anthropic");
    expect(result.featureProviders!["refinement"]).toBe("ollama-cloud");
  });

  test("LlmProviderSchema validates 'anthropic'", () => {
    const result = LlmProviderSchema.parse("anthropic");
    expect(result).toBe("anthropic");
  });

  test("LlmProviderSchema validates 'ollama-cloud'", () => {
    const result = LlmProviderSchema.parse("ollama-cloud");
    expect(result).toBe("ollama-cloud");
  });

  test("LlmProviderSchema rejects invalid provider names", () => {
    expect(() => LlmProviderSchema.parse("openai")).toThrow();
    expect(() => LlmProviderSchema.parse("")).toThrow();
    expect(() => LlmProviderSchema.parse("ollama")).toThrow();
  });

  test("OllamaCloudConfigSchema applies defaults for missing fields", () => {
    const result = OllamaCloudConfigSchema.parse({});

    expect(result.apiKey).toBe("");
    expect(result.defaultModel).toBe(DEFAULT_OLLAMA_MODEL);
    expect(result.featureModels).toBeUndefined();
  });

  test("OllamaCloudConfigSchema parses full config with featureModels", () => {
    const raw = {
      apiKey: "key-abc",
      defaultModel: "llama3.1:cloud",
      featureModels: {
        analysis: "minimax-m2.7:cloud",
        drafts: "llama3.1:cloud",
      },
    };

    const result = OllamaCloudConfigSchema.parse(raw);

    expect(result.apiKey).toBe("key-abc");
    expect(result.defaultModel).toBe("llama3.1:cloud");
    expect(result.featureModels).toEqual({
      analysis: "minimax-m2.7:cloud",
      drafts: "llama3.1:cloud",
    });
  });

  test("ConfigSchema rejects invalid featureProviders values", () => {
    const raw = {
      featureProviders: {
        analysis: "not-a-valid-provider",
      },
    };

    expect(() => ConfigSchema.parse(raw)).toThrow();
  });
});

test.describe("resolveAgentOllamaConfig", () => {
  test("returns undefined when no Ollama API key configured", () => {
    const result = resolveAgentOllamaConfig({
      ollamaCloud: undefined,
      featureProviders: { agentChat: "ollama-cloud" },
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when ollamaCloud has empty apiKey (silent misconfiguration guard)", () => {
    // Deep-merge in settings:set can produce { apiKey: "" } if the user clears the
    // key while featureProviders still says ollama-cloud. We must NOT route to Ollama
    // with an empty token, since that would fail with a confusing auth error rather
    // than gracefully falling back to the default.
    const result = resolveAgentOllamaConfig({
      ollamaCloud: { apiKey: "", defaultModel: DEFAULT_OLLAMA_MODEL },
      featureProviders: { agentChat: "ollama-cloud" },
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when agentChat feature is set to anthropic", () => {
    // User has a valid Ollama key, but routes the agent to Anthropic — possibly
    // because they want only some features (analysis, drafts) on Ollama.
    const result = resolveAgentOllamaConfig({
      ollamaCloud: { apiKey: "secret-123", defaultModel: DEFAULT_OLLAMA_MODEL },
      featureProviders: { agentChat: "anthropic", analysis: "ollama-cloud" },
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when featureProviders is missing entirely (defaults to anthropic)", () => {
    // User entered an Ollama key in Extensions tab but never picked per-feature
    // routing in the General tab. Must not silently use Ollama.
    const result = resolveAgentOllamaConfig({
      ollamaCloud: { apiKey: "secret-123", defaultModel: DEFAULT_OLLAMA_MODEL },
      featureProviders: undefined,
    });
    expect(result).toBeUndefined();
  });

  test("enables Ollama when key is set AND BOTH agent features are routed there", () => {
    const result = resolveAgentOllamaConfig({
      ollamaCloud: { apiKey: "secret-123", defaultModel: DEFAULT_OLLAMA_MODEL },
      featureProviders: { agentChat: "ollama-cloud", agentDrafter: "ollama-cloud" },
    });
    expect(result).toEqual({
      enabled: true,
      apiKey: "secret-123",
      model: DEFAULT_OLLAMA_MODEL,
    });
  });

  test("returns undefined when only agentChat is ollama-cloud (agentDrafter still anthropic)", () => {
    // Worker is shared between chat and drafter — sending mismatched configs to one
    // subprocess pointed at one URL produces 404s, so this case must not enable Ollama.
    const result = resolveAgentOllamaConfig({
      ollamaCloud: { apiKey: "secret-123", defaultModel: DEFAULT_OLLAMA_MODEL },
      featureProviders: { agentChat: "ollama-cloud" },
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when only agentDrafter is ollama-cloud (agentChat still anthropic)", () => {
    const result = resolveAgentOllamaConfig({
      ollamaCloud: { apiKey: "secret-123", defaultModel: DEFAULT_OLLAMA_MODEL },
      featureProviders: { agentDrafter: "ollama-cloud" },
    });
    expect(result).toBeUndefined();
  });

  test("uses per-feature agentDrafter model override when set", () => {
    const result = resolveAgentOllamaConfig({
      ollamaCloud: {
        apiKey: "secret-123",
        defaultModel: DEFAULT_OLLAMA_MODEL,
        featureModels: { agentDrafter: "qwen3:8b" },
      },
      featureProviders: { agentChat: "ollama-cloud", agentDrafter: "ollama-cloud" },
    });
    expect(result?.model).toBe("qwen3:8b");
  });

  test("falls back to defaultModel when agentDrafter featureModel not set", () => {
    const result = resolveAgentOllamaConfig({
      ollamaCloud: {
        apiKey: "secret-123",
        defaultModel: "custom-default-model",
        featureModels: { analysis: "qwen3:8b" }, // wrong feature, should not match
      },
      featureProviders: { agentChat: "ollama-cloud", agentDrafter: "ollama-cloud" },
    });
    expect(result?.model).toBe("custom-default-model");
  });
});
