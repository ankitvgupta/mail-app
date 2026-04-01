import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/** Best-effort screenshot — don't fail the test if it can't capture */
async function screenshot(pg: Page, name: string) {
  try {
    await pg.screenshot({ path: `tests/screenshots/${name}.png`, timeout: 5000 });
  } catch {
    console.log(`[Screenshot] Skipped ${name}`);
  }
}

test.describe("Command Palette (Cmd+K)", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Set a reasonable viewport
    await page.setViewportSize({ width: 1280, height: 800 });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });

    // Wait for inbox to fully load
    await page.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("screenshot 1: command palette opens with Cmd+K", async () => {
    // Open command palette with Cmd+K
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Verify it's visible
    const input = page.locator('input[placeholder="Type a command..."]');
    await expect(input).toBeVisible({ timeout: 3000 });

    // Screenshot: palette open showing all categories
    await screenshot(page, "command-palette-open");

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("screenshot 2: filtering commands by typing", async () => {
    // Open palette
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Type to filter
    const input = page.locator('input[placeholder="Type a command..."]');
    await input.fill("compose");
    await page.waitForTimeout(300);

    // Screenshot: filtered results showing compose-related commands
    await screenshot(page, "command-palette-filter-compose");

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("screenshot 3: filtering for theme commands", async () => {
    // Open palette
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Type to filter for theme
    const input = page.locator('input[placeholder="Type a command..."]');
    await input.fill("theme");
    await page.waitForTimeout(300);

    // Screenshot: theme-related commands
    await screenshot(page, "command-palette-filter-theme");

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("screenshot 4: keyboard navigation highlight", async () => {
    // Open palette
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Arrow down a few times to show navigation
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);

    // Screenshot: item selected via keyboard
    await screenshot(page, "command-palette-keyboard-nav");

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("screenshot 5: filtering for settings/actions", async () => {
    // Open palette
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Type to filter for settings
    const input = page.locator('input[placeholder="Type a command..."]');
    await input.fill("settings");
    await page.waitForTimeout(300);

    // Screenshot
    await screenshot(page, "command-palette-filter-settings");

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("screenshot 6: execute action - switch to dark mode then reopen palette", async () => {
    // Open palette and switch to dark mode
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Type a command..."]');
    await input.fill("dark");
    await page.waitForTimeout(300);

    // Press Enter to execute "Switch to dark theme"
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);

    // Now reopen palette to show it in dark mode
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Screenshot: palette in dark mode
    await screenshot(page, "command-palette-dark-mode");

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("screenshot 7: no results state", async () => {
    // Open palette
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(500);

    // Type nonsense to get no results
    const input = page.locator('input[placeholder="Type a command..."]');
    await input.fill("xyznonexistent");
    await page.waitForTimeout(300);

    // Screenshot: empty state
    await screenshot(page, "command-palette-no-results");

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});
