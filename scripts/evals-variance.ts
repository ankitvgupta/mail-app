/**
 * Empirical judge-variance analyzer for the eval framework.
 *
 * For each fixture, runs the feature N times (default 10), scores each
 * output via the LLM judge, and reports the score distribution. Lets us
 * pick a principled regression threshold instead of guessing.
 *
 * Usage:
 *   npx tsx scripts/evals-variance.ts                   # 10 runs per fixture, all features
 *   npx tsx scripts/evals-variance.ts --runs 15         # 15 runs each
 *   npx tsx scripts/evals-variance.ts --feature draft-generator
 *
 * Output:
 *   Per fixture: min, p25, median, p75, max, stddev, all scores
 *   Suggested threshold: ceil(max stddev across all fixtures * 2)
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { judge } from "../tests/evals/scoring/llm-judge";
import { runDraftGeneratorFixture } from "../tests/evals/features/draft-generator";
import { runCalendaringFixture } from "../tests/evals/features/calendaring-agent";
import { runArchiveReadyFixture } from "../tests/evals/features/archive-ready-analyzer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// .env.local loader
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile(join(REPO_ROOT, ".env.local"));

type FeatureRunner = (input: unknown, fixtureId: string) => Promise<string>;
const FEATURES: Record<string, FeatureRunner> = {
  "draft-generator": runDraftGeneratorFixture,
  "calendaring-agent": runCalendaringFixture,
  "archive-ready-analyzer": runArchiveReadyFixture,
};

interface Fixture {
  id: string;
  description: string;
  input: unknown;
  rubric: string;
}

const args = process.argv.slice(2);
function flag(name: string, def: string): string {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return def;
}
const RUNS = Number(flag("runs", "10"));
const FEATURE_FILTER = flag("feature", "");
const CONCURRENCY = Number(flag("concurrency", "5"));

function loadFixtures(feature: string): Fixture[] {
  const dir = join(REPO_ROOT, "tests", "evals", "feature-fixtures", feature);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture);
}

function stats(scores: number[]): {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
  stddev: number;
  range: number;
} {
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const pct = (p: number) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  const mean = scores.reduce((s, x) => s + x, 0) / n;
  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return {
    min: sorted[0],
    p25: pct(25),
    median: pct(50),
    p75: pct(75),
    max: sorted[n - 1],
    mean: Number(mean.toFixed(2)),
    stddev: Number(stddev.toFixed(2)),
    range: sorted[n - 1] - sorted[0],
  };
}

/** Run an async function pool with limited concurrency. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function analyzeFixture(
  feature: string,
  fixture: Fixture,
  runFeature: FeatureRunner,
): Promise<{ scores: number[]; reasons: string[] }> {
  process.stdout.write(`  [${fixture.id}] running ${RUNS} times`);
  const runs = await pool(Array.from({ length: RUNS }, (_, i) => i), CONCURRENCY, async (i) => {
    try {
      const output = await runFeature(fixture.input, `${fixture.id}#${i}`);
      const j = await judge(output, fixture.rubric, `${fixture.id}#${i}`);
      process.stdout.write(".");
      return { score: j.score, reason: j.reason };
    } catch (err) {
      process.stdout.write("x");
      return { score: 0, reason: `error: ${err instanceof Error ? err.message : err}` };
    }
  });
  process.stdout.write("\n");
  return {
    scores: runs.map((r) => r.score),
    reasons: runs.map((r) => r.reason),
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY missing — set it in .env.local.");
    process.exit(1);
  }

  const features = FEATURE_FILTER
    ? Object.keys(FEATURES).filter((f) => f === FEATURE_FILTER)
    : Object.keys(FEATURES);

  console.log(`Variance analysis: ${RUNS} runs per fixture, concurrency=${CONCURRENCY}`);
  console.log(`Features: ${features.join(", ")}`);

  type FixtureReport = {
    feature: string;
    id: string;
    description: string;
    scores: number[];
    stats: ReturnType<typeof stats>;
  };
  const reports: FixtureReport[] = [];

  for (const feature of features) {
    const fixtures = loadFixtures(feature);
    if (fixtures.length === 0) {
      console.log(`\n[${feature}] no fixtures`);
      continue;
    }
    const runner = FEATURES[feature];
    console.log(`\n[${feature}] ${fixtures.length} fixture(s)`);
    for (const fixture of fixtures) {
      const { scores } = await analyzeFixture(feature, fixture, runner);
      const s = stats(scores);
      reports.push({ feature, id: fixture.id, description: fixture.description, scores, stats: s });
    }
  }

  console.log("\n========================================");
  console.log("SUMMARY");
  console.log("========================================\n");

  for (const r of reports) {
    console.log(`[${r.feature}] ${r.id}`);
    console.log(`  ${r.description}`);
    console.log(
      `  scores: ${r.scores.join(", ")} | range=${r.stats.range} stddev=${r.stats.stddev} median=${r.stats.median} mean=${r.stats.mean}`,
    );
  }

  const maxStddev = Math.max(...reports.map((r) => r.stats.stddev));
  const maxRange = Math.max(...reports.map((r) => r.stats.range));
  const suggestedThreshold = Math.ceil(maxStddev * 2 * 10) / 10;

  console.log("\n========================================");
  console.log("THRESHOLD RECOMMENDATION");
  console.log("========================================");
  console.log(`  max stddev across fixtures: ${maxStddev}`);
  console.log(`  max range across fixtures:  ${maxRange}`);
  console.log(`  suggested threshold (2σ):   ${suggestedThreshold}`);
  console.log(`\n  Suggested baselines (use the p25 of each fixture):`);
  for (const r of reports) {
    console.log(`    ${r.feature}/${r.id}: ${r.stats.p25}`);
  }
}

main().catch((err) => {
  console.error("variance analyzer crashed:", err);
  process.exit(1);
});
