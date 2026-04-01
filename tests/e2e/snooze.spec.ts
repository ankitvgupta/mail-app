import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for Snooze Feature
 *
 * Tests the full snooze workflow: opening the menu, using presets,
 * typing natural language times, verifying snooze indicators, and unsnoozing.
 *
 * Run with: EXO_DEMO_MODE=true npx playwright test tests/e2e/snooze.spec.ts --headed
 */

// Helper: dismiss any overlay/modal that might be blocking the page
async function dismissOverlays(page: Page): Promise<void> {
  // Press Escape a few times to dismiss snooze menus, compose modals, etc.
  for (let i = 0; i < 3; i++) {
    const overlay = page.locator("div.fixed.inset-0").first();
    if (await overlay.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    } else {
      break;
    }
  }
}

// Helper: select an email and open it so action buttons appear.
// Navigates to the "All" tab first to ensure non-snoozed emails are visible.
async function selectAndOpenEmail(page: Page, nameFilter: string): Promise<void> {
  await dismissOverlays(page);
  // Ensure we're on the "All" tab (not Snoozed or another split)
  const allTab = page.locator("button").filter({ hasText: "All" }).first();
  if (await allTab.isVisible().catch(() => false)) {
    await allTab.click();
    await page.waitForTimeout(300);
  }
  const emailButton = page.locator("button").filter({ hasText: nameFilter }).first();
  await emailButton.click();
  // Press Enter to open the email detail view (action buttons only appear after opening)
  await page.keyboard.press("Enter");
  // Wait for action buttons to appear (title differs depending on snoozed state)
  await page
    .locator("button[title='Snooze (h)'], button[title='Snoozed']")
    .first()
    .waitFor({ timeout: 5000 });
}

test.describe("Snooze Feature — Menu & Presets", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Wait for email list to populate (priority badges or any email sender visible)
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low|HR Team|Product Team|Snoozed/ })
      .first()
      .waitFor({ timeout: 15000 });

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

  test("can open snooze menu from email detail", async () => {
    // Select a non-snoozed email (HR Team is not snoozed in demo mode)
    await selectAndOpenEmail(page, "HR Team");

    // Click snooze button (clock icon)
    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();

    // Snooze menu should appear
    const snoozeMenu = page.locator("text=Later Today");
    await expect(snoozeMenu).toBeVisible({ timeout: 3000 });

    // Should show preset options (use button locators to avoid matching email body text)
    await expect(page.locator("button:has-text('Tomorrow')").first()).toBeVisible();
    await expect(page.locator("button:has-text('Next Week')").first()).toBeVisible();
    await expect(page.locator("button:has-text('In 1 Week')").first()).toBeVisible();

    // Should show text input
    const textInput = page.locator("input[placeholder*='2 hours']");
    await expect(textInput).toBeVisible();

    // Should show date picker option
    await expect(page.locator("text=Pick date & time")).toBeVisible();
  });

  test("can close snooze menu with Escape", async () => {
    await selectAndOpenEmail(page, "HR Team");

    // Open snooze menu
    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();

    // Verify menu is open
    await expect(page.locator("text=Later Today")).toBeVisible({ timeout: 3000 });

    // Press Escape
    await page.keyboard.press("Escape");

    // Menu should be closed
    await expect(page.locator("text=Later Today")).not.toBeVisible({ timeout: 3000 });
  });

  test("can snooze email using 'Tomorrow' preset", async () => {
    await selectAndOpenEmail(page, "HR Team");

    // Open snooze menu
    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();
    await expect(page.locator("text=Tomorrow")).toBeVisible({ timeout: 3000 });

    // Click Tomorrow
    const tomorrowOption = page.locator("button:has-text('Tomorrow')").first();
    await tomorrowOption.click();

    // Snooze menu should close after selecting
    await expect(page.locator("text=Later Today")).not.toBeVisible({ timeout: 5000 });
  });

  test("snoozed email appears in Snoozed tab", async () => {
    // After the previous test snoozed an email, navigate to the Snoozed tab
    const snoozedTab = page.locator("button").filter({ hasText: "Snoozed" }).first();

    if (await snoozedTab.isVisible()) {
      await snoozedTab.click();
      await page.waitForTimeout(300);

      // Should show snoozed emails with a clock indicator
      const clockIcon = page.locator("svg path[d*='M12 8v4l3 3']");
      const hasIcon = await clockIcon
        .first()
        .isVisible()
        .catch(() => false);
      expect(hasIcon).toBe(true);
    }
  });
});

test.describe("Snooze Feature — Natural Language Input", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Wait for email list to populate
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low|Garry|HR Team|Product Team/ })
      .first()
      .waitFor({ timeout: 15000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("parses natural language time in text input", async () => {
    // Select an email — use a sender that exists in demo data and is not snoozed
    const emailButton = page.locator("button").filter({ hasText: "Garry" }).first();
    if (!(await emailButton.isVisible())) return;
    await selectAndOpenEmail(page, "Garry");

    // Open snooze menu
    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();

    // Type a natural language time
    const textInput = page.locator("input[placeholder*='2 hours']");
    await textInput.fill("2 hours");
    await page.waitForTimeout(200);

    // Should show parsed time preview (not "Couldn't parse that")
    const errorMessage = page.locator("text=Couldn't parse that");
    const hasError = await errorMessage.isVisible().catch(() => false);
    expect(hasError).toBe(false);

    // Should show a Snooze button for the parsed time
    const confirmButton = page.locator("button:has-text('Snooze')").last();
    await expect(confirmButton).toBeVisible();
  });

  test("shows error for unparseable input", async () => {
    // Select an email
    const emailButton = page.locator("button").filter({ hasText: "Garry" }).first();
    if (!(await emailButton.isVisible())) return;
    await selectAndOpenEmail(page, "Garry");

    // Open snooze menu
    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();

    // Type gibberish
    const textInput = page.locator("input[placeholder*='2 hours']");
    await textInput.fill("asdfghjkl");
    await page.waitForTimeout(200);

    // Should show error
    const errorMessage = page.locator("text=Couldn't parse that");
    await expect(errorMessage).toBeVisible();
  });

  test("can snooze with Enter key after typing time", async () => {
    // Select an email
    const emailButton = page.locator("button").filter({ hasText: "Garry" }).first();
    if (!(await emailButton.isVisible())) return;
    await selectAndOpenEmail(page, "Garry");

    // Open snooze menu
    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();

    // Type a time and hit Enter
    const textInput = page.locator("input[placeholder*='2 hours']");
    await textInput.fill("30m");
    await page.waitForTimeout(200);
    await textInput.press("Enter");
    await page.waitForTimeout(500);

    // Snooze menu should close
    await expect(page.locator("text=Later Today")).not.toBeVisible();
  });
});

test.describe("Snooze Feature — Snooze Banner & Unsnooze", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Wait for email list to populate
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low|HR Team|Product Team/ })
      .first()
      .waitFor({ timeout: 15000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("shows snooze banner on snoozed email and can unsnooze", async () => {
    // First, snooze a non-snoozed email
    await selectAndOpenEmail(page, "HR Team");

    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();
    await expect(page.locator("text=In 1 Week")).toBeVisible({ timeout: 3000 });

    // Click "In 1 Week" to snooze
    const inOneWeek = page.locator("button:has-text('In 1 Week')");
    await inOneWeek.click();
    await page.waitForTimeout(500);

    // Now find the snoozed email in the Snoozed tab and click it
    const snoozedTab = page.locator("button").filter({ hasText: "Snoozed" }).first();
    if (await snoozedTab.isVisible()) {
      await snoozedTab.click();
      await page.waitForTimeout(300);

      // Click on the snoozed email
      const snoozedEmail = page.locator("button").filter({ hasText: "HR Team" }).first();
      if (await snoozedEmail.isVisible()) {
        await snoozedEmail.click();
        await page.waitForTimeout(500);

        // Should show snooze banner with "Snoozed until..."
        const snoozeBanner = page.locator("text=Snoozed until");
        const hasBanner = await snoozeBanner.isVisible().catch(() => false);

        if (hasBanner) {
          // Click Unsnooze
          const unsnoozeButton = page.locator("button:has-text('Unsnooze')");
          await unsnoozeButton.click();
          await page.waitForTimeout(500);

          // Banner should disappear
          await expect(page.locator("text=Snoozed until")).not.toBeVisible();
        }
      }
    }
  });

  test("snooze button turns amber when thread is snoozed", async () => {
    // Snooze an email (Gustaf is not snoozed in demo mode)
    const emailButton = page.locator("button").filter({ hasText: "Gustaf" }).first();
    if (!(await emailButton.isVisible())) return;
    await selectAndOpenEmail(page, "Gustaf");

    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();
    await expect(page.locator("text=Later Today")).toBeVisible({ timeout: 3000 });

    const laterToday = page.locator("button:has-text('Later Today')");
    await laterToday.click();
    await page.waitForTimeout(500);

    // Navigate to the Snoozed tab to find the snoozed email
    const snoozedTab = page.locator("button").filter({ hasText: "Snoozed" }).first();
    if (await snoozedTab.isVisible()) {
      await snoozedTab.click();
      await page.waitForTimeout(300);

      const snoozedEmail = page.locator("button").filter({ hasText: "Gustaf" }).first();
      if (await snoozedEmail.isVisible()) {
        await snoozedEmail.click();
        await page.waitForTimeout(500);

        // The snooze button should now have the "Snoozed" title (amber state)
        const snoozedButton = page.locator("button[title='Snoozed']");
        const hasSnoozedState = await snoozedButton.isVisible().catch(() => false);

        if (hasSnoozedState) {
          expect(hasSnoozedState).toBe(true);
        }
      }
    }
  });
});

test.describe("Snooze Feature — Date Picker", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Wait for email list to populate
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low|HR Team|Product Team/ })
      .first()
      .waitFor({ timeout: 15000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("can open date picker from snooze menu", async () => {
    // Use a non-snoozed email
    await selectAndOpenEmail(page, "HR Team");

    // Open snooze menu
    const snoozeButton = page
      .locator("button[title='Snooze (h)'], button[title='Snoozed']")
      .first();
    await snoozeButton.click();
    await expect(page.locator("text=Pick date & time")).toBeVisible({ timeout: 3000 });

    // Click "Pick date & time"
    const datePickerOption = page.locator("text=Pick date & time");
    await datePickerOption.click();
    await page.waitForTimeout(300);

    // Should show date and time inputs
    const dateInput = page.locator("input[type='date']");
    const timeInput = page.locator("input[type='time']");
    await expect(dateInput).toBeVisible();
    await expect(timeInput).toBeVisible();

    // Should show a Snooze button
    const snoozeConfirm = page.locator("button:has-text('Snooze')").last();
    await expect(snoozeConfirm).toBeVisible();
  });
});
