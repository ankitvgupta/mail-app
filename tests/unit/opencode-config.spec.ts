import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("preload exposes the OpenCode model catalog through the typed settings channel", () => {
  const preload = readFileSync(resolve(import.meta.dirname, "../../src/preload/index.ts"), "utf8");
  const types = readFileSync(resolve(import.meta.dirname, "../../src/shared/types.ts"), "utf8");

  expect(preload).toContain(
    'listOpenCodeModels: (): Promise<unknown> => ipcRenderer.invoke("settings:list-opencode-models"),',
  );
  expect(types).toContain('"settings:list-opencode-models": void');
});

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
