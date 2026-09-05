import { test, expect } from "@playwright/test";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

test("a slow old search cannot overwrite the latest query or reopen cleared results", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    await waitForEmailListReady(page);
    const requests = await app.evaluateHandle(({ ipcMain }) => {
      const pending = new Map<string, () => void>();
      ipcMain.removeHandler("search:query");
      ipcMain.handle(
        "search:query",
        (_, { query }: { query: string }) =>
          new Promise((resolve) => {
            pending.set(query, () =>
              resolve({
                success: true,
                data: [
                  {
                    id: query,
                    threadId: query,
                    accountId: "default",
                    subject: `${query} result`,
                    from: "test@example.test",
                    to: "me@example.test",
                    date: "2026-01-01",
                    snippet: "",
                    rank: 0,
                  },
                ],
              }),
            );
          }),
      );
      return pending;
    });
    await page.locator("button[title*='Search']").first().click();
    const input = page.locator("input[placeholder*='Search']");
    await input.fill("old");
    await expect.poll(() => requests.evaluate((pending) => pending.has("old"))).toBe(true);
    await input.fill("new");
    await expect.poll(() => requests.evaluate((pending) => pending.has("new"))).toBe(true);
    await requests.evaluate((pending) => pending.get("new")?.());
    await expect(page.getByText("new result", { exact: true })).toBeVisible();
    await requests.evaluate((pending) => pending.get("old")?.());
    // Round-trip another renderer task after the IPC response has arrived.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    await expect(page.getByText("old result", { exact: true })).toHaveCount(0);
    await expect(page.getByText("new result", { exact: true })).toBeVisible();
    await input.fill("cleared");
    await expect.poll(() => requests.evaluate((pending) => pending.has("cleared"))).toBe(true);
    await input.fill("");
    await requests.evaluate((pending) => pending.get("cleared")?.());
    await expect(page.getByText("cleared result", { exact: true })).toHaveCount(0);
    await requests.dispose();
  } finally {
    await closeApp(app);
  }
});
