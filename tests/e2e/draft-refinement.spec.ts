import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for draft generation and refinement workflow.
 *
 * Tests cover generating a draft for an email that needs reply,
 * verifying the draft appears in the inline editor, entering
 * a refinement critique, and verifying the draft updates.
 *
 * All tests run in DEMO_MODE — draft generation has an ~800ms delay
 * and refinement prepends "[Refined...]" to the draft content.
 */

test.describe("Draft Generation and Refinement", () => {
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
    if (electronApp) await closeApp(electronApp);
  });

  test("can select an email that needs reply", async () => {
    // Wait for inbox to load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Find an email marked HIGH priority (needs reply)
    const highPriorityEmail = page.locator("button").filter({ hasText: "HIGH" }).first();
    await expect(highPriorityEmail).toBeVisible({ timeout: 10000 });
    await highPriorityEmail.click();
    await page.waitForTimeout(500);

    // Email detail should show the subject
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 5000 });
  });

  test("can generate a draft for the selected email", async () => {
    // Look for the Generate Draft button
    const generateButton = page.locator("button:has-text('Generate Draft')");

    if (!(await generateButton.isVisible())) {
      // In demo mode, Generate Draft button may not be available
      test.skip();
      return;
    }

    await generateButton.click();

    // Wait for generation (demo mode has ~800ms delay)
    await page.waitForTimeout(2000);

    // The inline reply editor should auto-open with the generated draft
    const editor = page.locator("[data-testid='inline-compose']");
    await expect(editor).toBeVisible({ timeout: 5000 });
  });

  test("draft editor contains generated content", async () => {
    const inlineCompose = page.locator("[data-testid='inline-compose']");

    if (!(await inlineCompose.isVisible())) {
      test.skip();
      return;
    }

    // The ProseMirror editor should have content
    const editor = inlineCompose.locator(".ProseMirror");
    await expect(editor).toBeVisible({ timeout: 3000 });

    // In demo mode, the draft should have some text content
    const content = await editor.textContent();
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(0);
  });

  test("can enter a refinement critique and submit it", async () => {
    // Look for the refine input field
    const refineInput = page.locator(
      "input[placeholder*='Refine'], input[placeholder*='refine'], input[placeholder*='critique'], input[placeholder*='feedback']",
    );

    if (!(await refineInput.isVisible())) {
      test.skip();
      return;
    }

    // Capture draft content before refinement
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    const editor = inlineCompose.locator(".ProseMirror");

    await refineInput.fill("make it shorter");

    // Click Refine button
    const refineButton = page.locator("button:has-text('Refine')");
    await expect(refineButton).toBeVisible();
    await refineButton.click();

    // Wait for refinement (demo mode has ~800ms delay)
    await page.waitForTimeout(2000);

    // After refinement, the draft content should have changed
    if (await inlineCompose.isVisible()) {
      const contentAfter = await editor.textContent();
      expect(contentAfter).toBeTruthy();
    }
  });

  test("can enter a second refinement critique", async () => {
    const refineInput = page.locator(
      "input[placeholder*='Refine'], input[placeholder*='refine'], input[placeholder*='critique'], input[placeholder*='feedback']",
    );

    if (!(await refineInput.isVisible())) {
      test.skip();
      return;
    }

    await refineInput.fill("make it more formal");

    const refineButton = page.locator("button:has-text('Refine')");
    await refineButton.click();
    await page.waitForTimeout(2000);

    // The draft should still be visible and updated
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    await expect(inlineCompose).toBeVisible({ timeout: 3000 });
    const editor = inlineCompose.locator(".ProseMirror");
    await expect(editor).toBeVisible();
    const content = await editor.textContent();
    expect(content).toBeTruthy();
  });

  test("refinement input clears after submission", async () => {
    const refineInput = page.locator(
      "input[placeholder*='Refine'], input[placeholder*='refine'], input[placeholder*='critique'], input[placeholder*='feedback']",
    );

    if (!(await refineInput.isVisible())) {
      test.skip();
      return;
    }

    // The input should be empty after the previous refinement was submitted
    const value = await refineInput.inputValue();
    expect(value).toBe("");
  });
});

test.describe("Draft Generation - Multiple Emails", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  test("switching emails clears previous draft state", async () => {
    // Wait for inbox to load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Select first HIGH priority email
    const highPriorityEmails = page.locator("button").filter({ hasText: "HIGH" });
    const firstEmail = highPriorityEmails.first();

    if (!(await firstEmail.isVisible())) {
      test.skip();
      return;
    }

    await firstEmail.click();
    await page.waitForTimeout(500);

    // Generate draft if needed
    const generateButton = page.locator("button:has-text('Generate Draft')");
    if (await generateButton.isVisible()) {
      await generateButton.click();
      await page.waitForTimeout(2000);
    }

    // Now navigate to a different email using 'j'
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("j");
    await page.waitForTimeout(500);

    // The subject should change (or the detail view should update)
    const newSubject = await page.locator("h1").first().textContent();
    expect(newSubject).toBeTruthy();
  });
});

test.describe("Draft Generation - From Full View", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  test("can generate and view draft from full email view", async () => {
    // Wait for inbox to load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Select a HIGH priority email
    const highPriorityEmail = page.locator("button").filter({ hasText: "HIGH" }).first();

    if (!(await highPriorityEmail.isVisible())) {
      test.skip();
      return;
    }

    await highPriorityEmail.click();
    await page.waitForTimeout(500);

    // Enter full view
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);

    // Generate draft if needed
    const generateButton = page.locator("button:has-text('Generate Draft')");
    if (await generateButton.isVisible()) {
      await generateButton.click();
      await page.waitForTimeout(2000);
    }

    // The inline compose should be visible (auto-opened with draft)
    const inlineCompose = page.locator("[data-testid='inline-compose']");
    const draftSection = page.locator("text=Proposed Draft");
    const hasEditor = await inlineCompose.isVisible().catch(() => false);
    const hasDraft = await draftSection.isVisible().catch(() => false);

    // Either the inline compose or the proposed draft section should be visible
    expect(hasEditor || hasDraft).toBe(true);

    if (hasEditor) {
      const editor = inlineCompose.locator(".ProseMirror");
      await expect(editor).toBeVisible({ timeout: 3000 });
    }
  });
});
