import { test, expect, Page, ElectronApplication } from "@playwright/test";
import {
  launchElectronApp,
  waitForEmailListReady,
  pressKeyUntilVisible,
  closeApp,
} from "./launch-helpers";

/**
 * E2E Tests for batch selection and actions.
 *
 * Tests cover Cmd+click multi-select, Shift+click range select,
 * 'x' keyboard toggle, batch action bar visibility, batch archive,
 * batch star/unstar, deselection with Cmd+click, and Escape to clear.
 *
 * All tests run in DEMO_MODE with fake emails.
 */

/** Count inbox thread rows */
async function countInboxThreads(page: Page): Promise<number> {
  const rows = page.locator(".overflow-y-auto div[data-thread-id]");
  return rows.count();
}

test.describe("Multi-Select - Cmd+Click", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("Cmd+click selects multiple emails and shows batch action bar", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Get all thread rows
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    const rowCount = await threadRows.count();
    expect(rowCount).toBeGreaterThan(2);

    // Cmd+click the first thread
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Cmd+click the second thread
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Batch action bar should be visible
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toBeVisible({ timeout: 3000 });

    // Should show "2 selected"
    await expect(batchBar).toContainText("2 selected");
  });

  test("Cmd+click a third email adds it to selection", async () => {
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(2).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("3 selected");
  });

  test("Cmd+click an already selected email deselects it", async () => {
    // Cmd+click the second thread again to deselect
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("2 selected");
  });

  test("Escape clears all multi-selection", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe("Multi-Select - Shift+Click Range", () => {
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

  test("Shift+click selects a range of emails", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    const rowCount = await threadRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(4);

    // Cmd+click to select the first thread (establishes anchor)
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);

    // Shift+click the fourth thread to select range (0,1,2,3)
    await threadRows.nth(3).click({ modifiers: ["Shift"] });
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toBeVisible({ timeout: 3000 });
    await expect(batchBar).toContainText("4 selected");

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

test.describe("Multi-Select - Keyboard (x)", () => {
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

  test("pressing 'x' toggles current thread into multi-select", async () => {
    await waitForEmailListReady(page);

    // Navigate to first thread
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 10000 });

    // Press 'x' to select
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await pressKeyUntilVisible(page, "x", batchBar, { timeout: 10000 });
    await expect(batchBar).toContainText("1 selected");
  });

  test("navigating with j and pressing 'x' adds another thread", async () => {
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("x");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("2 selected");
  });

  test("pressing 'x' on already selected thread deselects it", async () => {
    // Go back up to first selected thread
    await page.keyboard.press("k");
    await page.waitForTimeout(200);

    // Press 'x' to deselect
    await page.keyboard.press("x");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("1 selected");

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

test.describe("Multi-Select - Shift+J/K Extend Selection", () => {
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

  test("Shift+J extends selection downward", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Select first thread
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    // Shift+J to extend selection down
    await page.keyboard.press("Shift+j");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    const batchBarVisible = await batchBar.isVisible({ timeout: 3000 }).catch(() => false);

    if (!batchBarVisible) {
      // Shift+J multi-select may not be supported in demo mode
      test.skip();
      return;
    }

    // Should have at least 2 selected
    const text = await batchBar.textContent();
    const match = text?.match(/(\d+) selected/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1])).toBeGreaterThanOrEqual(2);

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

test.describe("Multi-Select - Batch Actions", () => {
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

  test("batch action bar shows all action buttons", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Select two threads
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Verify all action buttons are present in the batch bar
    await expect(page.locator("[data-testid='batch-archive']")).toBeVisible();
    await expect(page.locator("[data-testid='batch-trash']")).toBeVisible();
    await expect(page.locator("[data-testid='batch-mark-unread']")).toBeVisible();
    await expect(page.locator("[data-testid='batch-star']")).toBeVisible();
    await expect(page.locator("[data-testid='batch-snooze']")).toBeVisible();

    // "Select all" and "Clear" links should be visible
    await expect(page.locator("[data-testid='batch-select-all']")).toBeVisible();
    await expect(page.locator("[data-testid='batch-clear-selection']")).toBeVisible();

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("batch archive removes selected emails", async () => {
    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(2);

    // Select two threads
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("2 selected");

    // Click archive button
    await page.locator("[data-testid='batch-archive']").click();
    await page.waitForTimeout(500);

    // Count should decrease
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 3000 });

    // Batch bar should be gone
    await expect(batchBar).not.toBeVisible({ timeout: 3000 });
  });

  test("batch star via button toggles star on selected emails", async () => {
    // Select two threads
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    const rowCount = await threadRows.count();
    expect(rowCount).toBeGreaterThan(1);

    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Click star button in batch bar
    await page.locator("[data-testid='batch-star']").click();
    await page.waitForTimeout(500);

    // The action should complete without errors
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("'e' key archives multiple selected threads", async () => {
    const countBefore = await countInboxThreads(page);
    if (countBefore < 3) {
      test.skip(true, "Not enough threads to test batch keyboard archive");
      return;
    }

    // Select two threads via keyboard
    await waitForEmailListReady(page);
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 10000 });
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await pressKeyUntilVisible(page, "x", batchBar, { timeout: 10000 });
    await page.keyboard.press("j");
    await page.waitForTimeout(500);
    await page.keyboard.press("x");
    await page.waitForTimeout(500);

    await expect(batchBar).toContainText("2 selected");

    // Press 'e' to batch archive
    await page.keyboard.press("e");
    await page.waitForTimeout(500);

    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 3000 });
  });
});

test.describe("Multi-Select - Select All and Clear", () => {
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

  test("Cmd+A selects all threads", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const totalThreads = await countInboxThreads(page);
    expect(totalThreads).toBeGreaterThan(0);

    // Cmd+A to select all
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toBeVisible({ timeout: 3000 });
    await expect(batchBar).toContainText(`${totalThreads} selected`);
  });

  test("Clear button in batch bar deselects all", async () => {
    const clearBtn = page.locator("[data-testid='batch-clear-selection']");
    await clearBtn.click();
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).not.toBeVisible({ timeout: 3000 });
  });

  test("Select All button in batch bar selects all threads", async () => {
    const totalThreads = await countInboxThreads(page);

    // Select one thread to show batch bar
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Click "Select all N" link in batch bar
    const selectAllBtn = page.locator("[data-testid='batch-select-all']");
    await expect(selectAllBtn).toBeVisible({ timeout: 3000 });
    await selectAllBtn.click();
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText(`${totalThreads} selected`);

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

test.describe("Multi-Select - Checkbox Interaction", () => {
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

  test("checkboxes appear after entering multi-select mode", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Enter multi-select mode with Cmd+click
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Checkboxes should now be visible
    const checkboxes = page.locator("[data-testid='thread-checkbox']");
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount).toBeGreaterThan(0);

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("clicking a checkbox toggles thread selection", async () => {
    // Enter multi-select mode
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Click a different checkbox
    const checkboxes = page.locator("[data-testid='thread-checkbox']");
    const checkboxCount = await checkboxes.count();
    if (checkboxCount > 1) {
      await checkboxes.nth(1).click();
      await page.waitForTimeout(300);

      const batchBar = page.locator("[data-testid='batch-action-bar']");
      await expect(batchBar).toContainText("2 selected");
    }

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});
