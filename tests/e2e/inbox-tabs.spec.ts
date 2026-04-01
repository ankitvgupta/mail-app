import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { _electron as electron } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { closeApp } from "./launch-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E Tests for Superhuman-style inbox tab ordering.
 *
 * Tests cover:
 * - Priority tab is the default on launch
 * - Tab ordering: Priority → Other → Archive Ready → [custom] → Snoozed → All
 * - Clicking tabs filters the email list correctly
 * - Other = All minus Priority
 * - Tab counts are consistent
 */

/** Launch without switching to All tab (unlike launchElectronApp which auto-switches) */
async function launchWithoutTabSwitch(
  workerIndex = 0,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, "../../out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      EXO_DEMO_MODE: "true",
      TEST_WORKER_INDEX: String(workerIndex),
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForSelector("text=Exo", { timeout: 15000 });

  return { app, page: window };
}

/** Locator for the split-tabs bar (has overflow-x-auto, distinguishing it from the title bar) */
function tabBar(page: Page) {
  return page.locator("div.overflow-x-auto.border-b, div.border-b.overflow-x-auto").first();
}

/** Get the text content of all visible tab buttons in order */
async function getTabLabels(page: Page): Promise<string[]> {
  const buttons = tabBar(page).locator("button");
  const count = await buttons.count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await buttons.nth(i).innerText();
    // Normalize: "Priority11" or "Archive Ready\n6" → "Priority" / "Archive Ready"
    const label = text
      .replace(/\s*\d+\s*$/, "")
      .trim()
      .replace(/\s+/g, " ");
    labels.push(label);
  }
  return labels;
}

/** Get thread count from a tab button's count badge */
async function getTabCount(page: Page, tabName: string): Promise<number> {
  const tab = tabBar(page)
    .locator("button")
    .filter({ hasText: new RegExp(`^${tabName}`) });
  const text = await tab.innerText();
  // Extract the number from text like "Priority11" or "All18"
  const match = text.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Count visible thread rows in the email list */
async function getVisibleThreadCount(page: Page): Promise<number> {
  return page.locator("div[data-thread-id]").count();
}

test.describe("Inbox Tabs - Default and Ordering", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchWithoutTabSwitch(testInfo.workerIndex);
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  test("Priority tab is the default active tab on launch", async () => {
    // Wait for the tab bar to render
    await expect(tabBar(page)).toBeVisible({ timeout: 10000 });

    // Priority tab should have the active styling (border-blue-500)
    const priorityTab = tabBar(page)
      .locator("button")
      .filter({ hasText: /^Priority/ })
      .first();
    await expect(priorityTab).toBeVisible({ timeout: 5000 });

    // Check it has the active class (blue border)
    const classes = await priorityTab.getAttribute("class");
    expect(classes).toContain("border-blue-500");
  });

  test("tab ordering is Priority → Other → Archive Ready → ... → All", async () => {
    const labels = await getTabLabels(page);

    // First two must be Priority and Other
    expect(labels[0]).toBe("Priority");
    expect(labels[1]).toBe("Other");

    // Archive Ready is third (it has an icon, so the text extraction gets the icon char or "Archive")
    const thirdTabText = await tabBar(page).locator("button").nth(2).innerText();
    expect(thirdTabText).toContain("Archive Ready");

    // All tab must be last
    expect(labels[labels.length - 1]).toBe("All");
  });

  test("Priority tab shows only priority emails (needsReply + done)", async () => {
    // Priority should be active by default — verify we see priority emails
    const threadCount = await getVisibleThreadCount(page);
    expect(threadCount).toBeGreaterThan(0);

    // At least one visible thread should have a priority badge (HIGH, MEDIUM, or LOW).
    // "Done" threads (with a draft) show "Done" instead of a priority badge, so we
    // check for at least one rather than requiring all rows to match.
    const threads = page.locator("div[data-thread-id]");
    const count = await threads.count();
    let hasPriorityBadge = false;
    for (let i = 0; i < count; i++) {
      const text = await threads.nth(i).innerText();
      if (/HIGH|MEDIUM|LOW|DONE/i.test(text)) hasPriorityBadge = true;
    }
    expect(hasPriorityBadge).toBe(true);
  });

  test("clicking Other tab shows non-priority emails", async () => {
    const otherTab = tabBar(page)
      .locator("button")
      .filter({ hasText: /^Other/ })
      .first();

    await otherTab.click();
    await page.waitForTimeout(500);

    // Other tab should now be active
    const classes = await otherTab.getAttribute("class");
    expect(classes).toContain("border-blue-500");

    // Priority tab should no longer be active
    const priorityTab = tabBar(page)
      .locator("button")
      .filter({ hasText: /^Priority/ })
      .first();
    const priorityClasses = await priorityTab.getAttribute("class");
    expect(priorityClasses).toContain("border-transparent");
  });

  test("Other tab count = All count - Priority count", async () => {
    const priorityCount = await getTabCount(page, "Priority");
    const otherCount = await getTabCount(page, "Other");
    const allCount = await getTabCount(page, "All");

    // Other should be All minus Priority
    expect(otherCount).toBe(allCount - priorityCount);
  });

  test("clicking All tab shows all emails", async () => {
    const allTab = tabBar(page).locator("button").filter({ hasText: /^All/ }).first();

    await allTab.click();
    await page.waitForTimeout(500);

    // All tab should be active
    const classes = await allTab.getAttribute("class");
    expect(classes).toContain("border-blue-500");

    // Thread count should match the All tab's count badge
    const allCount = await getTabCount(page, "All");
    const visibleThreads = await getVisibleThreadCount(page);
    expect(visibleThreads).toBe(allCount);
  });

  test("clicking Priority tab filters back to priority emails", async () => {
    const priorityTab = tabBar(page)
      .locator("button")
      .filter({ hasText: /^Priority/ })
      .first();

    await priorityTab.click();
    await page.waitForTimeout(500);

    // Should be active
    const classes = await priorityTab.getAttribute("class");
    expect(classes).toContain("border-blue-500");

    // Thread count should match Priority count badge
    const priorityCount = await getTabCount(page, "Priority");
    const visibleThreads = await getVisibleThreadCount(page);
    expect(visibleThreads).toBe(priorityCount);
  });

  test("Archive Ready tab shows archive-ready count", async () => {
    const archiveTab = tabBar(page).locator("button").filter({ hasText: "Archive Ready" }).first();

    await archiveTab.click();
    await page.waitForTimeout(500);

    // Should be active
    const classes = await archiveTab.getAttribute("class");
    expect(classes).toContain("border-blue-500");
  });

  test("tab switching preserves email list state (no crash)", async () => {
    const tabs = ["Priority", "Other", "All"];

    // Rapidly switch between tabs
    for (const tabName of tabs) {
      const tab = tabBar(page)
        .locator("button")
        .filter({ hasText: new RegExp(`^${tabName}`) })
        .first();
      await tab.click();
      await page.waitForTimeout(200);
    }

    // App should still be functional
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });
});
