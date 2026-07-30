/**
 * Smoke tests against the PACKAGED .app binary (not dev mode).
 *
 * Catches the class of bugs dev mode never sees:
 *   - PATH issues (packaged macOS apps inherit a minimal PATH from
 *     Finder/Dock; src/main/index.ts has a PATH-fix step that needs
 *     to actually work)
 *   - native module (better-sqlite3) ABI mismatch in the asar bundle
 *   - missing files because they didn't get included in `extraResources`
 *   - electron-builder packaging quirks
 *
 * Requires the binary path in EXO_PACKAGED_BINARY. CI sets this to
 * release/linux-unpacked/exo after `npm run pack`. Locally on macOS,
 * use: `npm run pack && EXO_PACKAGED_BINARY="release/mac-arm64/Exo.app/Contents/MacOS/Exo" \
 *   npx playwright test --project=packaged`.
 *
 * The packaged binary resolves its data dir to the real per-user app dir
 * (same productName as the actual install), so we MUST redirect it with
 * EXO_USER_DATA_DIR or the smoke test writes into — and can corrupt — the
 * user's production config and database.
 */
import {
  test,
  expect,
  _electron as electron,
  type Page,
  type ElectronApplication,
} from "@playwright/test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BINARY = process.env.EXO_PACKAGED_BINARY ?? "";
const USER_DATA_DIR = path.join(__dirname, "../../.packaged-test-data");

test.beforeAll(() => {
  if (!BINARY) {
    test.skip(true, "EXO_PACKAGED_BINARY not set — skipping packaged smoke");
  }
  if (!existsSync(BINARY)) {
    // A set-but-wrong path must FAIL, not skip: the dist/->release/ incident
    // proved a silent skip keeps CI green while the packaged suite never
    // runs. Skipping is only acceptable when the suite wasn't requested.
    throw new Error(
      `EXO_PACKAGED_BINARY is set but does not exist at ${BINARY} — ` +
        `did you run 'npm run pack'? (electron-builder outputs to release/)`,
    );
  }
});

test.describe("Packaged app smoke", () => {
  test.describe.configure({ mode: "serial" });

  let app: ElectronApplication;
  let page: Page;

  const launchPackagedApp = async (): Promise<ElectronApplication> =>
    electron.launch({
      executablePath: BINARY,
      env: {
        ...process.env,
        // Demo mode so the packaged app doesn't need OAuth / Gmail creds
        // in CI. The packaging itself is what we're verifying, not
        // real-Gmail behavior.
        EXO_DEMO_MODE: "true",
        // Isolate ALL data (config, db, logs, Chromium profile) from the
        // real install's user-data dir — see header comment.
        EXO_USER_DATA_DIR: USER_DATA_DIR,
        // Test worker isolation pattern from launch-helpers.ts
        TEST_WORKER_INDEX: "0",
      },
      timeout: 30_000,
    });

  const closePackagedApp = async (target: ElectronApplication): Promise<void> => {
    const proc = target.process();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        target.close(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("packaged app shutdown timed out")), 5_000);
        }),
      ]);
    } catch {
      if (proc.pid) {
        try {
          process.kill(proc.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => proc.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  test.beforeAll(async () => {
    // Start from a clean slate — stale Chromium profile state or config from
    // a previous run would make the smoke test non-deterministic.
    rmSync(USER_DATA_DIR, { recursive: true, force: true });
    mkdirSync(USER_DATA_DIR, { recursive: true });
    app = await launchPackagedApp();
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    if (app) {
      await closePackagedApp(app);
    }
  });

  test("data dir is redirected away from the real install", async () => {
    // The whole reason this suite is safe to run locally: EXO_USER_DATA_DIR
    // must actually take effect. If the override regresses, the packaged
    // binary reads and writes the user's production data dir while every
    // other assertion here still passes — so verify it, don't trust it.
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    expect(userData).toBe(USER_DATA_DIR);
  });

  test("app launches within 30s and shows the Exo brand", async () => {
    await expect(page.locator("text=Exo").first()).toBeVisible({ timeout: 30_000 });
  });

  test("bundles an executable compatible OpenCode platform binary", () => {
    const resourcesDir =
      process.platform === "darwin"
        ? path.resolve(path.dirname(BINARY), "../Resources")
        : path.resolve(path.dirname(BINARY), "resources");
    const sdkCommand = process.platform === "win32" ? "opencode.exe" : "opencode";
    const normalizedPlatform = process.platform === "win32" ? "windows" : process.platform;
    const packageName = `opencode-${normalizedPlatform}-${process.arch}${
      process.arch === "x64" ? "-baseline" : ""
    }`;
    const sdkCommandPath = path.join(
      resourcesDir,
      "app.asar.unpacked/node_modules",
      packageName,
      "bin",
      sdkCommand,
    );
    const opencodeBinDir = path.dirname(sdkCommandPath);

    expect(existsSync(sdkCommandPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(sdkCommandPath).mode & 0o111).not.toBe(0);
    }
    const version = spawnSync("opencode", ["--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${opencodeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
      windowsHide: true,
    });
    expect(version.status, version.stderr || version.error?.message).toBe(0);
  });

  test("no main-process crash in the first 10s", async () => {
    const proc = app.process();
    // If the main process had crashed, electron.launch would have failed
    // or app.process() would be detached. Confirm it's still running.
    expect(proc.pid).toBeDefined();
    await page.waitForTimeout(5_000);
    expect(proc.killed).toBe(false);
  });

  test("inbox area renders (demo data shows)", async () => {
    // Demo mode populates a few mock emails. We don't care which —
    // just that the email-list area renders without a hard error.
    const inboxIndicator = page.locator("text=Inbox").first();
    await expect(inboxIndicator).toBeVisible({ timeout: 15_000 });
  });

  test("settings panel opens", async () => {
    // Either the settings button is visible (data-testid), or there's
    // a keyboard shortcut. Try button first, fall back to shortcut.
    const settingsBtn = page.locator("[data-testid='settings-button']");
    if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await settingsBtn.click();
    } else {
      await page.keyboard.press("ControlOrMeta+,");
    }
    await expect(page.locator("text=Settings").first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
  });

  test("no uncaught renderer errors in the first 15s", async () => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.waitForTimeout(10_000);
    // Filter out known noise — extensions/devtools-related warnings
    const real = errors.filter(
      (e) =>
        !e.includes("Autofill.enable") &&
        !e.includes("Autofill.setAddresses") &&
        !e.includes("HotModuleReplacement"),
    );
    if (real.length > 0) {
      console.error("Renderer errors observed during smoke:");
      for (const e of real) console.error(`  - ${e}`);
    }
    expect(real).toHaveLength(0);
  });

  test("shows an enabled OpenCode provider after a packaged-app restart", async () => {
    await page.evaluate(async () => {
      await window.api.settings.set({
        anthropicApiKey: "packaged-smoke-placeholder",
        featureProviders: {
          analysis: "opencode",
          agentChat: "opencode",
        },
        opencode: {
          enabled: true,
          featureModels: {
            analysis: "openai/gpt-5.2",
          },
        },
      });
    });

    await closePackagedApp(app);
    app = await launchPackagedApp();
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Opening via the keyboard here races React's global key listener on slower
    // packaged CI starts. This smoke is about the packaged provider surface, so
    // wait for the renderer store and open that surface directly.
    await page.waitForFunction(
      () =>
        typeof (
          window as unknown as {
            __ZUSTAND_STORE__?: { getState?: () => Record<string, unknown> };
          }
        ).__ZUSTAND_STORE__?.getState === "function",
      undefined,
      { timeout: 30_000 },
    );

    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __ZUSTAND_STORE__: {
            getState: () => {
              setShowSettings: (open: boolean) => void;
            };
          };
        }
      ).__ZUSTAND_STORE__;
      store.getState().setShowSettings(true);
    });
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("Provider for Email Analysis")).toHaveValue("opencode");
    await expect(page.getByLabel("OpenCode model for Email Analysis")).toHaveValue(
      "openai/gpt-5.2",
    );
    await expect(page.getByLabel("Provider for Agent Chat")).toHaveValue("opencode");
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __ZUSTAND_STORE__: {
            getState: () => {
              setAgentPaletteOpen: (open: boolean) => void;
            };
          };
        }
      ).__ZUSTAND_STORE__;
      store.getState().setAgentPaletteOpen(true);
    });

    await expect(page.getByPlaceholder("Ask agent anything...")).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(
        async () => {
          await page.evaluate(async () => {
            await window.api.agent.providers();
          });
          return page.getByRole("button", { name: "OpenCode" }).count();
        },
        { timeout: 30_000 },
      )
      .toBe(1);

    await expect(page.getByRole("button", { name: "OpenCode" })).toBeVisible({
      timeout: 5_000,
    });
  });
});
