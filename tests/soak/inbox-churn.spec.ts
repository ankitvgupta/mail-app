import { test, expect } from "@playwright/test";
import type { useAppStore } from "../../src/renderer/store";
import type { DashboardEmail } from "../../src/shared/types";
import { launchElectronApp, closeApp, waitForEmailListReady } from "../e2e/launch-helpers";

test("large multi-account inbox releases obsolete snapshots during repeated sync and switching", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    await waitForEmailListReady(page);
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false);
        window.show();
        window.focus();
      }
      ipcMain.removeHandler("sync:now");
      ipcMain.handle("sync:now", () => ({ success: true }));
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.evaluate(() => {
      const emails: DashboardEmail[] = Array.from({ length: 30_000 }, (_, i) => ({
        id: `churn-${i}`,
        threadId: `churn-thread-${i}`,
        accountId: `churn-${i % 3}`,
        from: "sender@example.test",
        to: "me@example.test",
        subject: `Churn message ${i}`,
        date: new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString(),
        body: "",
        labelIds: ["INBOX"],
      }));
      (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }).__ZUSTAND_STORE__.setState({
        emails,
        accounts: [0, 1, 2].map((id) => ({
          id: `churn-${id}`,
          email: `${id}@example.test`,
          isPrimary: id === 0,
          isConnected: true,
        })),
        currentAccountId: "churn-0",
        currentSplitId: null,
        selectedEmailId: null,
        selectedThreadId: null,
        viewMode: "split",
      });
    });
    await expect(page.locator('[data-thread-id="churn-thread-0"]')).toBeVisible();
    const samples: number[] = [];
    for (let wave = 0; wave < 6; wave++) {
      await page.evaluate(async (wave) => {
        const store = (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore })
          .__ZUSTAND_STORE__;
        for (let iteration = 0; iteration < 20; iteration++) {
          const accountId = `churn-${iteration % 3}`;
          const current = store.getState().emails.filter((email) => email.accountId === accountId);
          const incoming = structuredClone(current.slice(100));
          for (let j = 0; j < 100; j++) {
            const id = `added-${wave}-${iteration}-${j}`;
            incoming.push({
              id,
              threadId: id,
              accountId,
              from: "sender@example.test",
              to: "me@example.test",
              subject: id,
              date: new Date(
                Date.UTC(2026, 1, 1) + (wave * 2000 + iteration * 100 + j) * 1000,
              ).toISOString(),
              body: `Body ${id} ${"Synthetic content. ".repeat(50)}`,
              labelIds: ["INBOX"],
            });
          }
          store.getState().replaceEmailsForAccount(accountId, incoming);
          store.getState().setCurrentAccountId(iteration % 4 === 0 ? null : accountId);
          await new Promise(requestAnimationFrame);
        }
      }, wave);
      // Compare live heaps after collection, rather than temporary allocation peaks.
      await cdp.send("HeapProfiler.collectGarbage");
      const heap = await cdp.send("Runtime.getHeapUsage");
      samples.push(heap.usedSize);
    }
    console.log(`INBOX_CHURN_HEAP_BYTES ${JSON.stringify(samples)}`);
    // Added bodies intentionally increase the live dataset; obsolete snapshots
    // must not accumulate another inbox on every account switch / sync batch.
    expect(samples.at(-1)! - samples[1]).toBeLessThan(35 * 1024 * 1024);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }
          ).__ZUSTAND_STORE__.getState().emails.length,
      ),
    ).toBe(30_000);
    expect(await page.locator("[data-thread-id]").count()).toBeLessThan(100);
    await testInfo.attach("heap-samples", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
    await cdp.detach();
  } finally {
    await closeApp(app);
  }
});
