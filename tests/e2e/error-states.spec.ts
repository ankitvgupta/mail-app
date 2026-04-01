import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for error handling and edge cases.
 *
 * Tests cover app load without critical errors, inbox populates
 * in demo mode, long email body rendering, rapid keyboard navigation
 * stress test, modal state leak prevention, and scrollability.
 *
 * All tests run in DEMO_MODE with fake emails.
 */

test.describe("Error States - App Load", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Exclude known harmless errors
        if (
          !text.includes("net::ERR_") &&
          !text.includes("favicon") &&
          !text.includes("DevTools")
        ) {
          consoleErrors.push(text);
        }
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("app loads without critical console errors", async () => {
    // Wait for the app to fully load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);

    // There should be no critical JS errors
    // Some warnings are acceptable, but uncaught exceptions are not
    const criticalErrors = consoleErrors.filter(
      (e) =>
        e.includes("Uncaught") ||
        e.includes("TypeError") ||
        e.includes("ReferenceError") ||
        e.includes("SyntaxError"),
    );

    if (criticalErrors.length > 0) {
      console.error("Critical errors found:", criticalErrors);
    }
    expect(criticalErrors.length).toBe(0);
  });

  test("inbox shows emails in demo mode (not empty)", async () => {
    // At least one email thread should be visible
    const emailItems = page.locator("[data-thread-id]");
    const count = await emailItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test("app title is visible", async () => {
    // The Exo title should be in the titlebar
    await expect(page.locator("text=Exo").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Error States - Empty Inbox Handling", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("archiving all visible emails shows empty state gracefully", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Count initial threads — skip if none exist
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id]");
    const initialCount = await threadRows.count();
    if (initialCount === 0) {
      test.skip();
      return;
    }

    // Select all and archive
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    if (!(await batchBar.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await page.locator("[data-testid='batch-archive']").click();
    await page.waitForTimeout(1000);

    // After archiving all, the inbox should handle empty state
    const remainingCount = await threadRows.count();
    expect(remainingCount).toBe(0);

    // The inbox header should still be visible
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Error States - Long Email Body", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("email body renders without horizontal overflow", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Select first email
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    // Enter full view
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);

    // Check for horizontal overflow
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);

    // Return to split view
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("email list container has content when populated", async () => {
    // Wait for thread rows to render (may take time after returning from full view)
    const threadRows = page.locator("div[data-thread-id]");
    await expect(async () => {
      const count = await threadRows.count();
      expect(count).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
  });
});

test.describe("Error States - Rapid Interactions", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("rapid j/k navigation doesn't crash", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Rapidly press j to navigate down
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("j");
      await page.waitForTimeout(30);
    }

    // Rapidly press k to navigate back up
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("k");
      await page.waitForTimeout(30);
    }

    await page.waitForTimeout(500);

    // App should still be responsive
    const emailItems = page.locator("[data-thread-id]");
    const count = await emailItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test("rapidly opening and closing modals doesn't leak state", async () => {
    // Compose -> close -> search -> close -> settings -> close
    for (let i = 0; i < 3; i++) {
      // Open compose
      await page.keyboard.press("c");
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      // Open search
      await page.keyboard.press("/");
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      // Open command palette
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      // Open settings
      await page.keyboard.press("ControlOrMeta+,");
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }

    // After all rapid open/close cycles, j should still navigate
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    // Inbox should be visible and functional
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("rapid multi-select and deselect doesn't crash", async () => {
    // Rapidly select and deselect with x
    await page.keyboard.press("j");
    await page.waitForTimeout(100);

    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("x");
      await page.waitForTimeout(50);
      await page.keyboard.press("j");
      await page.waitForTimeout(50);
    }

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // App should still work
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Error States - UI Resilience", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("clicking empty space in detail area doesn't crash", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Click on body in a neutral area
    try {
      await page.click("body", { position: { x: 800, y: 400 }, timeout: 1000 });
    } catch {
      // Click might fail if coordinates are outside viewport
    }
    await page.waitForTimeout(500);

    // The click may have opened an email in full view, hiding the list.
    // Press Escape to return to the list view if needed.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // App should still be responsive
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("navigating while settings are open doesn't crash", async () => {
    // Open settings
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // Try pressing j/k (should be ignored in settings)
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("k");
    await page.waitForTimeout(200);

    // Settings should still be visible
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible();

    // Close settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("double-clicking an email doesn't cause issues", async () => {
    // Find an email to double-click
    const emailButton = page
      .locator("button")
      .filter({ hasText: /HIGH|MEDIUM|LOW/ })
      .first();

    if (await emailButton.isVisible()) {
      await emailButton.dblclick();
      await page.waitForTimeout(500);

      // App should handle double-click gracefully
      await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
    }
  });

  test("refresh works after multiple actions", async () => {
    // Perform some actions first
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("j");
    await page.waitForTimeout(200);

    // Click refresh button
    const refreshButton = page.locator("button[title='Refresh']");
    if (await refreshButton.isVisible()) {
      await refreshButton.click();
      await page.waitForTimeout(500);

      // Inbox should still be visible
      await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
    }
  });
});
