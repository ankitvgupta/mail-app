import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

let electronApp: ElectronApplication;
let page: Page;

test.describe("Dark Mode Coverage Gaps", () => {
  test.describe.configure({ mode: "serial" });

  // Helper: parse "rgb(r, g, b)" string into [r, g, b] numbers
  function parseRgb(rgb: string): [number, number, number] {
    const match = rgb.match(/\d+/g)?.map(Number) || [0, 0, 0];
    return [match[0], match[1], match[2]];
  }

  // Helper: check that two RGB values are within tolerance
  function rgbWithinTolerance(
    actual: [number, number, number],
    expected: [number, number, number],
    tolerance: number = 20,
  ): boolean {
    return (
      Math.abs(actual[0] - expected[0]) <= tolerance &&
      Math.abs(actual[1] - expected[1]) <= tolerance &&
      Math.abs(actual[2] - expected[2]) <= tolerance
    );
  }

  // Helper: check a color is "dark" (all channels below threshold)
  function isDark(rgb: [number, number, number], threshold: number = 80): boolean {
    return rgb[0] < threshold && rgb[1] < threshold && rgb[2] < threshold;
  }

  // Helper: check a color is "light" (all channels above threshold)
  function isLight(rgb: [number, number, number], threshold: number = 140): boolean {
    return rgb[0] > threshold && rgb[1] > threshold && rgb[2] > threshold;
  }

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
    });
    electronApp = result.app;
    page = result.page;

    // Wait for email list to populate
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low/ })
      .first()
      .waitFor({ timeout: 10000 });

    // Switch to dark mode via Settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({
      timeout: 5000,
    });

    const darkButton = page.locator("button:has-text('Dark')").first();
    await darkButton.click();
    await page.waitForTimeout(500);

    // Verify dark mode is active
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(true);

    // Close settings
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(300);
    }
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("offline banner has dark amber styling", async () => {
    // Inject offline state via Zustand store
    await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as ReturnType<
        typeof import("zustand").create
      >;
      (store.getState() as Record<string, (v: boolean) => void>).setOnline(false);
    });
    await page.waitForTimeout(300);

    // Verify banner is visible
    await expect(page.locator("text=You're offline")).toBeVisible({
      timeout: 3000,
    });

    // Check text color — should be light amber (dark:text-amber-300)
    const textColor = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.includes("You're offline")) {
          const parent = walker.currentNode.parentElement;
          if (parent) return window.getComputedStyle(parent).color;
        }
      }
      return null;
    });

    expect(textColor).not.toBeNull();
    const textRgb = parseRgb(textColor!);
    // amber-300 ≈ (252, 211, 77) — R channel should be high
    expect(textRgb[0]).toBeGreaterThan(180);

    // Check border color — dark:border-amber-800
    const borderColor = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="border-amber"]');
      for (const el of els) {
        const bc = window.getComputedStyle(el).borderBottomColor;
        if (bc && bc !== "rgba(0, 0, 0, 0)") return bc;
      }
      return null;
    });

    if (borderColor) {
      const borderRgb = parseRgb(borderColor);
      // amber-800 ≈ (146, 64, 14) — should be visible
      expect(borderRgb[0]).toBeGreaterThan(50);
    }

    // Restore online state
    await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as ReturnType<
        typeof import("zustand").create
      >;
      (store.getState() as Record<string, (v: boolean) => void>).setOnline(true);
    });
    await page.waitForTimeout(300);

    // Verify banner is gone
    await expect(page.locator("text=You're offline")).not.toBeVisible();
  });

  test("auth expired banner has dark amber styling", async () => {
    // Get current account ID
    const accountId = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as ReturnType<
        typeof import("zustand").create
      >;
      return (store.getState() as Record<string, string | null>).currentAccountId;
    });

    expect(accountId).not.toBeNull();

    // Inject expired account state
    await page.evaluate((id: string) => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as ReturnType<
        typeof import("zustand").create
      >;
      (store.getState() as Record<string, (v: string) => void>).addExpiredAccount(id);
    }, accountId!);
    await page.waitForTimeout(300);

    // Verify expired banner is visible
    await expect(page.locator("text=session expired")).toBeVisible({
      timeout: 3000,
    });

    // Check Re-authenticate button styling
    const reauthButton = page.locator("button:has-text('Re-authenticate')");
    await expect(reauthButton).toBeVisible();

    const buttonBg = await reauthButton.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );
    const buttonRgb = parseRgb(buttonBg);
    // dark:bg-amber-800 — should not be white/light
    expect(buttonRgb[0]).toBeLessThan(200);

    // Check banner text color — dark:text-amber-300
    const bannerTextColor = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.includes("session expired")) {
          const parent = walker.currentNode.parentElement;
          if (parent) return window.getComputedStyle(parent).color;
        }
      }
      return null;
    });

    expect(bannerTextColor).not.toBeNull();
    const textRgb = parseRgb(bannerTextColor!);
    // amber-300 ≈ (252, 211, 77) — light text
    expect(textRgb[0]).toBeGreaterThan(180);

    // Cleanup
    await page.evaluate((id: string) => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as ReturnType<
        typeof import("zustand").create
      >;
      (store.getState() as Record<string, (v: string) => void>).removeExpiredAccount(id);
    }, accountId!);
    await page.waitForTimeout(300);

    await expect(page.locator("text=session expired")).not.toBeVisible();
  });

  test("batch action bar has dark blue styling", async () => {
    // Select two threads via store injection for reliability
    const threadIds = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as ReturnType<
        typeof import("zustand").create
      >;
      const state = store.getState() as Record<string, unknown>;
      const emails = state.emails as Array<{ threadId: string }>;
      // Get first 2 unique threadIds
      const ids = [...new Set(emails.map((e) => e.threadId))].slice(0, 2);
      const toggle = (state as Record<string, (v: string) => void>).toggleThreadSelected;
      for (const id of ids) {
        toggle(id);
      }
      return ids;
    });

    expect(threadIds.length).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(300);

    // Verify batch action bar is visible
    const batchBar = page.locator('[data-testid="batch-action-bar"]');
    await expect(batchBar).toBeVisible({ timeout: 3000 });

    // Check the bar has dark blue background — dark:bg-blue-900/30
    // blue-900 is rgb(30, 58, 138) at 30% opacity — blue channel is high but it's
    // a dark color. Check R and G are low, and overall brightness is low.
    const barBg = await batchBar.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(barBg).not.toBeNull();
    const bgRgb = parseRgb(barBg);
    // R and G channels should be low (dark blue tint, not white/light)
    expect(bgRgb[0]).toBeLessThan(80);
    expect(bgRgb[1]).toBeLessThan(80);
    // Blue channel can be higher due to blue-900 tint
    expect(bgRgb[2]).toBeLessThan(200);

    // Check selection text color — dark:text-blue-300
    const selText = batchBar.locator("text=selected");
    const textColor = await selText.evaluate((el) => window.getComputedStyle(el).color);
    const textRgb = parseRgb(textColor);
    // blue-300 ≈ (147, 197, 253) — blue channel should be high
    expect(textRgb[2]).toBeGreaterThan(150);

    // Check border color — dark:border-blue-800
    const borderColor = await batchBar.evaluate(
      (el) => window.getComputedStyle(el).borderBottomColor,
    );
    if (borderColor) {
      const borderRgb = parseRgb(borderColor);
      // Blue > Red for blue tint
      expect(borderRgb[2]).toBeGreaterThan(borderRgb[0]);
    }

    // Cleanup — clear selection
    await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as ReturnType<
        typeof import("zustand").create
      >;
      (store.getState() as Record<string, () => void>).clearSelectedThreads();
    });
    await page.waitForTimeout(300);

    await expect(batchBar).not.toBeVisible();
  });

  test("attachment chips have dark borders and text", async () => {
    // Click the Q3 Quarterly Report email (has attachments in demo data)
    const reportEmail = page.locator("button").filter({ hasText: "Q3 Quarterly Report" }).first();
    await expect(reportEmail).toBeVisible({ timeout: 5000 });
    await reportEmail.click();
    await page.waitForTimeout(500);

    // Verify attachment chips are visible
    await expect(page.locator("text=Q3_Report_2025.pdf")).toBeVisible({
      timeout: 5000,
    });

    // Find the chip container element — it has the explicit border class
    // and contains the filename text
    const chipStyles = await page.evaluate(() => {
      // Find chip elements by their distinctive class pattern
      const chips = document.querySelectorAll(".rounded-lg.border");
      for (const chip of chips) {
        if (chip.textContent?.includes("Q3_Report_2025.pdf")) {
          const style = window.getComputedStyle(chip);
          return {
            border: style.borderTopColor, // Use specific side to avoid shorthand issues
            bg: style.backgroundColor,
          };
        }
      }
      return null;
    });

    expect(chipStyles).not.toBeNull();

    // Check border — dark:border-gray-600 ≈ (75, 85, 99)
    const borderRgb = parseRgb(chipStyles!.border);
    expect(rgbWithinTolerance(borderRgb, [75, 85, 99], 30)).toBe(true);

    // Check background — dark:bg-gray-700/50
    // gray-700 is (55, 65, 81) at 50% opacity, composited result should be dark
    const bgRgb = parseRgb(chipStyles!.bg);
    expect(isDark(bgRgb, 120)).toBe(true);

    // Check filename text color — dark:text-gray-300 ≈ (209, 213, 219)
    const filenameColor = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.includes("Q3_Report_2025.pdf")) {
          const parent = walker.currentNode.parentElement;
          if (parent) return window.getComputedStyle(parent).color;
        }
      }
      return null;
    });

    expect(filenameColor).not.toBeNull();
    const textRgb = parseRgb(filenameColor!);
    // gray-300 — light text
    expect(isLight(textRgb)).toBe(true);
  });

  test("forward compose has dark styling", async () => {
    // An email should be selected from previous test (Q3 Quarterly Report)
    // Press 'f' to open forward compose
    await page.keyboard.press("f");
    await page.waitForTimeout(500);

    // Verify forward compose is open — address fields should be shown
    const forwardVisible = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input[placeholder]");
      for (const input of inputs) {
        const ph = (input as HTMLInputElement).placeholder.toLowerCase();
        if (ph.includes("to") || ph.includes("recipient") || ph.includes("email")) {
          return true;
        }
      }
      // Look for "Forward" text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.trim() === "Forward") return true;
      }
      return false;
    });

    expect(forwardVisible).toBe(true);

    // Check compose area has dark background
    const composeBg = await page.evaluate(() => {
      const editables = document.querySelectorAll('[contenteditable="true"], textarea');
      for (const ta of editables) {
        let el: Element | null = ta;
        while (el) {
          const bg = window.getComputedStyle(el).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)") return bg;
          el = el.parentElement;
        }
      }
      return null;
    });

    if (composeBg) {
      const bgRgb = parseRgb(composeBg);
      expect(isDark(bgRgb, 100)).toBe(true);
    }

    // Check input fields have dark styling — dark:bg-gray-700
    const inputBg = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input[placeholder]");
      for (const input of inputs) {
        const ph = (input as HTMLInputElement).placeholder.toLowerCase();
        if (ph.includes("to") || ph.includes("recipient") || ph.includes("email")) {
          return window.getComputedStyle(input).backgroundColor;
        }
      }
      return null;
    });

    if (inputBg) {
      const inputRgb = parseRgb(inputBg);
      expect(isDark(inputRgb, 100)).toBe(true);
    }

    // Close forward compose
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("schedule send dropdown has dark styling", async () => {
    // Close any existing inline compose, then use standalone compose
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Open standalone compose with 'c'
    await page.keyboard.press("c");
    await page.waitForTimeout(500);

    // Fill in To field to enable the Schedule button
    const toInput = page
      .locator(
        "input[placeholder*='ecipient'], input[placeholder*='mail'], input[placeholder*='To']",
      )
      .first();
    await expect(toInput).toBeVisible({ timeout: 5000 });
    await toInput.fill("test@example.com");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);

    // Type body content
    const editor = page.locator("[contenteditable='true']").first();
    await editor.click();
    await editor.type("test content");
    await page.waitForTimeout(300);

    // Schedule button should now be enabled
    const scheduleButton = page.locator("button[title='Schedule send']").first();
    await expect(scheduleButton).toBeVisible({ timeout: 5000 });
    await expect(scheduleButton).toBeEnabled({ timeout: 5000 });

    await scheduleButton.click();
    await page.waitForTimeout(300);

    // Verify dropdown is visible — look for preset options
    const dropdownVisible = await page.evaluate(() => {
      const presets = [
        "Tomorrow morning",
        "Tomorrow afternoon",
        "Next Monday",
        "In one week",
        "Pick date & time",
      ];
      for (const p of presets) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.includes(p)) return true;
        }
      }
      return false;
    });

    expect(dropdownVisible).toBe(true);

    // Check dropdown background — dark:bg-gray-800 ≈ (31, 41, 55)
    const dropdownBg = await page.evaluate(() => {
      const dropdowns = document.querySelectorAll('[class*="shadow-lg"]');
      for (const dd of dropdowns) {
        if (dd.textContent?.includes("Tomorrow") || dd.textContent?.includes("Pick date")) {
          return window.getComputedStyle(dd).backgroundColor;
        }
      }
      return null;
    });

    expect(dropdownBg).not.toBeNull();
    const bgRgb = parseRgb(dropdownBg!);
    expect(isDark(bgRgb)).toBe(true);

    // Check border — dark:border-gray-700
    const dropdownBorder = await page.evaluate(() => {
      const dropdowns = document.querySelectorAll('[class*="shadow-lg"]');
      for (const dd of dropdowns) {
        if (dd.textContent?.includes("Tomorrow") || dd.textContent?.includes("Pick date")) {
          return window.getComputedStyle(dd).borderColor;
        }
      }
      return null;
    });

    if (dropdownBorder) {
      const borderRgb = parseRgb(dropdownBorder);
      expect(isDark(borderRgb, 100)).toBe(true);
    }

    // Check preset text color — should be readable on dark bg
    const presetColor = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.includes("Tomorrow morning")) {
          const parent = walker.currentNode.parentElement;
          if (parent) return window.getComputedStyle(parent).color;
        }
      }
      return null;
    });

    if (presetColor) {
      const textRgb = parseRgb(presetColor);
      // Text should be light on dark background
      expect(textRgb[0]).toBeGreaterThan(100);
    }

    // Close dropdown and compose
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("SplitConfigEditor has dark styling", async () => {
    // Open settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({
      timeout: 5000,
    });

    // Navigate to Splits tab
    const splitsTab = page.locator("button:has-text('Splits')");
    await expect(splitsTab).toBeVisible({ timeout: 3000 });
    await splitsTab.click();
    await page.waitForTimeout(300);

    // Click "+ New Split" button
    const newSplitButton = page.locator("button:has-text('New Split')");
    await expect(newSplitButton).toBeVisible({ timeout: 3000 });
    await newSplitButton.click();
    await page.waitForTimeout(300);

    // Verify split editor form is visible — look for the name input
    const nameInput = page.locator("input[placeholder*='Work']").first();
    await expect(nameInput).toBeVisible({ timeout: 3000 });

    // Check editor container background — dark:bg-gray-800 ≈ (31, 41, 55)
    const editorBg = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input");
      for (const input of inputs) {
        if ((input as HTMLInputElement).placeholder?.includes("Work")) {
          let el: Element | null = input.closest(".rounded-lg") || input.parentElement;
          while (el) {
            const bg = window.getComputedStyle(el).backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)") return bg;
            el = el.parentElement;
          }
        }
      }
      return null;
    });

    expect(editorBg).not.toBeNull();
    const bgRgb = parseRgb(editorBg!);
    expect(isDark(bgRgb)).toBe(true);

    // Check input field styling — dark:bg-gray-700, dark:border-gray-600, dark:text-gray-100
    const inputStyle = await page.evaluate(() => {
      const input = document.querySelector("input[placeholder*='Work']") as HTMLInputElement;
      if (!input) return null;
      const style = window.getComputedStyle(input);
      return {
        bg: style.backgroundColor,
        border: style.borderColor,
        color: style.color,
      };
    });

    expect(inputStyle).not.toBeNull();
    if (inputStyle) {
      const inputBgRgb = parseRgb(inputStyle.bg);
      // dark:bg-gray-700 ≈ (55, 65, 81)
      expect(isDark(inputBgRgb, 100)).toBe(true);

      const inputBorderRgb = parseRgb(inputStyle.border);
      // dark:border-gray-600 ≈ (75, 85, 99)
      expect(inputBorderRgb[0]).toBeGreaterThan(50);

      const inputTextRgb = parseRgb(inputStyle.color);
      // dark:text-gray-100 — light text
      expect(isLight(inputTextRgb)).toBe(true);
    }

    // Click Cancel to close the editor
    const cancelButton = page.locator("button:has-text('Cancel')");
    if (await cancelButton.isVisible()) {
      await cancelButton.click();
      await page.waitForTimeout(200);
    }

    // Close settings
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(300);
    }
  });
});
