/**
 * Visual regression baselines for key views.
 *
 * Linux-only by design — macOS dev machines produce different pixel
 * output for the same DOM (font hinting, GPU compositor differences).
 * Baselines are generated and compared in CI on Playwright's pinned
 * Linux docker image (see plan Phase 1 Layer 6 for the version pin).
 *
 * Skipped automatically on macOS unless EXO_FORCE_VISUAL=1, which is
 * for the rare case of regenerating baselines for cross-platform
 * comparison. **Do not commit macOS-generated baselines** — they will
 * fail in CI.
 *
 * Threshold is tight (maxDiffPixelRatio: 0.01) paired with per-screenshot
 * `mask` for transient regions (timestamps, animations, blinking carets).
 */
import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "./launch-helpers";
import { checkA11y } from "./helpers/a11y";

// Hard gate: visual regression is opt-in. It only runs in the dedicated
// CI job (mcr.microsoft.com/playwright docker image, pinned tag) so the
// committed baselines match the rendering. The Tests job runs the e2e
// project too, but on bare ubuntu-latest + xvfb where font rendering
// differs — running there would always fail the snapshot diff. Gate
// strictly by env: the visual-regression workflow sets
// EXO_VISUAL_REGRESSION=1, dev opts in with EXO_FORCE_VISUAL=1.
const isVisualEnv =
  process.env.EXO_VISUAL_REGRESSION === "1" || process.env.EXO_FORCE_VISUAL === "1";

test.beforeAll(() => {
  if (!isVisualEnv) {
    test.skip(true, "Visual regression is Linux-only. Set EXO_FORCE_VISUAL=1 to override.");
  }
});

test.describe("Visual regression — Linux-only", () => {
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

  // Common masks for time-varying regions. Pages that show relative
  // timestamps ("2 hours ago") need these excluded from the diff.
  function transientLocators() {
    return [
      page.locator("[data-testid='email-date']"),
      page.locator("[data-testid='sync-status']"),
      page.locator(".animate-pulse"),
      page.locator(".animate-spin"),
    ];
  }

  test("inbox default view", async () => {
    // Wait for inbox to fully render so we don't capture a loading state.
    await page.waitForSelector("div[data-thread-id]", { timeout: 10000 });
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot("inbox-default.png", {
      mask: transientLocators(),
      maxDiffPixelRatio: 0.01,
    });

    await checkA11y(page, {
      exclude: ["[data-testid='email-date']"],
    });
  });

  test("compose view (empty)", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot("compose-empty.png", {
      mask: transientLocators(),
      maxDiffPixelRatio: 0.01,
    });

    await checkA11y(page);

    // Close compose so the next test starts from inbox.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("settings panel (general tab)", async () => {
    // Settings is keyboard-shortcut accessible in most builds.
    // If button-based: page.locator("[data-testid='settings-button']").click();
    const settingsBtn = page.locator("[data-testid='settings-button']");
    if (await settingsBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await settingsBtn.click();
    } else {
      // Fallback: keyboard shortcut
      await page.keyboard.press("Meta+,");
    }

    await expect(page.locator("text=Settings").first()).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot("settings-general.png", {
      mask: transientLocators(),
      maxDiffPixelRatio: 0.01,
    });

    // SettingsPanel has its own palette debt that's out of scope for #126.
    // Tracked as a follow-up sweep — keep color-contrast disabled here.
    await checkA11y(page, {
      disableRules: ["color-contrast"],
    });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});
