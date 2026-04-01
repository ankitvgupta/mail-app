import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

/**
 * E2E test: sidebar reflects the focused email in a multi-sender thread.
 *
 * Uses the "Launch Readiness Review" thread which has 6 emails from 5 different
 * senders. Expanding each email should update the sidebar sender header to show
 * that email's sender.
 */

// The multi-sender thread senders in chronological order.
const THREAD_SENDERS = [
  { id: "demo-multi-001", name: "Nicolas Dessaigne", email: "nicolas.d@acmecorp.com" },
  { id: "demo-multi-002", name: "Pete Koomen", email: "pete.koomen@acmecorp.com" },
  { id: "demo-multi-003", name: "Aaron Epstein", email: "aaron.epstein@acmecorp.com" },
  { id: "demo-multi-004", name: "Brad Flora", email: "brad.flora@acmecorp.com" },
  { id: "demo-multi-005", name: "Harj Taggar", email: "harj.taggar@acmecorp.com" },
  { id: "demo-multi-006", name: "Nicolas Dessaigne", email: "nicolas.d@acmecorp.com" },
];

test.describe("Sidebar reflects focused email in thread", () => {
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
      await electronApp.close();
    }
  });

  test("clicking different emails in a multi-sender thread updates the sidebar sender", async () => {
    // Wait for inbox to load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Find and click the multi-sender thread
    const threadRow = page.locator("button").filter({ hasText: "Launch Readiness" }).first();
    await expect(threadRow).toBeVisible({ timeout: 5000 });
    await threadRow.click();

    // Wait for thread detail to load
    await expect(page.locator("h1").filter({ hasText: /Launch Readiness/ })).toBeVisible({
      timeout: 5000,
    });

    // Wait for the sidebar to settle after thread load
    await page.waitForTimeout(1000);

    // Ensure we're on the Sender tab (the sidebar may auto-switch to Agent
    // tab for threads that have analysis results)
    const senderTabButton = page.locator("button").filter({ hasText: "Sender" });
    if (await senderTabButton.isVisible().catch(() => false)) {
      await senderTabButton.click();
      await page.waitForTimeout(300);
    }

    const sidebarName = page.locator("[data-testid='sidebar-sender-name']");
    const sidebarEmail = page.locator("[data-testid='sidebar-sender-email']");
    await expect(sidebarName).toBeVisible({ timeout: 5000 });

    // Click through each email in the thread and verify the sidebar updates.
    // Thread messages are rendered inside [data-email-id] wrappers.
    for (const sender of THREAD_SENDERS) {
      const emailWrapper = page.locator(`[data-email-id="${sender.id}"]`);
      await expect(emailWrapper).toBeVisible({ timeout: 3000 });

      // Click the message row to toggle expand/collapse
      const clickTarget = emailWrapper.locator("button").first();
      await clickTarget.click();
      await page.waitForTimeout(500);

      // The click toggles the email. If it was already expanded, clicking
      // collapsed it (clearing focus). Re-click to expand and set focus.
      const expandedContent = emailWrapper.locator("div.group\\/msg");
      if (!(await expandedContent.isVisible().catch(() => false))) {
        await clickTarget.click();
        await page.waitForTimeout(500);
      }

      // Verify sidebar now shows this sender
      await expect(sidebarName).toHaveText(sender.name, { timeout: 3000 });
      await expect(sidebarEmail).toHaveText(sender.email, { timeout: 3000 });
    }
  });
});
