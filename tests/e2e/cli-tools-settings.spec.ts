import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for CLI Tools configuration in the Agents settings tab.
 *
 * Tests cover adding, editing, removing, and saving CLI tools.
 * All tests run in DEMO_MODE so no real API calls are made.
 */

test.describe("Settings - CLI Tools", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Open settings and navigate to Agents tab
    const settingsButton = page.locator("button[title='Settings']");
    await expect(settingsButton).toBeVisible({ timeout: 10000 });
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    const agentsTab = page.locator("button:has-text('Agents')");
    await agentsTab.click();
    await page.waitForTimeout(300);
    await expect(agentsTab).toHaveAttribute("data-active", "true");

    // Clean up any leftover CLI tools from prior runs
    const cliHeading = page.locator("h4:has-text('CLI Tools')");
    await expect(cliHeading).toBeVisible({ timeout: 5000 });

    // Remove all existing tools
    let removeBtn = page.locator("button[title='Remove tool']").first();
    while (await removeBtn.isVisible().catch(() => false)) {
      await removeBtn.click();
      await page.waitForTimeout(100);
      removeBtn = page.locator("button[title='Remove tool']").first();
    }

    // Save the clean state
    const saveButtons = page.locator("button:has-text('Save')");
    await saveButtons.last().click();
    await page.waitForTimeout(500);
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("shows CLI Tools section with heading and description", async () => {
    await expect(page.locator("h4:has-text('CLI Tools')")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=Allow the agent to run specific CLI commands")).toBeVisible();
  });

  test("shows Add CLI Tool button when no tools configured", async () => {
    await expect(page.locator("text=+ Add CLI Tool")).toBeVisible();
    // No command inputs should exist
    await expect(page.locator("input[placeholder*='curl']")).toHaveCount(0);
  });

  test("can add a CLI tool with command and instructions", async () => {
    await page.locator("text=+ Add CLI Tool").click();
    await page.waitForTimeout(200);

    const commandInput = page.locator("input[placeholder*='curl']").first();
    await expect(commandInput).toBeVisible();
    await commandInput.fill("curl");

    const instructionsInput = page.locator("textarea[placeholder*='Instructions']").first();
    await expect(instructionsInput).toBeVisible();
    await instructionsInput.fill("Use curl to fetch remote URLs");

    await expect(commandInput).toHaveValue("curl");
    await expect(instructionsInput).toHaveValue("Use curl to fetch remote URLs");
  });

  test("can add a second CLI tool", async () => {
    await page.locator("text=+ Add CLI Tool").click();
    await page.waitForTimeout(200);

    const commandInputs = page.locator("input[placeholder*='curl']");
    await expect(commandInputs).toHaveCount(2);

    await commandInputs.nth(1).fill("python3");

    const instructionInputs = page.locator("textarea[placeholder*='Instructions']");
    await instructionInputs.nth(1).fill("Run Python scripts");
  });

  test("can save CLI tools and get confirmation", async () => {
    const saveButton = page.locator("button:has-text('Save')").last();
    await expect(saveButton).toBeVisible();
    await saveButton.click();

    await expect(page.locator("button:has-text('Saved')")).toBeVisible({ timeout: 3000 });
  });

  test("can remove a CLI tool", async () => {
    const commandInputs = page.locator("input[placeholder*='curl']");
    const initialCount = await commandInputs.count();

    const removeButtons = page.locator("button[title='Remove tool']");
    await removeButtons.first().click();
    await page.waitForTimeout(200);

    await expect(commandInputs).toHaveCount(initialCount - 1);
  });

  test("CLI tools persist after closing and reopening settings", async () => {
    // Save after removing
    const saveButton = page.locator("button:has-text('Save')").last();
    await saveButton.click();
    await page.waitForTimeout(500);

    // Close settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Reopen settings
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // Navigate back to Agents tab
    const agentsTab = page.locator("button:has-text('Agents')");
    await agentsTab.click();
    await page.waitForTimeout(500);

    await expect(page.locator("h4:has-text('CLI Tools')")).toBeVisible({ timeout: 5000 });

    // The remaining tool (python3) should be present
    const commandInput = page.locator("input[placeholder*='curl']").first();
    await expect(commandInput).toBeVisible({ timeout: 5000 });
    await expect(commandInput).toHaveValue("python3");
  });
});
