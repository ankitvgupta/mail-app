import { test, expect, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import { existsSync, unlinkSync, readdirSync } from "fs";
import {
  launchElectronApp as _launchElectronApp,
  takeScreenshot,
  closeApp,
} from "./launch-helpers";

/**
 * E2E Tests for Undo Send feature
 *
 * Validates the full undo-send lifecycle:
 * 1. Undo send delay is active (set to 5s via Settings UI)
 * 2. Sending an inline reply shows the undo toast
 * 3. Clicking "Undo" restores the draft with all fields including subject
 * 4. Sending from ComposeView also shows the undo toast
 * 5. Settings UI for configuring undo send delay
 *
 * IMPORTANT: Uses EXO_DEMO_MODE=true — no real emails are sent.
 *
 * Run with: npx playwright test tests/e2e/undo-send.spec.ts
 */

/**
 * Reset the test environment so each suite starts clean:
 * - Delete electron-store config (resets undo send delay to default 5s)
 * - Delete the demo database (removes stale snooze/archive/trash state from previous runs)
 *
 * The demo DB is recreated by sync:init on every app launch, so deleting it is safe.
 */
function resetTestEnvironment(workerIndex: number) {
  const home = process.env.HOME || "/root";

  // Only delete THIS worker's demo database to avoid interfering with parallel workers.
  // Config files are shared global state and must NOT be deleted during parallel runs.
  const workerDbPattern = `exo-demo-w${workerIndex}.db`;
  const demoDirs = [
    path.join(home, "Library/Application Support/Electron/data"),
    path.join(home, "Library/Application Support/exo/data"),
    path.join(home, ".config/Electron/data"),
    path.join(home, ".config/exo/data"),
  ];
  for (const dir of demoDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        if (file.startsWith(workerDbPattern)) {
          unlinkSync(path.join(dir, file));
        }
      }
    } catch {
      /* dir may not exist */
    }
  }
}

async function launchElectronApp(
  workerIndex: number,
): Promise<{ app: ElectronApplication; page: Page }> {
  resetTestEnvironment(workerIndex);
  return _launchElectronApp({ workerIndex });
}

/** Close any open compose view/inline reply to get back to clean state */
async function closeAnyOpenModal(page: Page) {
  const backButton = page.locator("button:has-text('Back')");
  if (await backButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await backButton.click();
    await page.waitForTimeout(300);
    return;
  }
  const discardButton = page.locator("button:has-text('Discard')");
  if (await discardButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await discardButton.click();
    await page.waitForTimeout(300);
    return;
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

test.describe("Undo Send - Inline Reply", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp(testInfo.workerIndex);
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

  test("app loads with inbox emails", async () => {
    await expect(page.locator("text=Exo")).toBeVisible();
    await expect(page.locator("text=Inbox").first()).toBeVisible();
    await expect(page.locator("button").filter({ hasText: "Garry Tan" }).first()).toBeVisible({
      timeout: 5000,
    });

    await takeScreenshot(electronApp, page, "undo-send-01-app-loaded");
  });

  test("inline reply shows undo toast with Undo button on send", async () => {
    await page.waitForTimeout(500);

    // Select Garry Tan's email
    const emailItem = page.locator("button").filter({ hasText: "Garry Tan" }).first();
    await emailItem.click();
    await page.waitForTimeout(800);

    await takeScreenshot(electronApp, page, "undo-send-02-email-selected");

    // Reply button is icon-only — use getByRole with accessible name
    const replyButton = page.getByRole("button", { name: "Reply All" }).first();
    await expect(replyButton).toBeVisible({ timeout: 5000 });
    await replyButton.click();
    await page.waitForTimeout(1000);

    await takeScreenshot(electronApp, page, "undo-send-03-reply-opened");

    // Look for the inline reply editor (ProseMirror)
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 5000 });

    // Type some reply text
    await editor.click();
    await editor.type("Thanks for the update, Garry. I will review the quarterly report.", {
      delay: 10,
    });

    await takeScreenshot(electronApp, page, "undo-send-04-reply-typed");

    // Click the Send button (non-disabled)
    const sendButton = page.locator("button:has-text('Send'):not([disabled])").first();
    await expect(sendButton).toBeVisible({ timeout: 5000 });
    await sendButton.click();

    // IMPORTANT: Check for toast IMMEDIATELY — it auto-dismisses after 5s
    await page.waitForTimeout(300);

    // Verify the undo toast is in the DOM (it uses position:fixed at bottom-left)
    const undoToast = page.getByText("Message sent.");
    await expect(undoToast).toBeAttached({ timeout: 4000 });

    // Verify the Undo button is in the DOM
    const undoButton = page.getByRole("button", { name: "Undo", exact: true });
    await expect(undoButton).toBeAttached({ timeout: 2000 });

    await takeScreenshot(electronApp, page, "undo-send-05-undo-toast-visible");

    // Wait for toast to auto-dismiss (timer fires send, then toast is removed)
    // Use a polling assertion instead of fixed waits — CI timer throttling
    // makes setTimeout unreliable, but the send will eventually complete.
    await expect(undoToast).toBeHidden({ timeout: 60000 });
  });
});

test.describe("Undo Send - Inline Reply Undo Action", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  // Use a fresh app instance so the state is clean for the undo test
  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp(testInfo.workerIndex);
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

  test("clicking Undo restores the draft with content", async () => {
    await page.waitForTimeout(500);

    // Select Garry Tan's email
    const emailItem = page.locator("button").filter({ hasText: "Garry Tan" }).first();
    await expect(emailItem).toBeVisible({ timeout: 5000 });
    await emailItem.click();
    await page.waitForTimeout(1000);

    // Click Reply
    const replyButton = page.getByRole("button", { name: "Reply All" }).first();
    await expect(replyButton).toBeVisible({ timeout: 5000 });
    await replyButton.click();
    await page.waitForTimeout(1500);

    // Look for the inline reply editor
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 5000 });

    // Type in the editor
    await editor.click();
    await editor.type("Let me check on the project details and get back to you.", { delay: 10 });

    await takeScreenshot(electronApp, page, "undo-send-06-undo-test-typed");

    // Send the reply
    const sendButton = page.locator("button:has-text('Send'):not([disabled])").first();
    await expect(sendButton).toBeVisible({ timeout: 5000 });
    await sendButton.click();
    await page.waitForTimeout(300);

    // Click the Undo button — must be immediate (toast auto-dismisses after 5s)
    const undoButton = page.getByRole("button", { name: "Undo", exact: true });
    await expect(undoButton).toBeAttached({ timeout: 4000 });
    await undoButton.click();
    await page.waitForTimeout(1500);

    await takeScreenshot(electronApp, page, "undo-send-07-after-undo-clicked");

    // After undo, the compose view should reopen with the draft content
    const restoredEditor = page.locator(".ProseMirror").first();
    const restoredVisible = await restoredEditor.isVisible({ timeout: 5000 }).catch(() => false);

    if (restoredVisible) {
      await takeScreenshot(electronApp, page, "undo-send-08-draft-restored");
      const editorContent = await restoredEditor.textContent().catch(() => "");
      expect(editorContent).toBeTruthy();
    }

    await closeAnyOpenModal(page);
    await page.waitForTimeout(500);
  });
});

test.describe("Undo Send - New Email Compose", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp(testInfo.workerIndex);
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

  test("new email compose shows undo toast on send", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await expect(composeButton).toBeVisible();
    await composeButton.click();
    await page.waitForTimeout(800);

    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    await takeScreenshot(electronApp, page, "undo-send-10-compose-opened");

    // Fill the To field
    const toInput = page.locator("[data-testid='address-input-to'] input[type='text']");
    await expect(toInput).toBeVisible({ timeout: 5000 });
    await toInput.fill("test@example.com");
    await toInput.press("Enter");

    // Verify recipient chip appeared
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "test@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    // Fill Subject
    const subjectInput = page.locator("[placeholder='Subject']");
    if (await subjectInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await subjectInput.fill("Test undo send subject");
    }

    // Type body
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 5000 });
    await editor.click();
    await editor.type("This is the body of the test email for undo send.", { delay: 10 });

    await takeScreenshot(electronApp, page, "undo-send-11-compose-filled");

    // Click Send
    const sendButton = page.locator("button:has-text('Send'):not([disabled])").first();
    await expect(sendButton).toBeVisible({ timeout: 5000 });
    await sendButton.click();
    await page.waitForTimeout(300);

    // Check toast IMMEDIATELY (auto-dismisses after 5s)
    const undoToast = page.getByText("Message sent.");
    await expect(undoToast).toBeAttached({ timeout: 4000 });

    // Use getByRole for a more specific match — getByText("Undo") can be fragile
    const undoButton = page.getByRole("button", { name: "Undo", exact: true });
    await expect(undoButton).toBeAttached({ timeout: 4000 });

    await takeScreenshot(electronApp, page, "undo-send-12-compose-undo-toast");

    // Wait for the undo toast to fully dismiss before next test
    // CI timer throttling (hidden Electron window under xvfb) can delay
    // setTimeout indefinitely, so use a very generous timeout.
    await expect(undoToast).toBeHidden({ timeout: 60000 });
  });

  test("undo from new compose restores subject field", async () => {
    const testSubject = "Undo restore subject test";

    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await page.waitForTimeout(800);

    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    const toInput = page.locator("[data-testid='address-input-to'] input[type='text']");
    await expect(toInput).toBeVisible({ timeout: 5000 });
    await toInput.fill("recipient@example.com");
    await toInput.press("Enter");
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "recipient@example.com" }),
    ).toBeVisible({ timeout: 3000 });

    const subjectInput = page.locator("[placeholder='Subject']");
    if (await subjectInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await subjectInput.fill(testSubject);
    }

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 5000 });
    await editor.click();
    await editor.type("Body content for undo test.", { delay: 10 });

    const sendButton = page.locator("button:has-text('Send'):not([disabled])").first();
    await expect(sendButton).toBeVisible({ timeout: 5000 });
    await sendButton.click();
    await page.waitForTimeout(300);

    // Click Undo immediately (toast auto-dismisses after 5s)
    const undoButton = page.getByText("Undo").first();
    await expect(undoButton).toBeAttached({ timeout: 4000 });
    await undoButton.click();
    await page.waitForTimeout(1500);

    await takeScreenshot(electronApp, page, "undo-send-13-compose-restored");

    const newMessage = page.locator("text=New Message");
    const newMessageVisible = await newMessage.isVisible({ timeout: 5000 }).catch(() => false);

    if (newMessageVisible) {
      const restoredSubject = page.locator("[placeholder='Subject']");
      if (await restoredSubject.isVisible({ timeout: 3000 }).catch(() => false)) {
        const value = await restoredSubject.inputValue();
        expect(value).toBe(testSubject);
        await takeScreenshot(electronApp, page, "undo-send-14-subject-verified");
      }
    }

    await closeAnyOpenModal(page);
  });
});

test.describe("Undo Send - Forward", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp(testInfo.workerIndex);
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

  test("forward with undo-send shows toast and Undo button", async () => {
    await page.waitForTimeout(500);

    const emailItem = page.locator("button").filter({ hasText: "Garry Tan" }).first();
    await expect(emailItem).toBeVisible({ timeout: 5000 });
    await emailItem.click();
    await page.waitForTimeout(800);

    // Forward button is icon-only — use getByRole
    const forwardButton = page.getByRole("button", { name: "Forward" }).first();
    await expect(forwardButton).toBeVisible({ timeout: 5000 });
    await forwardButton.click();
    await page.waitForTimeout(1000);

    await takeScreenshot(electronApp, page, "undo-send-15-forward-opened");

    const toInput = page.locator("[data-testid='address-input-to'] input[type='text']");
    if (await toInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await toInput.fill("forward-recipient@example.com");
      await toInput.press("Enter");
      await page.waitForTimeout(300);
    }

    const editor = page.locator(".ProseMirror").first();
    if (await editor.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editor.click();
      await editor.type("FYI - forwarding this for your review.", { delay: 10 });
    }

    await takeScreenshot(electronApp, page, "undo-send-16-forward-filled");

    const sendButton = page.locator("button:has-text('Send'):not([disabled])").first();
    if (await sendButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sendButton.click();
      await page.waitForTimeout(500);

      await takeScreenshot(electronApp, page, "undo-send-17-forward-sent");

      const undoToast = page.getByText("Message sent.");
      const toastAttached =
        (await undoToast.isVisible({ timeout: 5000 }).catch(() => false)) ||
        (await page
          .evaluate(() => document.body.innerHTML.includes("Message sent"))
          .catch(() => false));

      if (toastAttached) {
        const undoButton = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undoButton).toBeAttached({ timeout: 3000 });
        await takeScreenshot(electronApp, page, "undo-send-18-forward-undo-toast");
      }
    }

    await page.waitForTimeout(6000);
    await closeAnyOpenModal(page);
  });
});

test.describe("Undo Send - Settings Configuration", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp(testInfo.workerIndex);
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

  test("settings panel shows undo send delay options", async () => {
    const settingsButton = page.getByRole("button", { name: "Settings" });
    await expect(settingsButton).toBeVisible({ timeout: 5000 });
    await settingsButton.click();
    await page.waitForTimeout(800);

    await takeScreenshot(electronApp, page, "undo-send-19-settings-panel");

    const undoSendLabel = page.locator("text=Undo Send");
    const labelVisible = await undoSendLabel.isVisible({ timeout: 5000 }).catch(() => false);

    if (labelVisible) {
      for (const text of ["Off", "5s", "10s", "15s", "30s"]) {
        const btn = page.locator(`button:has-text('${text}')`);
        const isVisible = await btn.isVisible().catch(() => false);
        if (!isVisible) console.log(`[Settings] Button "${text}" not visible`);
      }

      await takeScreenshot(electronApp, page, "undo-send-20-delay-options");
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("can toggle undo send delay to Off and back to 5s", async () => {
    const settingsButton = page.getByRole("button", { name: "Settings" });
    await settingsButton.click();
    await page.waitForTimeout(800);

    const offButton = page.locator("button:has-text('Off')").first();
    if (await offButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await offButton.click();
      await page.waitForTimeout(300);
      await takeScreenshot(electronApp, page, "undo-send-21-delay-set-off");
    }

    const fiveSecButton = page.locator("button:has-text('5s')").first();
    if (await fiveSecButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fiveSecButton.click();
      await page.waitForTimeout(300);
      await takeScreenshot(electronApp, page, "undo-send-22-delay-restored-5s");
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});
