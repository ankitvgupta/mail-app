import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for Reply and Forward workflows.
 *
 * These tests aggressively validate:
 * - Inline reply opens and functions correctly
 * - Inline forward opens with proper AddressInput and functions correctly
 * - Forward → Reply transition works (the main bug scenario)
 * - Reply → Forward transition works
 * - Cancel → Re-open transitions work
 * - Switching compose modes clears prior state properly
 *
 * All tests run in DEMO_MODE so no real emails are sent.
 */

/**
 * Navigate to full view for the first email thread.
 * Selects the first visible email and presses Enter to open full view.
 */
async function openFirstEmailInFullView(page: Page): Promise<void> {
  // Wait for email list to populate
  await page.waitForTimeout(1500);

  // Click the first email in the list
  const firstEmail = page.locator("[data-testid='email-list-item']").first();
  // If email list items don't have a test ID, fall back to finding buttons in the list
  const emailButton = (await firstEmail.isVisible().catch(() => false))
    ? firstEmail
    : page.locator("button").filter({ hasText: "Garry" }).first();

  await emailButton.click();
  await page.waitForTimeout(500);

  // Press Enter to switch to full view
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  // Verify we're in full view by checking for the Reply button
  await expect(page.locator("button[title='Reply All']").first()).toBeVisible({ timeout: 5000 });
}

/**
 * Disable undo-send by setting delay to 0 via the Zustand store.
 * This simplifies tests that don't specifically test undo-send behavior.
 */
async function disableUndoSend(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
      getState: () => { setUndoSendDelay: (s: number) => void };
    };
    store.getState().setUndoSendDelay(0);
  });
}

/**
 * Enable undo-send with a specific delay.
 */
async function setUndoSendDelay(page: Page, seconds: number): Promise<void> {
  await page.evaluate((s) => {
    const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
      getState: () => { setUndoSendDelay: (s: number) => void };
    };
    store.getState().setUndoSendDelay(s);
  }, seconds);
}

test.describe("Reply and Forward Workflows", () => {
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

  test("can navigate to full view and see reply/forward buttons", async () => {
    await openFirstEmailInFullView(page);

    const replyButton = page.locator("button[title='Reply All']").first();
    const forwardButton = page.locator("button[title='Forward']").first();

    await expect(replyButton).toBeVisible();
    await expect(forwardButton).toBeVisible();
  });

  test("reply opens inline compose with correct state", async () => {
    // Click Reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    // Inline compose should appear
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Should show "Reply to" header text
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Should have an editor area
    const editor = inlineCompose.locator(".ProseMirror");
    await expect(editor).toBeVisible();

    // Should have a Send button
    const sendButton = inlineCompose.locator("[data-testid='inline-compose-send']");
    await expect(sendButton).toBeVisible();

    // Close the reply
    const closeButton = inlineCompose.locator("[data-testid='inline-compose-close']");
    await closeButton.click();
    await page.waitForTimeout(300);

    // Inline compose should be gone
    await expect(inlineCompose).toBeHidden();
  });

  test("forward opens inline compose with AddressInput for To field", async () => {
    // Click Forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    // Inline compose should appear
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Should show "Forward" header text
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();

    // Forward mode should have AddressInput (with data-testid="address-input-to")
    const toInput = inlineCompose.locator("[data-testid='address-input-to']");
    await expect(toInput).toBeVisible({ timeout: 3000 });

    // Should have an editor
    const editor = inlineCompose.locator(".ProseMirror");
    await expect(editor).toBeVisible();

    // Close the forward
    const closeButton = inlineCompose.locator("[data-testid='inline-compose-close']");
    await closeButton.click();
    await page.waitForTimeout(300);

    await expect(inlineCompose).toBeHidden();
  });

  test("can type in forward recipient and add content", async () => {
    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Add a recipient via AddressInput
    const toInput = inlineCompose.locator("[data-testid='address-input-to'] input[type='text']");
    await toInput.fill("forward-recipient@example.com");
    await toInput.press("Enter");

    // Recipient should appear as a chip
    await expect(
      inlineCompose
        .locator("[data-testid='address-chip']")
        .filter({ hasText: "forward-recipient@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Type a message in the editor
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("FYI, forwarding this to you.", { delay: 10 });
    await expect(editor).toContainText("FYI, forwarding this to you.");

    // Close the forward
    const closeButton = inlineCompose.locator("[data-testid='inline-compose-close']");
    await closeButton.click();
    await page.waitForTimeout(300);
  });

  test("forward with Cc/Bcc toggle works", async () => {
    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Click Cc/Bcc toggle
    const ccBccToggle = inlineCompose.locator("[data-testid='inline-reply-cc-bcc-toggle']");
    await expect(ccBccToggle).toBeVisible();
    await ccBccToggle.click();
    await page.waitForTimeout(200);

    // Cc and Bcc address inputs should appear
    const ccInput = inlineCompose.locator("[data-testid='address-input-cc']");
    const bccInput = inlineCompose.locator("[data-testid='address-input-bcc']");
    await expect(ccInput).toBeVisible();
    await expect(bccInput).toBeVisible();

    // Close
    const closeButton = inlineCompose.locator("[data-testid='inline-compose-close']");
    await closeButton.click();
    await page.waitForTimeout(300);
  });

  test("cancel reply then open reply again works", async () => {
    // Open reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Cancel
    const closeButton = inlineCompose.locator("[data-testid='inline-compose-close']");
    await closeButton.click();
    await page.waitForTimeout(300);
    await expect(inlineCompose).toBeHidden();

    // Open reply again
    await replyButton.click();
    await page.waitForTimeout(800);
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("cancel forward then open forward again works", async () => {
    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Cancel
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
    await expect(inlineCompose).toBeHidden();

    // Open forward again
    await forwardButton.click();
    await page.waitForTimeout(800);
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    // Use exact text match to avoid matching content that contains "Forward"
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("cancel reply then open forward works", async () => {
    // Open reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Cancel reply
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);

    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    // Should now show Forward header, not Reply
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();
    // Should have AddressInput for To
    await expect(inlineCompose.locator("[data-testid='address-input-to']")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("cancel forward then open reply works", async () => {
    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();

    // Cancel forward
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);

    // Open reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });
});

test.describe("Reply After Forward - Bug Regression", () => {
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

  test("send forward then reply works (no undo-send)", async () => {
    await openFirstEmailInFullView(page);
    await disableUndoSend(page);

    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Add recipient and send
    const toInput = inlineCompose.locator("[data-testid='address-input-to'] input[type='text']");
    await toInput.fill("test-forward@example.com");
    await toInput.press("Enter");
    await page.waitForTimeout(200);

    // Type some content
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Forwarding this to you.", { delay: 10 });

    // Click Send
    const sendButton = inlineCompose.locator("[data-testid='inline-compose-send']");
    await sendButton.click();
    await page.waitForTimeout(1000);

    // Inline compose should close after send
    await expect(inlineCompose).toBeHidden({ timeout: 5000 });

    // Now try to reply — this is the bug scenario
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(1000);

    // Reply inline compose should open successfully
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("send forward then reply works (with undo-send)", async () => {
    // Enable undo-send with 5 second delay (default)
    await setUndoSendDelay(page, 5);

    // Open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Add recipient and send
    const toInput = inlineCompose.locator("[data-testid='address-input-to'] input[type='text']");
    await toInput.fill("test-forward-undo@example.com");
    await toInput.press("Enter");
    await page.waitForTimeout(200);

    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Undo-send forward test.", { delay: 10 });

    // Click Send (will queue with undo-send)
    const sendButton = inlineCompose.locator("[data-testid='inline-compose-send']");
    await sendButton.click();
    await page.waitForTimeout(1000);

    // Inline compose should close
    await expect(inlineCompose).toBeHidden({ timeout: 5000 });

    // Now try to reply — the key regression test
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(1000);

    // Reply inline compose should open successfully despite the pending forward
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Verify we can type in the reply
    const replyEditor = inlineCompose.locator(".ProseMirror");
    await replyEditor.click();
    await replyEditor.pressSequentially("Reply after forward works!", { delay: 10 });
    await expect(replyEditor).toContainText("Reply after forward works!");

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);

    // Disable undo-send for remaining tests
    await disableUndoSend(page);
  });

  test("send reply then forward works", async () => {
    // Open reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Type content and send
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Test reply content.", { delay: 10 });

    const sendButton = inlineCompose.locator("[data-testid='inline-compose-send']");
    await sendButton.click();
    await page.waitForTimeout(1000);

    await expect(inlineCompose).toBeHidden({ timeout: 5000 });

    // Now open forward
    const forwardButton = page.locator("button[title='Forward']").first();
    await forwardButton.click();
    await page.waitForTimeout(1000);

    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();
    await expect(inlineCompose.locator("[data-testid='address-input-to']")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });
});

test.describe("Keyboard Shortcuts for Reply/Forward", () => {
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

  test("pressing 'r' opens reply inline compose in full view", async () => {
    await openFirstEmailInFullView(page);

    // Press 'r' for reply
    await page.keyboard.press("r");
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("pressing 'f' opens forward inline compose in full view", async () => {
    // Press 'f' for forward
    await page.keyboard.press("f");
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.getByText("Forward", { exact: true })).toBeVisible();
    await expect(inlineCompose.locator("[data-testid='address-input-to']")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("pressing 'f' then close then 'r' works correctly", async () => {
    // Forward
    await page.keyboard.press("f");
    await page.waitForTimeout(800);
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);

    // Reply
    await page.keyboard.press("r");
    await page.waitForTimeout(800);
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });
    await expect(inlineCompose.locator("text=Reply")).toBeVisible();

    // Close
    await inlineCompose.locator("[data-testid='inline-compose-close']").click();
    await page.waitForTimeout(300);
  });

  test("pressing Escape blurs editor, second Escape navigates back", async () => {
    // Open reply
    await page.keyboard.press("r");
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Press Escape once — blurs editor but compose stays visible
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Compose should still be visible (first Esc only blurs)
    await expect(inlineCompose).toBeVisible();

    // Press Escape again — navigates back to inbox, closing compose
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    await expect(inlineCompose).toBeHidden();
  });
});

test.describe("Send via Cmd+Enter", () => {
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

  test("Cmd+Enter sends reply from inline compose", async () => {
    await openFirstEmailInFullView(page);
    await disableUndoSend(page);

    // Open reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Type content
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Sent via keyboard shortcut.", { delay: 10 });

    // Send via Cmd+Enter
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(1000);

    // Compose should close after send
    await expect(inlineCompose).toBeHidden({ timeout: 5000 });
  });
});

test.describe("Cmd+Enter does not insert newline before sending", () => {
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

  test("Cmd+Enter in new compose does not insert newline", async () => {
    // Open compose without adding recipients — send will be a no-op,
    // so we can inspect the editor content after the key press.
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Type text in the editor
    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await editor.pressSequentially("Hello World", { delay: 10 });
    await page.waitForTimeout(200);

    // Move cursor to middle of text (after "Hello")
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }

    // Press Cmd+Enter — should NOT insert a newline
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(300);

    // Editor should still show "Hello World" on a single line, no newline inserted
    const text = await editor.textContent();
    expect(text).toBe("Hello World");

    // Close compose
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("Cmd+Enter in inline reply does not insert newline", async () => {
    await openFirstEmailInFullView(page);

    // Open reply
    const replyButton = page.locator("button[title='Reply All']").first();
    await replyButton.click();
    await page.waitForTimeout(800);

    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 5000 });

    // Type text and move cursor to the middle
    const editor = inlineCompose.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Thanks for the update", { delay: 10 });
    await page.waitForTimeout(200);
    await page.keyboard.press("Home");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowRight");
    }

    // Use page.evaluate to capture innerHTML before AND after keydown in one tick.
    // This avoids the race where the compose closes before we can read the editor.
    const { before, after } = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='inline-compose'] .ProseMirror");
      if (!el) return { before: "", after: "" };
      const before = el.innerHTML;
      // Dispatch a synthetic Cmd+Enter keydown
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      const after = el.innerHTML;
      return { before, after };
    });

    // The innerHTML should be identical — no newline/br injected
    expect(after).toBe(before);
  });
});
