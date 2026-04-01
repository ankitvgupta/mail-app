import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/** Best-effort screenshot */
async function screenshot(page: Page, name: string) {
  const { mkdirSync } = await import("fs");
  mkdirSync("tests/screenshots", { recursive: true });
  await page.screenshot({ path: `tests/screenshots/${name}.png`, timeout: 5000 }).catch(() => {
    console.log(`Screenshot '${name}' timed out, skipping`);
  });
}

/** Count inbox thread rows */
async function countInboxThreads(page: Page): Promise<number> {
  const rows = page.locator(".overflow-y-auto div[data-thread-id]");
  return rows.count();
}

/** Select the first inbox thread via keyboard */
async function selectFirstThread(page: Page): Promise<void> {
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
}

/** Get the currently highlighted row's text */
async function getSelectedRowText(page: Page): Promise<string | null> {
  // The highlighted row has bg-blue-600 class on the outer div
  const selected = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600").first();
  if (await selected.isVisible().catch(() => false)) {
    return selected.textContent();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cmd/Ctrl+Click multi-select
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Multi-Select", () => {
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

  test("Cmd+click selects multiple threads and shows batch action bar", async () => {
    await page.waitForTimeout(1000);

    // Screenshot: initial inbox state
    await screenshot(page, "batch-01-initial-inbox");

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

    // Screenshot: two threads selected, batch bar visible
    await screenshot(page, "batch-02-two-selected");

    // Batch action bar should be visible
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toBeVisible({ timeout: 3000 });

    // Should show "2 selected"
    await expect(batchBar).toContainText("2 selected");

    // Checkboxes should be visible
    const checkboxes = page.locator("[data-testid='thread-checkbox']");
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount).toBeGreaterThan(0);

    // Screenshot: batch action bar close-up
    await screenshot(page, "batch-03-action-bar-visible");
  });

  test("Cmd+click third thread adds to selection", async () => {
    // Cmd+click a third thread
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(2).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("3 selected");

    await screenshot(page, "batch-04-three-selected");
  });

  test("Cmd+click already selected thread deselects it", async () => {
    // Cmd+click the second thread again to deselect
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("2 selected");

    await screenshot(page, "batch-05-deselected-one");
  });

  test("Escape clears multi-selection", async () => {
    // Press Escape to clear selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Batch bar should be hidden
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).not.toBeVisible({ timeout: 3000 });

    await screenshot(page, "batch-06-selection-cleared");
  });
});

// ---------------------------------------------------------------------------
// Keyboard multi-select with 'x'
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Keyboard Select (x)", () => {
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

  test("pressing 'x' toggles current thread selection", async () => {
    await page.waitForTimeout(1000);

    // Navigate to first thread
    await selectFirstThread(page);

    // Press 'x' to select it
    await page.keyboard.press("x");
    await page.waitForTimeout(300);

    // Batch bar should appear with "1 selected"
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toBeVisible({ timeout: 3000 });
    await expect(batchBar).toContainText("1 selected");

    await screenshot(page, "batch-07-x-single-select");

    // Navigate down and select another
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("x");
    await page.waitForTimeout(300);

    await expect(batchBar).toContainText("2 selected");

    await screenshot(page, "batch-08-x-two-selected");
  });

  test("pressing 'x' again on selected thread deselects it", async () => {
    // Navigate back up to the first thread
    await page.keyboard.press("k");
    await page.waitForTimeout(200);

    // Press 'x' again to deselect
    await page.keyboard.press("x");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("1 selected");

    // Clear selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

// ---------------------------------------------------------------------------
// Cmd+A select all
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Select All (Cmd+A)", () => {
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
    await page.waitForTimeout(1000);

    const totalThreads = await countInboxThreads(page);
    expect(totalThreads).toBeGreaterThan(0);

    // Cmd+A to select all
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toBeVisible({ timeout: 3000 });
    await expect(batchBar).toContainText(`${totalThreads} selected`);

    await screenshot(page, "batch-09-select-all");
  });

  test("Escape after select-all clears all selection", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).not.toBeVisible({ timeout: 3000 });

    await screenshot(page, "batch-10-select-all-cleared");
  });
});

// ---------------------------------------------------------------------------
// Batch archive
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Archive Multiple", () => {
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

  test("batch archive removes multiple threads at once", async () => {
    await page.waitForTimeout(1000);

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(2);

    // Select first two threads with Cmd+click
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);

    // Screenshot: before batch archive
    await screenshot(page, "batch-11-before-archive");

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("2 selected");

    // Click archive button in the batch bar
    await page.locator("[data-testid='batch-archive']").click();
    await page.waitForTimeout(500);

    // Count should decrease by 2
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 3000 });

    // Batch bar should be gone (selection cleared)
    await expect(batchBar).not.toBeVisible({ timeout: 3000 });

    await screenshot(page, "batch-12-after-archive");
  });

  test("keyboard 'e' archives multiple selected threads", async () => {
    const countBefore = await countInboxThreads(page);
    if (countBefore < 3) {
      test.skip();
      return;
    }

    // Select two threads via keyboard
    await selectFirstThread(page);
    await page.keyboard.press("x");
    await page.waitForTimeout(200);
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("x");
    await page.waitForTimeout(200);

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("2 selected");

    // Press 'e' to batch archive
    await page.keyboard.press("e");
    await page.waitForTimeout(500);

    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 3000 });

    await screenshot(page, "batch-13-keyboard-archive");
  });
});

// ---------------------------------------------------------------------------
// Batch trash
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Trash Multiple", () => {
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

  test("batch trash removes multiple threads via button", async () => {
    await page.waitForTimeout(1000);

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(2);

    // Select two threads
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);

    await screenshot(page, "batch-14-before-trash");

    // Click trash button
    await page.locator("[data-testid='batch-trash']").click();
    await page.waitForTimeout(500);

    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 3000 });

    await screenshot(page, "batch-15-after-trash");
  });

  test("keyboard '#' trashes multiple selected threads", async () => {
    const countBefore = await countInboxThreads(page);
    if (countBefore < 3) {
      test.skip();
      return;
    }

    // Select via keyboard
    await selectFirstThread(page);
    await page.keyboard.press("x");
    await page.waitForTimeout(200);
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("x");
    await page.waitForTimeout(200);

    // Press '#' to batch trash
    await page.keyboard.type("#");
    await page.waitForTimeout(500);

    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 3000 });

    await screenshot(page, "batch-16-keyboard-trash");
  });
});

// ---------------------------------------------------------------------------
// Batch mark unread
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Mark Unread", () => {
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

  test("batch mark unread via button updates thread state", async () => {
    await page.waitForTimeout(1000);

    // Select first two threads
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    const rowCount = await threadRows.count();
    expect(rowCount).toBeGreaterThan(1);

    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);
    await threadRows.nth(1).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    await screenshot(page, "batch-17-before-mark-unread");

    // Click mark unread button
    await page.locator("[data-testid='batch-mark-unread']").click();
    await page.waitForTimeout(500);

    // Batch bar should be cleared after action
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).not.toBeVisible({ timeout: 3000 });

    await screenshot(page, "batch-18-after-mark-unread");
  });
});

// ---------------------------------------------------------------------------
// Shift+click range select
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Shift+Click Range Select", () => {
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

  test("Shift+click selects a range of threads", async () => {
    await page.waitForTimeout(1000);

    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    const rowCount = await threadRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(4);

    // Cmd+click to select the first thread (establishes anchor)
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(200);

    // Shift+click the fourth thread to select a range (0,1,2,3)
    await threadRows.nth(3).click({ modifiers: ["Shift"] });
    await page.waitForTimeout(300);

    // Should have 4 selected
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toBeVisible({ timeout: 3000 });
    await expect(batchBar).toContainText("4 selected");

    await screenshot(page, "batch-19-shift-click-range");

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

// ---------------------------------------------------------------------------
// Checkbox direct click
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Checkbox Click", () => {
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

  test("clicking checkbox selects thread without opening detail", async () => {
    await page.waitForTimeout(1000);

    // First Cmd+click one thread to enter multi-select mode so checkboxes show
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Now checkboxes should be visible — click the second checkbox
    const checkboxes = page.locator("[data-testid='thread-checkbox']");
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount).toBeGreaterThan(1);

    await checkboxes.nth(1).click();
    await page.waitForTimeout(300);

    // Should now have 2 selected
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText("2 selected");

    await screenshot(page, "batch-20-checkbox-select");

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

// ---------------------------------------------------------------------------
// Select All button in batch bar
// ---------------------------------------------------------------------------
test.describe("Batch Actions - Select All Button", () => {
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

  test("Select All button in batch bar selects all threads", async () => {
    await page.waitForTimeout(1000);

    const totalThreads = await countInboxThreads(page);
    expect(totalThreads).toBeGreaterThan(2);

    // Select one thread to show batch bar
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id] button");
    await threadRows.nth(0).click({ modifiers: ["Meta"] });
    await page.waitForTimeout(300);

    // Click "Select all" link in batch bar
    const selectAllBtn = page.locator("[data-testid='batch-select-all']");
    await expect(selectAllBtn).toBeVisible({ timeout: 3000 });
    await selectAllBtn.click();
    await page.waitForTimeout(300);

    // All threads should be selected
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await expect(batchBar).toContainText(`${totalThreads} selected`);

    await screenshot(page, "batch-21-select-all-button");

    // Clear button should work
    const clearBtn = page.locator("[data-testid='batch-clear-selection']");
    await clearBtn.click();
    await page.waitForTimeout(300);

    await expect(batchBar).not.toBeVisible({ timeout: 3000 });

    await screenshot(page, "batch-22-clear-button");
  });
});
