#!/usr/bin/env node
/**
 * Day-0 spike: prove @anthropic-ai/claude-agent-sdk can load the
 * chrome-devtools MCP and drive a running Electron app via CDP.
 *
 * If this returns PASS, the plan's Phase 1.5 scripted agentic-verify
 * path is viable. If FAIL, fall back to interactive-only via the
 * existing electron-devtools-testing skill.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node scripts/spike-agent-sdk.mjs
 *
 * Writes a run log to scripts/.spike-runs/<timestamp>.log
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = join(__dirname, ".spike-runs", `${TIMESTAMP}.log`);

mkdirSync(join(__dirname, ".spike-runs"), { recursive: true });
const logEntries = [];
function log(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  console.log(entry);
  logEntries.push(entry);
}

function flushLog() {
  writeFileSync(LOG_PATH, logEntries.join("\n") + "\n");
}

async function waitForCdp(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${CDP_URL}/json/version`);
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`CDP at ${CDP_URL} not ready after ${timeoutMs}ms`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    log("FATAL: ANTHROPIC_API_KEY is not set in env. Aborting.");
    flushLog();
    process.exit(1);
  }

  log(`Launching Electron in demo mode with --remote-debugging-port=${CDP_PORT}...`);
  const electron = spawn(
    "npx",
    ["electron-vite", "dev", "--", `--remote-debugging-port=${CDP_PORT}`],
    {
      env: { ...process.env, EXO_DEMO_MODE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: join(__dirname, ".."),
    },
  );

  electron.stdout.on("data", (d) => process.stderr.write(`[electron] ${d}`));
  electron.stderr.on("data", (d) => process.stderr.write(`[electron-err] ${d}`));

  let killed = false;
  function cleanup() {
    if (killed) return;
    killed = true;
    if (!electron.killed) {
      log("Killing Electron subprocess...");
      electron.kill("SIGTERM");
      setTimeout(() => {
        if (!electron.killed) electron.kill("SIGKILL");
      }, 3000);
    }
  }

  const onSignal = (sig) => {
    log(`Received ${sig}; cleaning up.`);
    cleanup();
    flushLog();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    await waitForCdp();
    log("CDP is ready. Spawning Claude Agent SDK session with chrome-devtools MCP...");

    const prompt = [
      "You are a QA agent driving a desktop email application via the chrome-devtools MCP.",
      "",
      "Do exactly this:",
      "1. Call mcp__chrome-devtools__list_pages to see what tabs/windows are open.",
      "2. Pick the page that looks like the main app window — skip DevTools, chrome-error, blank pages, and any chrome:// URLs. Call mcp__chrome-devtools__select_page on it.",
      "3. Call mcp__chrome-devtools__take_snapshot to capture the current accessibility tree.",
      "4. Find any visible clickable element (button, tab, link, or interactive element with a uid in the snapshot). Click it with mcp__chrome-devtools__click.",
      "5. Call mcp__chrome-devtools__take_snapshot again to confirm something changed.",
      "",
      "Then in plain text describe what you observed and ended on. End your message with the literal token SPIKE_PASS if you successfully clicked something, or SPIKE_FAIL: <reason> otherwise.",
    ].join("\n");

    const result = query({
      prompt,
      options: {
        model: "claude-sonnet-4-6",
        maxTurns: 20,
        maxBudgetUsd: 1,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: {
          "chrome-devtools": {
            type: "stdio",
            command: "npx",
            args: ["-y", "chrome-devtools-mcp@latest", `--browser-url=${CDP_URL}`],
          },
        },
      },
    });

    const toolCalls = [];
    const textOut = [];
    let resultMeta = null;

    for await (const msg of result) {
      if (msg.type === "system" && msg.subtype === "init") {
        log(
          `Session initialized. Tools available: ${(msg.tools ?? []).filter((t) => t.startsWith("mcp__chrome-devtools__")).join(", ") || "(no chrome-devtools tools detected)"}`,
        );
      }
      if (msg.type === "assistant") {
        for (const block of msg.message.content ?? []) {
          if (block.type === "tool_use") {
            toolCalls.push(block.name);
            log(`tool_use: ${block.name}`);
          } else if (block.type === "text" && block.text) {
            textOut.push(block.text);
            log(`assistant text: ${block.text.replace(/\n/g, " ").slice(0, 160)}`);
          }
        }
      }
      if (msg.type === "result") {
        resultMeta = msg;
        log(
          `result: subtype=${msg.subtype} cost_usd=${msg.total_cost_usd ?? "?"} turns=${msg.num_turns ?? "?"} duration_ms=${msg.duration_ms ?? "?"}`,
        );
      }
    }

    const finalText = textOut.join("\n");
    const requiredCalls = ["list_pages", "select_page", "click"];
    const hasAllRequired = requiredCalls.every((req) =>
      toolCalls.some((t) => t.endsWith(`__${req}`) || t === req),
    );
    const sawSnapshotOrScreenshot = toolCalls.some((t) => /(snapshot|screenshot)/.test(t));
    const explicitPass = finalText.includes("SPIKE_PASS");
    const explicitFail = finalText.includes("SPIKE_FAIL");

    log("==========================================");
    log(`tool_calls=${JSON.stringify(toolCalls)}`);
    log(`final_text=${finalText.replace(/\n/g, " ").slice(0, 500)}`);
    log(
      `verdict_inputs: hasAllRequired=${hasAllRequired} sawSnapshotOrScreenshot=${sawSnapshotOrScreenshot} explicitPass=${explicitPass} explicitFail=${explicitFail}`,
    );
    log("==========================================");

    cleanup();

    if (explicitFail || !hasAllRequired || !sawSnapshotOrScreenshot) {
      log("VERDICT: SPIKE FAIL");
      log(`  required tools (any of): ${requiredCalls.join(", ")} + snapshot/screenshot`);
      log(`  observed: ${toolCalls.join(", ") || "(none)"}`);
      flushLog();
      console.log(`\n❌ SPIKE FAIL — see ${LOG_PATH}`);
      process.exit(2);
    }

    if (explicitPass || hasAllRequired) {
      log("VERDICT: SPIKE PASS");
      flushLog();
      console.log(`\n✅ SPIKE PASS — SDK + chrome-devtools MCP can drive Electron`);
      console.log(`   Cost: $${resultMeta?.total_cost_usd?.toFixed(4) ?? "?"} / Turns: ${resultMeta?.num_turns ?? "?"}`);
      console.log(`   Log: ${LOG_PATH}`);
      process.exit(0);
    }

    log("VERDICT: INCONCLUSIVE — treating as fail");
    flushLog();
    console.log(`\n⚠️  SPIKE INCONCLUSIVE — see ${LOG_PATH}`);
    process.exit(3);
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
    cleanup();
    flushLog();
    console.error(`\n💥 SPIKE FATAL — see ${LOG_PATH}`);
    process.exit(1);
  }
}

main();
