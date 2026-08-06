import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard for the dev/prod data sever (May 2026).
 *
 * The old `initDevData()` bootstrap copied the user's real Gmail tokens,
 * credentials, and database from the packaged app's real user-data dir
 * into `.dev-data/` on first dev run — which meant a fresh worktree could
 * silently re-import real-account state. That's now banned: dev signs in
 * as the dedicated test account (configured via `EXOEMAILTEST_EMAIL`
 * in `.env.local`) only.
 *
 * If anyone reintroduces a copy-from-prod step in `data-dir.ts`, this
 * test fails. Keeping the guard at the file-content level (not behavior)
 * because the real risk is the function existing at all — any caller can
 * trigger it.
 */
test("data-dir.ts has no prod-to-dev copy bootstrap", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "src", "main", "data-dir.ts"),
    "utf8",
  );

  expect(source).not.toContain("initDevData");
  expect(source).not.toContain("BOOTSTRAP_MARKER");
  expect(source).not.toContain("copyFileSync");
  expect(source).not.toContain("mkdirSync");
  expect(source).not.toContain("writeFileSync");
});

/**
 * Behavior tests for the EXO_USER_DATA_DIR override (July 2026).
 *
 * The override is the only thing keeping packaged smoke tests out of the
 * real install's data dir, so its two contracts — absolute path honored
 * verbatim, relative path rejected loudly — get direct coverage. The
 * override branch runs before any Electron access, so getDataDir() is
 * testable under plain Node.
 */
test.describe("EXO_USER_DATA_DIR override", () => {
  let saved: string | undefined;

  test.beforeEach(() => {
    saved = process.env.EXO_USER_DATA_DIR;
  });

  test.afterEach(() => {
    if (saved === undefined) delete process.env.EXO_USER_DATA_DIR;
    else process.env.EXO_USER_DATA_DIR = saved;
  });

  test("absolute override is returned verbatim, in any mode", async () => {
    process.env.EXO_USER_DATA_DIR = "/tmp/exo-override-test";
    const { getDataDir } = await import("../../src/main/data-dir");
    expect(getDataDir()).toBe("/tmp/exo-override-test");
  });

  test("relative override fails loudly", async () => {
    process.env.EXO_USER_DATA_DIR = "relative/scratch-dir";
    const { getDataDir } = await import("../../src/main/data-dir");
    expect(() => getDataDir()).toThrow(/absolute/);
  });
});
