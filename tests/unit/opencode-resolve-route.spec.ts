import { expect, test } from "@playwright/test";

import { resolveRoute } from "../../src/main/agents/providers/opencode/opencode-agent-provider";
import type { AgentFrameworkConfig } from "../../src/main/agents/types";
import type { OpenCodeModelOption } from "../../src/shared/types";

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

const baseConfig: AgentFrameworkConfig = {
  model: "claude-sonnet-4-6",
  opencode: { enabled: true },
};

test("an exact runtime selector wins over the legacy OpenCode model", () => {
  const config = {
    ...baseConfig,
    opencode: { enabled: true, model: "anthropic/claude-sonnet-4-5" },
  };

  expect(resolveRoute(config, "openai/gpt-5.2", models)).toEqual({
    providerID: "openai",
    modelID: "gpt-5.2",
  });
});

test("a unique bare runtime selector wins over an exact legacy model", () => {
  const config = {
    ...baseConfig,
    opencode: { enabled: true, model: "anthropic/claude-sonnet-4-5" },
  };

  expect(resolveRoute(config, "gpt-5.2", models)).toEqual({
    providerID: "openai",
    modelID: "gpt-5.2",
  });
});

test("the legacy OpenCode model is used when no runtime selector is supplied", () => {
  const config = {
    ...baseConfig,
    opencode: { enabled: true, model: "anthropic/claude-sonnet-4-5" },
  };

  expect(resolveRoute(config, undefined, models)).toEqual({
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  });
});

test("blank selection omits the route so OpenCode chooses its default", () => {
  expect(resolveRoute(baseConfig, undefined, models)).toBeUndefined();
});

test("a unique legacy bare selector resolves through the connected catalog", () => {
  const config = {
    ...baseConfig,
    opencode: { enabled: true, model: "gpt-5.2" },
  };

  expect(resolveRoute(config, undefined, models)).toEqual({
    providerID: "openai",
    modelID: "gpt-5.2",
  });
});

test("an ambiguous legacy bare selector fails visibly", () => {
  const config = {
    ...baseConfig,
    opencode: { enabled: true, model: "shared-model" },
  };
  const ambiguous = models.map((model) => ({ ...model, modelId: "shared-model" }));

  expect(() => resolveRoute(config, undefined, ambiguous)).toThrow(/ambiguous/i);
});
