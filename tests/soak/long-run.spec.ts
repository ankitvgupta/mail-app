/**
 * Soak test — launch the app and let it run for N minutes, taking
 * heap snapshots at intervals. Fails if memory growth is monotonic
 * AND exceeds the configured threshold.
 *
 * Layer 12 per the plan. Runs nightly on `main` (or locally on
 * demand). Default duration is 60 minutes — override via env vars
 * for faster local sanity runs:
 *
 *   EXO_SOAK_DURATION_MS=300000 EXO_SOAK_INTERVAL_MS=30000 \
 *     npx playwright test --project=soak
 *
 * Tracks the renderer JSHeapUsedSize (via window.performance.memory)
 * since that's where the dominant React tree + email-store state lives.
 * Main-process memory is harder to instrument without CDP — leaving as
 * a TODO once we have a clear-cut leak suspect.
 */
import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "../e2e/launch-helpers";

const DURATION_MS = Number(process.env.EXO_SOAK_DURATION_MS ?? 60 * 60 * 1000);
const INTERVAL_MS = Number(process.env.EXO_SOAK_INTERVAL_MS ?? 5 * 60 * 1000);
const GROWTH_THRESHOLD_PCT = Number(process.env.EXO_SOAK_GROWTH_PCT ?? 20);

interface Snapshot {
  t: number;
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
}

async function readHeapSnapshot(page: Page): Promise<Snapshot | null> {
  // performance.memory is Chrome-specific. Returns null when not exposed.
  const result = await page.evaluate(() => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (!mem) return null;
    return {
      usedJSHeapSize: mem.usedJSHeapSize,
      totalJSHeapSize: mem.totalJSHeapSize,
      jsHeapSizeLimit: mem.jsHeapSizeLimit,
    };
  });
  if (!result) return null;
  return {
    t: Date.now(),
    heapUsed: result.usedJSHeapSize,
    heapTotal: result.totalJSHeapSize,
    heapLimit: result.jsHeapSizeLimit,
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

test.describe("Soak test — renderer heap growth", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(DURATION_MS + 5 * 60 * 1000); // soak duration + buffer

  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (app) await closeApp(app);
  });

  test("renderer heap doesn't grow monotonically beyond threshold", async () => {
    console.log(
      `[soak] duration=${(DURATION_MS / 60000).toFixed(1)}m interval=${(INTERVAL_MS / 60000).toFixed(1)}m threshold=${GROWTH_THRESHOLD_PCT}%`,
    );

    // Baseline after a short warmup so initial allocations don't count
    // against us.
    await page.waitForTimeout(15_000);
    const baseline = await readHeapSnapshot(page);
    if (!baseline) {
      test.skip(
        true,
        "performance.memory is not exposed in this Electron build — soak test cannot measure heap",
      );
      return;
    }
    console.log(`[soak] baseline: ${mb(baseline.heapUsed)} / ${mb(baseline.heapTotal)} (limit ${mb(baseline.heapLimit)})`);

    const snapshots: Snapshot[] = [baseline];
    const deadline = Date.now() + DURATION_MS;

    while (Date.now() < deadline) {
      // Pulse some activity so we exercise more than idle state. Cheap
      // and representative: scroll the inbox, click random threads.
      try {
        await page.mouse.wheel(0, 300);
        const thread = page.locator("div[data-thread-id]").nth(
          snapshots.length % 5,
        );
        if (await thread.isVisible({ timeout: 500 }).catch(() => false)) {
          await thread.click({ timeout: 1000 }).catch(() => undefined);
        }
      } catch {
        // ignore — soak should be tolerant of UI drift
      }

      const sleepFor = Math.min(INTERVAL_MS, deadline - Date.now());
      if (sleepFor <= 0) break;
      await page.waitForTimeout(sleepFor);

      const snap = await readHeapSnapshot(page);
      if (snap) {
        snapshots.push(snap);
        const pctVsBaseline = ((snap.heapUsed - baseline.heapUsed) / baseline.heapUsed) * 100;
        console.log(
          `[soak] +${((snap.t - baseline.t) / 60000).toFixed(1)}m: ${mb(snap.heapUsed)} (Δ ${pctVsBaseline.toFixed(1)}%)`,
        );
      }
    }

    // Analysis:
    //   - Compute growth from baseline to last
    //   - Compute whether growth was monotonic (every subsequent snapshot >= previous)
    const last = snapshots.at(-1)!;
    const totalGrowthPct = ((last.heapUsed - baseline.heapUsed) / baseline.heapUsed) * 100;
    const monotonic = snapshots.every(
      (s, i) => i === 0 || s.heapUsed + 5 * 1024 * 1024 >= snapshots[i - 1].heapUsed,
    );

    console.log(`[soak] total growth: ${totalGrowthPct.toFixed(1)}%`);
    console.log(`[soak] monotonic: ${monotonic}`);

    // Fail only on BOTH: monotonic AND exceeds threshold. Either alone
    // is normal — GC dips happen, and a small steady drift is OK as
    // long as it doesn't compound.
    const isLeak = monotonic && totalGrowthPct > GROWTH_THRESHOLD_PCT;
    if (isLeak) {
      console.error(`[soak] LEAK SUSPECTED: monotonic ${totalGrowthPct.toFixed(1)}% growth over the run`);
      console.error(`[soak] Snapshots:`);
      for (const s of snapshots) {
        console.error(`  +${((s.t - baseline.t) / 60000).toFixed(1)}m: ${mb(s.heapUsed)}`);
      }
    }
    expect(isLeak).toBe(false);
  });
});
