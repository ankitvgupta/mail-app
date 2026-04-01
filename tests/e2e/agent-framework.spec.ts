import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

test.describe("Agent Framework", () => {
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

  test("Cmd+J opens the agent command palette", async () => {
    // Select the first email so palette shows quick actions
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    // Press Cmd+J
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    // The palette should be visible with contextual placeholder
    const paletteInput = page.locator('input[placeholder="Ask agent about this email..."]');
    await expect(paletteInput).toBeVisible({ timeout: 3000 });

    // Should show quick actions
    const quickActions = page.locator("text=Quick Actions");
    await expect(quickActions).toBeVisible();

    // Close with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(paletteInput).not.toBeVisible();
  });

  test("agent command palette shows quick actions", async () => {
    // Open palette
    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    // Verify quick actions are listed
    await expect(page.locator("text=Draft a reply to this thread")).toBeVisible();
    await expect(page.locator("text=Summarize this conversation")).toBeVisible();
    await expect(page.locator("text=Look up the sender")).toBeVisible();

    // Close
    await page.keyboard.press("Escape");
  });

  test("agent command palette shows general actions when no email selected", async () => {
    // Deselect any email first
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    // Since no email is selected, should show general-purpose actions and "No email context" indicator
    const noEmailContext = page.locator("text=No email context");
    await expect(noEmailContext).toBeVisible();

    // Should show general quick actions instead of email-specific ones
    await expect(page.locator("text=Draft a new email")).toBeVisible();

    // Placeholder should indicate general mode
    const paletteInput = page.locator('input[placeholder="Ask agent anything..."]');
    await expect(paletteInput).toBeVisible();

    await page.keyboard.press("Escape");
  });

  test("Settings panel has Agents tab", async () => {
    // Open settings via Cmd+,
    await page.keyboard.press("ControlOrMeta+,");
    await page.waitForTimeout(500);

    // Look for the Agents tab button
    const agentsTab = page.locator("button", { hasText: "Agents" });
    await expect(agentsTab).toBeVisible({ timeout: 3000 });

    // Click it
    await agentsTab.click();
    await page.waitForTimeout(300);

    // Verify the browser automation section is visible
    await expect(page.getByRole("heading", { name: "Browser Automation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agent Settings" })).toBeVisible();

    // Close settings
    const closeButton = page.locator('[title="Close settings"]').or(
      page
        .locator("button svg")
        .filter({ has: page.locator('path[d*="M6 18L18 6"]') })
        .first(),
    );
    if (await closeButton.isVisible()) {
      await closeButton.click();
    } else {
      await page.keyboard.press("Escape");
    }
  });

  test("agent palette filtering works", async () => {
    // Select an email first so quick actions are shown
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    await page.keyboard.press("ControlOrMeta+j");
    await page.waitForTimeout(500);

    // Type to filter
    const input = page.locator('input[placeholder="Ask agent about this email..."]');
    await input.fill("archive");
    await page.waitForTimeout(300);

    // Should show archive action, not all actions
    await expect(page.locator("text=Archive and label as handled")).toBeVisible();
    // "Summarize this conversation" should be filtered out
    await expect(page.locator("text=Summarize this conversation")).not.toBeVisible();

    await page.keyboard.press("Escape");
  });

  test("window.api.agent namespace exists in preload", async () => {
    const hasAgentApi = await page.evaluate(() => {
      return (
        typeof (window as Record<string, unknown>).api === "object" &&
        typeof ((window as Record<string, unknown>).api as Record<string, unknown>).agent ===
          "object"
      );
    });
    expect(hasAgentApi).toBe(true);
  });

  test("window.api.agent has expected methods", async () => {
    const methods = await page.evaluate(() => {
      const api = (window as Record<string, unknown>).api as Record<
        string,
        Record<string, unknown>
      >;
      const agent = api.agent;
      return {
        hasRun: typeof agent.run === "function",
        hasCancel: typeof agent.cancel === "function",
        hasConfirm: typeof agent.confirm === "function",
        hasProviders: typeof agent.providers === "function",
        hasOnEvent: typeof agent.onEvent === "function",
        hasOnConfirmation: typeof agent.onConfirmation === "function",
      };
    });
    expect(methods.hasRun).toBe(true);
    expect(methods.hasCancel).toBe(true);
    expect(methods.hasConfirm).toBe(true);
    expect(methods.hasProviders).toBe(true);
    expect(methods.hasOnEvent).toBe(true);
    expect(methods.hasOnConfirmation).toBe(true);
  });

  test("store has agent state slice", async () => {
    const storeState = await page.evaluate(() => {
      const store = (window as Record<string, unknown>).__ZUSTAND_STORE__ as {
        getState?: () => Record<string, unknown>;
      };
      if (!store || typeof store.getState !== "function") return null;
      const state = store.getState();
      return {
        hasAgentTasks: "agentTasks" in state,
        hasAgentTaskIdMap: "agentTaskIdMap" in state,
        hasIsAgentPaletteOpen: "isAgentPaletteOpen" in state,
        hasSelectedAgentIds: "selectedAgentIds" in state,
        hasAvailableProviders: "availableProviders" in state,
        hasAgentTaskHistory: "agentTaskHistory" in state,
        hasStartAgentTask: typeof state.startAgentTask === "function",
        hasAppendAgentEvent: typeof state.appendAgentEvent === "function",
      };
    });
    expect(storeState).not.toBeNull();
    expect(storeState!.hasAgentTasks).toBe(true);
    expect(storeState!.hasAgentTaskIdMap).toBe(true);
    expect(storeState!.hasIsAgentPaletteOpen).toBe(true);
    expect(storeState!.hasSelectedAgentIds).toBe(true);
    expect(storeState!.hasAvailableProviders).toBe(true);
    expect(storeState!.hasAgentTaskHistory).toBe(true);
    expect(storeState!.hasStartAgentTask).toBe(true);
    expect(storeState!.hasAppendAgentEvent).toBe(true);
  });
});
