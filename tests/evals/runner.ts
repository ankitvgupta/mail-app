/**
 * Eval runner for email analysis quality.
 *
 * Loads fixtures, runs each through EmailAnalyzer, scores deterministically,
 * compares against baseline, and outputs a report.
 *
 * Usage: npx tsx tests/evals/runner.ts [--update-baseline]
 *
 * Exit code 1 if any regression detected vs baseline.
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { EmailAnalyzer } from "../../src/main/services/email-analyzer";
import type { Email, AnalysisResult } from "../../src/shared/types";
import { resolveModelId, DEFAULT_MODEL_CONFIG } from "../../src/shared/types";
import {
  scoreDeterministic,
  type DeterministicResult,
  type EvalFixtureExpected,
} from "./scoring/deterministic";

// --- Types ---

interface EvalFixture {
  id: string;
  description: string;
  email: Email;
  expected: EvalFixtureExpected;
}

interface EvalReport {
  timestamp: string;
  fixtures_run: number;
  total_score: number;
  max_possible_score: number;
  percentage: number;
  results: Array<DeterministicResult & { description: string; actual: AnalysisResult }>;
  regressions: string[];
}

interface Baseline {
  version: number;
  generated_at: string | null;
  scores: Record<string, number>;
}

// --- Fixture loading ---

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const BASELINE_PATH = join(import.meta.dirname, "baseline.json");

export function loadFixtures(): EvalFixture[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const raw = readFileSync(join(FIXTURES_DIR, f), "utf-8");
    return JSON.parse(raw) as EvalFixture;
  });
}

function loadBaseline(): Baseline {
  const raw = readFileSync(BASELINE_PATH, "utf-8");
  return JSON.parse(raw) as Baseline;
}

function saveBaseline(scores: Record<string, number>): void {
  const baseline: Baseline = {
    version: 1,
    generated_at: new Date().toISOString(),
    scores,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
}

// --- Runner ---

async function runEval(fixtures: EvalFixture[]): Promise<EvalReport> {
  // Pass the app's actual default analysis model. Constructing with no args
  // falls back to the retired legacy default (claude-sonnet-4-20250514 → 404).
  const analyzer = new EmailAnalyzer(resolveModelId(DEFAULT_MODEL_CONFIG.analysis));
  const results: EvalReport["results"] = [];
  const regressions: string[] = [];
  const baseline = loadBaseline();

  for (const fixture of fixtures) {
    let actual: AnalysisResult;
    try {
      actual = await analyzer.analyze(fixture.email);
    } catch (err) {
      // Treat API errors as a zero score rather than crashing the whole run
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL [${fixture.id}]: ${errMsg}`);
      actual = { needs_reply: !fixture.expected.needs_reply, reason: `Error: ${errMsg}` };
    }

    const scored = scoreDeterministic(fixture.id, actual, fixture.expected);

    // Check for regression against baseline
    if (baseline.generated_at !== null && fixture.id in baseline.scores) {
      const baselineScore = baseline.scores[fixture.id];
      if (scored.score < baselineScore) {
        regressions.push(`${fixture.id}: ${scored.score}/10 (was ${baselineScore}/10)`);
      }
    }

    results.push({ ...scored, description: fixture.description, actual });
  }

  const totalScore = results.reduce((sum, r) => sum + r.score, 0);
  const maxPossible = results.length * 10;

  return {
    timestamp: new Date().toISOString(),
    fixtures_run: results.length,
    total_score: totalScore,
    max_possible_score: maxPossible,
    percentage: maxPossible > 0 ? Math.round((totalScore / maxPossible) * 100) : 0,
    results,
    regressions,
  };
}

// --- Output ---

function printReport(report: EvalReport): void {
  console.log("\n=== Email Analysis Eval Report ===\n");
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Fixtures:  ${report.fixtures_run}`);
  console.log(
    `Score:     ${report.total_score}/${report.max_possible_score} (${report.percentage}%)\n`,
  );

  for (const r of report.results) {
    const status = r.score === 10 ? "PASS" : "FAIL";
    const details = r.needs_reply_correct ? "" : " (needs_reply mismatch)";
    console.log(`  [${status}] ${r.fixture_id}: ${r.score}/10${details}`);
    console.log(`         ${r.description}`);
  }

  if (report.regressions.length > 0) {
    console.log("\nREGRESSIONS DETECTED:");
    for (const r of report.regressions) {
      console.log(`  - ${r}`);
    }
  }

  console.log("");
}

// --- Main ---

async function main(): Promise<void> {
  const updateBaseline = process.argv.includes("--update-baseline");

  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error("No fixtures found in", FIXTURES_DIR);
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} eval fixtures...`);
  const report = await runEval(fixtures);

  printReport(report);

  // Write full JSON report to stdout for CI consumption
  console.log("--- JSON Report ---");
  console.log(JSON.stringify(report, null, 2));

  if (updateBaseline) {
    const scores: Record<string, number> = {};
    for (const r of report.results) {
      scores[r.fixture_id] = r.score;
    }
    saveBaseline(scores);
    console.log(`Baseline updated (${Object.keys(scores).length} fixtures)`);
  }

  if (report.regressions.length > 0) {
    console.error(`\nEval FAILED: ${report.regressions.length} regression(s) detected`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests)
const isDirectExecution =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("runner.ts");

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Eval runner crashed:", err);
    process.exit(1);
  });
}
