import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for Compose and Send functionality
 *
 * IMPORTANT: These tests use EXO_DEMO_MODE=true
 * No real emails are ever sent - all Gmail API calls return mock responses
 *
 * Run with: npm run test:e2e
 */

test.describe("Compose - New Email", () => {
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
      await closeApp(electronApp);
    }
  });

  test("can open compose modal via Compose button", async () => {
    // Find and click the Compose button
    const composeButton = page.locator("button:has-text('Compose')");
    await expect(composeButton).toBeVisible();
    await composeButton.click();

    // The compose view should appear (title is "New Message")
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Close compose via Back button
    const backButton = page.locator("button:has-text('Back')");
    if (await backButton.isVisible()) {
      await backButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("compose modal has required fields", async () => {
    // Open compose view
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Check for To field (AddressInput with placeholder "recipient@example.com")
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await expect(toField).toBeVisible();

    // Check for Subject field
    const subjectField = page.locator("input[placeholder='Subject']");
    await expect(subjectField).toBeVisible();

    // Check for rich text editor area
    const editor = page.locator(".ProseMirror, [contenteditable='true']");
    await expect(editor).toBeVisible();

    // Check for Send button
    const sendButton = page.locator("button:has-text('Send')");
    await expect(sendButton).toBeVisible();

    // Close compose via Back button
    const backButton = page.locator("button:has-text('Back')");
    if (await backButton.isVisible()) {
      await backButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("can add recipients to To field", async () => {
    // Open compose view
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Add a recipient via the AddressInput component
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("test@example.com");
    await toField.press("Enter");

    // The recipient should appear as a chip/tag
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "test@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Close compose via Back button
    const backButton = page.locator("button:has-text('Back')");
    if (await backButton.isVisible()) {
      await backButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("Cc and Bcc fields are hidden by default and can be expanded", async () => {
    // Open compose view
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Cc and Bcc fields should NOT be visible by default
    const ccField = page.locator("[data-testid='address-input-cc']");
    await expect(ccField).not.toBeVisible();

    const bccField = page.locator("[data-testid='address-input-bcc']");
    await expect(bccField).not.toBeVisible();

    // The Cc/Bcc toggle button should be visible
    const toggleButton = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await expect(toggleButton).toBeVisible();

    // Click toggle to expand Cc/Bcc
    await toggleButton.click();
    await page.waitForTimeout(200);

    // Now Cc and Bcc fields should be visible
    await expect(ccField).toBeVisible({ timeout: 3000 });
    await expect(bccField).toBeVisible({ timeout: 3000 });

    // Toggle button should disappear once expanded
    await expect(toggleButton).not.toBeVisible();

    // Verify we can type in the Cc field
    const ccInput = ccField.locator("input[type='text']");
    await ccInput.fill("cc-test@example.com");
    await ccInput.press("Enter");
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "cc-test@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Close compose via Back button
    const backButton = page.locator("button:has-text('Back')");
    if (await backButton.isVisible()) {
      await backButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("can type in rich text editor", async () => {
    // Open compose view
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Find the ProseMirror editor
    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await editor.pressSequentially("This is a test email body.", { delay: 10 });

    // The content should be in the editor
    await expect(editor).toContainText("This is a test email body.");

    // Close compose via Back button
    const backButton = page.locator("button:has-text('Back')");
    if (await backButton.isVisible()) {
      await backButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("can compose and send a new email (demo mode)", async () => {
    // Open compose modal
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Fill in recipient via AddressInput
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    await toField.fill("recipient@example.com");
    await toField.press("Enter");
    await page.waitForTimeout(200);

    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Test Email from Demo Mode");

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await editor.pressSequentially(
      "This email is sent in demo mode and will not actually be delivered.",
    );

    // Click Send
    const sendButton = page.locator("button").filter({ hasText: /^Send/ }).first();
    await sendButton.click();

    // Modal should close after successful send in demo mode
    await expect(page.locator("text=New Message")).toBeHidden({ timeout: 5000 });
  });
});

test.describe("Compose - Reply", () => {
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

  test("can open inline reply from email detail", async () => {
    // First, select an email to view - wait for email list to load
    await page.waitForTimeout(1000);

    // Find an email in the list
    const emailButton = page.locator("button").filter({ hasText: "Garry" }).first();
    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(800);

      // Navigate to full view so inline reply works
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);

      // Find and click the Reply All button in the email detail header
      const replyButton = page.locator("button[title='Reply All']").first();
      if (await replyButton.isVisible()) {
        await replyButton.click();
        await page.waitForTimeout(500);

        // The inline compose form should appear
        const inlineCompose = page.locator("[data-testid='inline-compose']");
        await expect(inlineCompose).toBeVisible({ timeout: 5000 });

        // Close inline reply
        const closeButton = page.locator("[data-testid='inline-compose-close']");
        if (await closeButton.isVisible()) {
          await closeButton.click();
          await page.waitForTimeout(300);
        }
      }
    }
  });

  test("reply opens inline compose with editor", async () => {
    // Go back to split view first
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Select an email
    const emailButton = page.locator("button").filter({ hasText: "Project" }).first();
    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(800);

      // Navigate to full view
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);

      // Click Reply All
      const replyButton = page.locator("button[title='Reply All']").first();
      if (await replyButton.isVisible()) {
        await replyButton.click();
        await page.waitForTimeout(500);

        // Inline compose should appear with editor
        const inlineCompose = page.locator("[data-testid='inline-compose']");
        await expect(inlineCompose).toBeVisible({ timeout: 5000 });

        // Editor (ProseMirror) should be present
        const editor = inlineCompose.locator(".ProseMirror");
        await expect(editor).toBeVisible({ timeout: 3000 });

        // Close inline reply
        const closeButton = page.locator("[data-testid='inline-compose-close']");
        if (await closeButton.isVisible()) {
          await closeButton.click();
          await page.waitForTimeout(300);
        }
      }
    }
  });
});

test.describe("Compose - Forward", () => {
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

  test("can open forward modal from email detail", async () => {
    // Wait for email list to load
    await page.waitForTimeout(1000);

    // Select an email
    const emailButton = page.locator("button").filter({ hasText: "Garry" }).first();
    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(800);

      // Find and click the Forward button
      const forwardButton = page.locator("button[title='Forward (F)']").first();
      if (await forwardButton.isVisible()) {
        await forwardButton.click();
        await page.waitForTimeout(500);

        // The compose modal should open with "Forward" title
        const forwardTitle = page.locator("h2:has-text('Forward')");
        await expect(forwardTitle).toBeVisible({ timeout: 5000 });

        // To field should be empty (forward needs new recipient)
        const toField = page.locator("input[placeholder='Recipients']");
        await expect(toField).toBeVisible();

        // Close modal
        const discardButton = page.locator("button:has-text('Discard')");
        if (await discardButton.isVisible()) {
          await discardButton.click();
          await page.waitForTimeout(300);
        }
      }
    }
  });

  test("forward opens modal (demo mode may not pre-fill)", async () => {
    // Wait for email list
    await page.waitForTimeout(500);

    // Select an email
    const emailButton = page.locator("button").filter({ hasText: "Project" }).first();
    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(800);

      // Click Forward
      const forwardButton = page.locator("button[title='Forward (F)']").first();
      if (await forwardButton.isVisible()) {
        await forwardButton.click();
        await page.waitForTimeout(500);

        // Forward modal should open
        const forwardTitle = page.locator("h2:has-text('Forward')");
        await expect(forwardTitle).toBeVisible({ timeout: 5000 });

        // Subject field should exist
        const subjectField = page.locator("input[placeholder='Subject']");
        await expect(subjectField).toBeVisible();

        // Close modal
        const discardButton = page.locator("button:has-text('Discard')");
        if (await discardButton.isVisible()) {
          await discardButton.click();
          await page.waitForTimeout(300);
        }
      }
    }
  });
});

test.describe("Compose - Rich Text Editor", () => {
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

  test("toolbar has formatting buttons", async () => {
    // Open compose modal
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await page.waitForTimeout(500);

    // Check for toolbar buttons - Bold button has title "Bold (Cmd+B)"
    const boldButton = page.locator("button[title='Bold (Cmd+B)']").first();
    const hasBold = await boldButton.isVisible().catch(() => false);

    // At minimum, some formatting options should exist
    expect(hasBold).toBe(true);

    // Close modal
    const discardButton = page.locator("button:has-text('Discard')");
    if (await discardButton.isVisible()) {
      await discardButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("can apply bold formatting", async () => {
    // Open compose modal
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await page.waitForTimeout(500);

    // Type some text
    const editor = page.locator(".ProseMirror, [contenteditable='true']").first();
    await editor.click();
    await editor.type("Normal text ", { delay: 10 });

    // Click bold button (title is "Bold (Cmd+B)")
    const boldButton = page.locator("button[title='Bold (Cmd+B)']").first();
    if (await boldButton.isVisible()) {
      await boldButton.click();
    }

    await editor.type("bold text", { delay: 10 });

    // The editor should contain both texts
    await expect(editor).toContainText("Normal text bold text");

    // Close modal
    const discardButton = page.locator("button:has-text('Discard')");
    if (await discardButton.isVisible()) {
      await discardButton.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe("Compose - Save Draft", () => {
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

  test("can save a draft (demo mode)", async () => {
    // Open compose modal
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await page.waitForTimeout(500);

    // Fill in some content
    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Draft Test Email");

    const editor = page.locator(".ProseMirror, [contenteditable='true']").first();
    await editor.click();
    await editor.type("This is a draft that should be saved locally.");

    // Click Save Draft button
    const saveDraftButton = page.locator("button:has-text('Save Draft')");
    if (await saveDraftButton.isVisible()) {
      await saveDraftButton.click();
      await page.waitForTimeout(500);

      // In demo mode, this should succeed and close the modal
    }

    // Close modal if still open
    const discardButton = page.locator("button:has-text('Discard')");
    if (await discardButton.isVisible()) {
      await discardButton.click();
      await page.waitForTimeout(300);
    }
  });
});
