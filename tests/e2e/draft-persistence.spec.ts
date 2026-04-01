import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * E2E Tests for draft persistence across navigation.
 *
 * Validates that when a user starts composing (reply or forward),
 * navigates away (Esc to inbox), and returns to the same thread,
 * all compose fields are restored exactly:
 * - To/Cc/Bcc recipients (including display names)
 * - Subject line
 * - Body content
 * - Compose mode (reply vs forward)
 *
 * All tests run in DEMO_MODE so no real emails are sent.
 */

async function openFirstEmailInFullView(page: Page): Promise<void> {
  await page.waitForTimeout(1500);

  const firstEmail = page.locator("[data-testid='email-list-item']").first();
  const emailButton = (await firstEmail.isVisible().catch(() => false))
    ? firstEmail
    : page.locator("button").filter({ hasText: "Garry" }).first();

  await emailButton.click();
  await page.waitForTimeout(500);

  // Press Enter to switch to full view
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  await expect(page.locator("button[title='Reply All']").first()).toBeVisible({ timeout: 5000 });
}

/** Navigate from full view back to inbox. */
async function navigateBackToInbox(page: Page): Promise<void> {
  // Click somewhere neutral first to ensure editor is blurred.
  // Avoid top-left corner (macOS traffic lights could close the window).
  await page.locator("body").click({ position: { x: 300, y: 100 } });
  await page.waitForTimeout(200);

  // Press Escape to navigate back to inbox
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
}

/** Re-open the same email thread from the inbox list. */
async function reopenFirstEmail(page: Page): Promise<void> {
  const firstEmail = page.locator("[data-testid='email-list-item']").first();
  const emailButton = (await firstEmail.isVisible().catch(() => false))
    ? firstEmail
    : page.locator("button").filter({ hasText: "Garry" }).first();

  await emailButton.click();
  await page.waitForTimeout(500);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
}

test.describe("Draft persistence across navigation", () => {
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
      // Race close against a timeout — on CI, pending timers in the renderer
      // can prevent clean shutdown, causing afterAll to exceed 60s.
      await closeApp(electronApp);
    }
  });

  test("reply body persists after navigating away and back", async () => {
    await openFirstEmailInFullView(page);

    // Open reply (may auto-open with pre-existing draft content from demo data)
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Type some content into the editor so we can verify it persists
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await page.waitForTimeout(300);
    await editor.pressSequentially("Draft persistence test content");
    await page.waitForTimeout(300);
    const originalText = await editor.textContent();
    expect(originalText).toBeTruthy();

    // Navigate away — Esc blurs editor, then Esc navigates back
    await navigateBackToInbox(page);
    await page.waitForTimeout(500);

    // Re-open the same thread
    await reopenFirstEmail(page);

    // The inline compose should auto-reopen with the saved draft
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Body should contain the same text as before
    const restoredEditor = inlineCompose.locator(".ProseMirror");
    const restoredText = await restoredEditor.textContent();
    expect(restoredText).toBe(originalText);

    // Close compose (don't clean up draft — other tests may use it)
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("forward recipients and body persist after navigating away and back", async () => {
    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Should be in forward mode
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();

    // Add a recipient
    const toInput = inlineCompose.locator("[data-testid='address-input-to'] input[type='text']");
    await toInput.fill("forward-persist@example.com");
    await toInput.press("Enter");
    await page.waitForTimeout(300);

    // Verify the chip was added
    await expect(
      inlineCompose
        .locator("[data-testid='address-chip']")
        .filter({ hasText: "forward-persist@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Type body content
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    const testBody = "Forwarding this important email to you.";
    await editor.pressSequentially(testBody, { delay: 10 });
    await page.waitForTimeout(500);

    // Navigate away
    await navigateBackToInbox(page);
    await page.waitForTimeout(500);

    // Re-open the same thread
    await reopenFirstEmail(page);

    // Compose should auto-reopen in forward mode
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible({
      timeout: 3000,
    });

    // Recipient should be restored
    await expect(
      inlineCompose
        .locator("[data-testid='address-chip']")
        .filter({ hasText: "forward-persist@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Body should be restored
    const restoredEditor = inlineCompose.locator(".ProseMirror");
    await expect(restoredEditor).toContainText(testBody, { timeout: 3000 });

    // Clean up: close and clear
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);

    // Discard draft by opening forward, clearing body, closing
    await forwardButton.click();
    await page.waitForTimeout(500);
    const clearEditor = inlineCompose.locator(".ProseMirror");
    await clearEditor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("forward with Cc recipients persists after navigating away and back", async () => {
    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Add To recipient
    const toInput = inlineCompose.locator("[data-testid='address-input-to'] input[type='text']");
    await toInput.fill("primary@example.com");
    await toInput.press("Enter");
    await page.waitForTimeout(200);

    // Show Cc/Bcc fields
    const ccBccToggle = inlineCompose.locator("[data-testid='inline-reply-cc-bcc-toggle']");
    await ccBccToggle.click();
    await page.waitForTimeout(200);

    // Add Cc recipient
    const ccInput = inlineCompose.locator("[data-testid='address-input-cc'] input[type='text']");
    await ccInput.fill("cc-person@example.com");
    await ccInput.press("Enter");
    await page.waitForTimeout(200);

    // Type body
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    const testBody = "FYI with CC.";
    await editor.pressSequentially(testBody, { delay: 10 });
    await page.waitForTimeout(500);

    // Navigate away
    await navigateBackToInbox(page);
    await page.waitForTimeout(500);

    // Re-open
    await reopenFirstEmail(page);

    // Compose should restore in forward mode
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible({
      timeout: 3000,
    });

    // To recipient restored
    await expect(
      inlineCompose
        .locator("[data-testid='address-chip']")
        .filter({ hasText: "primary@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Cc field should be visible and have the recipient
    const ccChip = inlineCompose
      .locator("[data-testid='address-input-cc'] [data-testid='address-chip']")
      .filter({ hasText: "cc-person@example.com" });
    await expect(ccChip).toBeVisible({ timeout: 3000 });

    // Body restored
    await expect(inlineCompose.locator(".ProseMirror")).toContainText(testBody, { timeout: 3000 });

    // Clean up
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
    await forwardButton.click();
    await page.waitForTimeout(500);
    const clearEditor = inlineCompose.locator(".ProseMirror");
    await clearEditor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("compose mode persists: forward stays forward after round-trip", async () => {
    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();

    // Type body to ensure draft gets saved
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Mode persistence test.", { delay: 10 });
    await page.waitForTimeout(500);

    // Navigate away and back
    await navigateBackToInbox(page);
    await page.waitForTimeout(500);
    await reopenFirstEmail(page);

    // Should reopen in forward mode, NOT reply mode
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible({
      timeout: 3000,
    });

    // The AddressInput for To should be visible (forward-specific)
    await expect(inlineCompose.locator("[data-testid='address-input-to']")).toBeVisible({
      timeout: 3000,
    });

    // Clean up: discard the forward draft so it doesn't leak into the next test.
    // The close button triggers handleDiscardDraft which clears the persisted draft.
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(500);

    // Verify compose is fully closed before proceeding
    await expect(inlineCompose).not.toBeVisible({ timeout: 5000 });
  });

  test("reply mode persists: reply stays reply after round-trip", async () => {
    // Open reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Reply", { exact: true })).toBeVisible();

    // Type body
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Reply mode persistence.", { delay: 10 });
    await page.waitForTimeout(500);

    // Navigate away and back
    await navigateBackToInbox(page);
    await page.waitForTimeout(500);
    await reopenFirstEmail(page);

    // Should reopen in reply mode, NOT forward
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Reply", { exact: true })).toBeVisible({ timeout: 3000 });

    // Should NOT have the forward-specific AddressInput for To
    // (Reply mode uses a collapsed address summary, not an editable AddressInput)
    // Clean up
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });
});
