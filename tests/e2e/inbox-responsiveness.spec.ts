import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { useAppStore } from "../../src/renderer/store";
import type { DashboardEmail } from "../../src/shared/types";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

test("large inbox remains responsive across refreshes, navigation, and full search", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await launchElectronApp({
    workerIndex: testInfo.workerIndex,
    extraArgs: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
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
    await page.evaluate(() => {
      const store = (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore })
        .__ZUSTAND_STORE__;
      const emails: DashboardEmail[] = Array.from({ length: 30_000 }, (_, i) => ({
        id: `responsive-${i}`,
        threadId: `responsive-thread-${Math.floor(i / 3)}`,
        accountId: "responsive-account",
        from: `Person ${i % 100} <person${i % 100}@example.test>`,
        to: "me@example.test",
        subject: `Project ${Math.floor(i / 3)}`,
        date: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
        snippet: "Synthetic inbox responsiveness fixture",
        body: "",
        labelIds: ["INBOX"],
      }));
      store.setState({
        emails,
        accounts: [
          {
            id: "responsive-account",
            email: "me@example.test",
            isPrimary: true,
            isConnected: true,
          },
        ],
        currentAccountId: "responsive-account",
        currentSplitId: null,
        selectedEmailId: null,
        selectedThreadId: null,
        viewMode: "split",
      });
    });
    await expect(page.locator('[data-thread-id="responsive-thread-0"]')).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (process.env.EXO_PERF_PROFILE) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    const metrics = await page.evaluate(async () => {
      const store = (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore })
        .__ZUSTAND_STORE__;
      const timings: Record<string, number[]> = {};
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      // Measure inside the renderer to exclude Playwright's polling latency.
      // rAF plus a timer yields through the frame's render/paint opportunity.
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
      const measure = async (name: string, action: () => void) => {
        await frame();
        const start = performance.now();
        action();
        await frame();
        (timings[name] ??= []).push(performance.now() - start);
      };
      for (let i = 0; i < 8; i++) {
        await measure("navigate", () =>
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })),
        );
        // Structured clone represents unchanged metadata arriving over IPC.
        const fresh = structuredClone(store.getState().emails).map((email) => ({
          ...email,
          body: "",
        }));
        await measure("refresh", () =>
          store.getState().replaceEmailsForAccount("responsive-account", fresh),
        );
        await measure("bodyUpdate", () =>
          store.getState().updateEmail(`responsive-${100 + i}`, { body: `Hydrated body ${i}` }),
        );
      }
      const results = store
        .getState()
        .emails.filter((_, i) => i % 3 === 0)
        .slice(0, 1500);
      await measure("showSearch", () =>
        store.setState({
          activeSearchQuery: "project",
          activeSearchResults: results,
          remoteSearchResults: [],
          remoteSearchStatus: "complete",
          selectedEmailId: null,
          selectedThreadId: null,
        }),
      );
      const searchRows = document.querySelectorAll("[data-thread-id]").length;
      for (let i = 0; i < 6; i++) {
        await measure("searchNavigate", () =>
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })),
        );
      }
      observer.disconnect();
      return { timings, longTasks, searchRows };
    });
    console.log(`INBOX_RESPONSIVENESS ${JSON.stringify(metrics)}`);
    expect(metrics.searchRows).toBeLessThan(100);
    await testInfo.attach("responsiveness", {
      body: JSON.stringify(metrics),
      contentType: "application/json",
    });
    if (process.env.EXO_PERF_PROFILE) {
      const { profile } = await cdp.send("Profiler.stop");
      const profilePath = testInfo.outputPath("renderer.cpuprofile");
      await writeFile(profilePath, JSON.stringify(profile));
      await testInfo.attach("renderer.cpuprofile", {
        path: profilePath,
        contentType: "application/json",
      });
    }
    await cdp.detach();
    await expect(page.getByTestId("search-results-header")).toContainText("project");
    const selected = await page.evaluate(
      () =>
        (
          window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }
        ).__ZUSTAND_STORE__.getState().selectedThreadId,
    );
    expect(selected).toMatch(/^responsive-thread-/);
    await page.getByRole("button", { name: "Close search", exact: true }).click();
    await expect(page.locator('[data-thread-id="responsive-thread-0"]')).toBeVisible();
    expect(await page.locator("[data-thread-id]").count()).toBeLessThan(100);
  } finally {
    await closeApp(app);
  }
});
