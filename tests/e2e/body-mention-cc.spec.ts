import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * E2E tests for +mention / @mention inside the ProseMirror compose body.
 *
 * The mention callback adds the selected contact to Cc and — critically —
 * populates nameMap so the chip renders the display name instead of the bare
 * email. On send, nameMap becomes `recipientNames` and is used by
 * formatAddressesWithNames to produce "Name <email>" MIME headers.
 *
 * Demo contacts (src/main/ipc/search.ipc.ts): Alice Johnson, Bob Smith.
 */

let electronApp: ElectronApplication;
let page: Page;

test.describe("Body +mention / @mention → Cc with display name", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[Console Error]: ${msg.text()}`);
    });
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  async function openCompose() {
    await page.locator("button:has-text('Compose')").click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
  }

  async function closeCompose() {
    const discard = page.locator("button[title='Discard draft']");
    if (await discard.isVisible({ timeout: 1000 }).catch(() => false)) {
      await discard.click();
      await page.waitForTimeout(300);
    }
  }

  test("+mention adds contact to Cc with display name in chip", async () => {
    await openCompose();

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await editor.pressSequentially("+bob", { delay: 50 });

    // Dropdown appears with Bob Smith
    const dropdown = page.locator("[data-testid='mention-dropdown']");
    await expect(dropdown).toBeVisible({ timeout: 3000 });
    await expect(dropdown.locator("text=Bob Smith")).toBeVisible();

    // Confirm selection
    await editor.press("Enter");
    await expect(dropdown).not.toBeVisible({ timeout: 2000 });

    // Cc field reveals with Bob's chip showing his NAME (not the bare email)
    const ccChip = page
      .locator("[data-testid='address-input-cc'] [data-testid='address-chip']")
      .first();
    await expect(ccChip).toBeVisible({ timeout: 2000 });
    await expect(ccChip).toHaveText("Bob Smith");
    await expect(ccChip).not.toContainText("bob@example.com");

    await closeCompose();
  });

  test("@mention also populates nameMap (not just +)", async () => {
    await openCompose();

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await editor.pressSequentially("@ali", { delay: 50 });

    const dropdown = page.locator("[data-testid='mention-dropdown']");
    await expect(dropdown).toBeVisible({ timeout: 3000 });
    await expect(dropdown.locator("text=Alice Johnson")).toBeVisible();

    await editor.press("Enter");
    await expect(dropdown).not.toBeVisible({ timeout: 2000 });

    const ccChip = page
      .locator("[data-testid='address-input-cc'] [data-testid='address-chip']")
      .first();
    await expect(ccChip).toBeVisible({ timeout: 2000 });
    await expect(ccChip).toHaveText("Alice Johnson");

    await closeCompose();
  });

});
