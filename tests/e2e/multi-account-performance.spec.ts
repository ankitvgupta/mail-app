import { test, expect } from "@playwright/test";
import type { useAppStore } from "../../src/renderer/store";
import type { DashboardEmail } from "../../src/shared/types";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

test("switching large accounts and All Inboxes stays responsive during refreshes", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    await waitForEmailListReady(page);
    const emails: DashboardEmail[] = Array.from({ length: 60_000 }, (_, i) => {
      const account = ["a", "b", "c"][i % 3];
      return {
        id: `multi-${i}`,
        threadId: `multi-${account}-${Math.floor(i / 9)}`,
        accountId: `multi-${account}`,
        from: `Sender ${i % 100} <sender${i % 100}@example.test>`,
        to: `${account}@example.test`,
        subject: `Conversation ${i}`,
        date: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
        body: "",
        labelIds: ["INBOX"],
      };
    });
    const counters = await app.evaluateHandle(({ ipcMain, BrowserWindow }, data) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
        window.show();
        window.focus();
      }
      const counters = { prefetched: 0, refreshes: 0 };
      const byAccount = new Map(
        ["a", "b", "c"].map((a) => [
          `multi-${a}`,
          data.filter((e) => e.accountId === `multi-${a}`),
        ]),
      );
      ipcMain.removeHandler("sync:get-emails");
      ipcMain.handle("sync:get-emails", (_, { accountId }: { accountId: string }) => {
        counters.refreshes++;
        return { success: true, data: byAccount.get(accountId) ?? [] };
      });
      ipcMain.removeHandler("sync:prefetch-bodies");
      ipcMain.handle("sync:prefetch-bodies", (_, { ids }: { ids: string[] }) => {
        counters.prefetched += ids.filter((id) => id.startsWith("multi-")).length;
        return { success: true, data: ids.map((id) => ({ id, body: `Body of ${id}` })) };
      });
      ipcMain.removeHandler("sync:now");
      ipcMain.handle("sync:now", () => ({ success: true }));
      return counters;
    }, emails);
    await page.evaluate((data) => {
      (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }).__ZUSTAND_STORE__.setState({
        emails: data,
        accounts: ["a", "b", "c"].map((id) => ({
          id: `multi-${id}`,
          email: `${id}@example.test`,
          isPrimary: id === "a",
          isConnected: true,
        })),
        currentAccountId: "multi-a",
        currentSplitId: null,
        selectedEmailId: null,
        selectedThreadId: null,
        viewMode: "split",
      });
    }, emails);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect(page.locator('[data-thread-id="multi-a-0"]')).toBeVisible();
    const timings: { account: string; ms: number }[] = [];
    for (const account of ["b", "c", "all", "a", "b", "c", "all", "a", "b", "a"]) {
      const current = await page.evaluate(
        () =>
          (
            window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }
          ).__ZUSTAND_STORE__.getState().currentAccountId,
      );
      await page
        .getByRole("button", {
          name: current ? `${current.slice(-1)}@example.test` : "All Inboxes",
          exact: true,
        })
        .evaluate((button: HTMLButtonElement) => button.click());
      const button = page.getByRole("button", {
        name:
          account === "all"
            ? /^All Inboxes\s*3$/
            : new RegExp(`^${account}@example.test(?: Primary)?$`),
      });
      const ms = await button.evaluate(async (element: HTMLButtonElement, nextAccount) => {
        const frame = () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => {
              const channel = new MessageChannel();
              channel.port1.onmessage = () => {
                channel.port1.close();
                channel.port2.close();
                resolve();
              };
              channel.port2.postMessage(null);
            }),
          );
        await frame();
        const start = performance.now();
        element.click();
        const firstId = `multi-${nextAccount === "all" ? "a" : nextAccount}-0`;
        for (let i = 0; i < 60; i++) {
          await frame();
          const row = document.querySelector(`[data-thread-id="${firstId}"]`);
          if (row?.getClientRects().length) return performance.now() - start;
        }
        throw new Error(`Account ${nextAccount} did not render`);
      }, account);
      timings.push({ account, ms });
      expect(await page.locator("[data-thread-id]").count()).toBeLessThan(100);
      // Let asynchronous metadata and body refreshes settle before switching back.
      await page.waitForTimeout(150);
    }
    console.log(`MULTI_ACCOUNT_SWITCH ${JSON.stringify(timings)}`);
    await testInfo.attach("multi-account-switch", {
      body: JSON.stringify(timings),
      contentType: "application/json",
    });
    const counts = await counters.evaluate((c) => c);
    expect(counts.refreshes).toBeGreaterThanOrEqual(10);
    expect(counts.prefetched).toBeLessThanOrEqual(14 * 60);
    await counters.dispose();
    await cdp.detach();
  } finally {
    await closeApp(app);
  }
});
