#!/usr/bin/env node
/**
 * End-to-end test: the NEW MiniMax model (minimax-m3:cloud) driven through the
 * Claude Agent SDK harness routed to Ollama Cloud — i.e. the exact path
 * ClaudeAgentProvider takes when `ollamaCloud.enabled` is true.
 *
 * This mirrors ClaudeAgentProvider.buildChildEnv() + the query() call in
 * src/main/agents/providers/claude-agent-provider.ts:
 *   - ANTHROPIC_BASE_URL  = https://ollama.com
 *   - ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY = OLLAMA_API_KEY
 *   - every MODEL_ENV_VAR  = minimax-m3:cloud
 *   - query() with an in-process MCP tool (createSdkMcpServer + tool)
 *
 * Verifies the harness can, against minimax-m3 on Ollama Cloud:
 *   • stream assistant text
 *   • invoke an MCP tool (agent tool-calling is the core of this harness)
 *   • reach a terminal result
 *
 * Usage:  node scripts/test-minimax-claude-sdk.mjs [model]
 *   defaults to minimax-m3:cloud; pass another tag to compare.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/load-env.mjs";
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? "minimax-m3:cloud";

// MODEL_ENV_VARS — kept in lockstep with claude-agent-provider.ts. If Claude
// Code falls back to any hardcoded Anthropic model for a subtask, it 404s on
// ollama.com, so every one must point at our model.
const MODEL_ENV_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_CUSTOM_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

loadEnv(join(__dirname, "..", ".env"));
loadEnv(join(__dirname, "..", ".env.local"));

const OLLAMA_KEY = process.env.OLLAMA_API_KEY;
if (!OLLAMA_KEY) {
  console.error("FAIL: OLLAMA_API_KEY is required (load .env first)");
  process.exit(1);
}

// --- buildChildEnv() Ollama branch, replicated ---
const childEnv = { ...process.env };
childEnv.ANTHROPIC_BASE_URL = "https://ollama.com";
childEnv.ANTHROPIC_AUTH_TOKEN = OLLAMA_KEY;
childEnv.ANTHROPIC_API_KEY = OLLAMA_KEY;
for (const k of MODEL_ENV_VARS) childEnv[k] = MODEL;
childEnv.DISABLE_TELEMETRY = "1";
childEnv.DISABLE_ERROR_REPORTING = "1";
childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
childEnv.DO_NOT_TRACK = "1";
delete childEnv.CLAUDECODE;

console.log("=== MiniMax × Claude Agent SDK × Ollama Cloud ===");
console.log(`model:    ${MODEL}`);
console.log(`base_url: ${childEnv.ANTHROPIC_BASE_URL}`);
console.log(`auth:     ${OLLAMA_KEY.slice(0, 4)}…${OLLAMA_KEY.slice(-4)} (len=${OLLAMA_KEY.length})`);

// --- in-process MCP tool, same mechanism the provider uses for mail tools ---
let toolCalled = false;
let toolArgs = null;
const mcpServer = createSdkMcpServer({
  name: "mail-app-tools",
  version: "1.0.0",
  tools: [
    tool(
      "get_email",
      "Returns the body of an email by id. Call this with id='42'.",
      { id: z.string() },
      async (args) => {
        toolCalled = true;
        toolArgs = args;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ subject: "Quarterly sync", body: `Email ${args.id}: please confirm Tuesday 3pm.` }),
            },
          ],
        };
      },
    ),
  ],
});

const PROMPT =
  "You have an MCP tool `get_email`. Call it with id='42', then in plain text " +
  "summarize the email in one sentence. End your reply with the literal token MINIMAX_SDK_PASS.";

const q = query({
  prompt: PROMPT,
  options: {
    model: MODEL,
    systemPrompt: "You are a QA agent. Follow instructions exactly. You MUST call the get_email tool.",
    mcpServers: { "mail-app-tools": mcpServer },
    allowedTools: ["mcp__mail-app-tools__get_email"],
    includePartialMessages: true,
    maxTurns: 12,
    permissionMode: "bypassPermissions",
    settingSources: [],
    persistSession: false,
    env: childEnv,
    stderr: (d) => process.stderr.write(`[claude-stderr] ${d}`),
  },
});

const toolCalls = [];
const textOut = [];
let resultMeta = null;

const timeout = setTimeout(() => {
  console.error("\nFAIL: 120s timeout waiting for result");
  process.exit(3);
}, 120_000);

try {
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      console.log(`[init] session started; model=${msg.model ?? MODEL}`);
    }
    if (msg.type === "assistant") {
      for (const block of msg.message.content ?? []) {
        if (block.type === "tool_use") {
          toolCalls.push(block.name);
          console.log(`\n[tool_use] ${block.name} ${JSON.stringify(block.input)}`);
        } else if (block.type === "text" && block.text) {
          textOut.push(block.text);
          process.stdout.write(block.text);
        }
      }
    }
    if (msg.type === "result") {
      resultMeta = msg;
      console.log(
        `\n[result] subtype=${msg.subtype} turns=${msg.num_turns ?? "?"} duration_ms=${msg.duration_ms ?? "?"}`,
      );
    }
  }
} catch (err) {
  clearTimeout(timeout);
  console.error(`\nFAIL: query threw: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
clearTimeout(timeout);

const finalText = textOut.join("");
const sdkSawToolCall = toolCalls.some((t) => t.endsWith("get_email"));
const sawText = finalText.trim().length > 0;
const sawToken = finalText.includes("MINIMAX_SDK_PASS");
const resultOk = resultMeta?.subtype === "success" || resultMeta != null;

const pass = toolCalled && sdkSawToolCall && sawText && resultOk;

console.log("\n=========================");
console.log(`tool executed (handler ran): ${toolCalled}  args=${JSON.stringify(toolArgs)}`);
console.log(`tool_use seen by SDK:        ${sdkSawToolCall}`);
console.log(`streamed assistant text:     ${sawText}`);
console.log(`MINIMAX_SDK_PASS token:      ${sawToken}`);
console.log(`reached result:              ${resultOk} (${resultMeta?.subtype ?? "none"})`);
console.log(`VERDICT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
console.log("=========================");
process.exit(pass ? 0 : 1);
