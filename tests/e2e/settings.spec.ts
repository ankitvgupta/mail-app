import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * E2E Tests for the Settings panel.
 *
 * Tests cover opening/closing settings, navigating between tabs,
 * changing theme, adjusting undo send delay, and verifying persistence.
 *
 * All tests run in DEMO_MODE so no real API calls are made.
 */

test.describe("Settings Panel - Open and Close", () => {
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
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("can open settings via gear icon button", async () => {
    const settingsButton = page.locator("button[title='Settings']");
    await expect(settingsButton).toBeVisible({ timeout: 10000 });
    await settingsButton.click();

    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });
  });

  test("shows General tab by default with expected sections", async () => {
    // General tab content should be visible
    await expect(page.locator("h2:has-text('General Settings')")).toBeVisible({ timeout: 5000 });

    // Should show Appearance, Inbox Density, and Undo Send sections
    await expect(page.locator("h3:has-text('Appearance')")).toBeVisible();
    await expect(page.locator("h3:has-text('Inbox Density')")).toBeVisible();
    await expect(page.locator("h3:has-text('Undo Send')")).toBeVisible();
  });

  test("can close settings via X button and return to inbox", async () => {
    // Settings should already be open from the previous test
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // Click the close button (X icon with M6 18L18 6 path)
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await page.waitForTimeout(300);

    // Should be back to inbox
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });

  test("can open settings via Cmd+, keyboard shortcut", async () => {
    // Ensure we're on the inbox view
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });

    // Press Cmd+, to open settings
    await page.keyboard.press("ControlOrMeta+,");
    await page.waitForTimeout(500);

    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });
  });

  test("can close settings via Escape key", async () => {
    // Settings should be open from previous test
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Settings Panel - Tab Navigation", () => {
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
      await closeApp(electronApp);
    }
  });

  test("opens with General tab active by default", async () => {
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // General tab content should be visible
    await expect(page.locator("h2:has-text('General Settings')")).toBeVisible({ timeout: 5000 });
  });

  test("can navigate to Accounts tab", async () => {
    const accountsTab = page.locator("button:has-text('Accounts')");
    await accountsTab.click();
    await page.waitForTimeout(300);

    // The tab should be visually selected (has blue styling)
    await expect(accountsTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Calendar tab", async () => {
    // Scope within settings panel to avoid matching sidebar/email "Calendar" buttons
    const settings = page.locator("[data-testid='settings-panel']");
    const calendarTab = settings.getByRole("button", { name: "Calendar", exact: true });
    await calendarTab.click();
    await page.waitForTimeout(300);

    await expect(calendarTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Splits tab", async () => {
    const splitsTab = page.locator("button:has-text('Splits')");
    await splitsTab.click();
    await page.waitForTimeout(300);

    await expect(splitsTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Signatures tab", async () => {
    const signaturesTab = page.locator("button:has-text('Signatures')");
    await signaturesTab.click();
    await page.waitForTimeout(300);

    await expect(signaturesTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Prompts tab", async () => {
    const promptsTab = page.locator("button:has-text('Prompts')");
    await promptsTab.click();
    await page.waitForTimeout(300);

    await expect(promptsTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Writing Style tab", async () => {
    const styleTab = page.locator("button:has-text('Writing Style')");
    await styleTab.click();
    await page.waitForTimeout(300);

    await expect(styleTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Executive Assistant tab", async () => {
    const eaTab = page.locator("button:has-text('Executive Assistant')");
    await eaTab.click();
    await page.waitForTimeout(300);

    await expect(eaTab).toHaveAttribute("data-active", "true");
    await expect(page.locator("text=Executive Assistant Integration")).toBeVisible({
      timeout: 5000,
    });
  });

  test("can navigate to AI Memories tab", async () => {
    const memoriesTab = page.locator("button:has-text('AI Memories')");
    await memoriesTab.click();
    await page.waitForTimeout(300);

    await expect(memoriesTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Queue tab", async () => {
    const queueTab = page.locator("button:has-text('Queue')");
    await queueTab.click();
    await page.waitForTimeout(300);

    await expect(queueTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate to Agents tab", async () => {
    const agentsTab = page.locator("button:has-text('Agents')");
    await agentsTab.click();
    await page.waitForTimeout(300);

    await expect(agentsTab).toHaveAttribute("data-active", "true");
  });

  test("can navigate back to General tab", async () => {
    const generalTab = page.locator("button").filter({ hasText: /^General$/ });
    await generalTab.click();
    await page.waitForTimeout(300);

    await expect(generalTab).toHaveAttribute("data-active", "true");
    await expect(page.locator("h2:has-text('General Settings')")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Settings Panel - Theme Switching", () => {
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
      await closeApp(electronApp);
    }
  });

  test("can switch to dark theme", async () => {
    // Open settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // Find and click the Dark button in the Appearance section
    const darkButton = page.locator("button:has-text('Dark')").first();
    await darkButton.click();
    await page.waitForTimeout(500);

    // The Dark button should now have the active style (blue background)
    await expect(darkButton).toHaveAttribute("data-active", "true");

    // The document should have dark class
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(true);
  });

  test("can switch to light theme", async () => {
    const lightButton = page.locator("button:has-text('Light')").first();
    await lightButton.click();
    await page.waitForTimeout(500);

    await expect(lightButton).toHaveAttribute("data-active", "true");

    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(false);
  });

  test("can switch to system theme", async () => {
    const systemButton = page.locator("button:has-text('System')").first();
    await systemButton.click();
    await page.waitForTimeout(500);

    await expect(systemButton).toHaveAttribute("data-active", "true");
  });
});

test.describe("Settings Panel - Undo Send Delay", () => {
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
      await closeApp(electronApp);
    }
  });

  test("shows all undo send delay options", async () => {
    // Open settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // Find the Undo Send section
    await expect(page.locator("h3:has-text('Undo Send')")).toBeVisible();

    // All delay options should be visible
    for (const label of ["Off", "5s", "10s", "15s", "30s"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
  });

  test("can change undo send delay to 10s", async () => {
    const tenSecButton = page.locator("button:has-text('10s')");
    await tenSecButton.click();
    await page.waitForTimeout(300);

    // The 10s button should be active
    await expect(tenSecButton).toHaveAttribute("data-active", "true");
  });

  test("can set undo send to Off", async () => {
    const offButton = page.getByTestId("settings-panel").locator("button:has-text('Off')");
    await offButton.click();
    await page.waitForTimeout(300);

    await expect(offButton).toHaveAttribute("data-active", "true");
  });

  test("can set undo send to 30s", async () => {
    const thirtySecButton = page.locator("button:has-text('30s')");
    await thirtySecButton.click();
    await page.waitForTimeout(300);

    await expect(thirtySecButton).toHaveAttribute("data-active", "true");
  });
});

test.describe("Settings Panel - Persistence", () => {
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
      await closeApp(electronApp);
    }
  });

  test("undo send delay persists after closing and reopening settings", async () => {
    // Open settings and change undo send delay to 15s
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    const fifteenSecButton = page.getByRole("button", { name: "15s", exact: true });
    await fifteenSecButton.click();
    await page.waitForTimeout(500);

    // Verify 15s is active
    await expect(fifteenSecButton).toHaveAttribute("data-active", "true");

    // Close settings
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    await closeButton.click();
    await page.waitForTimeout(300);

    // Reopen settings
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // The 15s button should still be active
    await expect(fifteenSecButton).toHaveAttribute("data-active", "true");
  });

  test("theme preference persists after closing and reopening settings", async () => {
    // Switch to dark theme
    const darkButton = page.locator("button:has-text('Dark')").first();
    await darkButton.click();
    await page.waitForTimeout(500);
    await expect(darkButton).toHaveAttribute("data-active", "true");

    // Close settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Reopen settings
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // Dark button should still be active
    await expect(darkButton).toHaveAttribute("data-active", "true");

    // The document should still have dark class
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(true);

    // Restore to light for other tests
    const lightButton = page.locator("button:has-text('Light')").first();
    await lightButton.click();
    await page.waitForTimeout(300);
  });

  test("inbox density persists after closing and reopening settings", async () => {
    // Switch to compact density
    const compactButton = page.locator("button:has-text('Compact')");
    await compactButton.click();
    await page.waitForTimeout(500);
    await expect(compactButton).toHaveAttribute("data-active", "true");

    // Close and reopen settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // Compact should still be active
    await expect(compactButton).toHaveAttribute("data-active", "true");

    // Restore to default
    const defaultButton = page.locator("button:has-text('Default')").first();
    await defaultButton.click();
    await page.waitForTimeout(300);
  });
});

// The electron-store config is shared across parallel e2e workers (only the DB
// is per-worker). This flow owns the OpenCode, feature-provider, Sender Lookup,
// and background-agent keys, but never touches the Hostler key owned by
// tests/e2e/hostler-settings.spec.ts.
test.describe("Settings Panel - per-feature OpenCode models", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:list-opencode-models");
      ipcMain.handle("settings:list-opencode-models", () => ({
        success: true,
        data: [
          {
            providerId: "openai",
            providerName: "OpenAI",
            modelId: "gpt-5.2",
            modelName: "GPT-5.2",
          },
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            modelId: "claude-sonnet-4-5",
            modelName: "Claude Sonnet 4.5",
          },
        ],
      }));
    });

    await page.evaluate(() =>
      window.api.settings.set({
        senderLookupProvider: "exa",
        featureProviders: {},
        backgroundAgentProvider: "claude",
        opencode: { enabled: true, model: "legacy-model", featureModels: {} },
      }),
    );
  });

  test.afterAll(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.evaluate(() =>
          window.api.settings.set({
            senderLookupProvider: "anthropic",
            featureProviders: {},
            backgroundAgentProvider: "claude",
            opencode: { enabled: false, model: "", featureModels: {} },
          }),
        );
      }
    } finally {
      if (electronApp) {
        await closeApp(electronApp);
      }
    }
  });

  test("stages and persists per-feature OpenCode models and Agent Chat defaults", async () => {
    await page.locator("button[title='Settings']").click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    const labels = [
      "Email Analysis",
      "Draft Generation",
      "Draft Refinement",
      "Scheduling Detection",
      "Archive-Ready Analysis",
      "Sender Lookup",
      "Agent Drafter",
      "Agent Chat",
    ];
    for (const label of labels) {
      const select = page.getByLabel(`Provider for ${label}`);
      await select.scrollIntoViewIfNeeded();
      await expect(select.locator("option[value='opencode']")).toBeEnabled();
    }

    await page.getByLabel("Provider for Email Analysis").selectOption("opencode");
    const analysisModel = page.getByLabel("OpenCode model for Email Analysis");
    await expect(analysisModel).toHaveAttribute("role", "combobox");
    await expect(analysisModel).toHaveAttribute("aria-autocomplete", "list");
    await analysisModel.click();
    await expect(page.getByRole("listbox", { name: "OpenCode model suggestions" })).toBeVisible();
    await analysisModel.press("ArrowDown");
    await analysisModel.press("Enter");
    await expect(analysisModel).toHaveValue("openai/gpt-5.2");

    await page.getByLabel("Provider for Draft Generation").selectOption("opencode");
    await page
      .getByLabel("OpenCode model for Draft Generation")
      .fill("anthropic/claude-sonnet-4-5");

    // Provider and model changes remain staged until the existing Save flow.
    const before = (await page.evaluate(() => window.api.settings.get())) as {
      data?: {
        featureProviders?: Record<string, string>;
        opencode?: { featureModels?: Record<string, string> };
      };
    };
    expect(before.data?.featureProviders?.analysis).toBeUndefined();
    expect(before.data?.opencode?.featureModels?.analysis).toBeUndefined();

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(async () => {
        const cfg = (await page.evaluate(() => window.api.settings.get())) as {
          data?: {
            opencode?: {
              enabled?: boolean;
              model?: string;
              featureModels?: Record<string, string>;
            };
          };
        };
        return cfg.data?.opencode;
      })
      .toMatchObject({
        enabled: true,
        model: "legacy-model",
        featureModels: {
          analysis: "openai/gpt-5.2",
          drafts: "anthropic/claude-sonnet-4-5",
        },
      });

    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByLabel("OpenCode model for Email Analysis")).toHaveValue(
      "openai/gpt-5.2",
    );
    await expect(page.getByLabel("OpenCode model for Draft Generation")).toHaveValue(
      "anthropic/claude-sonnet-4-5",
    );

    // A selector removed from the live catalog remains visible and explicitly warned.
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
      window.api.settings.set({
        opencode: { featureModels: { analysis: "openai/removed-model" } },
      }),
    );
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByLabel("OpenCode model for Email Analysis")).toHaveValue(
      "openai/removed-model",
    );
    await expect(page.getByText("Saved model is unavailable in OpenCode.")).toBeVisible();

    // Catalog refresh failures stay visible and a later successful refresh recovers.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:list-opencode-models");
      ipcMain.handle("settings:list-opencode-models", () => ({
        success: false,
        error: "OpenCode model catalog unavailable",
      }));
    });
    await page.getByRole("button", { name: "Refresh models" }).first().click();
    await expect(page.getByRole("alert").first()).toHaveText("OpenCode model catalog unavailable");

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("settings:list-opencode-models");
      ipcMain.handle("settings:list-opencode-models", () => ({
        success: true,
        data: [
          {
            providerId: "openai",
            providerName: "OpenAI",
            modelId: "gpt-5.2",
            modelName: "GPT-5.2",
          },
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            modelId: "claude-sonnet-4-5",
            modelName: "Claude Sonnet 4.5",
          },
        ],
      }));
    });
    await page.getByRole("button", { name: "Refresh models" }).first().click();
    await expect(page.getByRole("alert")).toHaveCount(0);

    // OpenCode parsing is only eligible with Exa. Leaving Exa resets the staged route.
    await page.getByLabel("Provider for Sender Lookup").selectOption("opencode");
    await page.getByLabel("OpenCode model for Sender Lookup").fill("openai/gpt-5.2");
    await page.getByLabel("Backend").selectOption("anthropic");
    await expect(page.getByLabel("Provider for Sender Lookup")).toHaveValue("anthropic");

    // Agent Drafter owns both the background runtime and per-feature model route.
    await page.getByLabel("Provider for Agent Drafter").selectOption("opencode");
    await page.getByLabel("OpenCode model for Agent Drafter").fill("openai/gpt-5.2");
    await page.getByLabel("Provider for Agent Chat").selectOption("opencode");
    await page.getByLabel("OpenCode model for Agent Chat").fill("openai/gpt-5.2");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect
      .poll(async () => {
        const cfg = (await page.evaluate(() => window.api.settings.get())) as {
          data?: {
            senderLookupProvider?: string;
            backgroundAgentProvider?: string;
            featureProviders?: Record<string, string>;
          };
        };
        return {
          senderLookupProvider: cfg.data?.senderLookupProvider,
          senderLookup: cfg.data?.featureProviders?.senderLookup,
          backgroundAgentProvider: cfg.data?.backgroundAgentProvider,
          agentDrafter: cfg.data?.featureProviders?.agentDrafter,
          agentChat: cfg.data?.featureProviders?.agentChat,
        };
      })
      .toEqual({
        senderLookupProvider: "anthropic",
        senderLookup: "anthropic",
        backgroundAgentProvider: "opencode",
        agentDrafter: "opencode",
        agentChat: "opencode",
      });

    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.getByPlaceholder("Ask agent anything...")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
            getState: () => { selectedAgentIds: string[] };
          };
          return store.getState().selectedAgentIds;
        }),
      )
      .toEqual(["opencode"]);

    await page.getByRole("button", { name: "Claude" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
            getState: () => { selectedAgentIds: string[] };
          };
          return store.getState().selectedAgentIds;
        }),
      )
      .toEqual(["claude"]);

    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+j");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = (window as unknown as Record<string, unknown>).__ZUSTAND_STORE__ as {
            getState: () => { selectedAgentIds: string[] };
          };
          return store.getState().selectedAgentIds;
        }),
      )
      .toEqual(["opencode"]);
    await page.keyboard.press("Escape");
  });

  test("retains a saved OpenCode selection when the extension is disabled", async ({}, testInfo) => {
    await page.evaluate(() =>
      window.api.settings.set({
        featureProviders: { analysis: "opencode" },
        backgroundAgentProvider: "claude",
        opencode: {
          enabled: false,
          featureModels: { analysis: "openai/gpt-5.2" },
        },
      }),
    );
    await closeApp(electronApp);
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    await page.locator("button[title='Settings']").click();
    const select = page.getByLabel("Provider for Email Analysis");
    await select.scrollIntoViewIfNeeded();
    await expect(select).toHaveValue("opencode");
    await expect(select.locator("option[value='opencode']")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Enable OpenCode in Extensions" })).toBeVisible();
    await expect(page.getByLabel("OpenCode model for Email Analysis")).toHaveValue(
      "openai/gpt-5.2",
    );
  });
});
