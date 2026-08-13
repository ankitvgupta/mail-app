import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { closeApp, launchElectronApp } from "./launch-helpers";

test.describe("Settings - Hostler", () => {
  test.describe.configure({ mode: "serial" });

  let electronApp: ElectronApplication;
  let page: Page;
  let originalHostlerConfig:
    | { enabled: boolean; apiKey: string; harness: string; model?: string }
    | undefined;

  test.beforeAll(async ({}, testInfo) => {
    const launched = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = launched.app;
    page = launched.page;

    const current = (await page.evaluate(() => window.api.settings.get())) as {
      data?: { hostler?: typeof originalHostlerConfig };
    };
    originalHostlerConfig = current.data?.hostler;

    await page.getByTitle("Settings").click();
    await page.getByRole("button", { name: "Extensions" }).click();
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  test("save confirms success and persists Hostler settings", async () => {
    const heading = page.getByRole("heading", { name: "Hostler Agent (cloud)", exact: true });
    await heading.scrollIntoViewIfNeeded();
    const card = heading.locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]");
    try {
      const toggle = card.getByRole("checkbox");

      if (await toggle.isChecked()) {
        await toggle.evaluate((element) => element.click());
        await expect
          .poll(async () => {
            const result = (await page.evaluate(() => window.api.settings.get())) as {
              data?: { hostler?: { enabled: boolean } };
            };
            return result.data?.hostler?.enabled;
          })
          .toBe(false);
        await expect(toggle).toBeEnabled();
      }

      await toggle.evaluate((element) => element.click());
      await expect
        .poll(async () => {
          const result = (await page.evaluate(() => window.api.settings.get())) as {
            data?: { hostler?: { enabled: boolean } };
          };
          return result.data?.hostler?.enabled;
        })
        .toBe(true);
      await expect(toggle).toBeChecked();

      const apiKeyInput = card.getByPlaceholder("cpk_...");
      await apiKeyInput.fill("");
      await apiKeyInput.fill("cpk_e2e_test");
      await card.getByPlaceholder("opencode").fill("codex");
      await card.getByPlaceholder("openai/glm-5.2").fill("openai/test-model");

      await card.getByRole("button", { name: "Save", exact: true }).click();
      await expect(card.getByRole("button", { name: "Saved", exact: true })).toBeVisible();

      const result = (await page.evaluate(() => window.api.settings.get())) as {
        success: boolean;
        data?: {
          hostler?: { enabled: boolean; apiKey: string; harness: string; model?: string };
        };
      };
      expect(result).toMatchObject({
        success: true,
        data: {
          hostler: {
            enabled: true,
            apiKey: "cpk_e2e_test",
            harness: "codex",
            model: "openai/test-model",
          },
        },
      });

      await page.keyboard.press("Escape");
      await page.getByTitle("Settings").click();
      await page.getByRole("button", { name: "Extensions" }).click();
      await heading.scrollIntoViewIfNeeded();

      await expect(card.getByPlaceholder("cpk_...")).toHaveValue("cpk_e2e_test");
      await expect(card.getByPlaceholder("opencode")).toHaveValue("codex");
      await expect(card.getByPlaceholder("openai/glm-5.2")).toHaveValue("openai/test-model");
    } finally {
      const restored = (await page.evaluate(
        (hostler) => window.api.settings.set({ hostler }),
        originalHostlerConfig,
      )) as { success: boolean };
      expect(restored.success).toBe(true);
    }
  });

  test("save reports IPC failures and prevents duplicate submissions", async () => {
    await electronApp.evaluate(({ ipcMain }) => {
      const pending: Array<(result: { success: false; error: string }) => void> = [];
      const globals = globalThis as typeof globalThis & { releaseHostlerSave?: () => boolean };
      globals.releaseHostlerSave = () => {
        const resolve = pending.shift();
        if (!resolve) return false;
        resolve({ success: false, error: "Test settings write failed" });
        return true;
      };
      ipcMain.removeHandler("settings:set");
      ipcMain.handle(
        "settings:set",
        () =>
          new Promise<{ success: false; error: string }>((resolve) => {
            pending.push(resolve);
          }),
      );
    });

    const heading = page.getByRole("heading", { name: "Hostler Agent (cloud)", exact: true });
    const card = heading.locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]");
    const toggle = card.getByRole("checkbox");

    await toggle.evaluate((element) => element.click());
    await expect(toggle).toBeDisabled();
    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const globals = globalThis as typeof globalThis & { releaseHostlerSave?: () => boolean };
          return globals.releaseHostlerSave?.() ?? false;
        }),
      )
      .toBe(true);
    await expect(toggle).toBeChecked();
    await expect(card.getByRole("alert")).toHaveText("Test settings write failed");

    await card.getByPlaceholder("opencode").fill("opencode");
    await expect(card.getByRole("alert")).toHaveCount(0);

    await card.getByRole("button", { name: /^Save(?:d)?$/ }).click();
    const savingButton = card.getByRole("button", { name: "Saving...", exact: true });
    await expect(savingButton).toBeDisabled();
    await expect(toggle).toBeDisabled();
    await expect(card.getByPlaceholder("cpk_...")).toBeDisabled();
    await expect(card.getByPlaceholder("opencode")).toBeDisabled();
    await expect(card.getByPlaceholder("openai/glm-5.2")).toBeDisabled();
    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const globals = globalThis as typeof globalThis & { releaseHostlerSave?: () => boolean };
          const released = globals.releaseHostlerSave?.() ?? false;
          if (released) delete globals.releaseHostlerSave;
          return released;
        }),
      )
      .toBe(true);
    await expect(card.getByRole("alert")).toHaveText("Test settings write failed");
    await expect(card.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:set");
      ipcMain.handle("settings:set", () => ({ success: true }));
    });
    await toggle.evaluate((element) => element.click());
    await expect(toggle).not.toBeChecked();

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:set");
      ipcMain.handle("settings:set", () => ({ success: false, error: "Enable failed" }));
    });
    await toggle.evaluate((element) => element.click());
    await expect(toggle).not.toBeChecked();
    await expect(card.getByRole("alert")).toHaveText("Enable failed");

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:set");
      ipcMain.handle("settings:set", () => ({ success: true }));
    });
    await toggle.evaluate((element) => element.click());
    await expect(toggle).toBeChecked();
  });

  test("save uses a fallback error for a malformed IPC response", async () => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:set");
      ipcMain.handle("settings:set", () => undefined);
    });

    const heading = page.getByRole("heading", { name: "Hostler Agent (cloud)", exact: true });
    const card = heading.locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]");
    await card.getByRole("button", { name: /^Save(?:d)?$/ }).click();
    await expect(card.getByRole("alert")).toHaveText("Could not save Hostler settings.");
  });

  test("save reports rejected IPC calls and can be retried", async () => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:set");
      ipcMain.handle("settings:set", () => {
        throw new Error("Test IPC rejection");
      });
    });

    const heading = page.getByRole("heading", { name: "Hostler Agent (cloud)", exact: true });
    const card = heading.locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]");
    await card.getByRole("button", { name: /^Save(?:d)?$/ }).click();
    await expect(card.getByRole("alert")).toContainText("Test IPC rejection");

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:set");
      ipcMain.handle("settings:set", () => ({ success: true }));
    });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await expect(card.getByRole("alert")).toHaveCount(0);
  });
});
