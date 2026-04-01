import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

let electronApp: ElectronApplication;
let page: Page;

// Helper to read store state
async function getStoreState(page: Page) {
  return page.evaluate(() => {
    const store = (
      window as unknown as { __ZUSTAND_STORE__?: { getState: () => Record<string, unknown> } }
    ).__ZUSTAND_STORE__;
    if (!store) return null;
    const state = store.getState();
    return {
      selectedEmailId: state.selectedEmailId as string | null,
      selectedThreadId: state.selectedThreadId as string | null,
      snoozedThreadIds: Array.from(state.snoozedThreadIds as Set<string>),
      emailCount: (state.emails as unknown[]).length,
      viewMode: state.viewMode as string,
    };
  });
}

test.describe("Snooze — email must leave inbox and cursor must advance", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
      extraEnv: { EXO_TEST_MODE: "true" },
    });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      console.log(`[RENDERER ${msg.type()}]: ${msg.text()}`);
    });

    // Wait for the app to fully load with emails
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low/ })
      .first()
      .waitFor({ timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("snooze removes email from inbox and advances cursor to next thread", async () => {
    // Wait for email list to be fully rendered and React effects to settle
    await expect(page.locator("div[data-thread-id]").first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Step 1: Select a thread (so there's a "next" thread below for cursor advancement)
    // Use retry-based approach — on CI, keyboard events can fire before React state commits
    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    const deadline1 = Date.now() + 15000;
    while (Date.now() < deadline1) {
      await page.keyboard.press("j");
      try {
        await expect(selectedRow).toBeVisible({ timeout: 500 });
        break;
      } catch {
        // retry
      }
    }
    await expect(selectedRow).toBeVisible({ timeout: 2000 });

    // Press j again to move to the second thread
    const firstThreadId = await selectedRow.getAttribute("data-thread-id");
    const deadline2 = Date.now() + 10000;
    while (Date.now() < deadline2) {
      await page.keyboard.press("j");
      try {
        await expect(selectedRow).toBeVisible({ timeout: 500 });
        const currentId = await selectedRow.getAttribute("data-thread-id");
        if (currentId !== firstThreadId) break;
      } catch {
        // retry
      }
    }

    const stateBefore = await getStoreState(page);
    expect(stateBefore).not.toBeNull();
    console.log("State BEFORE snooze:", JSON.stringify(stateBefore));

    const snoozedThreadId = stateBefore!.selectedThreadId;
    expect(snoozedThreadId).not.toBeNull();

    // Step 2: Identify the thread BELOW the selected one (the expected next selection)
    const nextThreadInfo = await page.evaluate((currentThreadId: string) => {
      const store = (
        window as unknown as { __ZUSTAND_STORE__?: { getState: () => Record<string, unknown> } }
      ).__ZUSTAND_STORE__;
      if (!store) return null;
      // Access the useThreadedEmails derived data by calling the selector
      const state = store.getState();
      const emails = state.emails as Array<{
        id: string;
        threadId: string;
        accountId: string;
        date: string;
        labelIds?: string[];
      }>;
      const snoozedThreadIds = state.snoozedThreadIds as Set<string>;
      const currentAccountId = state.currentAccountId as string;

      // Reproduce thread grouping logic to get the ordered thread list
      const accountEmails = emails.filter(
        (e) => e.accountId === currentAccountId && (e.labelIds || []).includes("INBOX"),
      );
      const threadMap = new Map<string, typeof accountEmails>();
      for (const e of accountEmails) {
        const existing = threadMap.get(e.threadId) || [];
        existing.push(e);
        threadMap.set(e.threadId, existing);
      }
      // Filter out snoozed
      const threadIds = [...threadMap.keys()].filter((tid) => !snoozedThreadIds.has(tid));
      const currentIndex = threadIds.indexOf(currentThreadId);

      if (currentIndex < 0 || threadIds.length <= 1)
        return { nextThreadId: null, currentIndex, threadCount: threadIds.length };

      // Same logic as archive: Math.min(currentIndex, length - 2), then filter out current
      const nextIndex = Math.min(currentIndex, threadIds.length - 2);
      const remaining = threadIds.filter((tid) => tid !== currentThreadId);
      const nextThreadId = remaining[nextIndex] || null;

      return {
        nextThreadId,
        currentIndex,
        threadCount: threadIds.length,
        remainingCount: remaining.length,
      };
    }, snoozedThreadId!);

    console.log("Expected next thread:", JSON.stringify(nextThreadInfo));

    // Step 3: Press h to open snooze menu (retry until it appears)
    const snoozeMenu = page.locator("text=Later Today");
    const deadline3 = Date.now() + 10000;
    while (Date.now() < deadline3) {
      await page.keyboard.press("h");
      try {
        await expect(snoozeMenu).toBeVisible({ timeout: 500 });
        break;
      } catch {
        // retry
      }
    }
    await expect(snoozeMenu).toBeVisible({ timeout: 2000 });

    // Step 4: Click "In 1 Week" to snooze
    await page.locator("button").filter({ hasText: "In 1 Week" }).click();
    // Wait for snooze menu to disappear (indicates action completed)
    await expect(snoozeMenu).toBeHidden({ timeout: 5000 });

    const stateAfter = await getStoreState(page);
    console.log("State AFTER snooze:", JSON.stringify(stateAfter));

    // Assertions
    expect(stateAfter).not.toBeNull();

    // The snoozed thread should be in snoozedThreadIds
    expect(stateAfter!.snoozedThreadIds).toContain(snoozedThreadId);

    // Cursor must NOT be null — it should have advanced to the next thread
    expect(stateAfter!.selectedThreadId).not.toBeNull();
    expect(stateAfter!.selectedEmailId).not.toBeNull();

    // Cursor must NOT still be on the snoozed thread
    expect(stateAfter!.selectedThreadId).not.toBe(snoozedThreadId);

    // Cursor should be on the expected next thread
    if (nextThreadInfo?.nextThreadId) {
      expect(stateAfter!.selectedThreadId).toBe(nextThreadInfo.nextThreadId);
    }

    // The selected row in the UI should be highlighted
    const highlightedRow = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600");
    await expect(highlightedRow.first()).toBeVisible({ timeout: 2000 });
  });
});
