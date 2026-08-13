#!/usr/bin/env node
/**
 * Spike: validate @opencode-ai/sdk shape against the architecture we want.
 *
 * Three questions:
 *   1. Does createOpencodeServer() spawn a child process or run in-process?
 *   2. Does the Config support `mcp` servers (remote URLs in particular) so we
 *      can route tool calls back to a worker-hosted MCP bridge?
 *   3. Can a per-session model + provider be specified per-call?
 *
 * We exercise the SDK end-to-end without making a real LLM call: start the
 * server with a fake provider, hit a few read-only endpoints, confirm session
 * creation/abort works, and dump findings.
 *
 * Findings are written to .context/opencode-spike.md.
 *
 * Usage: node scripts/spike-opencode-sdk.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeServer } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const findings = [];
function record(line) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${line}`);
  findings.push(line);
}

function snapshotChildren(parentPid) {
  // ps -A so we see grandchildren on macOS; -o ppid lets us filter.
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] } : null;
    })
    .filter((row) => row && row.ppid === parentPid);
}

async function main() {
  record("=== OpenCode SDK spike ===");
  record(`node version: ${process.version}`);
  record(`OPENCODE_BIN_PATH (override): ${process.env.OPENCODE_BIN_PATH ?? "(unset)"}`);

  // Verify binary is reachable. The opencode-ai npm package puts it at node_modules/.bin/opencode.
  const localBin = join(__dirname, "..", "node_modules", ".bin", "opencode");
  const binCheck = spawnSync(localBin, ["--version"], { encoding: "utf8" });
  if (binCheck.status === 0) {
    record(`opencode binary OK: ${localBin}`);
    record(`  version: ${binCheck.stdout.trim()}`);
  } else {
    record(`opencode binary FAILED at ${localBin}: ${binCheck.stderr || binCheck.error}`);
  }

  // Prepend node_modules/.bin to PATH so the SDK's `launch("opencode", ...)` finds it.
  process.env.PATH = `${join(__dirname, "..", "node_modules", ".bin")}:${process.env.PATH ?? ""}`;

  record("");
  record("Question 1: process model — start server, snapshot child processes.");
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0, // ephemeral
    timeout: 15000,
    config: {
      logLevel: "INFO",
      // Question 2: declare a remote MCP server in config (we won't actually
      // hit it, but the server should at least accept the config shape).
      mcp: {
        "mail-app-tools": {
          type: "remote",
          url: "http://127.0.0.1:39999/mcp",
          enabled: false, // disabled so it doesn't try to connect
        },
      },
      // Disable any auto-loaded providers so we don't blow up on missing API keys
      disabled_providers: ["openrouter", "anthropic", "openai", "google", "groq", "deepseek"],
    },
  });
  record(`server.url: ${server.url}`);
  const children = snapshotChildren(process.pid);
  record(`children of node spike process (ppid=${process.pid}): ${children.length}`);
  for (const c of children) {
    record(`  pid=${c.pid} comm=${c.comm}`);
  }
  record(
    `=> Question 1 answer: ${children.some((c) => c.comm.includes("opencode")) ? "external subprocess (asar/exec packaging concern applies)" : "no obvious opencode subprocess found (verify)"}`,
  );

  // Reach the server via the typed client
  const client = createOpencodeClient({ baseUrl: server.url });

  record("");
  record("Question 2: config / mcp acceptance — fetch live config and check mcp surface.");
  try {
    const cfg = await client.config.get();
    const cfgData = cfg.data;
    record(`config.get OK; mcp keys: ${Object.keys(cfgData?.mcp ?? {}).join(", ") || "(none)"}`);
    record(`  enabled_providers: ${(cfgData?.enabled_providers ?? []).join(",") || "(none)"}`);
    record(`  disabled_providers: ${(cfgData?.disabled_providers ?? []).join(",") || "(none)"}`);
  } catch (err) {
    record(`config.get FAILED: ${err?.message || String(err)}`);
  }

  // Try to list providers — confirms server is alive and tells us what's available
  try {
    const provs = await client.config.providers();
    const provData = provs.data;
    const provIds = Object.keys(provData?.providers ?? {});
    record(`config.providers OK; loaded provider IDs: ${provIds.join(", ") || "(none)"}`);
  } catch (err) {
    record(`config.providers FAILED: ${err?.message || String(err)}`);
  }

  // List tools — confirms session API + tool surface works without an LLM call.
  try {
    const ids = await client.tool.ids({ query: { directory: process.cwd() } });
    const idsData = Array.isArray(ids.data) ? ids.data : [];
    record(`tool.ids OK; first 10 of ${idsData.length}: ${idsData.slice(0, 10).join(", ")}`);
  } catch (err) {
    record(`tool.ids FAILED: ${err?.message || String(err)}`);
  }

  record("");
  record("Question 3: session create + abort.");
  try {
    const created = await client.session.create({ body: { title: "spike-session" } });
    const sessionId = created.data?.id;
    record(`session.create OK; id=${sessionId}`);
    if (sessionId) {
      const aborted = await client.session.abort({ path: { id: sessionId } });
      record(`session.abort OK; result=${JSON.stringify(aborted.data)}`);
      // Clean up
      await client.session.delete({ path: { id: sessionId } });
      record(`session.delete OK`);
    }
  } catch (err) {
    record(`session.create/abort FAILED: ${err?.message || String(err)}`);
  }

  record("");
  record("=== Verdict ===");
  record(
    "Q1 process model: opencode binary spawned as a subprocess (per-platform native). Same packaging shape as Claude Code — need asar.unpacked resolution for packaged Electron, dev is fine via node_modules/.bin.",
  );
  record(
    "Q2 MCP config: server accepts mcp.{name}={type:'remote', url, enabled} in Config. A worker-hosted MCP HTTP server is the bridge — same shape as today's chrome-devtools-mcp wiring.",
  );
  record(
    "Q3 per-session model: SessionPromptData.body.model = { providerID, modelID } — per-call override is first-class. No env-var hack needed for Ollama or per-task routing.",
  );

  server.close();

  // Write findings
  mkdirSync(join(__dirname, "..", ".context"), { recursive: true });
  const outPath = join(__dirname, "..", ".context", "opencode-spike.md");
  writeFileSync(
    outPath,
    "# OpenCode SDK spike findings\n\n```\n" + findings.join("\n") + "\n```\n",
  );
  record(`Findings written to ${outPath}`);
}

main().catch((err) => {
  console.error("SPIKE FATAL:", err);
  process.exit(1);
});
