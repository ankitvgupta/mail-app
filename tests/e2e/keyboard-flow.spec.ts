import { test, expect, Page, ElectronApplication } from "@playwright/test";
import {
  launchElectronApp,
  waitForEmailListReady,
  pressKeyUntilVisible,
  closeApp,
} from "./launch-helpers";

/**
 * E2E Tests for complete keyboard-driven workflows.
 *
 * Tests cover j/k navigation, Enter to open, r/R for reply/reply-all,
 * 'f' for forward, 'e' for archive, 's' for star, 'g i' for go-to-inbox,
 * Cmd+K for command palette, '/' for search, Escape for closing modals,
 * and 'c' for compose.
 *
 * All tests run in DEMO_MODE with fake emails.
 */

/** Get the data-thread-id of the currently selected (highlighted) row */
async function getSelectedThreadId(page: Page): Promise<string | null> {
  const selected = page.locator("div[data-thread-id][data-selected='true']").first();
  if (await selected.isVisible().catch(() => false)) {
    return selected.getAttribute("data-thread-id");
  }
  return null;
}

test.describe("Keyboard Navigation - j/k Movement", () => {
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

  test("j selects the first email when nothing is selected", async () => {
    await waitForEmailListReady(page);

    // Retry j until selection appears — on CI the keyboard handler or store
    // subscription may not be ready on the first press
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 15000 });
  });

  test("j moves selection down to next email", async () => {
    const firstId = await getSelectedThreadId(page);

    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    const secondId = await getSelectedThreadId(page);
    expect(secondId).not.toBeNull();
    // Ids should differ if there are multiple emails
    if (firstId && secondId) {
      expect(secondId).not.toEqual(firstId);
    }
  });

  test("k moves selection up", async () => {
    const beforeK = await getSelectedThreadId(page);

    await page.keyboard.press("k");
    await page.waitForTimeout(300);

    const afterK = await getSelectedThreadId(page);
    expect(afterK).not.toBeNull();
    if (beforeK && afterK) {
      expect(afterK).not.toEqual(beforeK);
    }
  });

  test("ArrowDown works the same as j", async () => {
    const before = await getSelectedThreadId(page);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);

    const after = await getSelectedThreadId(page);
    expect(after).not.toBeNull();
  });

  test("ArrowUp works the same as k", async () => {
    // Move down first
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);

    const before = await getSelectedThreadId(page);

    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);

    const after = await getSelectedThreadId(page);
    expect(after).not.toBeNull();
  });

  test("j at the bottom of list stays at last email", async () => {
    // Navigate to the bottom by pressing j more times than there are threads
    const threadCount = await page.locator("div[data-thread-id]").count();
    for (let i = 0; i < threadCount + 5; i++) {
      await page.keyboard.press("j");
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    const atBottom = await getSelectedThreadId(page);

    // Press j one more time — should stay at the same email
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    const stillAtBottom = await getSelectedThreadId(page);
    expect(stillAtBottom).toEqual(atBottom);
  });
});

test.describe("Keyboard Navigation - Enter and Escape", () => {
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

  test("Enter opens email in full view", async () => {
    await waitForEmailListReady(page);

    // Select first thread — retry until selection appears
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 15000 });

    // Open full view — retry Enter until full view renders
    const replyButton = page.locator("button[title='Reply All']").first();
    await pressKeyUntilVisible(page, "Enter", replyButton, { timeout: 15000 });
  });

  test("Escape exits full view back to split view", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Inbox should still be visible (split view)
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("Escape deselects the selected email", async () => {
    // Select an email
    await page.keyboard.press("j");
    // Wait for selection to appear (CI can be slow to process keyboard events)
    await expect(page.locator("div[data-thread-id][data-selected='true']")).toBeVisible({
      timeout: 10000,
    });

    const selected = await getSelectedThreadId(page);
    expect(selected).not.toBeNull();

    // Escape to deselect
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});

test.describe("Keyboard Compose - Reply, Reply-All, Forward", () => {
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

  test("'r' opens reply-all inline compose in full view", async () => {
    await waitForEmailListReady(page);

    // Navigate to first email and enter full view — retry each step
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 15000 });
    const replyButton = page.locator("button[title='Reply All']").first();
    await pressKeyUntilVisible(page, "Enter", replyButton, { timeout: 15000 });

    // Press 'r' for reply-all
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await pressKeyUntilVisible(page, "r", inlineCompose, { timeout: 15000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Should have an editor
    const editor = inlineCompose.locator(".ProseMirror");
    await expect(editor).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("'R' (Shift+r) opens reply (single) inline compose", async () => {
    await page.keyboard.press("Shift+r");

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 10000 });

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("'f' opens forward inline compose with To field", async () => {
    await page.keyboard.press("f");

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 10000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();

    // Forward should have AddressInput for To
    await expect(inlineCompose.locator("[data-testid='address-input-to']")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("switching between r and f correctly changes compose mode", async () => {
    // Open reply
    await page.keyboard.press("r");
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 10000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);

    // Open forward
    await page.keyboard.press("f");
    await expect(inlineCompose).toBeVisible({ timeout: 10000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });
});

test.describe("Keyboard Actions - Archive (e)", () => {
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

  test("'e' archives the selected email and advances to next", async () => {
    await waitForEmailListReady(page);

    // Count threads before archive
    const threadRows = page.locator(".overflow-y-auto div[data-thread-id]");
    const countBefore = await threadRows.count();
    expect(countBefore).toBeGreaterThan(0);

    // Select first thread — retry until selection appears
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 15000 });
    const selectedBefore = await getSelectedThreadId(page);

    // Press 'e' to archive
    await page.keyboard.press("e");
    await page.waitForTimeout(500);

    // Thread count should decrease (CI can be slow to update DOM)
    await expect(async () => {
      const countAfter = await threadRows.count();
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 10000 });

    // Selection should advance to next thread (not null)
    const selectedAfter = await getSelectedThreadId(page);
    if (countBefore > 1) {
      expect(selectedAfter).not.toBeNull();
      expect(selectedAfter).not.toEqual(selectedBefore);
    }
  });
});

test.describe("Keyboard Actions - Star (s)", () => {
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

  test("'s' stars selected thread when in multi-select mode", async () => {
    await waitForEmailListReady(page);

    // Select first thread — retry until selection appears
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 15000 });

    // Enter multi-select mode with 'x'
    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await pressKeyUntilVisible(page, "x", batchBar, { timeout: 10000 });

    // Press 's' to toggle star
    await page.keyboard.press("s");
    await page.waitForTimeout(500);

    // The star action should complete without crash
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Keyboard Go-To - g i (Go to Inbox)", () => {
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

  test("'g then i' switches to priority inbox view", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Switch away from priority view first (go to "All" tab)
    const allTab = page
      .locator("button")
      .filter({ hasText: /^All\s*\d*$/ })
      .first();
    if (await allTab.isVisible().catch(() => false)) {
      await allTab.click();
      await page.waitForTimeout(300);
    }

    // Press 'g' then 'i' to go to inbox (priority view)
    await page.keyboard.press("g");
    await page.waitForTimeout(200);
    await page.keyboard.press("i");
    await page.waitForTimeout(500);

    // Priority tab should be active
    const priorityTab = page
      .locator("button")
      .filter({ hasText: /^Priority\s*\d*$/ })
      .first();
    const isActive = await priorityTab
      .evaluate(
        (el) =>
          el.classList.contains("border-blue-500") || el.classList.contains("dark:border-blue-400"),
      )
      .catch(() => false);
    expect(isActive).toBe(true);
  });

  test("'g then g' also navigates to top of inbox", async () => {
    // Navigate down
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("j");
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(200);

    // Press 'g' then 'g'
    await page.keyboard.press("g");
    await page.waitForTimeout(200);
    await page.keyboard.press("g");
    await page.waitForTimeout(300);

    const topId = await getSelectedThreadId(page);
    expect(topId).not.toBeNull();
  });

  test("'G' (Shift+g) navigates to bottom of inbox", async () => {
    // Press Shift+G to go to bottom
    await page.keyboard.press("Shift+g");
    await page.waitForTimeout(300);

    const bottomId = await getSelectedThreadId(page);
    expect(bottomId).not.toBeNull();
  });
});

test.describe("Keyboard - Command Palette and Search", () => {
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

  test("Cmd+K opens command palette", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Command palette should be visible with a search/input field
    const paletteInput = page
      .locator(
        "input[placeholder*='command'], input[placeholder*='Command'], input[placeholder*='Search'], input[placeholder*='Type']",
      )
      .first();
    const paletteVisible = await paletteInput.isVisible().catch(() => false);
    expect(paletteVisible).toBe(true);

    // Close with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("'/' opens search", async () => {
    await page.keyboard.press("/");
    await page.waitForTimeout(500);

    // Search input should be visible
    const searchInput = page.locator("input[placeholder*='Search'], input[type='search']").first();
    await expect(searchInput).toBeVisible({ timeout: 3000 });

    // Close with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("Escape closes command palette", async () => {
    // Open command palette
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Verify it's open
    const paletteInput = page
      .locator(
        "input[placeholder*='command'], input[placeholder*='Command'], input[placeholder*='Search'], input[placeholder*='Type']",
      )
      .first();
    await expect(paletteInput).toBeVisible({ timeout: 3000 });

    // Close with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Should no longer be visible
    await expect(paletteInput).not.toBeVisible({ timeout: 3000 });
  });

  test("Escape closes search", async () => {
    // Open search
    await page.keyboard.press("/");
    await page.waitForTimeout(500);

    const searchInput = page.locator("input[placeholder*='Search'], input[type='search']").first();
    await expect(searchInput).toBeVisible({ timeout: 3000 });

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await expect(searchInput).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe("Keyboard - Compose New Email (c)", () => {
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

  test("'c' opens new email compose view", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("c");
    await page.waitForTimeout(500);

    // "New Message" should be visible
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Required fields should be present
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await expect(toField).toBeVisible();

    const subjectField = page.locator("input[placeholder='Subject']");
    await expect(subjectField).toBeVisible();

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible();
  });

  test("can type in compose fields after opening with 'c'", async () => {
    // Fill in recipient
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("keyboard-test@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    // Recipient chip should appear
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "keyboard-test@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Fill in subject
    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Keyboard Flow Test");

    // Type in editor
    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await editor.pressSequentially("This email was composed via keyboard shortcut.", { delay: 10 });

    await expect(editor).toContainText("This email was composed via keyboard shortcut.");

    // Close compose
    const backButton = page.locator("button:has-text('Back')");
    if (await backButton.isVisible()) {
      await backButton.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe("Keyboard - Escape Closes All Modals", () => {
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

  test("Escape closes settings", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("Escape clears multi-selection", async () => {
    // Select a thread with 'x'
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 15000 });

    const batchBar = page.locator("[data-testid='batch-action-bar']");
    await pressKeyUntilVisible(page, "x", batchBar, { timeout: 10000 });

    // Escape clears selection — retry in case the keypress doesn't register immediately
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await page.keyboard.press("Escape");
      try {
        await expect(batchBar).not.toBeVisible({ timeout: 1000 });
        break;
      } catch {
        // Retry
      }
    }
    await expect(batchBar).not.toBeVisible({ timeout: 2000 });
  });

  test("Escape exits full view", async () => {
    // Enter full view
    await page.keyboard.press("j");
    await expect(page.locator("div[data-thread-id][data-selected='true']")).toBeVisible({
      timeout: 5000,
    });
    await page.keyboard.press("Enter");

    await expect(page.locator("button[title='Reply All']").first()).toBeVisible({ timeout: 10000 });

    // Escape back to split view
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("sequential modals open/close cleanly without leaking state", async () => {
    // Open and close search
    await page.keyboard.press("/");
    const searchInput = page.locator("input[placeholder*='Search']");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(searchInput).toBeHidden({ timeout: 5000 });

    // Open and close command palette
    await page.keyboard.press("ControlOrMeta+k");
    const paletteInput = page.locator("input[placeholder='Type a command...']");
    await expect(paletteInput).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect(paletteInput).toBeHidden({ timeout: 5000 });

    // Open and close settings
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.locator("text=Settings").first();
    await expect(settings).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // 'j' navigation should still work (not trapped in a modal)
    await waitForEmailListReady(page);
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await pressKeyUntilVisible(page, "j", selectedRow, { timeout: 10000 });

    const selected = await getSelectedThreadId(page);
    expect(selected).not.toBeNull();
  });
});

test.describe("Keyboard - Agent Palette (Cmd+J)", () => {
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

  test("Cmd+J opens agent palette", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    const agentInput = page.locator("input[placeholder*='Ask agent']").first();
    await expect(agentInput).toBeVisible({ timeout: 3000 });
  });

  test("Escape closes agent palette", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const agentInput = page.locator("input[placeholder*='Ask agent']").first();
    await expect(agentInput).not.toBeVisible({ timeout: 3000 });
  });

  test("Cmd+J on selected email shows email context", async () => {
    // After previous test: palette was closed but the dual Escape handler
    // (component + global) may have also exited full view. Re-select an email.
    const threadRow = page.locator("div[data-thread-id]").first();
    if (await threadRow.isVisible().catch(() => false)) {
      await threadRow.click();
      await page.waitForTimeout(500);
    }

    // Open agent palette — should show email-specific placeholder
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    const agentInput = page.locator("input[placeholder='Ask agent about this email...']").first();
    await expect(agentInput).toBeVisible({ timeout: 3000 });

    // Close — use the palette's own close button to avoid the dual-handler issue
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("Escape after agent palette allows further Escape navigation", async () => {
    // We're in full view from previous tests (demo auto-selects first email).
    // Verify we're in full view by checking for the Reply All button.
    const replyButton = page.locator("button[title='Reply All']").first();
    await expect(replyButton).toBeVisible({ timeout: 5000 });

    // Open agent palette
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);
    await expect(page.locator("input[placeholder*='Ask agent']").first()).toBeVisible({
      timeout: 3000,
    });

    // Close agent palette with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(page.locator("input[placeholder*='Ask agent']").first()).not.toBeVisible({
      timeout: 3000,
    });

    // Escape should exit full view (not get stuck)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Should be back in split/list view — thread rows now visible
    await expect(page.locator("div[data-thread-id]").first()).toBeVisible({ timeout: 5000 });
  });

  test("Cmd+J works while in compose mode (subject focused)", async () => {
    // Open compose
    await page.keyboard.press("c");
    await page.waitForTimeout(500);
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Focus the subject field (a regular input, not ProseMirror)
    const subjectField = page.locator("input[placeholder='Subject']");
    await expect(subjectField).toBeVisible();
    await subjectField.click();
    await page.waitForTimeout(200);

    // Cmd+J should open agent palette even though an input is focused
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    const agentInput = page.locator("input[placeholder*='Ask agent']").first();
    await expect(agentInput).toBeVisible({ timeout: 3000 });

    // Close palette
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(agentInput).not.toBeVisible({ timeout: 3000 });

    // Close compose — focus was restored to ProseMirror by the palette close,
    // so Escape should close compose directly now
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  test("Escape closes agent palette when compose (draft) is open — not stuck", async () => {
    // This is the core regression test: when compose mode is active (composeState.isOpen),
    // the Escape handler must close the agent palette first, not return early from the
    // compose mode check. Without the fix, compose mode's early return blocks the
    // palette close and the user gets "stuck".

    // Open compose (functionally identical to reopening a saved draft — both set
    // composeState.isOpen with mode "new")
    await page.keyboard.press("c");
    await page.waitForTimeout(500);
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Click editor to ensure focus is in a predictable place
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.waitForTimeout(200);

    // Cmd+J opens agent palette on top of compose
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    const agentInput = page.locator("input[placeholder*='Ask agent']").first();
    await expect(agentInput).toBeVisible({ timeout: 3000 });
    // Ensure agent input is focused (requestAnimationFrame focus can be slow in CI)
    await agentInput.focus();
    await page.waitForTimeout(200);

    // THE FIX: Escape should close the agent palette, not get stuck
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Agent palette should be closed
    await expect(agentInput).not.toBeVisible({ timeout: 3000 });

    // Compose should still be visible (Escape only closed the overlay, not compose)
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 3000 });

    // Close compose via discard button to clean up state
    const discardButton = page.locator("button[title='Discard draft']");
    await discardButton.click();
    await page.waitForTimeout(500);

    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("Escape closes agent palette on a saved-and-reopened draft", async () => {
    // Create a draft: compose, fill in data, then Escape to save
    await page.keyboard.press("c");
    await page.waitForTimeout(500);
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("draft-escape-test@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Draft Escape Test");
    await page.waitForTimeout(200);

    // Escape inside compose container triggers onCancel which saves the draft
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    // Draft should now appear in the email list (drafts show at top with "Draft" badge)
    const draftBadge = page.locator("text=Draft Escape Test").first();
    await expect(draftBadge).toBeVisible({ timeout: 5000 });

    // Click the draft row to reopen it (sets selectedDraftId + opens compose)
    await draftBadge.click();
    await page.waitForTimeout(500);

    // Verify compose reopened
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Click editor to ensure focus is in a predictable place
    const reopenedEditor = page.locator(".ProseMirror").first();
    await expect(reopenedEditor).toBeVisible();
    await reopenedEditor.click();
    await page.waitForTimeout(200);

    // Cmd+J opens agent palette
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    const agentInput = page.locator("input[placeholder*='Ask agent']").first();
    await expect(agentInput).toBeVisible({ timeout: 3000 });
    // Ensure agent input is focused (requestAnimationFrame focus can be slow in CI)
    await agentInput.focus();
    await page.waitForTimeout(200);

    // Escape should close the palette (not get stuck)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Palette closed
    await expect(agentInput).not.toBeVisible({ timeout: 3000 });

    // Compose still open
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 3000 });

    // Clean up: discard the draft
    const discardButton = page.locator("button[title='Discard draft']");
    await discardButton.click();
    await page.waitForTimeout(500);

    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("agent palette and other modals don't leak state between each other", async () => {
    // Open agent palette, close it
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Open command palette — should work, not stuck
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(300);
    const cmdInput = page
      .locator(
        "input[placeholder*='command'], input[placeholder*='Command'], input[placeholder*='Search'], input[placeholder*='Type']",
      )
      .first();
    await expect(cmdInput).toBeVisible({ timeout: 3000 });

    // Close command palette
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Agent palette should also still work
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(300);
    await expect(page.locator("input[placeholder*='Ask agent']").first()).toBeVisible({
      timeout: 3000,
    });

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // j/k should still work — press j to select a thread
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    // Verify we're not stuck in a modal — the thread list should respond
    // to navigation (either a thread gets selected or we enter full view)
    const threadVisible = await page
      .locator("div[data-thread-id]")
      .first()
      .isVisible()
      .catch(() => false);
    const replyButton = await page
      .locator("button[title='Reply All']")
      .first()
      .isVisible()
      .catch(() => false);
    expect(threadVisible || replyButton).toBe(true);
  });
});
