import { test, expect } from "@playwright/test";
import type { useAppStore } from "../../src/renderer/store";
import type { DashboardEmail } from "../../src/shared/types";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

test("large inbox stays virtualized while switching accounts and searching", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    await waitForEmailListReady(page);
    const emails: DashboardEmail[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `perf-email-${i}`,
      threadId: `perf-${i < 10_000 ? "a" : "b"}-${Math.floor(i / 3)}`,
      accountId: i < 10_000 ? "perf-a" : "perf-b",
      from: `Person ${i % 100} <person${i % 100}@example.test>`,
      to: "me@example.test",
      subject: `Project ${Math.floor(i / 3)}`,
      date: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
      snippet: "Synthetic inbox performance fixture",
      body: "",
      labelIds: ["INBOX", "UNREAD"],
    }));
    // Keep account refreshes on the same synthetic dataset through the real
    // renderer IPC path. Demo search remains the existing canned fixture.
    const counters = await app.evaluateHandle(({ ipcMain, BrowserWindow }, data) => {
      const counters = { legacyFetches: 0 };
      // Avoid headless background-frame throttling in latency measurements.
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
      }
      ipcMain.removeHandler("sync:get-emails");
      ipcMain.handle("sync:get-emails", (_, { accountId }: { accountId: string }) => ({
        success: true,
        data: data.filter((email) => email.accountId === accountId),
      }));
      ipcMain.removeHandler("sync:now");
      ipcMain.handle("sync:now", () => ({ success: true }));
      ipcMain.removeHandler("gmail:fetch-unread");
      ipcMain.handle("gmail:fetch-unread", (_, { accountId }: { accountId: string }) => {
        counters.legacyFetches++;
        return { success: true, data: data.filter((email) => email.accountId === accountId) };
      });
      return counters;
    }, emails);
    await page.evaluate((data) => {
      const store = (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore })
        .__ZUSTAND_STORE__;
      store.setState({
        emails: data,
        accounts: [
          { id: "perf-a", email: "a@example.test", isPrimary: true, isConnected: true },
          { id: "perf-b", email: "b@example.test", isPrimary: false, isConnected: true },
        ],
        currentAccountId: "perf-a",
        currentSplitId: null,
        selectedEmailId: null,
        selectedThreadId: null,
        viewMode: "split",
      });
    }, emails);
    await expect(page.locator('[data-thread-id^="perf-a-"]').first()).toBeVisible({
      timeout: 15000,
    });

    const durations: number[] = [];
    for (const account of ["b", "a", "b", "a", "b", "a"]) {
      const current = account === "b" ? "a" : "b";
      await page
        .getByRole("button", { name: `${current}@example.test`, exact: true })
        .evaluate((button: HTMLButtonElement) => button.click());
      const start = performance.now();
      await page
        .getByRole("button", { name: new RegExp(`^${account}@example.test(?: Primary)?$`) })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.locator(`[data-thread-id^="perf-${account}-"]`).first()).toBeVisible();
      durations.push(performance.now() - start);
      // DOM size must depend on the viewport, not the thousands of threads.
      expect(await page.locator("[data-thread-id]").count()).toBeLessThan(100);
    }
    console.log(`LARGE_INBOX_SWITCH_MS ${JSON.stringify(durations)}`);
    await testInfo.attach("account-switch-latency", {
      body: JSON.stringify({ emailCount: emails.length, durationsMs: durations }),
      contentType: "application/json",
    });
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    const selected = await page.evaluate(
      () =>
        (
          window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }
        ).__ZUSTAND_STORE__.getState().selectedThreadId,
    );
    expect(selected).toMatch(/^perf-a-/);
    await page.locator("button[title*='Search']").first().click();
    await page.locator("input[placeholder*='Search']").fill("project");
    await expect(page.getByText("Search all mail", { exact: false }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-thread-id^="perf-a-"]').first()).toBeVisible();
    expect(await counters.evaluate((value) => value.legacyFetches)).toBe(0);
    await counters.dispose();
  } finally {
    await closeApp(app);
  }
});
