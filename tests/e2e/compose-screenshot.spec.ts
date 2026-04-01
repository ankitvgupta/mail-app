import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

test.describe("Compose View - CC/BCC Toggle", () => {
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

  test.afterEach(async () => {
    // Ensure compose view is closed between tests
    try {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      // If still in compose, click Back
      const backButton = page.locator("button:has-text('Back')");
      if (await backButton.isVisible({ timeout: 300 })) {
        await backButton.click();
        await page.waitForTimeout(200);
      }
    } catch {
      // Page may already be in inbox state
    }
  });

  test("CC/BCC collapsed by default with all core elements visible", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    // CC/BCC should be collapsed by default
    await expect(page.locator("[data-testid='compose-cc-bcc-toggle']")).toBeVisible();
    await expect(page.locator("[data-testid='address-input-cc']")).not.toBeVisible();
    await expect(page.locator("[data-testid='address-input-bcc']")).not.toBeVisible();

    // To, Subject, editor, Send should all be visible
    await expect(page.locator("[data-testid='address-input-to']")).toBeVisible();
    await expect(page.locator("input[placeholder='Subject']")).toBeVisible();
    await expect(page.locator("button").filter({ hasText: /^Send/ }).first()).toBeVisible();
  });

  test("toggle expands CC/BCC and allows adding recipients", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Expand CC/BCC
    const toggleButton = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await toggleButton.click();
    await page.waitForTimeout(300);

    // CC and BCC fields should now be visible
    await expect(page.locator("[data-testid='address-input-cc']")).toBeVisible();
    await expect(page.locator("[data-testid='address-input-bcc']")).toBeVisible();

    // Toggle button should be gone
    await expect(page.locator("[data-testid='compose-cc-bcc-toggle']")).not.toBeVisible();

    // Can add CC and BCC recipients
    const ccInput = page.locator("[data-testid='address-input-cc'] input[type='text']");
    await ccInput.fill("cc@example.com");
    await ccInput.press("Enter");
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "cc@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    const bccInput = page.locator("[data-testid='address-input-bcc'] input[type='text']");
    await bccInput.fill("bcc@example.com");
    await bccInput.press("Enter");
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "bcc@example.com" }),
    ).toBeVisible({ timeout: 3000 });
  });

  test("send with CC/BCC works after expanding", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Add To
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("to@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    // Expand and add CC
    const toggleButton = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await toggleButton.click();
    await page.waitForTimeout(200);

    const ccInput = page.locator("[data-testid='address-input-cc'] input[type='text']");
    await ccInput.fill("cc@example.com");
    await ccInput.press("Enter");
    await page.waitForTimeout(200);

    // Add subject
    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Test with CC");

    // Send should be enabled and work
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeEnabled({ timeout: 3000 });
    await sendButton.click();

    // Compose should close after send
    await expect(page.locator("text=New Message")).not.toBeVisible({ timeout: 5000 });
  });
});
