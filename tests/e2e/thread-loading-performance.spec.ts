import { test, expect } from "@playwright/test";
import type { useAppStore } from "../../src/renderer/store";
import type { DashboardEmail } from "../../src/shared/types";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

test("selection preloads a thread once and late replies cannot replace the current conversation", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    await waitForEmailListReady(page);
    const emails: DashboardEmail[] = ["a", "b"].map((id, i) => ({
      id: `load-${id}`,
      threadId: `load-thread-${id}`,
      accountId: "load-account",
      from: "Fixture Sender <sender@example.test>",
      to: "me@example.test",
      subject: `Loading fixture ${id.toUpperCase()}`,
      date: new Date(Date.UTC(2026, 0, 2 - i)).toISOString(),
      body: "",
      labelIds: ["INBOX"],
    }));
    const requests = await app.evaluateHandle(({ ipcMain }, data) => {
      const requests: string[] = [];
      const release = new Map<string, () => void>();
      ipcMain.removeHandler("emails:get-thread");
      ipcMain.handle("emails:get-thread", (_, { threadId }: { threadId: string }) => {
        requests.push(threadId);
        const result = {
          success: true,
          data: data
            .filter((e) => e.threadId === threadId)
            .map((e) => ({ ...e, body: `Full body for ${e.id}` })),
        };
        if (threadId === "load-thread-a")
          return new Promise((resolve) => release.set(threadId, () => resolve(result)));
        return result;
      });
      return { requests, release };
    }, emails);
    await page.evaluate((data) => {
      (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }).__ZUSTAND_STORE__.setState({
        emails: data,
        accounts: [
          { id: "load-account", email: "me@example.test", isPrimary: true, isConnected: true },
        ],
        currentAccountId: "load-account",
        currentSplitId: null,
        selectedEmailId: null,
        selectedThreadId: null,
        viewMode: "split",
      });
    }, emails);
    await expect(page.locator('[data-thread-id="load-thread-a"]')).toBeVisible();
    await page.keyboard.press("j");
    await expect.poll(() => requests.evaluate((r) => r.requests)).toEqual(["load-thread-a"]);
    await page.keyboard.press("Enter");
    await expect(page.getByText("Loading fixture A", { exact: true }).last()).toBeVisible();
    await page.keyboard.press("j");
    await expect(page.getByText("Full body for load-b", { exact: true })).toBeVisible();
    await requests.evaluate((r) => r.release.get("load-thread-a")?.());
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    await expect(page.getByText("Full body for load-a", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Full body for load-b", { exact: true })).toBeVisible();
    await page.keyboard.press("k");
    await expect(page.getByText("Full body for load-a", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-thread-id="load-thread-a"]')).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Full body for load-a", { exact: true })).toBeVisible();
    expect(
      await requests.evaluate((r) => r.requests.filter((id) => id === "load-thread-a").length),
    ).toBe(1);
    await requests.dispose();
  } finally {
    await closeApp(app);
  }
});
