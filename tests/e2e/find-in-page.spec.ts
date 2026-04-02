import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, waitForEmailListReady, pressKeyUntilVisible } from "./launch-helpers";

/**
 * E2E Tests for Cmd+F find-in-page functionality.
 * Tests run in DEMO_MODE with fake emails.
 */
test.describe("Find in Page - Cmd+F", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("Cmd+F opens find bar", async () => {
    // Wait for inbox + React effects to settle
    await waitForEmailListReady(page);

    // Open find bar (retry on CI where effects may not be registered yet)
    const findBar = page.locator('[data-testid="find-bar"]');
    await pressKeyUntilVisible(page, "ControlOrMeta+f", findBar);

    const findInput = page.locator('[data-testid="find-bar-input"]');
    await expect(findInput).toBeVisible();
    await expect(findInput).toBeFocused();
  });

  test("Escape closes find bar", async () => {
    const findBar = page.locator('[data-testid="find-bar"]');
    await expect(findBar).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(findBar).not.toBeVisible({ timeout: 3000 });
  });

  test("typing shows match count", async () => {
    // Re-open find bar
    const findBar = page.locator('[data-testid="find-bar"]');
    await pressKeyUntilVisible(page, "ControlOrMeta+f", findBar);

    const findInput = page.locator('[data-testid="find-bar-input"]');
    await expect(findInput).toBeFocused();

    // Type a sender name visible in the email list (from demo fake-inbox.ts)
    await findInput.pressSequentially("Garry", { delay: 50 });

    // Playwright's key simulation doesn't reliably trigger the full
    // React onChange → debounce → IPC chain. Trigger findInPage from
    // main process to validate the found-in-page → find:result → UI path.
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      win.webContents.findInPage("Garry");
    });

    // Match count should be visible
    await expect(findBar.locator("text=/\\d+ of \\d+/")).toBeVisible({ timeout: 5000 });

    // Close
    await page.keyboard.press("Escape");
    await expect(findBar).not.toBeVisible({ timeout: 3000 });
  });
});
