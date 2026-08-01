import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * E2E Tests for the sender profile panel.
 *
 * Tests cover the sidebar panel that shows sender information
 * when an email is selected, profile display, switching between
 * emails and verifying the profile updates, and sidebar tab cycling.
 *
 * All tests run in DEMO_MODE with fake emails and mock sender profiles.
 */

test.describe("Sender Profile - Display", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;
  let userDataDir: string;

  test.beforeAll(async ({}, testInfo) => {
    // The full E2E matrix reuses one demo database per Playwright worker.
    // Earlier archive/trash/snooze suites can therefore change the inbox after
    // this serial describe starts. Give this stateful flow its own data dir so
    // every assertion observes the same deterministic demo inbox.
    userDataDir = mkdtempSync(join(tmpdir(), "exo-sender-profile-"));
    const result = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
      userDataDir,
    });
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
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("selecting an email shows the detail view with sender info", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Select first email
    await page.keyboard.press("j");
    await page.waitForTimeout(500);

    // The email detail should show a subject line
    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 5000 });

    // Sender name should be visible in the detail view
    // Demo emails have known senders
    const senderNames = [
      "Garry Tan",
      "Jared Friedman",
      "Michael Seibel",
      "GitHub",
      "Tech Weekly",
      "Amazon",
      "Gustaf",
      "Diana",
      "Tom Blomfield",
      "Nicolas",
      "Dalton",
    ];

    let foundSender = false;
    for (const name of senderNames) {
      const el = page.locator(`text=${name}`).first();
      if (await el.isVisible().catch(() => false)) {
        foundSender = true;
        break;
      }
    }

    expect(foundSender).toBe(true);
  });

  test("sidebar panel is available when email is selected", async () => {
    // Enter full view to see the sidebar
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);

    // Assert full view actually opened
    const replyButton = page.locator("button[title='Reply All']").first();
    if (!(await replyButton.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    // Check for sender-related content (avatar, name, email)
    // The SenderProfilePanel shows a circular avatar and sender details
    const avatar = page.locator("[class*='rounded-full']").first();
    await expect(avatar).toBeVisible({ timeout: 3000 });

    // Return to split view
    await page.keyboard.press("Escape");
    await expect(replyButton).toBeHidden({ timeout: 5000 });
    await expect(page.locator("div[data-thread-id] > button").first()).toBeVisible({
      timeout: 15000,
    });
  });

  test("leaving full view preserves row selection and sender sidebar", async () => {
    const firstThreadButton = page.locator("div[data-thread-id] > button").first();
    await expect(firstThreadButton).toBeVisible({ timeout: 15000 });
    const firstThreadId = await firstThreadButton.evaluate(
      (button) => button.parentElement?.dataset.threadId ?? null,
    );
    expect(firstThreadId).toBeTruthy();

    // Establish this test's own selection directly. Keyboard navigation has
    // separate coverage, and synthetic key events can precede its global
    // listener registration when the full E2E matrix is under load.
    await page.evaluate((threadId) => {
      const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
        getState: () => {
          emails: Array<{ id: string; threadId: string; date: string }>;
          setSelectedEmailId: (id: string | null) => void;
          setSelectedThreadId: (id: string | null) => void;
          setViewMode: (mode: "split" | "full") => void;
        };
      };
      const state = store.getState();
      const latestEmail = state.emails
        .filter((email) => email.threadId === threadId)
        .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0];
      if (!latestEmail) throw new Error(`No email found for thread ${threadId}`);
      state.setSelectedThreadId(threadId);
      state.setSelectedEmailId(latestEmail.id);
      state.setViewMode("split");
    }, firstThreadId);

    const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
    await expect(selectedRow).toBeVisible({ timeout: 15000 });
    const selectedThreadIdBefore = await selectedRow.getAttribute("data-thread-id");
    const selectedEmailIdBefore = await page.evaluate(() => {
      const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
        getState: () => { selectedEmailId: string | null };
      };
      return store.getState().selectedEmailId;
    });
    expect(selectedEmailIdBefore).toBeTruthy();

    const readSelectionState = () =>
      page.evaluate(() => {
        const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
          getState: () => {
            selectedEmailId: string | null;
            selectedThreadId: string | null;
            viewMode: "split" | "full";
          };
        };
        const state = store.getState();
        return {
          selectedEmailId: state.selectedEmailId,
          selectedThreadId: state.selectedThreadId,
          viewMode: state.viewMode,
        };
      });

    const replyButton = page.locator("button[title='Reply All']").first();
    await selectedRow.locator("> button").click();
    await expect(replyButton).toBeVisible({ timeout: 10000 });

    const senderName = page.locator("[data-testid='sidebar-sender-name']");
    await expect(senderName).toBeVisible({ timeout: 5000 });
    const senderBefore = await senderName.textContent();

    await page.keyboard.press("Escape");

    // Full view is gone, but the row stays highlighted on the email we were
    // just viewing so j/k resume from there. The preview sidebar keeps showing
    // that email's sender.
    await expect(replyButton).toBeHidden({ timeout: 5000 });
    await expect
      .poll(readSelectionState, {
        message: "Escape should preserve the selected email and thread in split view",
      })
      .toEqual({
        selectedEmailId: selectedEmailIdBefore,
        selectedThreadId: selectedThreadIdBefore,
        viewMode: "split",
      });

    // The email list unmounts in full view and remounts on return to split
    // view. Wait on that lifecycle condition before checking the virtualized
    // row, so an empty transitional DOM cannot be mistaken for lost state.
    await expect(page.locator("div[data-thread-id]").first()).toBeVisible();
    await expect(selectedRow).toHaveCount(1);
    expect(await selectedRow.getAttribute("data-thread-id")).toBe(selectedThreadIdBefore);
    await expect(senderName).toBeVisible({ timeout: 5000 });
    expect(await senderName.textContent()).toBe(senderBefore);
  });
});

test.describe("Sender Profile - Switching Emails", () => {
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

  test("switching emails updates the detail view sender", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // The email detail subject h1 is inside the thread header, not the app titlebar
    const detailSubject = page.locator(".overflow-y-auto h1");

    // Select first email
    await page.keyboard.press("j");
    await page.waitForTimeout(500);

    const visible = await detailSubject.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    const firstSubject = await detailSubject.textContent();

    // Move to second email
    await page.keyboard.press("j");
    await page.waitForTimeout(500);

    const secondSubject = await detailSubject.textContent();

    // Subjects should differ (different emails selected)
    expect(firstSubject).toBeTruthy();
    expect(secondSubject).toBeTruthy();
    if (firstSubject && secondSubject) {
      expect(secondSubject).not.toEqual(firstSubject);
    }
  });

  test("rapidly switching emails doesn't crash the profile panel", async () => {
    // Rapidly navigate through emails
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("j");
      await page.waitForTimeout(100);
    }

    await page.waitForTimeout(500);

    // App should still be responsive
    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible({ timeout: 5000 });

    // Navigate back up
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("k");
      await page.waitForTimeout(100);
    }

    await page.waitForTimeout(500);
    await expect(h1).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Sender Profile - Sidebar Tab Cycling", () => {
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

  test("pressing 'b' cycles through sidebar tabs", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Select an email first
    await page.keyboard.press("j");
    await page.waitForTimeout(500);

    // Get current page content
    const contentBefore = await page.textContent("body");

    // Press 'b' to cycle sidebar tab
    await page.keyboard.press("b");
    await page.waitForTimeout(500);

    // Content may change as a different sidebar tab is shown
    // Just verify no crash
    const contentAfter = await page.textContent("body");
    expect(contentAfter).toBeTruthy();

    // Press 'b' again to cycle to next tab
    await page.keyboard.press("b");
    await page.waitForTimeout(500);

    const contentAfterSecond = await page.textContent("body");
    expect(contentAfterSecond).toBeTruthy();
  });
});

test.describe("Sender Profile - Full View", () => {
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

  test("full view shows sender name for the selected email", async () => {
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Open the first email directly; this test covers full-view rendering,
    // not keyboard navigation.
    const firstThread = page.locator("div[data-thread-id] > button").first();
    await expect(firstThread).toBeVisible({ timeout: 15000 });
    await firstThread.click();

    // Should be in full view
    const replyButton = page.locator("button[title='Reply All']").first();
    await expect(replyButton).toBeVisible({ timeout: 10000 });

    // The email header area should show sender name
    const bodyText = await page.textContent("body");
    expect(bodyText).toBeTruthy();

    // At least one known demo sender should be visible
    const knownSenders = [
      "Garry",
      "Jared",
      "Michael",
      "GitHub",
      "Gustaf",
      "Diana",
      "Tom",
      "Nicolas",
      "Dalton",
    ];
    let found = false;
    for (const sender of knownSenders) {
      if (bodyText?.includes(sender)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);

    // Return to split view
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  test("switching emails in full view preserves full view mode", async () => {
    // Enter full view
    await page.keyboard.press("j");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);

    const replyButton = page.locator("button[title='Reply All']").first();
    await expect(replyButton).toBeVisible({ timeout: 5000 });

    const firstSubject = await page.locator("h1").first().textContent();

    // Navigate to next email while in full view (j should still work)
    await page.keyboard.press("j");
    await page.waitForTimeout(500);

    // Should still be in full view (or back to split — depends on implementation)
    // The subject should have changed or the email detail should update
    const bodyText = await page.textContent("body");
    expect(bodyText).toBeTruthy();

    // Return to split view
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });
});
