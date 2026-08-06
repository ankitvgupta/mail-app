#!/usr/bin/env node
/**
 * End-to-end test: the NEW MiniMax model (minimax-m3:cloud) driven through the
 * OpenCode harness routed to Ollama Cloud — i.e. the exact path
 * OpenCodeAgentProvider takes when `ollamaCloud.enabled` is true.
 *
 * Mirrors OpenCodeAgentProvider.buildOpencodeConfig() + resolveRoute() in
 * src/main/agents/providers/opencode/opencode-agent-provider.ts:
 *   - provider "ollama-cloud" via @ai-sdk/openai-compatible
 *     baseURL https://ollama.com/v1, apiKey = OLLAMA_API_KEY
 *   - models registered with tool_call: true
 *   - session.prompt routed to { providerID: "ollama-cloud", modelID: <model> }
 *   - a remote MCP bridge exposing one fake mail tool
 *
 * Verifies, against minimax-m3 on Ollama Cloud through OpenCode:
 *   • streaming text deltas
 *   • the MCP tool getting called
 *   • a terminal session.idle
 *
 * Usage:  node scripts/test-minimax-opencode.mjs [model]
 *   defaults to minimax-m3:cloud.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/load-env.mjs";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? "minimax-m3:cloud";

loadEnv(join(__dirname, "..", ".env"));
loadEnv(join(__dirname, "..", ".env.local"));

const OLLAMA_KEY = process.env.OLLAMA_API_KEY;
if (!OLLAMA_KEY) {
  console.error("FAIL: OLLAMA_API_KEY is required (load .env first)");
  process.exit(1);
}

// Prepend node_modules/.bin so the OpenCode SDK finds the `opencode` binary.
const binDir = join(__dirname, "..", "node_modules", ".bin");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const { createOpencodeServer } = await import("@opencode-ai/sdk");
const { createOpencodeClient } = await import("@opencode-ai/sdk/client");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = await import(
  "@modelcontextprotocol/sdk/server/streamableHttp.js"
);
const { createServer } = await import("node:http");
const { randomUUID } = await import("node:crypto");

console.log("=== MiniMax × OpenCode × Ollama Cloud ===");
console.log(`model:    ollama-cloud/${MODEL}`);
console.log(`base_url: https://ollama.com/v1`);
console.log(`auth:     ${OLLAMA_KEY.slice(0, 4)}…${OLLAMA_KEY.slice(-4)} (len=${OLLAMA_KEY.length})`);

// --- Step 1: MCP bridge with one fake mail tool (mirrors McpBridge) ---
let toolWasCalled = false;
let toolArgsSeen = null;

const mcp = new McpServer({ name: "mail-app-tools", version: "1.0.0" });
mcp.registerTool(
  "get_email",
  {
    description: "Returns the body of an email by id. Call this with id='42'.",
    inputSchema: { id: z.string() },
  },
  async (args) => {
    toolWasCalled = true;
    toolArgsSeen = args;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ subject: "Quarterly sync", body: `Email ${args.id}: please confirm Tuesday 3pm.` }),
        },
      ],
    };
  },
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(transport);

const httpServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    let body;
    if (bodyStr) {
      try {
        body = JSON.parse(bodyStr);
      } catch {
        /* ignore */
      }
    }
    transport.handleRequest(req, res, body).catch((err) => console.error("MCP handler error:", err));
  });
});
await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", () => {
    httpServer.off("error", reject);
    resolve();
  });
});
const bridgeUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;
console.log(`[oc] MCP bridge: ${bridgeUrl}`);

// --- Step 2: OpenCode server config — buildOpencodeConfig() Ollama branch ---
const ocConfig = {
  logLevel: "WARN",
  mcp: {
    "mail-app-tools": { type: "remote", url: bridgeUrl, enabled: true },
  },
  permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  // ollama active, anthropic inactive -> anthropic added to disabled list
  disabled_providers: ["github-copilot", "openrouter", "google", "groq", "deepseek", "anthropic"],
  provider: {
    "ollama-cloud": {
      name: "Ollama Cloud",
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://ollama.com/v1",
        apiKey: OLLAMA_KEY,
      },
      models: {
        [MODEL]: { id: MODEL, name: MODEL, tool_call: true },
      },
    },
  },
};

console.log("[oc] starting OpenCode server (may install @ai-sdk/openai-compatible on first run)…");
const server = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 0,
  timeout: 60_000,
  config: ocConfig,
});
console.log(`[oc] server: ${server.url}`);
const client = createOpencodeClient({ baseUrl: server.url });

try {
  const ids = await client.tool.ids({ query: { directory: process.cwd() } });
  const idList = Array.isArray(ids.data) ? ids.data : [];
  if (!idList.some((t) => /get_email/.test(t))) {
    console.warn(`[oc] WARNING: get_email not in tool list yet (may load lazily)`);
  } else {
    console.log(`[oc] tool registered: get_email`);
  }
} catch (err) {
  console.warn(`[oc] tool.ids check failed: ${err?.message ?? err}`);
}

// --- Step 3: session + prompt routed to ollama-cloud/minimax ---
const session = await client.session.create({ body: { title: "minimax-oc-smoke" } });
const sessionId = session.data?.id;
if (!sessionId) {
  console.error("FAIL: session.create returned no id");
  process.exit(2);
}

const abort = new AbortController();
const eventResult = await client.event.subscribe({ signal: abort.signal });
const eventIter = eventResult.stream[Symbol.asyncIterator]();

const PROMPT =
  "You have an MCP tool `get_email`. Call it with id='42', then in plain text " +
  "summarize the email in one sentence. End your reply with the literal token MINIMAX_OC_PASS.";

const promptPromise = client.session
  .promptAsync({
    path: { id: sessionId },
    body: {
      model: { providerID: "ollama-cloud", modelID: MODEL },
      system: "You are a QA agent. Follow instructions exactly. You MUST use the get_email tool.",
      tools: { write: false, edit: false, read: false, glob: false, grep: false, bash: false },
      parts: [{ type: "text", text: PROMPT }],
    },
  })
  .catch((err) => {
    console.error(`[oc] promptAsync rejected: ${err?.message ?? err}`);
    abort.abort();
  });

let textOut = "";
const toolCallsSeen = [];
let sessionErrored = null;
const overallTimeout = setTimeout(() => {
  console.error("\n[oc] FAIL: 150s timeout waiting for session.idle");
  abort.abort();
}, 150_000);

while (true) {
  const step = await eventIter.next();
  if (step.done) break;
  const ev = step.value;

  if (ev.type === "message.part.updated") {
    const part = ev.properties.part;
    if (part.type === "text" && part.sessionID === sessionId) {
      if (ev.properties.delta) {
        process.stdout.write(ev.properties.delta);
        textOut += ev.properties.delta;
      } else if (part.text && part.text.length > textOut.length && part.text.startsWith(textOut)) {
        const delta = part.text.slice(textOut.length);
        process.stdout.write(delta);
        textOut = part.text;
      }
    } else if (part.type === "tool" && part.sessionID === sessionId) {
      if (!toolCallsSeen.includes(part.callID)) {
        toolCallsSeen.push(part.callID);
        console.log(`\n[oc] tool_call_start: ${part.tool}`);
      }
      if (part.state?.status === "completed") console.log(`[oc] tool_call_end: ${part.tool}`);
    }
  }
  if (ev.type === "session.idle" && ev.properties.sessionID === sessionId) {
    console.log("\n[oc] session.idle");
    break;
  }
  if (ev.type === "session.error" && ev.properties.sessionID === sessionId) {
    sessionErrored = ev.properties.error;
    console.error("\n[oc] session.error", JSON.stringify(ev.properties.error));
    break;
  }
}

clearTimeout(overallTimeout);
abort.abort();
await promptPromise;
server.close();
httpServer.close();

// --- Step 4: verdict ---
const sawText = textOut.trim().length > 0;
const sawToken = textOut.includes("MINIMAX_OC_PASS");
const pass = toolWasCalled && sawText && !sessionErrored;

console.log("\n=========================");
console.log(`tool executed (handler ran): ${toolWasCalled}  args=${JSON.stringify(toolArgsSeen)}`);
console.log(`streamed assistant text:     ${sawText}`);
console.log(`MINIMAX_OC_PASS token:       ${sawToken}`);
console.log(`session.error:               ${sessionErrored ? JSON.stringify(sessionErrored) : "none"}`);
console.log(`VERDICT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
console.log("=========================");
process.exit(pass ? 0 : 1);
