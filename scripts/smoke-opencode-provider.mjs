#!/usr/bin/env node
/**
 * End-to-end smoke test for OpenCodeAgentProvider.
 *
 * Spawns the real OpenCode server through the SDK, stands up the MCP bridge
 * with one fake tool, runs a tiny prompt, and verifies we see:
 *   • streaming text deltas
 *   • the fake MCP tool getting called (LLM is told it MUST call it)
 *   • a terminal session.idle (completed state)
 *
 * Two goals:
 *   1. Catch obvious wiring regressions before doing a real Electron smoke test
 *   2. Document the moving parts so future debugging is faster
 *
 * Requires:
 *   • ANTHROPIC_API_KEY in env (used by OpenCode's anthropic provider)
 *   • node_modules/.bin/opencode (the per-platform binary from opencode-ai)
 *
 * Usage:
 *   node scripts/smoke-opencode-provider.mjs
 *
 * Note: this script lives outside the Electron worker, so we have to load the
 * provider's TS module via tsx. Run via tsx from package.json, or invoke node
 * with the loader at top. For simplicity we exercise the building blocks
 * (MCP bridge + OpenCode SDK) directly here, matching what the provider does
 * — proves the same shape works.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from .env so ANTHROPIC_API_KEY is populated when the script is run
// outside of `npm run` (which doesn't auto-load .env files).
function loadEnv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let val = trimmed.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv(join(__dirname, "..", ".env"));
loadEnv(join(__dirname, "..", ".env.local"));

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FAIL: ANTHROPIC_API_KEY is required (load .env first)");
  process.exit(1);
}

// Prepend node_modules/.bin so the SDK finds `opencode` without a global install.
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

// --- Step 1: stand up an MCP bridge with one fake tool ---

let toolWasCalled = false;
let toolArgsSeen = null;

const mcp = new McpServer({ name: "smoke-tools", version: "1.0.0" });
mcp.registerTool(
  "echo_email",
  {
    description: "Returns a canned email body for the given ID. Call this with id='42'.",
    inputSchema: { id: z.string() },
  },
  async (args) => {
    toolWasCalled = true;
    toolArgsSeen = args;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ subject: "Smoke test", body: `Hello, you asked for ${args.id}` }),
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
    let body = undefined;
    if (bodyStr) {
      try {
        body = JSON.parse(bodyStr);
      } catch {
        // ignore
      }
    }
    transport.handleRequest(req, res, body).catch((err) => {
      console.error("MCP handler error:", err);
    });
  });
});

await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", () => {
    httpServer.off("error", reject);
    resolve();
  });
});
const port = httpServer.address().port;
const bridgeUrl = `http://127.0.0.1:${port}/mcp`;
console.log(`[smoke] MCP bridge: ${bridgeUrl}`);

// --- Step 2: spawn the OpenCode server, pointing at the bridge ---

const ocConfig = {
  logLevel: "INFO",
  mcp: {
    "smoke-tools": { type: "remote", url: bridgeUrl, enabled: true },
  },
  permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  provider: {
    anthropic: { options: { apiKey: process.env.ANTHROPIC_API_KEY } },
  },
  disabled_providers: ["github-copilot", "openrouter", "google", "groq", "deepseek"],
};

const server = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 0,
  timeout: 30_000,
  config: ocConfig,
});
console.log(`[smoke] OpenCode server: ${server.url}`);
const client = createOpencodeClient({ baseUrl: server.url });

// Sanity check that OpenCode picked up the MCP server
try {
  const ids = await client.tool.ids({ query: { directory: process.cwd() } });
  const idList = Array.isArray(ids.data) ? ids.data : [];
  console.log(`[smoke] OpenCode-known tool IDs: ${idList.join(", ")}`);
  if (!idList.some((t) => /echo_email/.test(t))) {
    console.warn(`[smoke] WARNING: echo_email not in tool list yet (may load lazily)`);
  }
} catch (err) {
  console.warn(`[smoke] tool.ids check failed: ${err?.message ?? err}`);
}

// --- Step 3: create a session and prompt ---

const session = await client.session.create({ body: { title: "smoke-session" } });
const sessionId = session.data?.id;
if (!sessionId) {
  console.error("FAIL: session.create returned no id");
  process.exit(2);
}
console.log(`[smoke] session: ${sessionId}`);

// Subscribe to the SSE stream BEFORE prompting
const abort = new AbortController();
const eventResult = await client.event.subscribe({ signal: abort.signal });
const eventIter = eventResult.stream[Symbol.asyncIterator]();

// Kick off the prompt
const PROMPT =
  "You have an MCP tool called echo_email. Call it with id='42' and then in plain text describe what it returned. End your message with the literal token SMOKE_PASS once done.";

const promptPromise = client.session
  .promptAsync({
    path: { id: sessionId },
    body: {
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" },
      system:
        "You are a smoke test agent. Follow instructions exactly. You MUST use the echo_email tool.",
      tools: { write: false, edit: false, read: false, glob: false, grep: false, bash: false },
      parts: [{ type: "text", text: PROMPT }],
    },
  })
  .catch((err) => {
    console.error(`[smoke] promptAsync rejected: ${err?.message ?? err}`);
    abort.abort();
  });

// Consume events until session.idle
let textOut = "";
const toolCallsSeen = [];
const overallTimeout = setTimeout(() => {
  console.error("[smoke] FAIL: 60s timeout waiting for session.idle");
  abort.abort();
}, 60_000);

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
        console.log(`\n[smoke] tool_call_start: ${part.tool} (callID=${part.callID})`);
      }
      if (part.state?.status === "completed") {
        console.log(`[smoke] tool_call_end: ${part.tool}`);
      }
    }
  }
  if (ev.type === "session.idle" && ev.properties.sessionID === sessionId) {
    console.log("\n[smoke] session.idle");
    break;
  }
  if (ev.type === "session.error" && ev.properties.sessionID === sessionId) {
    console.error("[smoke] FAIL: session.error", JSON.stringify(ev.properties.error));
    clearTimeout(overallTimeout);
    abort.abort();
    server.close();
    httpServer.close();
    process.exit(3);
  }
}

clearTimeout(overallTimeout);
abort.abort();
await promptPromise;

// --- Step 4: verdict ---
let pass = true;
const reasons = [];

if (!toolWasCalled) {
  pass = false;
  reasons.push("MCP tool echo_email was never invoked");
}
if (toolArgsSeen && toolArgsSeen.id !== "42") {
  reasons.push(`MCP tool called with unexpected args: ${JSON.stringify(toolArgsSeen)}`);
}
if (!textOut.includes("SMOKE_PASS")) {
  pass = false;
  reasons.push(`SMOKE_PASS token missing from output (got: ${JSON.stringify(textOut.slice(-200))})`);
}

console.log("\n=========================");
console.log(`tool called: ${toolWasCalled}`);
console.log(`tool args: ${JSON.stringify(toolArgsSeen)}`);
console.log(`text contains SMOKE_PASS: ${textOut.includes("SMOKE_PASS")}`);
console.log(`verdict: ${pass ? "PASS" : "FAIL"}`);
if (!pass) {
  console.log("reasons:");
  for (const r of reasons) console.log(`  - ${r}`);
}
console.log("=========================");

server.close();
httpServer.close();
process.exit(pass ? 0 : 1);
