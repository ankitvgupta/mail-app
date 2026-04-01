import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for Email Body Rendering
 *
 * Tests that email content is properly displayed, including:
 * - Plain text emails
 * - HTML formatted emails
 * - Proper rendering without raw HTML/entities
 */

let electronApp: ElectronApplication;
let page: Page;

test.describe("Email Body Rendering", () => {
  test.describe.configure({ mode: "serial" });

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

  test("renders plain text email correctly", async () => {
    // Wait for email list to populate (use senders known to not be pre-snoozed)
    const emailItem = page
      .locator("button")
      .filter({ hasText: /Garry|HR Team|Product Team|Amazon/i })
      .first();
    await expect(emailItem).toBeVisible({ timeout: 15000 });

    // Click on an email to show detail in split view
    await emailItem.click();

    // Should see the email subject as a heading
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 5000 });

    // Plain text emails render as inline text (not an iframe).
    // HTML emails render in an iframe[title='Email content'].
    // Check that either the iframe or inline text body is present.
    const iframe = page.locator("iframe[title='Email content']");
    const textBody = page.locator("div.whitespace-pre-wrap");
    const hasIframe = await iframe
      .first()
      .isVisible()
      .catch(() => false);
    const hasTextBody = await textBody
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasIframe || hasTextBody).toBe(true);
  });

  test("renders HTML email without showing raw tags", async () => {
    // Click on the HTML formatted email (Weekly Product Update)
    const htmlEmailButton = page
      .locator("button")
      .filter({ hasText: "Weekly Product Update" })
      .first();

    if (await htmlEmailButton.isVisible()) {
      await htmlEmailButton.click();
      await page.keyboard.press("Enter");

      // Should show the email subject
      await expect(page.locator("h1").filter({ hasText: /Weekly Product Update/ })).toBeVisible({
        timeout: 5000,
      });

      // Check for the email body container
      const bodyContainer = page.locator("iframe[title='Email content']");
      await expect(bodyContainer.first()).toBeVisible({ timeout: 5000 });

      // Should have an iframe for HTML content
      const iframe = page.locator("iframe[title='Email content']");
      await expect(iframe.first()).toBeVisible({ timeout: 5000 });

      // The page should NOT show raw HTML tags like "<div" or "<!DOCTYPE"
      const pageContent = await page.content();
      expect(pageContent).not.toContain("&lt;div");
      expect(pageContent).not.toContain("&lt;html");
    }
  });

  test("HTML email iframe renders content inside", async () => {
    // Click on the HTML formatted email
    const htmlEmailButton = page
      .locator("button")
      .filter({ hasText: "Weekly Product Update" })
      .first();

    if (await htmlEmailButton.isVisible()) {
      await htmlEmailButton.click();
      await page.keyboard.press("Enter");
      await page.locator("iframe[title='Email content']").first().waitFor({ timeout: 5000 });

      // Get the iframe
      const iframe = page.locator("iframe[title='Email content']").first();

      if (await iframe.isVisible()) {
        // Check iframe has content (non-zero height)
        const iframeBox = await iframe.boundingBox();
        expect(iframeBox).not.toBeNull();
        if (iframeBox) {
          expect(iframeBox.height).toBeGreaterThan(50);
        }

        // Try to access iframe content
        const frameLocator = iframe.contentFrame();
        if (frameLocator) {
          // The iframe should contain our email content keywords
          const frameContent = frameLocator.locator("body");
          await expect(frameContent).toBeVisible({ timeout: 5000 });

          // Check for expected content rendered inside the iframe
          const darkModeText = frameLocator.locator("text=Dark Mode");
          const bugFixesText = frameLocator.locator("text=Bug Fixes");

          const hasDarkMode = await darkModeText.isVisible().catch(() => false);
          const hasBugFixes = await bugFixesText.isVisible().catch(() => false);

          expect(hasDarkMode || hasBugFixes).toBe(true);
        }
      }
    }
  });

  test("does not show HTML entities like &amp; or &lt;", async () => {
    // Select an HTML email so content renders in iframe (Product Team newsletter)
    const htmlEmail = page.locator("button").filter({ hasText: "Weekly Product Update" }).first();

    if (await htmlEmail.isVisible()) {
      await htmlEmail.click();

      // HTML emails render in an iframe
      const iframe = page.locator("iframe[title='Email content']").first();
      await expect(iframe).toBeVisible({ timeout: 10000 });

      // Access iframe content and check for raw HTML entities
      const frame = iframe.contentFrame();
      if (frame) {
        const text = await frame.locator("body").textContent();

        // Should not contain raw HTML entities
        if (text) {
          expect(text).not.toContain("&amp;");
          expect(text).not.toContain("&lt;");
          expect(text).not.toContain("&gt;");
        }
      }
    }
  });
});
