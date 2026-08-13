import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Cap workers to avoid resource contention from many simultaneous Electron instances.
  // Note: workers is a top-level-only option — per-project workers is silently ignored.
  // GitHub Actions ubuntu-latest has 2 vCPUs, so "75%" would give just 1 worker.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [["github"], ["html"]] : "html",
  timeout: 60000,
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "unit",
      testDir: "./tests/unit",
      testMatch: /.*\.spec\.ts/,
      fullyParallel: true,
    },
    {
      name: "e2e",
      testDir: "./tests/e2e",
      testMatch: /.*\.spec\.ts/,
      // Each worker gets an isolated database via TEST_WORKER_INDEX,
      // so E2E tests can now run fully in parallel across files.
      // Tests within a describe block stay serial (they share an Electron instance).
      fullyParallel: true,
    },
    {
      name: "integration",
      testDir: "./tests",
      testMatch: /.*\.spec\.ts/,
      // Each opt-in suite has its own project (migrations, packaged, agentic,
      // real-gmail, soak). Exclude them here so the integration project
      // doesn't accidentally inherit a 60min soak run or a real-Gmail OAuth
      // attempt during normal CI.
      testIgnore: [
        /unit\//,
        /e2e\//,
        /problematic\//,
        /agentic\//,
        /real-gmail\//,
        /soak\//,
        /migrations\//,
        /packaged\//,
      ],
      fullyParallel: true,
    },
    {
      name: "problematic",
      testDir: "./tests/problematic",
      testMatch: /.*\.spec\.ts/,
      // These tests are flaky and excluded from the main test run
      // Run manually with: npx playwright test --project=problematic
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "benchmark",
      testDir: "./benchmarks",
      testMatch: /.*\.spec\.ts/,
      // Performance benchmarks — not part of CI, run manually with:
      // npx playwright test --project=benchmark
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "migrations",
      testDir: "./tests/migrations",
      testMatch: /.*\.spec\.ts/,
      // DB migration replay + schema symmetry checks. Single worker because
      // each test sets up its own in-memory DB — no shared state, but no
      // benefit to parallelism either.
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "packaged",
      testDir: "./tests/packaged",
      testMatch: /.*\.spec\.ts/,
      // Smoke tests against the packaged .app binary. Requires the
      // EXO_PACKAGED_BINARY env var to point at the executable.
      // Run via: npm run pack && EXO_PACKAGED_BINARY=... npx playwright test --project=packaged
      // Single worker — Electron app instance is expensive to spin up,
      // and these are smoke tests not parallel-load tests.
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "real-gmail",
      testDir: "./tests/real-gmail",
      testMatch: /.*\.spec\.ts/,
      // Layer 9 — real-Gmail integration tests against the test account
      // (configured via EXOEMAILTEST_EMAIL in .env.local).
      // LOCAL ONLY. Gated by EXO_REAL_GMAIL_TEST=true so accidental
      // invocations skip cleanly. Refresh-token-only auth from .env.local.
      // Excludes full-sync (the real-gmail-full-sync project below is the
      // explicit opt-in path for those slower tests).
      testIgnore: /.*\.full-sync\.spec\.ts/,
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "agentic",
      testDir: "./tests/agentic",
      testMatch: /.*\.spec\.ts/,
      // Tests for the agentic-verify driver helpers + self-tests.
      // Pure-logic tests run without Electron; driver-behavior tests
      // (if/when added) launch a subprocess. Single worker — these
      // touch shared port 9222 when they do launch.
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "soak",
      testDir: "./tests/soak",
      testMatch: /.*\.spec\.ts/,
      // Layer 12 — long-running soak test. Default duration 60min, but
      // dev can override via EXO_SOAK_DURATION_MS for shorter sanity
      // runs. Runs on `main` only (too slow for every PR).
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "real-gmail-full-sync",
      testDir: "./tests/real-gmail",
      testMatch: /.*\.full-sync\.spec\.ts/,
      // Layer 9b — full-sync mode: wipes local state, OAuths from
      // scratch, full sync from empty inbox. Slow (~4min), opt-in.
      // EXO_DISABLE_PREFETCH=true is set in the test helper so the
      // sync pipeline isn't entangled with PrefetchService LLM calls.
      fullyParallel: false,
      workers: 1,
    },
  ],
});
