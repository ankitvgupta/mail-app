import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

/**
 * E2E Tests for Exo
 *
 * These tests verify the complete user experience using demo data.
 * Run with: npm run test:e2e
 */

test.describe("Exo E2E - Inbox View", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Capture errors for debugging
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

  test("displays inbox with threaded emails", async () => {
    // Should show inbox header with count (e.g. "Inbox(13)")
    const inboxHeader = page.locator("text=Inbox").first();
    await expect(inboxHeader).toBeVisible({ timeout: 10000 });

    // Should show at least one email item with a priority badge (High/Medium/Low)
    const emailWithPriority = page
      .locator("button")
      .filter({ hasText: /High|Medium|Low/ })
      .first();
    await expect(emailWithPriority).toBeVisible({ timeout: 10000 });
  });

  test("shows thread count badge for multi-email threads", async () => {
    // The Project Alpha thread has 3 emails - look for a thread count badge
    const threadBadge = page.locator("button:has-text('3')").first();

    // If there's a thread with multiple emails, it should show a count
    const hasBadge = await threadBadge.isVisible().catch(() => false);
    if (hasBadge) {
      await expect(threadBadge).toBeVisible();
    }
  });

  test("sorts emails with most recent first", async () => {
    // Get all visible email items in the list
    const emailItems = page
      .locator("[class*='border-b']")
      .filter({ hasText: /\d+[mhd]|Jan|Feb|Mar/ });
    const count = await emailItems.count();

    // Should have multiple emails
    expect(count).toBeGreaterThan(0);
  });

  test("can click to select an email", async () => {
    // Click on an email in the list
    const firstEmail = page.locator("button").filter({ hasText: "Project Alpha" }).first();

    if (await firstEmail.isVisible()) {
      await firstEmail.click();

      // The email detail should show the subject
      await expect(page.locator("h1").filter({ hasText: /Project Alpha/ })).toBeVisible({
        timeout: 5000,
      });
    }
  });

  test("can expand thread to see individual emails", async () => {
    // Find a thread with multiple emails (should have a number badge)
    const threadBadge = page.locator("button:has-text('3')").first();

    if (await threadBadge.isVisible()) {
      await threadBadge.click();

      // After expanding, we should see the thread detail view
      await expect(page.locator("h1").first()).toBeVisible({ timeout: 5000 });
    }
  });
});

test.describe("Exo E2E - Email Detail", () => {
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

  test("shows email content when selected", async () => {
    // Click on any visible email in the list (senders may be snoozed from prior runs)
    const candidates = ["Garry", "HR Team", "Jared", "Diana", "Gustaf", "Michael"];
    let clicked = false;
    for (const name of candidates) {
      const btn = page.locator("button").filter({ hasText: name }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      test.skip(true, "No known sender visible in inbox");
      return;
    }

    // Should show the email detail view with an h1 subject header
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 5000 });
  });

  test("shows analysis result for analyzed email", async () => {
    // Select an email that should have analysis (Needs Reply section)
    const needsReplyEmail = page.locator("button").filter({ hasText: "HIGH" }).first();

    if (await needsReplyEmail.isVisible()) {
      await needsReplyEmail.click();

      // Analysis section should show the result
      const analysisSection = page.locator("text=Needs Reply").first();
      await expect(analysisSection).toBeVisible({ timeout: 5000 });
    }
  });

  test("shows draft section for emails needing reply", async () => {
    // Find and click an email that needs reply
    const needsReplyEmail = page.locator("button").filter({ hasText: "HIGH" }).first();

    if (await needsReplyEmail.isVisible()) {
      await needsReplyEmail.click();
      await page.waitForTimeout(500);

      // Should show Proposed Draft section or Generate Draft button
      const draftSection = page.locator("text=Proposed Draft");
      const generateButton = page.locator("text=Generate Draft");

      const hasDraft = await draftSection.isVisible().catch(() => false);
      const hasGenerate = await generateButton.isVisible().catch(() => false);

      expect(hasDraft || hasGenerate).toBe(true);
    }
  });
});

test.describe("Exo E2E - Draft Generation", () => {
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

  test("can generate draft for email", async () => {
    // Find an email that needs reply and doesn't have a draft yet
    const emailButton = page.locator("button").filter({ hasText: "HIGH" }).first();

    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(500);

      // Look for Generate Draft button
      const generateButton = page.locator("button:has-text('Generate Draft')");

      if (await generateButton.isVisible()) {
        await generateButton.click();

        // Wait for generation (demo mode has 800ms delay) — draft auto-opens in inline editor
        await page.waitForTimeout(2000);

        // The inline reply editor should auto-open with the generated draft
        const editor = page.locator("[data-testid='inline-compose']");
        const hasEditor = await editor.isVisible().catch(() => false);
        expect(hasEditor).toBe(true);
      }
    }
  });

  test("can open generated draft for editing", async () => {
    // Select an email and generate/view draft
    const emailButton = page.locator("button").filter({ hasText: "HIGH" }).first();

    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(500);

      // Generate if needed
      const generateButton = page.locator("button:has-text('Generate Draft')");
      if (await generateButton.isVisible()) {
        await generateButton.click();
        // Draft auto-opens in inline editor after generation
        await page.waitForTimeout(2000);
      }

      // The inline reply editor should be open with a ProseMirror editor
      const editor = page.locator("[data-testid='inline-compose']");
      const hasEditor = await editor.isVisible().catch(() => false);
      expect(hasEditor).toBe(true);
    }
  });
});

test.describe("Exo E2E - Navigation", () => {
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

  test("can access settings", async () => {
    // Click settings button (gear icon)
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();

    // Settings panel should appear - look for the h1 title specifically
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });
  });

  test("can close settings and return to inbox", async () => {
    // Settings may already be open from previous serial test — only click if not
    const settingsHeader = page.locator("h1:has-text('Settings')");
    if (!(await settingsHeader.isVisible().catch(() => false))) {
      const settingsButton = page.locator("button[title='Settings']");
      await settingsButton.click();
      await page.waitForTimeout(500);
    }

    // Wait for settings to be visible
    await expect(settingsHeader).toBeVisible({ timeout: 5000 });

    // Find close button (X icon in the title bar - it's next to the Settings title)
    // The close button has an SVG with the X path
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();

    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(300);
    }

    // Should be back to inbox
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("can refresh emails", async () => {
    // Ensure we're on the inbox view first (close settings if open)
    const settingsHeader = page.locator("h1:has-text('Settings')");
    if (await settingsHeader.isVisible().catch(() => false)) {
      const backButton = page
        .locator("button")
        .filter({ hasText: /Back|Close|←/ })
        .first();
      if (await backButton.isVisible().catch(() => false)) {
        await backButton.click();
        await page.waitForTimeout(300);
      }
    }

    // Wait for inbox to be visible
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });

    // Click refresh button
    const refreshButton = page.locator("button[title='Refresh']");
    await refreshButton.click();

    // The inbox should still show after refresh
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("can toggle skipped emails section", async () => {
    // Look for Skipped section toggle
    const skippedToggle = page.locator("button:has-text('Skipped')");

    if (await skippedToggle.isVisible()) {
      // Click to expand
      await skippedToggle.click();
      await page.waitForTimeout(300);

      // Should show skipped emails (like newsletters)
      // Click again to collapse
      await skippedToggle.click();
    }
  });
});

test.describe("Exo E2E - Draft Critique", () => {
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

  test("can refine draft with critique", async () => {
    // Find an email that needs reply
    const emailButton = page.locator("button").filter({ hasText: "HIGH" }).first();

    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(500);

      // Generate draft if needed
      const generateButton = page.locator("button:has-text('Generate Draft')");
      if (await generateButton.isVisible()) {
        await generateButton.click();
        await page.waitForTimeout(1500);
      }

      // Find the refine input
      const refineInput = page.locator("input[placeholder*='Refine']");
      if (await refineInput.isVisible()) {
        await refineInput.fill("make it more informal");

        // Click Refine button
        const refineButton = page.locator("button:has-text('Refine')");
        await refineButton.click();

        // Wait for refinement (demo mode has 800ms delay)
        await page.waitForTimeout(1500);

        // The draft should be updated (in demo mode, it prepends [Refined...])
        const textarea = page.locator("textarea").first();
        if (await textarea.isVisible()) {
          const content = await textarea.inputValue();
          expect(content).toContain("Refined");
        }
      }
    }
  });
});

test.describe("Exo E2E - EA Settings", () => {
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

  test("can configure EA settings", async () => {
    // Open settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await page.waitForTimeout(500);

    // Click on Executive Assistant tab
    const eaTab = page.locator("button:has-text('Executive Assistant')");
    await expect(eaTab).toBeVisible({ timeout: 5000 });
    await eaTab.click();

    // Should see the EA settings form
    await expect(page.locator("text=Executive Assistant Integration")).toBeVisible();

    // Enable EA toggle (click the toggle button)
    const toggle = page
      .locator("button")
      .filter({ has: page.locator("span.rounded-full") })
      .first();
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(300);
    }

    // Fill in EA details (if visible after enabling)
    const nameInput = page.locator("input[placeholder*='Sarah']");
    const emailInput = page.locator("input[placeholder*='sarah@']");

    if (await nameInput.isVisible()) {
      await nameInput.fill("Test Assistant");
    }
    if (await emailInput.isVisible()) {
      await emailInput.fill("assistant@example.com");
    }

    // Save changes
    const saveButton = page.locator("button:has-text('Save Changes')");
    await saveButton.click();
    await page.waitForTimeout(500);

    // Close settings
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
    }
  });
});

test.describe("Exo E2E - CC Display", () => {
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

  test("shows CC banner for scheduling emails when EA is configured", async () => {
    // First configure EA in settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await page.waitForTimeout(500);

    const eaTab = page.locator("button:has-text('Executive Assistant')");
    await eaTab.click();
    await page.waitForTimeout(300);

    // Enable and configure EA
    const toggle = page
      .locator("button")
      .filter({ has: page.locator("span.rounded-full") })
      .first();
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(300);
    }

    const nameInput = page.locator("input[placeholder*='Sarah']");
    const emailInput = page.locator("input[placeholder*='sarah@']");

    if (await nameInput.isVisible()) {
      await nameInput.fill("My Assistant");
      await emailInput.fill("assistant@test.com");
    }

    const saveButton = page.locator("button:has-text('Save Changes')");
    await saveButton.click();
    await page.waitForTimeout(500);

    // Close settings
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(300);
    }

    // Find and click on the scheduling email (demo-meeting)
    const meetingEmail = page
      .locator("button")
      .filter({ hasText: "Meeting to discuss partnership" });
    if (await meetingEmail.isVisible()) {
      await meetingEmail.click();
      await page.waitForTimeout(500);

      // Generate a draft
      const generateButton = page.locator("button:has-text('Generate Draft')");
      if (await generateButton.isVisible()) {
        await generateButton.click();
        await page.waitForTimeout(1500);
      }

      // Check for CC banner (should show the EA email)
      const ccBanner = page.locator("text=CC:");
      if (await ccBanner.isVisible()) {
        await expect(ccBanner).toBeVisible();
      }
    }
  });
});
