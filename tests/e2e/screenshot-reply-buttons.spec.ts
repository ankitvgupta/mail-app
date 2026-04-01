import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, takeScreenshot , closeApp } from "./launch-helpers";

test.describe("Thread Reply Buttons Screenshot", () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low/ })
      .first()
      .waitFor({ timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  test("capture reply buttons in multi-message thread", async () => {
    // Click on Jared Friedman's Project Alpha thread (has 4 messages)
    const emailButton = page.locator("button").filter({ hasText: "Jared Friedman" }).first();
    await expect(emailButton).toBeVisible({ timeout: 5000 });
    await emailButton.click();
    await page.waitForTimeout(2000);

    // Wait for the thread to load
    await expect(page.locator("button[title='Archive']")).toBeVisible({ timeout: 5000 });

    // Expand collapsed messages by clicking on them
    // Click on the first Jared Friedman collapsed message header
    const firstCollapsed = page
      .locator("text=Jared Friedman")
      .filter({ hasText: "I wanted to kick off" })
      .first();
    if (await firstCollapsed.isVisible().catch(() => false)) {
      await firstCollapsed.click();
      await page.waitForTimeout(500);
    }

    // Click on Michael Seibel collapsed message
    const mikeCollapsed = page.locator("text=Michael Seibel").first();
    if (await mikeCollapsed.isVisible().catch(() => false)) {
      await mikeCollapsed.click();
      await page.waitForTimeout(500);
    }

    // Reply buttons are now icon-only in the header, visible on hover (Superhuman-style).
    // Find them by role and title attribute.
    const perMessageReply = page.locator("[role='button'][title='Reply']");
    const replyCount = await perMessageReply.count();
    console.log(`  Found ${replyCount} Reply buttons across expanded messages`);
    expect(replyCount).toBeGreaterThanOrEqual(2);

    // Hover over a message to make the buttons visible for the screenshot
    if (replyCount >= 2) {
      await perMessageReply.nth(1).scrollIntoViewIfNeeded();
    }
    // Hover the parent message container to trigger group-hover visibility
    const messageContainers = page.locator(".group\\/msg");
    if (
      await messageContainers
        .nth(1)
        .isVisible()
        .catch(() => false)
    ) {
      await messageContainers.nth(1).hover();
    }
    await takeScreenshot(electronApp, page, "thread-reply-buttons-multiple");

    // Also screenshot with first message hovered
    await perMessageReply.first().scrollIntoViewIfNeeded();
    if (
      await messageContainers
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await messageContainers.first().hover();
    }
    await takeScreenshot(electronApp, page, "thread-reply-buttons");
  });
});
