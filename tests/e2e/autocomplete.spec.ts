import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for email autocomplete dropdown in To/CC/BCC fields
 *
 * Uses EXO_DEMO_MODE=true so contacts:suggest returns:
 *   - alice@example.com (Alice Johnson)
 *   - bob@example.com (Bob Smith)
 */

let electronApp: ElectronApplication;
let page: Page;

test.describe("Email Autocomplete Dropdown", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("[Autocomplete]") || msg.type() === "error") {
        console.log(`[Renderer ${msg.type()}]: ${text}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  /** Open the compose view via the Compose button */
  async function openCompose() {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
  }

  /** Close compose via discard button */
  async function closeCompose() {
    const discardButton = page.locator("button[title='Discard draft']");
    if (await discardButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await discardButton.click();
      await page.waitForTimeout(300);
    }
  }

  /**
   * Get the To field input inside the AddressInput component.
   * Uses data-testid on the wrapper so it works both with and without chips.
   */
  function getToInput() {
    return page.locator("[data-testid='address-input-to'] input[type='text']");
  }

  test("dropdown appears when typing a matching query", async () => {
    await openCompose();

    const toField = getToInput();
    await toField.click();
    await toField.fill("ali");

    // Wait for debounce (150ms) + IPC round-trip
    const dropdown = page.locator("[data-testid='autocomplete-dropdown']");
    await expect(dropdown).toBeVisible({ timeout: 3000 });

    // Should show Alice Johnson with her email
    await expect(page.locator("text=Alice Johnson")).toBeVisible();
    await expect(page.locator("text=alice@example.com")).toBeVisible();

    await closeCompose();
  });

  test("keyboard navigation selects and adds a contact", async () => {
    await openCompose();

    const toField = getToInput();
    await toField.click();
    await toField.fill("ali");

    // Wait for dropdown
    await expect(page.locator("[data-testid='autocomplete-dropdown']")).toBeVisible({
      timeout: 3000,
    });

    // ArrowDown to select first item, Enter to confirm
    await toField.press("ArrowDown");
    await toField.press("Enter");

    // The contact should appear as a chip showing the name (not bare email)
    const chip = page.locator("[data-testid='address-chip']").filter({ hasText: "Alice Johnson" });
    await expect(chip).toBeVisible({ timeout: 2000 });

    // The input should be cleared
    await expect(toField).toHaveValue("");

    await closeCompose();
  });

  test("mouse click selects a contact", async () => {
    await openCompose();

    const toField = getToInput();
    await toField.click();
    await toField.fill("bob");

    // Wait for dropdown with Bob Smith
    const suggestion = page
      .locator("[data-testid='autocomplete-suggestion']")
      .filter({ hasText: "Bob Smith" });
    await expect(suggestion).toBeVisible({ timeout: 3000 });

    // Click the suggestion (uses mousedown internally)
    await suggestion.click();

    // Bob should appear as a chip showing his name
    const chip = page.locator("[data-testid='address-chip']").filter({ hasText: "Bob Smith" });
    await expect(chip).toBeVisible({ timeout: 2000 });

    await closeCompose();
  });

  test("Escape dismisses the dropdown", async () => {
    await openCompose();

    const toField = getToInput();
    await toField.click();
    await toField.fill("ali");

    // Wait for dropdown
    const dropdown = page.locator("[data-testid='autocomplete-dropdown']");
    await expect(dropdown).toBeVisible({ timeout: 3000 });

    // Press Escape
    await toField.press("Escape");

    // Dropdown should be hidden
    await expect(dropdown).not.toBeVisible({ timeout: 2000 });

    await closeCompose();
  });

  test("already-added addresses are filtered from suggestions", async () => {
    await openCompose();

    const toField = getToInput();
    await toField.click();

    // First add alice via keyboard
    await toField.fill("ali");
    await expect(page.locator("[data-testid='autocomplete-dropdown']")).toBeVisible({
      timeout: 3000,
    });
    await toField.press("ArrowDown");
    await toField.press("Enter");

    // Verify alice chip exists (shows name from autocomplete selection)
    await expect(
      page.locator("[data-testid='address-chip']").filter({ hasText: "Alice Johnson" }),
    ).toBeVisible();

    // Now type "alice" again — she should be filtered out
    await toField.fill("alice");

    // Wait for debounce + IPC
    await page.waitForTimeout(500);

    // Dropdown should not appear (alice is the only match and she's already added)
    const dropdown = page.locator("[data-testid='autocomplete-dropdown']");
    await expect(dropdown).not.toBeVisible({ timeout: 1000 });

    await closeCompose();
  });

  test("domain matching shows multiple contacts", async () => {
    await openCompose();

    const toField = getToInput();
    await toField.click();
    // Both demo contacts have @example.com
    await toField.fill("example");

    // Wait for dropdown — both contacts should appear
    const dropdown = page.locator("[data-testid='autocomplete-dropdown']");
    await expect(dropdown).toBeVisible({ timeout: 3000 });
    await expect(page.locator("text=Alice Johnson")).toBeVisible();
    await expect(page.locator("text=Bob Smith")).toBeVisible();

    await closeCompose();
  });

  test("Tab key selects suggestion and adds it as a chip", async () => {
    await openCompose();

    const toField = getToInput();
    await toField.click();
    await toField.fill("bob");

    // Wait for dropdown
    await expect(page.locator("[data-testid='autocomplete-dropdown']")).toBeVisible({
      timeout: 3000,
    });

    // ArrowDown to highlight Bob, Tab to confirm
    await toField.press("ArrowDown");
    await toField.press("Tab");

    // Bob should appear as a chip showing his name
    const chip = page.locator("[data-testid='address-chip']").filter({ hasText: "Bob Smith" });
    await expect(chip).toBeVisible({ timeout: 2000 });

    // Input should be cleared
    await expect(toField).toHaveValue("");

    await closeCompose();
  });

  test("Tab key works in CC field autocomplete", async () => {
    await openCompose();

    // Expand CC/BCC fields
    const ccToggle = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await expect(ccToggle).toBeVisible({ timeout: 3000 });
    await ccToggle.click();
    await page.waitForTimeout(200);

    // Type in CC field
    const ccInput = page.locator("[data-testid='address-input-cc'] input[type='text']");
    await expect(ccInput).toBeVisible({ timeout: 3000 });
    await ccInput.click();
    await ccInput.fill("ali");

    // Wait for dropdown
    await expect(page.locator("[data-testid='autocomplete-dropdown']")).toBeVisible({
      timeout: 3000,
    });

    // ArrowDown + Tab to select Alice
    await ccInput.press("ArrowDown");
    await ccInput.press("Tab");

    // Alice should appear as a chip showing her name inside the CC field wrapper
    const ccChip = page
      .locator("[data-testid='address-input-cc'] [data-testid='address-chip']")
      .filter({ hasText: "Alice Johnson" });
    await expect(ccChip).toBeVisible({ timeout: 2000 });

    await closeCompose();
  });

  test("clicking suggestion in CC field adds it as a chip", async () => {
    await openCompose();

    // Expand CC/BCC fields
    const ccToggle = page.locator("[data-testid='compose-cc-bcc-toggle']");
    await expect(ccToggle).toBeVisible({ timeout: 3000 });
    await ccToggle.click();
    await page.waitForTimeout(200);

    // Type in CC field
    const ccInput = page.locator("[data-testid='address-input-cc'] input[type='text']");
    await expect(ccInput).toBeVisible({ timeout: 3000 });
    await ccInput.click();
    await ccInput.fill("bob");

    // Wait for Bob's suggestion
    const suggestion = page
      .locator("[data-testid='autocomplete-suggestion']")
      .filter({ hasText: "Bob Smith" });
    await expect(suggestion).toBeVisible({ timeout: 3000 });

    // Click the suggestion
    await suggestion.click();

    // Bob should appear as a chip showing his name in the CC field
    const ccChip = page
      .locator("[data-testid='address-input-cc'] [data-testid='address-chip']")
      .filter({ hasText: "Bob Smith" });
    await expect(ccChip).toBeVisible({ timeout: 2000 });

    await closeCompose();
  });
});
