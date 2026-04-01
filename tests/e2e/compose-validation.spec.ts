import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

/**
 * E2E Tests for compose validation: subject OR body is sufficient to send.
 *
 * Uses EXO_DEMO_MODE=true — no real emails are ever sent.
 */

test.describe("Compose validation — send with subject only (no body)", () => {
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
      await electronApp.close();
    }
  });

  test("send button is disabled with no recipients and no content", async () => {
    // Open compose
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Send should be disabled (no recipients, no content)
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeDisabled();

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("send button is enabled with To + Subject (no body)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Add To recipient
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("test@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    // Add subject
    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Subject only email");
    await page.waitForTimeout(200);

    // Do NOT type anything in the body — leave it empty

    // Send should be enabled
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeEnabled({ timeout: 3000 });

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("send button is enabled with To + Body (no subject)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Add To recipient
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("test@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    // Leave subject empty — type in the body
    const editor = page.locator(".ProseMirror, [contenteditable='true']").first();
    await editor.click();
    await editor.type("Body without subject", { delay: 10 });
    await page.waitForTimeout(200);

    // Send should be enabled
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeEnabled({ timeout: 3000 });

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("send button is disabled with To only (no subject, no body)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Add To recipient only
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("test@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    // No subject, no body

    // Send should be disabled
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeDisabled();

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("send button is enabled with Bcc + Subject (no To, no body)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Expand Cc/Bcc fields first
    const toggleButton = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await toggleButton.click();
    await page.waitForTimeout(200);

    // Add Bcc recipient
    const bccField = page.locator("[data-testid='address-input-bcc'] input[type='text']");
    await bccField.fill("secret@example.com");
    await bccField.press("Enter");
    await page.waitForTimeout(200);

    // Add subject
    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("BCC only email");
    await page.waitForTimeout(200);

    // Send should be enabled
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeEnabled({ timeout: 3000 });

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("can actually send with subject only (demo mode)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Add To recipient
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("test@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    // Add subject only
    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Subject only send test");
    await page.waitForTimeout(200);

    // Click send
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await sendButton.click();

    // In demo mode, the compose should close on success
    await expect(page.locator("text=New Message")).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe("Compose validation — Cc-only and Bcc-only sends", () => {
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

  test("send button is enabled with Cc + Body (no To, no subject)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Expand Cc/Bcc fields first
    const toggleButton = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await toggleButton.click();
    await page.waitForTimeout(200);

    // Add Cc recipient
    const ccField = page.locator("[data-testid='address-input-cc'] input[type='text']");
    await ccField.fill("cc@example.com");
    await ccField.press("Enter");
    await page.waitForTimeout(200);

    // Type body only
    const editor = page.locator(".ProseMirror, [contenteditable='true']").first();
    await editor.click();
    await editor.type("Cc-only email body", { delay: 10 });
    await page.waitForTimeout(200);

    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeEnabled({ timeout: 3000 });

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("send button is disabled with Cc only (no content)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Expand Cc/Bcc fields first
    const toggleButton = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await toggleButton.click();
    await page.waitForTimeout(200);

    // Add Cc recipient only
    const ccField = page.locator("[data-testid='address-input-cc'] input[type='text']");
    await ccField.fill("cc@example.com");
    await ccField.press("Enter");
    await page.waitForTimeout(200);

    // No subject, no body

    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await expect(sendButton).toBeDisabled();

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});
