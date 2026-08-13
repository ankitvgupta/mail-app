/**
 * Unit tests for Ollama Cloud agent environment integration.
 *
 * Since ClaudeAgentProvider.buildChildEnv() is private and requires the
 * Claude Agent SDK, we test the public contract indirectly:
 * - Verify the shared types accept ollamaCloud config
 * - Verify ConfigSchema round-trips correctly for agent-relevant fields
 * - Verify the LLM service module exports needed for agent integration
 */
import { test, expect } from "@playwright/test";
import {
  ConfigSchema,
  OllamaCloudConfigSchema,
  LlmProviderSchema,
  type Config,
  type LlmProvider,
} from "../../src/shared/types";

test.describe("Ollama Cloud agent environment types", () => {
  test("Config type accepts ollamaCloud with all agent-relevant fields", () => {
    const config: Config = ConfigSchema.parse({
      ollamaCloud: {
        apiKey: "test-agent-key",
        defaultModel: "minimax-m2.7:cloud",
        featureModels: {
          agentDrafter: "llama3.1:cloud",
          agentChat: "minimax-m2.7:cloud",
        },
      },
      featureProviders: {
        agentDrafter: "ollama-cloud",
        agentChat: "ollama-cloud",
      },
    });

    expect(config.ollamaCloud?.apiKey).toBe("test-agent-key");
    expect(config.featureProviders?.["agentDrafter"]).toBe("ollama-cloud");
    expect(config.featureProviders?.["agentChat"]).toBe("ollama-cloud");
  });

  test("LLM service exports setOllamaConfig and _setOllamaClientForTesting", async () => {
    // Verify the module exports exist — agents need these to configure Ollama
    const llmService = await import("../../src/main/services/llm-service");

    expect(typeof llmService.setOllamaConfig).toBe("function");
    expect(typeof llmService._setOllamaClientForTesting).toBe("function");
    expect(typeof llmService.resetOllamaClient).toBe("function");
  });

  test("ollamaCloud config round-trips through ConfigSchema parse", () => {
    const input = {
      ollamaCloud: {
        apiKey: "round-trip-key",
        defaultModel: "custom-model:cloud",
        featureModels: { analysis: "model-a", drafts: "model-b" },
      },
      featureProviders: {
        analysis: "ollama-cloud" as LlmProvider,
        drafts: "ollama-cloud" as LlmProvider,
        refinement: "anthropic" as LlmProvider,
      },
    };

    const parsed = ConfigSchema.parse(input);
    // Re-parse to simulate serialization round-trip
    const reparsed = ConfigSchema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed.ollamaCloud?.apiKey).toBe("round-trip-key");
    expect(reparsed.ollamaCloud?.defaultModel).toBe("custom-model:cloud");
    expect(reparsed.ollamaCloud?.featureModels).toEqual({
      analysis: "model-a",
      drafts: "model-b",
    });
    expect(reparsed.featureProviders?.["analysis"]).toBe("ollama-cloud");
    expect(reparsed.featureProviders?.["refinement"]).toBe("anthropic");
  });

  test("OllamaCloudConfigSchema featureModels accepts arbitrary feature keys", () => {
    // Agents may register new feature keys — the schema uses z.record so any string key works
    const result = OllamaCloudConfigSchema.parse({
      apiKey: "k",
      featureModels: {
        customAgentFeature: "some-model:cloud",
        anotherFeature: "another-model:cloud",
      },
    });

    expect(result.featureModels?.["customAgentFeature"]).toBe("some-model:cloud");
    expect(result.featureModels?.["anotherFeature"]).toBe("another-model:cloud");
  });
});
