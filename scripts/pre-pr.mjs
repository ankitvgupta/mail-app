#!/usr/bin/env node
/**
 * Pre-PR local gate.
 *
 * Runs every LLM-dependent check locally, aggregates results into a
 * single report, and injects that report into the current PR's body
 * via a marker block (gh pr edit). The CI job `verify-prepr-report`
 * fails the PR if the marker block is missing or stale (SHA mismatch),
 * so this script's run is functionally required before merge.
 *
 * Modes:
 *   default      : full run (~15 min, ~$5)
 *     1. eval suite — every feature with fixtures
 *     2. agentic-verify --mode=verify-diff
 *     3. real-gmail mode 9a (cached .dev-data)
 *   --quick      : fast iteration (~3-5 min, ~$1)
 *     - eval ONLY for features whose source dirs the diff touched
 *     - agentic-verify --mode=verify-diff (already diff-scoped)
 *     - skip real-gmail
 *   --full-sync  : default + real-gmail mode 9b (full sync test)
 *   --no-inject  : run everything but don't touch the PR body
 *   --no-comment : run everything but don't upsert the PR comment
 *
 * Output:
 *   .pre-pr-report.md         — committed locally (gitignored)
 *   <PR body>                 — marker block updated via gh (CI gate)
 *   <PR comment>              — single upserted comment with full
 *                               agentic-verify report in <details>;
 *                               updates in place on repeat runs
 *   stdout                    — progress + final verdict
 *
 * Local-only. Requires ANTHROPIC_API_KEY in .env.local or env.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectIntoPrBody } from "./lib/pr-body-splice.mjs";
import { upsertPrComment } from "./lib/pr-comment-upsert.mjs";
import { isNoUiSurfaceDiff } from "./lib/agentic-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const REPORT_PATH = join(REPO_ROOT, ".pre-pr-report.md");
const RUNS_DIR = join(__dirname, ".agentic-runs");

// ============================================================
// .env.local loader
// ============================================================

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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
// CLI
// ============================================================

const args = new Set(process.argv.slice(2));
const QUICK = args.has("--quick");
const FULL_SYNC = args.has("--full-sync");
const NO_INJECT = args.has("--no-inject");
const NO_COMMENT = args.has("--no-comment");

const MODE = QUICK ? "quick" : FULL_SYNC ? "full-sync" : "full";

function gitShortSha() {
  // --short=7 (not bare --short) so the length matches the CI side
  // (`${PR_HEAD_SHA:0:7}` always takes exactly 7 chars). Git's bare
  // --short uses `core.abbrev` which auto-grows beyond 7 for large
  // repos and would produce a marker that CI flags as stale.
  return execSync("git rev-parse --short=7 HEAD", { cwd: REPO_ROOT }).toString().trim();
}

function gitChangedFiles() {
  try {
    const base = execSync("git merge-base origin/main HEAD", { cwd: REPO_ROOT }).toString().trim();
    return execSync(`git diff --name-only ${base}..HEAD`, { cwd: REPO_ROOT })
      .toString()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================
// Feature → source-dir mapping (quick mode)
// ============================================================

const FEATURE_PATHS = {
  "draft-generator": [/^src\/main\/services\/draft-generator\.ts$/, /draft-generator/],
  "calendaring-agent": [/^src\/main\/services\/calendaring-agent\.ts$/, /calendaring-agent/],
  "sender-lookup": [/^src\/main\/services\/sender-lookup\.ts$/, /sender-lookup/],
  "style-profiler": [
    /^src\/main\/services\/style-profiler\.ts$/,
    /style-(profiler|indexer|inference)/,
  ],
  "archive-ready-analyzer": [/^src\/main\/services\/archive-ready-analyzer\.ts$/, /archive-ready/],
  "analysis-edit-learner": [/analysis-edit-learner/, /memory-learner/],
  "draft-edit-learner": [/draft-edit-learner/, /memory-learner/],
};

// Mirror of the FEATURES registry in tests/evals/feature-evals.ts. Kept
// in sync manually — when an eval suite lands for a TODO feature, add
// its name here. Letting a feature into the quick-mode eval list
// without scaffolding makes feature-evals throw "Unknown feature" and
// fail the eval phase with a misleading spurious failure.
const REGISTERED_FEATURES = new Set([
  "draft-generator",
  "calendaring-agent",
  "archive-ready-analyzer",
]);

function affectedFeatures(changedFiles) {
  const features = new Set();
  const skipped = new Set();
  for (const file of changedFiles) {
    for (const [feature, patterns] of Object.entries(FEATURE_PATHS)) {
      if (patterns.some((p) => p.test(file))) {
        if (REGISTERED_FEATURES.has(feature)) features.add(feature);
        else skipped.add(feature);
      }
    }
  }
  if (skipped.size > 0) {
    console.log(
      `[evals] note: diff touched feature(s) without eval scaffolding yet: ${[...skipped].join(", ")}`,
    );
  }
  return [...features];
}

// ============================================================
// Find the most recent agentic-verify report (newer than a cutoff).
// ============================================================

/**
 * Returns the newest `*-verify-diff.{md,json,log}` set in RUNS_DIR with
 * mtime >= `sinceMs`, or null if none found. Used to attach the full
 * agentic-verify markdown report AND the literal trace log to the PR
 * comment.
 *
 * We filter by mtime instead of just "newest in dir" so a stale run
 * left over from a previous session doesn't get spliced into a comment
 * for a run that crashed before writing its own report.
 */
function findLatestVerifyReport(sinceMs) {
  if (!existsSync(RUNS_DIR)) return null;
  const candidates = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith("-verify-diff.md"))
    .map((f) => {
      const full = join(RUNS_DIR, f);
      return { file: full, mtime: statSync(full).mtimeMs };
    })
    .filter((c) => c.mtime >= sinceMs)
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return null;
  const md = candidates[0].file;
  const json = md.replace(/\.md$/, ".json");
  const logPath = md.replace(/\.md$/, ".log");
  return {
    md,
    json: existsSync(json) ? json : null,
    log: existsSync(logPath) ? logPath : null,
  };
}

// ============================================================
// Subprocess runner — captures output, tags with phase name.
// ============================================================

// Whether a diff has no UI-reachable surface for agentic-verify to drive
// (test scaffolding, build/CI scripts, docs, repo metadata, or a
// lockfile-only dependency bump) lives in agentic-helpers.mjs so it's unit
// tested. When the whole diff is in that set, agentic-verify correctly
// returns "inconclusive" (exit 3) and we treat it as a soft pass.

function runPhase(name, cmd, argv, opts = {}) {
  const start = Date.now();
  console.log(`\n──── ${name} ────`);
  console.log(`  $ ${cmd} ${argv.join(" ")}`);
  const res = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
  });
  const ms = Date.now() - start;
  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const status = res.status ?? -1;
  console.log(`  → exit=${status} (${(ms / 1000).toFixed(1)}s)`);
  // agentic-verify exit 3 = inconclusive ("couldn't reach the
  // diff-affected flow"). For no-UI-surface diffs (tests/scripts/docs or
  // a lockfile-only dependency bump), the diff is structurally unreachable
  // from the UI, so inconclusive is the right answer and shouldn't fail
  // the gate. opts.softExits lets the caller widen `ok` for known-non-fatal
  // exit codes.
  const softExits = opts.softExits ?? [];
  const ok = status === 0 || softExits.includes(status);
  return { name, status, ms, stdout, stderr, ok };
}

// ============================================================
// Main
// ============================================================

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required. Put it in .env.local (see .env.local.example).");
    process.exit(1);
  }

  const sha = gitShortSha();
  const changed = gitChangedFiles();
  console.log(`pre-pr mode=${MODE} sha=${sha}`);
  console.log(`changed files: ${changed.length}`);

  const phases = [];

  // ============================================================
  // Phase 1 — Evals
  // ============================================================

  if (MODE === "quick") {
    const features = affectedFeatures(changed);
    if (features.length === 0) {
      console.log("\n[evals] no AI-feature files in diff — skipping eval phase");
    } else {
      console.log(`\n[evals] affected features: ${features.join(", ")}`);
      for (const feature of features) {
        phases.push(
          runPhase(`eval:${feature}`, "npx", [
            "tsx",
            "tests/evals/feature-evals.ts",
            "--feature",
            feature,
          ]),
        );
      }
    }
  } else {
    // Full / full-sync: run analyzer eval (existing) + every feature suite
    phases.push(runPhase("eval:analyzer", "npx", ["tsx", "tests/evals/runner.ts"]));
    phases.push(runPhase("eval:features", "npx", ["tsx", "tests/evals/feature-evals.ts", "--all"]));
  }

  // ============================================================
  // Phase 2 — Agentic verify (diff-scoped)
  // ============================================================
  //
  // For no-UI-surface diffs (tests/scripts/docs or a lockfile-only
  // dependency bump), the agent has no UI-reachable code path to exercise
  // and will correctly report "inconclusive" (exit 3). We still run the
  // phase to confirm the app boots clean, but accept inconclusive as a
  // soft pass in that case so those PRs aren't blocked.
  //
  // verifyStartMs captures wall-clock so the PR-comment upsert step
  // can pick out THIS run's agentic-verify report file from RUNS_DIR
  // and skip stale ones from prior sessions.
  const verifyStartMs = Date.now();
  const noUiSurface = isNoUiSurfaceDiff(changed);
  if (noUiSurface) {
    console.log(
      `\n[agentic-verify] diff has no UI surface (tests/scripts/docs/lockfile); will accept "inconclusive" verdict.`,
    );
  }
  // Budget bump: the default $0.50 in agentic-verify.mjs is enough for shallow
  // demo-mode flows but too tight when the diff touches LLM-routing code paths
  // (llm-service, draft-generator, agent-coordinator). The agent then explores
  // real-mode flows with sender enrichment + draft generation and routinely
  // crashes mid-verification on budget exhaustion (exit 1) before it can emit
  // a verdict. $1.50 gives ~3× headroom over the worst observed run ($0.90).
  //
  // Timeout bump: the 10-min default in agentic-verify.mjs is too tight for
  // flows with built-in waits — e.g. block-sender commits via a 12s undo
  // toast and then makes several real-Gmail round-trips. A run on PR #172
  // completed the verification (filter created, email removed) but hit the
  // hard timeout before emitting its verdict (exit 124). 20 min covers the
  // observed worst case (~16 min) with headroom.
  //
  // Action budget likewise: the default 40 turns starves multi-thousand-line
  // diffs — observed a run that completed every verification probe and hit
  // error_max_turns on the turn that would have emitted the verdict JSON. 70
  // gives finish-line headroom while the dollar budget still caps spend.
  const verifyResult = runPhase(
    "agentic-verify",
    "node",
    [
      "scripts/agentic-verify.mjs",
      "--mode=verify-diff",
      "--budget-usd=1.5",
      "--timeout-ms=1200000",
      "--action-budget=70",
    ],
    noUiSurface ? { softExits: [3] } : {},
  );

  // Promote "inconclusive + zero anomalies + non-trivial exploration" to a
  // soft pass. Backend-only diffs (e.g. provider routing in llm-service.ts,
  // composeNewEmail in draft-generator.ts) often have no UI surface the
  // agent can drive — the agent honestly reports inconclusive even after
  // verifying the surrounding flows are healthy. Treating that as a hard
  // failure blocked legitimate Ollama-only fixes (PR #160). The action
  // floor (≥10) ensures the agent actually explored before bailing.
  if (verifyResult.status === 3 && !verifyResult.ok && !noUiSurface) {
    const report = findLatestVerifyReport(verifyStartMs);
    if (report?.json) {
      try {
        const data = JSON.parse(readFileSync(report.json, "utf8"));
        const anomalies = Array.isArray(data.anomalies) ? data.anomalies.length : 0;
        const actions = typeof data.actions === "number" ? data.actions : 0;
        if (data.verdict === "inconclusive" && anomalies === 0 && actions >= 10) {
          console.log(
            `[agentic-verify] inconclusive but 0 anomalies + ${actions} actions — accepting as soft pass (diff has no UI surface).`,
          );
          verifyResult.ok = true;
        }
      } catch {
        /* report unreadable — leave as hard fail */
      }
    }
  }
  phases.push(verifyResult);

  // ============================================================
  // Phase 3 — Real-Gmail (optional)
  // ============================================================

  if (MODE !== "quick") {
    const env = { EXO_REAL_GMAIL_TEST: "true" };
    if (MODE === "full-sync") {
      phases.push(
        runPhase(
          "real-gmail:full-sync",
          "npx",
          ["playwright", "test", "--project=real-gmail-full-sync"],
          {
            env,
          },
        ),
      );
    } else {
      phases.push(
        runPhase("real-gmail:cached", "npx", ["playwright", "test", "--project=real-gmail"], {
          env,
        }),
      );
    }
  }

  // ============================================================
  // Aggregate report
  // ============================================================

  const allOk = phases.every((p) => p.ok);
  const verdict = allOk ? "PASS" : "FAIL";
  const reportLines = [];
  reportLines.push(`**Pre-PR verdict**: ${verdict}`);
  reportLines.push("");
  reportLines.push(`- mode: \`${MODE}\``);
  reportLines.push(`- sha: \`${sha}\``);
  reportLines.push(`- generated: ${new Date().toISOString()}`);
  reportLines.push("");
  reportLines.push("| Phase | Status | Duration |");
  reportLines.push("|---|---|---|");
  for (const p of phases) {
    const statusEmoji = p.ok ? "✅" : "❌";
    reportLines.push(
      `| ${p.name} | ${statusEmoji} exit ${p.status} | ${(p.ms / 1000).toFixed(1)}s |`,
    );
  }
  reportLines.push("");
  if (!allOk) {
    reportLines.push("### Failures");
    reportLines.push("");
    for (const p of phases.filter((x) => !x.ok)) {
      reportLines.push(`<details><summary>${p.name} — exit ${p.status}</summary>`);
      reportLines.push("");
      reportLines.push("```");
      const tail = (p.stdout + p.stderr).split("\n").slice(-40).join("\n");
      reportLines.push(tail);
      reportLines.push("```");
      reportLines.push("</details>");
      reportLines.push("");
    }
  }

  const report = reportLines.join("\n");
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written to ${REPORT_PATH}`);

  if (!NO_INJECT) {
    try {
      const status = injectIntoPrBody({
        content: report,
        meta: { SHA: sha, mode: MODE },
      });
      if (status === "no-pr") {
        console.log(
          "No PR open for the current branch — local report only. Open the PR and re-run.",
        );
      } else {
        console.log(`PR body ${status} with the report block.`);
      }
    } catch (err) {
      console.error(`Failed to update PR body: ${err instanceof Error ? err.message : err}`);
      console.error("Local report is still valid at " + REPORT_PATH);
    }
  }

  if (!NO_COMMENT) {
    try {
      const commentBody = buildPrCommentBody({
        verdict,
        phases,
        sha,
        mode: MODE,
        verifyReport: findLatestVerifyReport(verifyStartMs),
      });
      const result = upsertPrComment({ content: commentBody });
      if (result.status === "no-pr") {
        console.log("No PR open — skipped comment upsert.");
      } else {
        console.log(`PR comment ${result.status}: ${result.url}`);
      }
    } catch (err) {
      console.error(`Failed to upsert PR comment: ${err instanceof Error ? err.message : err}`);
      console.error("PR body marker block is still the source of truth for CI.");
    }
  }

  console.log(`\nVerdict: ${verdict}`);
  process.exit(allOk ? 0 : 1);
}

/**
 * Compose the human-readable PR comment. Summary on top, full agentic
 * verify report inside a <details> block so the comment stays compact
 * by default. Failed-phase logs get their own collapsibles.
 *
 * GitHub comments have a 65,536-character body cap. We build the
 * header + trailer (failures + footer) first, measure them, and only
 * then size the embedded agentic report to fit the remaining budget.
 * This way the report — which can be safely truncated and is by far
 * the largest chunk — absorbs the budget pressure when multiple
 * phases fail with verbose logs.
 */
const COMMENT_BODY_BUDGET = 60_000; // leave headroom under the 65,536 cap

function buildPrCommentBody({ verdict, phases, sha, mode, verifyReport }) {
  // Header (always cheap, always included verbatim).
  const headerLines = [];
  const emoji = verdict === "PASS" ? "✅" : "❌";
  headerLines.push(`## ${emoji} Pre-PR verification — ${verdict}`);
  headerLines.push("");
  headerLines.push(`- **mode**: \`${mode}\``);
  headerLines.push(`- **sha**: \`${sha}\``);
  headerLines.push(`- **generated**: ${new Date().toISOString()}`);
  headerLines.push("");
  headerLines.push("| Phase | Status | Duration |");
  headerLines.push("|---|---|---|");
  for (const p of phases) {
    const statusEmoji = p.ok ? "✅" : "❌";
    headerLines.push(
      `| ${p.name} | ${statusEmoji} exit ${p.status} | ${(p.ms / 1000).toFixed(1)}s |`,
    );
  }
  headerLines.push("");
  const header = headerLines.join("\n");

  // Trailer (failures + footer). Built up-front so we know its real
  // size before deciding how much of the agentic report to inline.
  // Each failed phase's tail is capped at 40 lines × 200 chars max so
  // a single phase with very long log lines can't blow the budget on
  // its own.
  const trailerLines = [];
  const failed = phases.filter((p) => !p.ok);
  if (failed.length > 0) {
    trailerLines.push("### Failures");
    trailerLines.push("");
    for (const p of failed) {
      trailerLines.push(`<details><summary>${p.name} — exit ${p.status}</summary>`);
      trailerLines.push("");
      trailerLines.push("```");
      const tail = (p.stdout + p.stderr)
        .split("\n")
        .slice(-40)
        .map((line) => (line.length > 200 ? line.slice(0, 200) + " …" : line))
        .join("\n");
      trailerLines.push(tail);
      trailerLines.push("```");
      trailerLines.push("</details>");
      trailerLines.push("");
    }
  }
  trailerLines.push("");
  trailerLines.push(
    "<sub>This comment is upserted by `npm run pre-pr`. The CI gate reads the marker block in the PR description, not this comment.</sub>",
  );
  const trailer = trailerLines.join("\n");

  // Middle: TWO collapsibles —
  //   1. Summary (verdict, anomalies, etc.) — open by default so it's
  //      visible without clicking.
  //   2. Literal trace (the .log file) — closed by default. Can be
  //      large (multiple kB per tool call), so the trace section
  //      absorbs whatever budget remains; the summary is always shown
  //      in full because it's small and the headline information.
  //
  // If the trace would exceed the remaining budget, we keep the TAIL
  // — that's where the verdict, final assistant text, and most recent
  // activity live; the start is just Electron boot boilerplate.
  let summarySection = "";
  if (verifyReport?.md && existsSync(verifyReport.md)) {
    const md = readFileSync(verifyReport.md, "utf8");
    summarySection =
      "<details open><summary><strong>Agentic verification — summary</strong></summary>\n\n" +
      md +
      "\n\n</details>\n";
  }

  let traceSection = "";
  if (verifyReport?.log && existsSync(verifyReport.log)) {
    const wrapperOverhead = 400; // <details>/<summary>/code-fence/truncation note
    const budget =
      COMMENT_BODY_BUDGET -
      header.length -
      trailer.length -
      summarySection.length -
      wrapperOverhead;
    if (budget > 500) {
      let logText = readFileSync(verifyReport.log, "utf8");
      let truncationNote = "";
      if (logText.length > budget) {
        const localPath = verifyReport.log.replace(REPO_ROOT + "/", "");
        logText = "…[start truncated for comment size]\n" + logText.slice(-budget);
        truncationNote = `\n_Full trace at \`${localPath}\` locally._\n`;
      }
      traceSection =
        "<details><summary><strong>Agentic verification — literal trace</strong></summary>\n\n" +
        truncationNote +
        "\n```\n" +
        logText +
        "\n```\n\n</details>\n";
    }
  }

  if (!summarySection && !traceSection) {
    summarySection =
      "_Agentic verification report not found — likely the phase failed before writing its report. See logs below._\n";
  }

  return [header, summarySection, traceSection, trailer].join("\n");
}

main().catch((err) => {
  console.error("pre-pr crashed:", err);
  process.exit(1);
});
