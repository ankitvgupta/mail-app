import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

/**
 * E2E Tests for Cmd+F find-in-page functionality.
 *
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
    // Wait for inbox to load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Select first email
    await page.keyboard.press("j");
    await expect(page.locator("div[data-thread-id][data-selected='true']")).toBeVisible({
      timeout: 10000,
    });

    // Open find bar
    await page.keyboard.press("Meta+f");

    // Verify find bar appears with input
    const findBar = page.locator('[data-testid="find-bar"]');
    await expect(findBar).toBeVisible({ timeout: 5000 });

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

  test("Cmd+F and typing shows match count", async () => {
    // Re-open find bar
    await page.keyboard.press("Meta+f");

    const findBar = page.locator('[data-testid="find-bar"]');
    await expect(findBar).toBeVisible({ timeout: 5000 });

    const findInput = page.locator('[data-testid="find-bar-input"]');
    await expect(findInput).toBeFocused();

    // Type a common word that should appear on the page
    await findInput.fill("Inbox");

    // Wait for debounce + findInPage result
    await page.waitForTimeout(500);

    // Should show match count (the word "Inbox" appears in the sidebar)
    await expect(findBar.locator("text=/\\d+ of \\d+/")).toBeVisible({ timeout: 5000 });

    // Close
    await page.keyboard.press("Escape");
    await expect(findBar).not.toBeVisible({ timeout: 3000 });
  });
});
