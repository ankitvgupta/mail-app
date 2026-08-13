/**
 * Unit tests for Hostler agent reconciliation.
 *
 * Hostler agents are immutable versioned configs on the server; agent-sync
 * finds the app's agent by name and publishes a new version only when the
 * desired config actually changed. Properties tested:
 *   - Client tools convert zod → JSON Schema; unconvertible schemas are
 *     skipped (not fatal); the $schema meta key is stripped.
 *   - ensureAgent: create when missing, no-op when equal, version-bump on
 *     drift.
 *   - Config comparison ignores key order and server-added extra fields.
 */
import { test, expect } from "@playwright/test";
import { z } from "zod";
import type { Agent, AgentConfig } from "@hostler/sdk";
import {
  agentConfigEquals,
  buildAgentConfig,
  buildClientTools,
  ensureAgent,
  HOSTLER_AGENT_NAME,
  type HostlerAgentsApi,
} from "../../src/main/agents/providers/hostler/agent-sync";

function makeFakeAgentsApi(existing: Agent[]): HostlerAgentsApi & {
  created: AgentConfig[];
  versioned: { id: string; config: AgentConfig }[];
} {
  const created: AgentConfig[] = [];
  const versioned: { id: string; config: AgentConfig }[] = [];
  return {
    created,
    versioned,
    list: async () => existing,
    create: async (config) => {
      created.push(config);
      return { id: "agt_new", version: 1, config, createdAt: "2026-07-13T00:00:00Z" };
    },
    createVersion: async (id, config) => {
      versioned.push({ id, config });
      return { id, version: 2, config, createdAt: "2026-07-13T00:00:00Z" };
    },
  };
}

const TOOLS = [
  {
    name: "read_email",
    description: "Read an email by id",
    inputSchema: z.object({ id: z.string().describe("Email id") }),
  },
];

const MODEL = { provider: "anthropic", id: "claude-haiku-4-5" };

test("buildClientTools converts zod schemas to JSON Schema without $schema", () => {
  const tools = buildClientTools(TOOLS);
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("read_email");
  expect(tools[0].description).toBe("Read an email by id");
  expect(tools[0].inputSchema).not.toHaveProperty("$schema");
  expect(tools[0].inputSchema).toMatchObject({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });
});

test("buildClientTools skips tools whose schema cannot convert", () => {
  const tools = buildClientTools([
    ...TOOLS,
    {
      name: "bad_tool",
      description: "Schema is unrepresentable in JSON Schema",
      inputSchema: z.object({ when: z.date() }),
    },
  ]);
  expect(tools.map((t) => t.name)).toEqual(["read_email"]);
});

test("buildAgentConfig pins the well-known name and disables sandbox built-ins", () => {
  const config = buildAgentConfig({ tools: TOOLS, model: MODEL, harness: "pi" });
  expect(config.name).toBe(HOSTLER_AGENT_NAME);
  expect(config.harness).toBe("pi");
  expect(config.model).toEqual(MODEL);
  // Prompt-injection hardening: no filesystem/shell built-ins in the sandbox;
  // the client tools are the agent's entire surface.
  expect(config.sandboxTools).toEqual([]);
  expect(config.clientTools).toHaveLength(1);
  expect(config.system).toContain("untrusted input");
});

test("ensureAgent creates the agent when none exists", async () => {
  const api = makeFakeAgentsApi([]);
  const desired = buildAgentConfig({ tools: TOOLS, model: MODEL, harness: "pi" });

  const ref = await ensureAgent(api, desired);

  expect(api.created).toHaveLength(1);
  expect(api.versioned).toHaveLength(0);
  expect(ref).toEqual({ id: "agt_new", version: 1 });
});

test("ensureAgent reuses the stored version when the config is unchanged", async () => {
  const desired = buildAgentConfig({ tools: TOOLS, model: MODEL, harness: "pi" });
  // Simulate a server round-trip: same config, different key order + an
  // extra server-side field. Neither must force a version bump.
  const stored: AgentConfig = {
    clientTools: desired.clientTools,
    system: desired.system,
    model: { id: MODEL.id, provider: MODEL.provider },
    harness: desired.harness,
    name: desired.name,
    sandboxTools: [],
    serverAddedField: "ignored",
  };
  const api = makeFakeAgentsApi([
    { id: "agt_1", version: 3, config: stored, createdAt: "2026-07-01T00:00:00Z" },
  ]);

  const ref = await ensureAgent(api, desired);

  expect(api.created).toHaveLength(0);
  expect(api.versioned).toHaveLength(0);
  expect(ref).toEqual({ id: "agt_1", version: 3 });
});

test("ensureAgent publishes a new version when the config drifts", async () => {
  const desired = buildAgentConfig({ tools: TOOLS, model: MODEL, harness: "pi" });
  const stored = buildAgentConfig({
    tools: TOOLS,
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    harness: "pi",
  });
  const api = makeFakeAgentsApi([
    { id: "agt_1", version: 3, config: stored, createdAt: "2026-07-01T00:00:00Z" },
  ]);

  const ref = await ensureAgent(api, desired);

  expect(api.created).toHaveLength(0);
  expect(api.versioned).toEqual([{ id: "agt_1", config: desired }]);
  expect(ref).toEqual({ id: "agt_1", version: 2 });
});

test("ensureAgent matches by name among other agents", async () => {
  const desired = buildAgentConfig({ tools: TOOLS, model: MODEL, harness: "pi" });
  const other: AgentConfig = { name: "unrelated-agent", harness: "pi", model: MODEL };
  const api = makeFakeAgentsApi([
    { id: "agt_other", version: 1, config: other, createdAt: "2026-07-01T00:00:00Z" },
    { id: "agt_ours", version: 5, config: desired, createdAt: "2026-07-01T00:00:00Z" },
  ]);

  const ref = await ensureAgent(api, desired);
  expect(ref).toEqual({ id: "agt_ours", version: 5 });
});

test("agentConfigEquals is insensitive to key order and extra fields", () => {
  const a = buildAgentConfig({ tools: TOOLS, model: MODEL, harness: "pi" });
  const b: AgentConfig = {
    serverField: 42,
    sandboxTools: [],
    clientTools: a.clientTools,
    system: a.system,
    harness: a.harness,
    model: { id: MODEL.id, provider: MODEL.provider },
    name: a.name,
  };
  expect(agentConfigEquals(a, b)).toBe(true);

  const c: AgentConfig = { ...b, harness: "opencode" };
  expect(agentConfigEquals(a, c)).toBe(false);
});
