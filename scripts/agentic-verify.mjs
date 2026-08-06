#!/usr/bin/env node
/**
 * Agentic feature verification driver.
 *
 * Spawns an LLM agent (claude-agent-sdk) that drives the running
 * Electron app via the chrome-devtools MCP and writes a structured
 * report. Two modes:
 *
 *   --mode=verify-diff  : diff-scoped — reads `git diff origin/main..HEAD`,
 *                         substitutes into the feature-brief template,
 *                         agent verifies the affected flow works.
 *   --mode=explore      : open-ended exploration — agent wanders the
 *                         app looking for anything broken.
 *
 * The agent uses ONLY the chrome-devtools MCP for app interaction.
 * No file access, no bash, no shell — sandboxed by tool whitelist.
 *
 * Local-only. Never CI. Requires ANTHROPIC_API_KEY (loaded from
 * .env.local).
 *
 * Usage:
 *   node scripts/agentic-verify.mjs --mode=verify-diff
 *   node scripts/agentic-verify.mjs --mode=explore --action-budget=100 --budget-usd=2
 *
 * Writes a report to scripts/.agentic-runs/<timestamp>-<mode>.{md,json}.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractFinalJson, summarizeToolCalls, renderReportMd } from "./lib/agentic-helpers.mjs";

/**
 * Find an available TCP port in [9223, 9999]. Skips 9222 by default
 * because Chrome's remote-debug port is commonly 9222 and would conflict.
 * Tries up to 20 ports starting from `start`.
 */
async function findFreePort(start = 9223, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const candidate = start + i;
    const ok = await new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      try {
        server.listen(candidate, "127.0.0.1");
      } catch {
        resolve(false);
      }
    });
    if (ok) return candidate;
  }
  throw new Error(`No free port in [${start}, ${start + attempts}]`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ============================================================
// .env.local loader (avoid adding dotenv as a dep)
// ============================================================

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(join(REPO_ROOT, ".env.local"));
loadEnvFile(join(REPO_ROOT, ".env"));

// ============================================================
// Args
// ============================================================

const args = process.argv.slice(2);
function flag(name, defaultValue = null) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return defaultValue;
}

const MODE = flag("mode", "verify-diff");
// --data=auto|real|demo
//   auto  : real-mode-first (the default). Real mode is used unless the
//           ENTIRE diff matches DATA_DEMO_SAFE_PATTERNS (docs/tests/
//           scripts/config — provably non-behavioral), in which case demo
//           is used. Any behavioral file in the diff → real.
//   real  : force real mode (uses .dev-data/ tokens for the test account
//           and sets EXO_DISABLE_PREFETCH so we don't burn API spend on
//           background analysis).
//   demo  : force demo mode. Hermetic, no real Gmail.
const DATA_MODE_RAW = flag("data", "auto");
const ACTION_BUDGET = Number(flag("action-budget", MODE === "explore" ? 100 : 40));
const BUDGET_USD = Number(flag("budget-usd", MODE === "explore" ? 2 : 0.5));
const TIMEOUT_MS = Number(flag("timeout-ms", 10 * 60 * 1000));
// CDP_PORT defaults to "auto" — pick a free port at runtime so we don't
// clash with a running Chrome (which often holds 9222). User can pin
// via --cdp-port=<N>. Resolved later in main() once we can await.
const CDP_PORT_RAW = flag("cdp-port", "auto");
let CDP_PORT = CDP_PORT_RAW === "auto" ? 0 : Number(CDP_PORT_RAW);
let CDP_URL = CDP_PORT ? `http://127.0.0.1:${CDP_PORT}` : "";

if (!["verify-diff", "explore"].includes(MODE)) {
  console.error(`Unknown mode: ${MODE}. Use --mode=verify-diff or --mode=explore.`);
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`ANTHROPIC_API_KEY is required. Put it in .env.local (see .env.local.example).`);
  process.exit(1);
}

// ============================================================
// Paths
// ============================================================

const RUNS_DIR = join(__dirname, ".agentic-runs");
mkdirSync(RUNS_DIR, { recursive: true });
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_BASE = join(RUNS_DIR, `${TIMESTAMP}-${MODE}`);
const LOG_PATH = `${REPORT_BASE}.log`;
const REPORT_MD = `${REPORT_BASE}.md`;
const REPORT_JSON = `${REPORT_BASE}.json`;

const logLines = [];
function log(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  console.log(entry);
  logLines.push(entry);
}
function flushLog() {
  writeFileSync(LOG_PATH, logLines.join("\n") + "\n");
}

// ============================================================
// Diff (verify-diff mode only)
// ============================================================

function gitDiffSummary() {
  try {
    const base = execSync("git merge-base origin/main HEAD", { cwd: REPO_ROOT }).toString().trim();
    const files = execSync(`git diff --name-only ${base}..HEAD`, { cwd: REPO_ROOT })
      .toString()
      .trim();
    const stat = execSync(`git diff --shortstat ${base}..HEAD`, { cwd: REPO_ROOT })
      .toString()
      .trim();
    const patch = execSync(`git diff --no-ext-diff --unified=40 ${base}..HEAD`, {
      cwd: REPO_ROOT,
      maxBuffer: 1024 * 1024 * 8,
    }).toString();
    return {
      base,
      files: files || "(none)",
      shortstat: stat || "(no changes)",
      patch: truncateForPrompt(patch || "(no patch)", 30_000),
    };
  } catch (err) {
    return {
      base: "(unknown)",
      files: "(diff failed)",
      shortstat: `diff failed: ${err instanceof Error ? err.message : String(err)}`,
      patch: "(diff failed)",
    };
  }
}

function truncateForPrompt(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} characters]`;
}

/**
 * Files whose changes are unambiguously non-behavioral — docs, tests,
 * scripts, infra config, type-only declarations. If the ENTIRE diff
 * matches these patterns, demo mode is safe. Anything else routes to
 * the real test Gmail account.
 *
 * The default flipped on 2026-05-27: previously the router defaulted
 * to demo and only escalated to real for an allowlist of "risky" service
 * files. That left almost every behavioral change running against
 * curated demo fixtures, which can't expose agent runtimes, real Gmail
 * threading quirks, or auth/token paths. The whole reason the
 * `exoemailtest@gmail.com` test account exists is so agentic
 * verification can hit real Gmail-shaped state — making demo the
 * default defeats that.
 */
const DATA_DEMO_SAFE_PATTERNS = [
  /^docs\//,
  /^tests\//,
  /^scripts\//,
  /^benchmarks\//,
  /^\.github\//,
  /^\.claude\//,
  /\.md$/,
  /^CHANGELOG/,
  /^README/,
  /^LICENSE/,
  /^TODOS/,
  /^CONTRIBUTING/,
  /^\.gitignore$/,
  /^\.prettierrc/,
  /^\.editorconfig$/,
  /^eslint\.config\./,
  /^prettier\.config\./,
  /^postcss\.config\./,
  /^tailwind\.config\./,
  /^playwright.*\.config\./,
  /^vite\.[^/]*\.config\./,
  /^electron-vite\.config\./,
  /^tsconfig[^/]*\.json$/,
  /^package(-lock)?\.json$/,
  /^src\/shared\/types\.ts$/,
];

/**
 * Decide whether the agent should run against the real test account
 * or demo data, given the changed files and the user's explicit flag.
 *
 * Real-mode-first: if ANY changed file is not in the demo-safe
 * allowlist, we run against the real test Gmail account. Demo mode is
 * only used when the diff is provably non-behavioral (docs, tests,
 * scripts, config). The test account exists for this; using demo by
 * default wastes that infrastructure and produces false-pass verdicts
 * for anything that depends on real Gmail or real agent execution.
 */
function resolveDataMode(rawFlag, changedFiles) {
  if (rawFlag === "real" || rawFlag === "demo") return rawFlag;
  if (changedFiles.length === 0) {
    return { mode: "demo", reason: "no diff" };
  }
  const behavioral = changedFiles.filter((f) => !DATA_DEMO_SAFE_PATTERNS.some((p) => p.test(f)));
  if (behavioral.length === 0) {
    return {
      mode: "demo",
      reason: "diff is docs/tests/scripts/config only — no runtime surface to exercise",
    };
  }
  // Truncate the reason if many files changed — keeps the log readable.
  const sample = behavioral.slice(0, 5).join(", ");
  const suffix = behavioral.length > 5 ? `, +${behavioral.length - 5} more` : "";
  return {
    mode: "real",
    reason: `diff touches behavioral code (${sample}${suffix}) — running against test account`,
  };
}

function headSha() {
  try {
    // Pin abbreviation length to 7 to match the CI side (see pre-pr.mjs).
    return execSync("git rev-parse --short=7 HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "(unknown)";
  }
}

// ============================================================
// Prompt assembly
// ============================================================

function loadPrompt(mode) {
  const path =
    mode === "verify-diff"
      ? join(__dirname, "agentic-verify-prompts", "feature-brief.md")
      : join(__dirname, "agentic-verify-prompts", "exploration-rubric.md");
  return readFileSync(path, "utf8");
}

function fillTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
}

// ============================================================
// Electron lifecycle
// ============================================================

// Default 3 min — first-run cold electron-vite builds can take 1-2 min
// to produce a CDP-listening main process after `npx electron-vite dev`
// returns. Previous 30s default consistently flaked on cold caches.
async function waitForCdp(timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Bound each fetch independently — without a per-fetch signal,
    // `fetch` can hang for the full Node default if Electron has the
    // socket bound but isn't yet responding (cold CDP init). One
    // hanging fetch would consume the entire `timeoutMs` budget and
    // produce a misleading "not ready after Nms" error where N is
    // the configured budget, not the actual elapsed wall time.
    const controller = new AbortController();
    const fetchAbort = setTimeout(() => controller.abort(), 2_000);
    try {
      const r = await fetch(`${CDP_URL}/json/version`, { signal: controller.signal });
      if (r.ok) return;
    } catch {
      // not ready / aborted — keep polling
    } finally {
      clearTimeout(fetchAbort);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  const actualMs = Date.now() - start;
  throw new Error(`CDP at ${CDP_URL} not ready after ${actualMs}ms (budget ${timeoutMs}ms)`);
}

function launchElectron(dataMode) {
  // In `real` mode: don't set EXO_DEMO_MODE — the app boots against the
  // test account using .dev-data/ tokens. Set EXO_DISABLE_PREFETCH so
  // the agent's run doesn't trigger background Claude analysis on every
  // seeded email (would burn $$).
  //
  // EXO_HEADLESS=true suppresses the visible BrowserWindow (src/main/window.ts
  // creates it with `show: false` and skips the `ready-to-show` `.show()` call).
  // CDP and IPC still work, so the chrome-devtools MCP agent is unaffected —
  // the window just never paints, so pre-pr runs don't steal focus.
  const launchEnv =
    dataMode === "real"
      ? {
          ...process.env,
          EXO_DEMO_MODE: "",
          EXO_DISABLE_PREFETCH: "true",
          EXO_HEADLESS: "true",
        }
      : { ...process.env, EXO_DEMO_MODE: "true", EXO_HEADLESS: "true" };
  log(`Launching Electron in ${dataMode} mode with --remote-debugging-port=${CDP_PORT}...`);
  // `detached: true` makes the child the leader of a new process group.
  // We can then signal the whole tree at once via `process.kill(-pid, ...)`.
  // Without this, killing the npx wrapper leaves electron-vite and Electron
  // (and Electron's GPU/network/renderer helpers) orphaned — historically
  // we've leaked dozens of these from aborted pre-pr / agentic-verify runs.
  const electron = spawn(
    "npx",
    ["electron-vite", "dev", "--", `--remote-debugging-port=${CDP_PORT}`],
    {
      env: launchEnv,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
      detached: true,
    },
  );
  electron.stdout.on("data", (d) =>
    process.stderr.write(`[electron] ${d.toString().split("\n")[0]}\n`),
  );
  electron.stderr.on("data", (d) =>
    process.stderr.write(`[electron-err] ${d.toString().split("\n")[0]}\n`),
  );
  return electron;
}

/**
 * Kill the entire Electron process group. Returns a promise that resolves
 * once the leader has actually exited (or after a hard SIGKILL deadline),
 * so the caller can safely process.exit() without leaving children behind.
 */
function killElectron(electron) {
  return new Promise((resolve) => {
    const pid = electron.pid;
    if (!pid || electron.exitCode !== null || electron.signalCode !== null) {
      resolve();
      return;
    }

    let exited = false;
    const onExit = () => {
      if (exited) return;
      exited = true;
      resolve();
    };
    electron.once("exit", onExit);
    electron.once("close", onExit);

    // Signal the whole process group (negative pid). electron-vite spawns
    // Electron, which spawns helpers — they all need to die together.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        electron.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }

    const sigkillTimer = setTimeout(() => {
      if (exited) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          electron.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 3000);

    // Hard deadline: even if SIGKILL didn't take, give up and let the
    // OS reap. We've at least requested the kill.
    const giveUpTimer = setTimeout(onExit, 6000);

    electron.once("exit", () => {
      clearTimeout(sigkillTimer);
      clearTimeout(giveUpTimer);
    });
  });
}

/**
 * Synchronous best-effort kill, for `process.on("exit", ...)` — Node's
 * exit event doesn't await async work, so we can't `await killElectron`
 * there. This sends SIGKILL to the process group as a last resort.
 */
function killElectronSync(electron) {
  const pid = electron?.pid;
  if (!pid) return;
  if (electron.exitCode !== null || electron.signalCode !== null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      electron.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const sha = headSha();

  // Resolve CDP port lazily so we can pick a free one if the user didn't pin.
  if (CDP_PORT === 0) {
    CDP_PORT = await findFreePort(9223);
    CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
    log(`Auto-selected CDP port: ${CDP_PORT}`);
  } else {
    CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
  }

  log(`mode=${MODE} sha=${sha} action_budget=${ACTION_BUDGET} budget_usd=${BUDGET_USD}`);

  // Resolve data mode (real vs demo) from the diff + the user's flag.
  // In explore mode, default to demo since there's no diff to consult.
  const diffForMode = MODE === "verify-diff" ? gitDiffSummary() : { files: "" };
  const changedList =
    diffForMode.files && diffForMode.files !== "(none)" && diffForMode.files !== "(diff failed)"
      ? diffForMode.files.split("\n").filter(Boolean)
      : [];
  const dataResolution = resolveDataMode(DATA_MODE_RAW, changedList);
  const dataMode = typeof dataResolution === "string" ? dataResolution : dataResolution.mode;
  if (typeof dataResolution === "object") {
    log(`data mode: ${dataResolution.mode} (${dataResolution.reason})`);
  } else {
    log(`data mode: ${dataResolution} (forced via --data)`);
  }

  let prompt;
  if (MODE === "verify-diff") {
    const diff = diffForMode;
    if (diff.files === "(none)" || diff.files === "(diff failed)") {
      log(
        `No diff vs origin/main detected (base=${diff.base}). verify-diff has nothing to scope — bailing.`,
      );
      const report = {
        mode: MODE,
        sha,
        verdict: "skipped",
        summary: "No diff vs origin/main — nothing to verify.",
        anomalies: [],
        actions: 0,
        cost_usd: 0,
      };
      writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
      writeFileSync(REPORT_MD, renderReportMd(report));
      flushLog();
      console.log(`\nSKIPPED — see ${REPORT_MD}`);
      process.exit(0);
    }
    log(`diff base=${diff.base} ${diff.shortstat}`);
    log(`changed files:\n${diff.files}`);
    const template = loadPrompt("verify-diff");
    prompt = fillTemplate(template, {
      DIFF_SUMMARY: diff.shortstat,
      DIFF_PATCH: diff.patch,
      CHANGED_FILES: diff.files,
      DATA_MODE: dataMode,
      ACTION_BUDGET,
      BUDGET_USD,
    });
  } else {
    const template = loadPrompt("explore");
    prompt = fillTemplate(template, { DATA_MODE: dataMode, ACTION_BUDGET, BUDGET_USD });
  }

  const electron = launchElectron(dataMode);
  let killed = false;
  async function cleanup() {
    if (killed) return;
    killed = true;
    await killElectron(electron);
  }

  // Register cleanup on every plausible exit path. Historically only
  // SIGINT was handled, so Ctrl-C-from-pre-pr, SIGTERM from a parent,
  // SIGHUP on terminal close, and uncaught exceptions all leaked the
  // Electron process tree.
  //
  // Signal handlers exit SYNCHRONOUSLY with the signal's exit code.
  // If we awaited cleanup() here, the main `for await` loop would keep
  // running concurrently — Electron's death tears down CDP, the agent
  // SDK finishes naturally, and the normal-completion path's
  // `process.exit(0/2/3)` would race ahead and replace the signal exit
  // code. Kicking the async kill is fire-and-forget; the sync
  // `on("exit", killElectronSync)` below sends SIGKILL to the whole
  // process group, which the kernel delivers regardless of our state.
  function installExitHandlers() {
    const onSignal = (signal, exitCode) => () => {
      log(signal);
      killElectron(electron).catch(() => {});
      flushLog();
      process.exit(exitCode);
    };
    process.once("SIGINT", onSignal("SIGINT", 130));
    process.once("SIGTERM", onSignal("SIGTERM", 143));
    process.once("SIGHUP", onSignal("SIGHUP", 129));
    process.once("uncaughtException", (err) => {
      log(`uncaughtException: ${err instanceof Error ? err.stack : String(err)}`);
      killElectron(electron).catch(() => {});
      flushLog();
      process.exit(1);
    });
    process.once("unhandledRejection", (reason) => {
      log(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
      killElectron(electron).catch(() => {});
      flushLog();
      process.exit(1);
    });
    // Last-resort synchronous cleanup. Runs even if something else
    // calls process.exit() without going through cleanup() first.
    process.once("exit", () => killElectronSync(electron));
  }
  installExitHandlers();

  // Synchronous exit for the same reason as the signal handlers above:
  // we can't `await` here without letting the main loop race to a
  // different exit code. The sync on("exit") fallback handles cleanup.
  const timeout = setTimeout(() => {
    log(`hard timeout after ${TIMEOUT_MS}ms`);
    killElectron(electron).catch(() => {});
    flushLog();
    process.exit(124);
  }, TIMEOUT_MS);

  try {
    await waitForCdp();
    log("CDP ready. Spawning agent...");

    const result = query({
      prompt,
      options: {
        model: "claude-sonnet-4-6",
        maxTurns: ACTION_BUDGET,
        maxBudgetUsd: BUDGET_USD,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: {
          "chrome-devtools": {
            type: "stdio",
            command: "npx",
            args: ["-y", "chrome-devtools-mcp@1.0.1", `--browser-url=${CDP_URL}`],
          },
        },
      },
    });

    const toolCalls = [];
    const textChunks = [];
    let resultMeta = null;
    // Per-tool-call cap so a single huge `take_snapshot` (which dumps
    // the entire DOM) can't bloat the log file. The PR comment trims
    // again at body-size scale; this cap keeps individual entries
    // human-readable while preserving the bulk of the trace.
    const TOOL_RESULT_LOG_CAP = 4000;
    let toolIndex = 0;
    const toolIdToIndex = new Map();

    function formatToolInput(input) {
      try {
        const s = JSON.stringify(input);
        return s.length > 800 ? s.slice(0, 800) + " …[truncated]" : s;
      } catch {
        return String(input);
      }
    }

    function extractToolResultText(block) {
      const c = block.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((part) => (typeof part?.text === "string" ? part.text : JSON.stringify(part)))
          .join("\n");
      }
      return JSON.stringify(c ?? "");
    }

    for await (const msg of result) {
      if (msg.type === "system" && msg.subtype === "init") {
        const cdpTools = (msg.tools ?? []).filter((t) => t.startsWith("mcp__chrome-devtools__"));
        log(`session init — chrome-devtools tools: ${cdpTools.length}`);
      }
      if (msg.type === "assistant") {
        for (const block of msg.message.content ?? []) {
          if (block.type === "tool_use") {
            toolIndex += 1;
            toolCalls.push({ name: block.name, input: block.input });
            if (block.id) toolIdToIndex.set(block.id, toolIndex);
            log(`tool#${toolIndex}: ${block.name}`);
            log(`  input: ${formatToolInput(block.input)}`);
          } else if (block.type === "text" && block.text) {
            textChunks.push(block.text);
            log(`text: ${block.text}`);
          }
        }
      }
      if (msg.type === "user") {
        for (const block of msg.message.content ?? []) {
          if (block.type === "tool_result") {
            const idx = toolIdToIndex.get(block.tool_use_id) ?? "?";
            const tag = block.is_error ? "error" : "result";
            const text = extractToolResultText(block);
            const capped =
              text.length > TOOL_RESULT_LOG_CAP
                ? text.slice(0, TOOL_RESULT_LOG_CAP) +
                  ` …[truncated, ${text.length - TOOL_RESULT_LOG_CAP} more chars]`
                : text;
            // Indent multi-line output so it's visually grouped with
            // the tool call in the log.
            const indented = capped
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n");
            log(`${tag}#${idx}:\n${indented}`);
          }
        }
      }
      if (msg.type === "result") {
        resultMeta = msg;
        log(
          `result: subtype=${msg.subtype} cost=${msg.total_cost_usd ?? "?"} turns=${msg.num_turns ?? "?"}`,
        );
        // The result message is terminal by contract, but the SDK stream can
        // stay open past it (observed with error_max_turns: the run sat until
        // the 10-minute hard timeout, exit 124, and no report was written —
        // which also left the Electron child alive to poison the next pre-pr
        // phase). Break so cleanup + report happen promptly.
        break;
      }
    }

    clearTimeout(timeout);
    await cleanup();

    const finalText = textChunks.join("\n\n");
    const parsed = extractFinalJson(finalText);

    const report = {
      mode: MODE,
      sha,
      verdict: parsed?.verdict ?? "inconclusive",
      summary: parsed?.summary ?? finalText.slice(0, 1000),
      anomalies: parsed?.anomalies ?? [],
      actions: toolCalls.length,
      tool_calls_summary: summarizeToolCalls(toolCalls),
      cost_usd: resultMeta?.total_cost_usd ?? null,
      turns: resultMeta?.num_turns ?? null,
      duration_ms: resultMeta?.duration_ms ?? null,
      raw_final_text: finalText,
    };

    writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
    writeFileSync(REPORT_MD, renderReportMd(report));
    flushLog();

    console.log(`\nverdict: ${report.verdict}`);
    console.log(`anomalies: ${report.anomalies.length}`);
    console.log(`actions: ${report.actions}`);
    console.log(`cost: $${(report.cost_usd ?? 0).toFixed(4)}`);
    console.log(`report: ${REPORT_MD}`);

    // Exit codes:
    //   0 = clean / pass
    //   2 = anomalies found / fail verdict
    //   3 = inconclusive
    if (report.verdict === "fail" || report.anomalies.some((a) => a.severity === "high")) {
      process.exit(2);
    } else if (report.verdict === "inconclusive") {
      process.exit(3);
    }
    process.exit(0);
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
    clearTimeout(timeout);
    await cleanup();
    flushLog();
    console.error(`\nFATAL — see ${LOG_PATH}`);
    process.exit(1);
  }
}

main();
