import { test, expect } from "@playwright/test";
import type { DashboardEmail } from "../../src/shared/types";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

test("large search pages stay virtualized and restore the selected result after opening a thread", async ({}, testInfo) => {
  const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
  try {
    await waitForEmailListReady(page);
    const emails: DashboardEmail[] = Array.from({ length: 351 }, (_, i) => ({
      id: `search-page-${i}`,
      threadId: `search-page-thread-${i}`,
      accountId: "default",
      from: "person@example.test",
      to: "me@example.com",
      subject: `Paginated search ${i}`,
      date: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
      body: "",
      labelIds: [],
    }));
    const requests = await app.evaluateHandle(({ ipcMain }, data) => {
      const pageSizes: number[] = [];
      ipcMain.removeHandler("emails:search");
      ipcMain.handle("emails:search", () => ({ success: true, data: data.slice(0, 300) }));
      ipcMain.removeHandler("emails:search-remote");
      ipcMain.handle(
        "emails:search-remote",
        (_, { maxResults, pageToken }: { maxResults: number; pageToken?: string }) => {
          pageSizes.push(maxResults);
          return {
            success: true,
            data: {
              emails: pageToken ? data.slice(300) : [],
              nextPageToken: pageToken ? undefined : "page-two",
            },
          };
        },
      );
      ipcMain.removeHandler("emails:get-thread");
      ipcMain.handle("emails:get-thread", (_, { threadId }: { threadId: string }) => ({
        success: true,
        data: data
          .filter((email) => email.threadId === threadId)
          .map((email) => ({ ...email, body: `Opened ${email.subject}` })),
      }));
      return pageSizes;
    }, emails);
    await page.locator("button[title*='Search']").first().click();
    await page.locator("input[placeholder*='Search']").fill("paginated");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("search-results-header")).toBeVisible();
    await expect(page.locator('button[data-thread-id="search-page-thread-0"]')).toBeVisible();
    expect(await page.locator("button[data-thread-id]").count()).toBeLessThan(100);
    // Scroll the actual search viewport, allowing the existing pagination
    // sentinel to request a second page outside the initially mounted rows.
    await page.locator('button[data-thread-id="search-page-thread-0"]').evaluate((row) => {
      let element = row.parentElement;
      while (element && getComputedStyle(element).overflowY !== "auto")
        element = element.parentElement;
      if (!element) throw new Error("Search scroll container missing");
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => requests.evaluate((sizes) => sizes.length)).toBe(2);
    await page
      .locator("button[data-thread-id]")
      .last()
      .evaluate((row) => {
        let element = row.parentElement;
        while (element && getComputedStyle(element).overflowY !== "auto")
          element = element.parentElement;
        if (!element) throw new Error("Search scroll container missing");
        element.scrollTop = element.scrollHeight;
      });
    const last = page.locator('button[data-thread-id="search-page-thread-350"]');
    await expect(last).toBeVisible();
    await last.click();
    await expect(page.getByText("Opened Paginated search 350", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(last).toBeVisible();
    await expect(last).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("k");
    await expect(page.locator('button[data-thread-id="search-page-thread-349"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(await page.locator("button[data-thread-id]").count()).toBeLessThan(100);
    expect(await requests.evaluate((sizes) => sizes)).toEqual([50, 50]);
    await requests.dispose();
  } finally {
    await closeApp(app);
  }
});
