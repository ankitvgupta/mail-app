/**
 * Multi-feature eval runner.
 *
 * Per-feature suites live in `tests/evals/feature-fixtures/<feature>/*.json`.
 * Each fixture is graded via the LLM judge against its rubric. Baselines
 * are stored per-feature at `tests/evals/baselines/<feature>.json`.
 *
 * This is separate from the analyzer-specific runner.ts to avoid
 * destabilizing the existing analyzer eval flow during the expansion.
 * Once draft-generator (and friends) have stable baselines, we can
 * consolidate.
 *
 * Usage:
 *   npx tsx tests/evals/feature-evals.ts --feature draft-generator
 *   npx tsx tests/evals/feature-evals.ts --all
 *   npx tsx tests/evals/feature-evals.ts --feature draft-generator --update-baseline
 *
 * Exit code 1 on any regression > 0.5 points vs baseline.
 *
 * NOTE: requires ANTHROPIC_API_KEY in env. Never runs in CI.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { judge, type JudgeResult } from "./scoring/llm-judge";
import { runDraftGeneratorFixture } from "./features/draft-generator";
import { runCalendaringFixture } from "./features/calendaring-agent";
import { runArchiveReadyFixture } from "./features/archive-ready-analyzer";

// .env.local loader — feature-evals needs ANTHROPIC_API_KEY at runtime.
// Claude Code scrubs the env from subprocesses so .env.local is the
// canonical source. No new deps.
function loadEnvFile(path: string): void {
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

loadEnvFile(join(import.meta.dirname, "..", "..", ".env.local"));

// ============================================================
// Feature registry
// ============================================================
//
// Each feature must define:
//   - name: directory key matching feature-fixtures/<name>/
//   - runFixture(fixture): produces the feature output as a string the
//     judge can grade against the rubric
//
// To add a new feature: create feature-fixtures/<name>/, drop a few
// JSON fixtures in, write a runFixture function, and register here.

type FeatureRunner = (fixtureInput: unknown, fixtureId: string) => Promise<string>;

const FEATURES: Record<string, FeatureRunner> = {
  "draft-generator": runDraftGeneratorFixture,
  "calendaring-agent": runCalendaringFixture,
  "archive-ready-analyzer": runArchiveReadyFixture,
};

/**
 * Features the plan calls out but which don't have eval scaffolding
 * yet. Tracking them here so `--all` reports what's still TODO instead
 * of silently skipping. As each one ships, move its name from this
 * list into FEATURES.
 */
const TODO_FEATURES = [
  "sender-lookup",
  "style-profiler",
  "analysis-edit-learner",
  "draft-edit-learner",
];

// ============================================================
// Fixture + baseline shape
// ============================================================

interface FeatureFixture {
  id: string;
  description: string;
  /** Feature-specific input. Schema is up to runFixture(). */
  input: unknown;
  /** Markdown checklist of what good output looks like for this fixture. */
  rubric: string;
  /** Minimum score the judge should give a good output (used for sanity, not gate). */
  expectedMinScore?: number;
}

interface FeatureBaseline {
  version: number;
  feature: string;
  generatedAt: string | null;
  scores: Record<string, { score: number; reason: string }>;
}

interface FixtureResult {
  fixtureId: string;
  description: string;
  judge: JudgeResult;
  baselineScore: number | null;
  delta: number | null;
  output: string;
  /** Set when runFixture threw — the judge result is then skipped so an
   *  infrastructure crash isn't silently graded as a model regression. */
  infraError?: string;
  /** Set when the judge itself failed (API/parse error). The
   *  regression-delta check is skipped — see #129. */
  judgeError?: string;
}

interface FeatureReport {
  feature: string;
  fixturesRun: number;
  results: FixtureResult[];
  regressions: string[];
  /** Infrastructure errors (runFixture threw) — distinct from judge
   *  regressions. The runner exits non-zero on either, but they're
   *  reported separately so a developer doesn't chase a phantom model
   *  regression that's really a broken service call. */
  infraErrors: string[];
  /** Judge errors (the judge call failed — API/parse). Same treatment
   *  as infraErrors: skip the delta check, exit non-zero, report
   *  separately so a Claude 5xx doesn't look like a model regression. */
  judgeErrors: string[];
}

// ============================================================
// Paths
// ============================================================

const FIXTURES_ROOT = join(import.meta.dirname, "feature-fixtures");
const BASELINES_ROOT = join(import.meta.dirname, "baselines");

// Empirically calibrated via `npx tsx scripts/evals-variance.ts` — see
// docs/EVAL_VARIANCE.md for the methodology and raw data. Re-measured
// 2026-05-22 on draft-generator + calendaring-agent: max observed
// stddev rose to 2.15 (dg-3-decline), so two stddev = 4.3, rounded up
// to 5.0. The earlier 3.0 figure assumed stddev <=1.43 and was flaking
// pre-pr ~50% of the time on bimodal fixtures (dg-1, ca-1) and tail
// outliers (dg-2 hitting 3, ca-1 hitting 4–5). At threshold=5 a fixture
// must score 5+ points below baseline to fail, which empirically only
// happens when the judge takes a clear stance about something
// materially broken. Baselines stay at p25 of observed runs.
const REGRESSION_THRESHOLD = 5.0;

function fixturesDir(feature: string): string {
  return join(FIXTURES_ROOT, feature);
}

function baselinePath(feature: string): string {
  return join(BASELINES_ROOT, `${feature}.json`);
}

// ============================================================
// IO
// ============================================================

function loadFixtures(feature: string): FeatureFixture[] {
  const dir = fixturesDir(feature);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as FeatureFixture);
}

function loadBaseline(feature: string): FeatureBaseline | null {
  const path = baselinePath(feature);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as FeatureBaseline;
}

function saveBaseline(feature: string, results: FixtureResult[]): void {
  mkdirSync(BASELINES_ROOT, { recursive: true });
  const baseline: FeatureBaseline = {
    version: 1,
    feature,
    generatedAt: new Date().toISOString(),
    scores: Object.fromEntries(
      results.map((r) => [r.fixtureId, { score: r.judge.score, reason: r.judge.reason }]),
    ),
  };
  writeFileSync(baselinePath(feature), JSON.stringify(baseline, null, 2) + "\n");
}

// ============================================================
// Runner
// ============================================================

async function runFeature(feature: string): Promise<FeatureReport> {
  const runFixture = FEATURES[feature];
  if (!runFixture) {
    throw new Error(`Unknown feature: ${feature}. Known: ${Object.keys(FEATURES).join(", ")}`);
  }

  const fixtures = loadFixtures(feature);
  if (fixtures.length === 0) {
    console.warn(`[${feature}] no fixtures found in ${fixturesDir(feature)} — skipping`);
    return {
      feature,
      fixturesRun: 0,
      results: [],
      regressions: [],
      infraErrors: [],
      judgeErrors: [],
    };
  }

  const baseline = loadBaseline(feature);
  const results: FixtureResult[] = [];
  const regressions: string[] = [];
  const infraErrors: string[] = [];
  const judgeErrors: string[] = [];

  for (const fixture of fixtures) {
    console.log(`[${feature}] running ${fixture.id}...`);
    let output: string;
    let infraError: string | undefined;
    try {
      output = await runFixture(fixture.input, fixture.id);
    } catch (err) {
      infraError = err instanceof Error ? err.message : String(err);
      console.error(`  ${fixture.id}: runFixture error: ${infraError}`);
      output = "";
    }

    if (infraError) {
      // Skip the judge entirely — grading an empty string against the
      // rubric would assign a low score and surface as a false regression.
      infraErrors.push(`${fixture.id}: ${infraError}`);
      results.push({
        fixtureId: fixture.id,
        description: fixture.description,
        judge: { score: 0, reason: `infrastructure error: ${infraError}` },
        baselineScore: baseline?.scores[fixture.id]?.score ?? null,
        delta: null,
        output: "",
        infraError,
      });
      continue;
    }

    const judgement = await judge(output, fixture.rubric, fixture.id);
    const baselineScore = baseline?.scores[fixture.id]?.score ?? null;

    // Judge itself failed — skip the delta check so a Claude 5xx or
    // parser bug doesn't surface as a phantom model regression. See #129.
    if (judgement.judgeError) {
      judgeErrors.push(`${fixture.id}: ${judgement.judgeError}`);
      results.push({
        fixtureId: fixture.id,
        description: fixture.description,
        judge: judgement,
        baselineScore,
        delta: null,
        output,
        judgeError: judgement.judgeError,
      });
      continue;
    }

    const delta = baselineScore !== null ? judgement.score - baselineScore : null;

    if (delta !== null && delta < -REGRESSION_THRESHOLD) {
      regressions.push(
        `${fixture.id}: ${judgement.score}/10 (baseline ${baselineScore}/10, Δ ${delta.toFixed(1)})`,
      );
    }

    results.push({
      fixtureId: fixture.id,
      description: fixture.description,
      judge: judgement,
      baselineScore,
      delta,
      output,
    });
  }

  return {
    feature,
    fixturesRun: results.length,
    results,
    regressions,
    infraErrors,
    judgeErrors,
  };
}

function printReport(report: FeatureReport): void {
  console.log(`\n=== ${report.feature} ===`);
  console.log(`Fixtures: ${report.fixturesRun}`);
  if (report.fixturesRun === 0) return;

  for (const r of report.results) {
    const deltaStr = r.judgeError
      ? "(judge error)"
      : r.infraError
        ? "(infra error)"
        : r.delta === null
          ? "(no baseline)"
          : r.delta >= 0
            ? `+${r.delta.toFixed(1)}`
            : r.delta.toFixed(1);
    console.log(`  [${r.judge.score}/10] ${r.fixtureId} ${deltaStr}`);
    console.log(`    ${r.description}`);
    console.log(`    judge: ${r.judge.reason}`);
  }

  if (report.regressions.length > 0) {
    console.log(`\n  REGRESSIONS (> ${REGRESSION_THRESHOLD} pts below baseline):`);
    for (const reg of report.regressions) console.log(`    - ${reg}`);
  }

  if (report.infraErrors.length > 0) {
    console.log(`\n  INFRASTRUCTURE ERRORS (runFixture threw — not a model regression):`);
    for (const err of report.infraErrors) console.log(`    - ${err}`);
  }

  if (report.judgeErrors.length > 0) {
    console.log(`\n  JUDGE ERRORS (judge call failed — not a model regression):`);
    for (const err of report.judgeErrors) console.log(`    - ${err}`);
  }
}

// ============================================================
// CLI
// ============================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");
  const all = args.includes("--all");
  const featureArg = args[args.indexOf("--feature") + 1];

  const targets: string[] = all
    ? Object.keys(FEATURES)
    : featureArg && !featureArg.startsWith("--")
      ? [featureArg]
      : [];

  if (targets.length === 0) {
    console.error("Usage:");
    console.error("  npx tsx tests/evals/feature-evals.ts --feature <name>");
    console.error("  npx tsx tests/evals/feature-evals.ts --all");
    console.error(`  Known features: ${Object.keys(FEATURES).join(", ")}`);
    console.error(`  TODO features (not yet implemented): ${TODO_FEATURES.join(", ")}`);
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required. This eval runner is local-only.");
    process.exit(1);
  }

  const reports: FeatureReport[] = [];
  let anyRegressions = false;
  let anyInfraErrors = false;
  let anyJudgeErrors = false;
  for (const feature of targets) {
    const report = await runFeature(feature);
    reports.push(report);
    printReport(report);
    if (updateBaseline && report.fixturesRun > 0) {
      // Refuse to persist baselines when any fixture has a score-0
      // placeholder (judge or infra error). Otherwise --update-baseline
      // during an outage would write score 0 for the broken fixtures,
      // and future runs would compute deltas like +7 against that — a
      // permanent regression-detection blind spot.
      const blockingErrors = report.judgeErrors.length + report.infraErrors.length;
      if (blockingErrors > 0) {
        console.warn(
          `  [${feature}] baseline NOT updated — ${blockingErrors} judge/infra error(s) present. Fix the underlying failure and re-run.`,
        );
      } else {
        saveBaseline(feature, report.results);
        console.log(`  baseline updated → ${baselinePath(feature)}`);
      }
    }
    if (report.regressions.length > 0) anyRegressions = true;
    if (report.infraErrors.length > 0) anyInfraErrors = true;
    if (report.judgeErrors.length > 0) anyJudgeErrors = true;
  }

  if (all && TODO_FEATURES.length > 0) {
    console.log(`\nNOTE: ${TODO_FEATURES.length} features still TODO:`);
    for (const f of TODO_FEATURES) console.log(`  - ${f}`);
  }

  console.log(`\nTotal fixtures run: ${reports.reduce((s, r) => s + r.fixturesRun, 0)}`);
  if (anyInfraErrors) {
    console.error(
      "\nEval FAILED: infrastructure errors (runFixture threw — not a model regression).",
    );
    console.error("Check the runner code path, not the model or rubric.");
    process.exit(1);
  }
  if (anyJudgeErrors) {
    console.error("\nEval FAILED: judge errors (judge call failed — not a model regression).");
    console.error(
      "Check Anthropic API status or the judge response parser, not the feature output.",
    );
    process.exit(1);
  }
  if (anyRegressions) {
    console.error("\nEval FAILED: regressions detected vs baseline");
    process.exit(1);
  }
}

const isDirectExecution =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("feature-evals.ts");

if (isDirectExecution) {
  main().catch((err) => {
    console.error("feature-evals crashed:", err);
    process.exit(1);
  });
}
