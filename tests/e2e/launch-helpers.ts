import { _electron as electron, expect, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, "../../tests/screenshots");

export type LaunchOptions = {
  workerIndex?: number;
  extraEnv?: Record<string, string>;
  waitAfterLoad?: number;
};

/**
 * Launch Electron app for E2E testing with per-worker database isolation.
 *
 * Each worker gets its own database file (e.g. exo-demo-w0.db)
 * so E2E tests can run fully in parallel without state conflicts.
 */
export async function launchElectronApp(
  options: LaunchOptions = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const { workerIndex = 0, extraEnv = {}, waitAfterLoad } = options;

  const app = await electron.launch({
    args: [path.join(__dirname, "../../out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      EXO_DEMO_MODE: "true",
      TEST_WORKER_INDEX: String(workerIndex),
      ...extraEnv,
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForSelector("text=Exo", { timeout: 15000 });

  // The app defaults to the Priority tab. Switch to "All" so tests see every
  // email in the demo inbox (most tests search for specific emails by name).
  const allTab = window
    .locator("button")
    .filter({ hasText: /^All\s*\d*$/ })
    .first();
  try {
    await allTab.waitFor({ state: "visible", timeout: 3000 });
    await allTab.click();
    await window.waitForTimeout(300);
  } catch {
    // Tab may not be visible yet (e.g. before sync completes) — continue
  }

  if (waitAfterLoad) {
    await window.waitForTimeout(waitAfterLoad);
  }

  return { app, page: window };
}

/**
 * Close an Electron app for test cleanup.
 *
 * electronApp.close() can hang when the renderer has pending timers,
 * and Playwright's internal pipe handles keep the worker alive past the
 * 60s teardown limit. We SIGTERM the process directly, wait for exit,
 * and SIGKILL as a fallback.
 */
export async function closeApp(electronApp: ElectronApplication): Promise<void> {
  const proc = electronApp.process();
  const pid = proc.pid;
  if (!pid) return;

  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    proc.once("close", () => resolve());
  });

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const gracefulTimeout = setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }, 5000);

  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 8000))]);
  clearTimeout(gracefulTimeout);
}

/**
 * Wait for email list to be fully rendered and React effects to settle.
 * On CI (slow CPU + xvfb), there's a gap between thread rows appearing in the DOM
 * and the keyboard handler's useEffect registering / store subscriptions updating.
 * The settle delay lets React flush pending effects before keyboard events fire.
 */
export async function waitForEmailListReady(page: Page): Promise<void> {
  await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("div[data-thread-id]").first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1000);
}

/**
 * Press a key and retry until the expected locator becomes visible.
 * Works around CI timing where keyboard events fire before React state commits.
 */
export async function pressKeyUntilVisible(
  page: Page,
  key: string,
  locator: ReturnType<Page["locator"]>,
  { timeout = 10000, retryInterval = 500 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.keyboard.press(key);
    try {
      await expect(locator).toBeVisible({ timeout: retryInterval });
      return;
    } catch {
      // Key didn't take effect yet — retry
    }
  }
  await expect(locator).toBeVisible({ timeout: 2000 });
}

/**
 * Best-effort screenshot capture, disabled by default.
 * Set E2E_SCREENSHOTS=true to enable (useful for debugging test failures).
 *
 * Uses Electron's native capturePage first (more reliable under xvfb),
 * falls back to Playwright's page.screenshot.
 */
export async function takeScreenshot(
  app: ElectronApplication,
  page: Page,
  name: string,
  description?: string,
) {
  if (process.env.E2E_SCREENSHOTS !== "true") return;

  // Brief settle time before capture (carried over from screenshot-reply-buttons.spec.ts)
  await page.waitForTimeout(500);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const filename = `${name}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);

  try {
    const imageBuffer = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return "";
      const image = await win.webContents.capturePage();
      return image.toPNG().toString("base64");
    });

    if (imageBuffer && imageBuffer.length > 0) {
      fs.writeFileSync(filepath, Buffer.from(imageBuffer, "base64"));
      console.log(`  [screenshot] ${filename}${description ? ` - ${description}` : ""}`);
      return;
    }
  } catch {
    // Fall through to Playwright screenshot
  }

  try {
    await page.screenshot({ path: filepath, timeout: 5000 });
    console.log(`  [screenshot] ${filename} (fallback)${description ? ` - ${description}` : ""}`);
  } catch {
    console.log(`  [screenshot] ${filename} - SKIPPED`);
  }
}
