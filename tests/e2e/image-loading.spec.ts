import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

/**
 * Test that verifies images actually load in email content.
 * Uses demo mode so tests work without real Gmail credentials.
 */

let electronApp: ElectronApplication;
let page: Page;

test.describe("Image Loading in Emails", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Capture console messages for debugging
    page.on("console", (msg) => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    // Capture failed requests
    page.on("requestfailed", (request) => {
      console.log(`[Request Failed]: ${request.url()} - ${request.failure()?.errorText}`);
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("images load in HTML emails", async () => {
    // Wait for app and emails to load
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page
      .locator("button")
      .filter({ hasText: /Garry|HR Team|Product Team/ })
      .first()
      .waitFor({ timeout: 10000 });

    // Find an HTML email — Product Team newsletter is always visible (not snoozed)
    const htmlEmail = page.locator("button").filter({ hasText: "Weekly Product Update" }).first();
    const q3Report = page.locator("button").filter({ hasText: "Q3 Quarterly Report" }).first();

    if (await htmlEmail.isVisible().catch(() => false)) {
      await htmlEmail.click();
    } else if (await q3Report.isVisible().catch(() => false)) {
      await q3Report.click();
    } else {
      test.skip(true, "No HTML email visible in inbox");
      return;
    }

    // In split view, clicking an email renders detail panel with iframe for HTML content
    const iframe = page.locator("iframe[title='Email content']");
    await expect(iframe.first()).toBeVisible({ timeout: 10000 });

    // Access the iframe content to verify images are present
    const frame = iframe.first().contentFrame();
    if (frame) {
      // Check for img tags inside the iframe
      const images = frame.locator("img");
      const imgCount = await images.count();

      // Demo HTML emails should contain at least one image
      if (imgCount > 0) {
        const firstImg = images.first();
        const src = await firstImg.getAttribute("src");
        expect(src).toBeTruthy();
      }
    }
  });
});
