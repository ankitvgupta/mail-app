import { test, expect } from "@playwright/test";
import type { useAppStore } from "../../src/renderer/store";
import type { DashboardEmail } from "../../src/shared/types";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

for (const scenario of ["cached", "in-flight", "deleted", "verification-error"] as const) {
  test(`reopening an archived thread cannot restore removed cached members (${scenario})`, async ({}, testInfo) => {
    const { app, page } = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    try {
      await waitForEmailListReady(page);
      const emails: DashboardEmail[] = ["first", "second"].map((name, index) => ({
        id: `cache-${name}`,
        threadId: "cache-thread",
        accountId: "cache-account",
        from: "Cache Sender <sender@example.test>",
        to: "me@example.test",
        subject: `Cache ${name} message`,
        date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
        body: `Cached ${name} body`,
        labelIds: ["INBOX"],
      }));
      const requests = await app.evaluateHandle(
        ({ ipcMain }, { emails, scenario }) => {
          const controls = {
            archived: false,
            count: 0,
            releaseInitial: () => {},
            releaseVerification: () => {},
          };
          ipcMain.removeHandler("emails:get-thread");
          ipcMain.handle("emails:get-thread", () => {
            controls.count++;
            if (controls.archived) {
              return new Promise((resolve) => {
                controls.releaseVerification = () =>
                  resolve(
                    scenario === "verification-error"
                      ? { success: false, error: "Fixture verification failed" }
                      : {
                          success: true,
                          data: (scenario === "deleted" ? emails.slice(0, 1) : emails).map(
                            (email) => ({ ...email, labelIds: [] }),
                          ),
                        },
                  );
              });
            }
            const result = { success: true, data: emails };
            if (scenario === "in-flight") {
              return new Promise((resolve) => {
                controls.releaseInitial = () => resolve(result);
              });
            }
            return result;
          });
          ipcMain.removeHandler("search:query");
          ipcMain.handle("search:query", () => ({
            success: true,
            data: [{ ...emails[0], snippet: "", rank: 0 }],
          }));
          ipcMain.removeHandler("gmail:get-email");
          ipcMain.handle("gmail:get-email", () => ({
            success: true,
            data: { ...emails[0], body: "", labelIds: [] },
          }));
          return controls;
        },
        { emails, scenario },
      );
      await page.evaluate((emails) => {
        const store = (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore })
          .__ZUSTAND_STORE__;
        store.setState({
          emails: emails.map((email) => ({ ...email, body: "" })),
          accounts: [
            { id: "cache-account", email: "me@example.test", isPrimary: true, isConnected: true },
          ],
          currentAccountId: "cache-account",
          currentSplitId: null,
          localDrafts: [],
          selectedEmailId: null,
          selectedThreadId: null,
          viewMode: "split",
        });
      }, emails);
      await expect(page.locator('[data-thread-id="cache-thread"]')).toBeVisible();
      if (scenario === "in-flight") {
        await page.keyboard.press("j");
      } else {
        await page.locator('[data-thread-id="cache-thread"]').click();
        await expect(page.getByText("Cached second body", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await expect.poll(() => requests.evaluate((controls) => controls.count)).toBe(1);

      // Model a completed archive: the mailbox snapshot has removed all thread
      // members and subsequent DB reads return their authoritative new labels.
      await requests.evaluate((controls) => {
        controls.archived = true;
      });
      await page.evaluate(() => {
        (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }).__ZUSTAND_STORE__.setState(
          {
            emails: [],
            selectedEmailId: null,
            selectedThreadId: null,
            viewMode: "split",
          },
        );
      });
      await page.locator("button[title*='Search']").first().click();
      await page.locator("input[placeholder*='Search']").fill("Cache first message");
      await page.getByText("Cache first message", { exact: true }).click();
      if (scenario === "in-flight") {
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }
                ).__ZUSTAND_STORE__.getState().selectedEmailId,
            ),
          )
          .toBe("cache-first");
        await requests.evaluate((controls) => controls.releaseInitial());
      }
      await expect.poll(() => requests.evaluate((controls) => controls.count)).toBe(2);
      await expect(page.getByText("Cached first body", { exact: true })).toBeVisible();
      await expect(page.locator('[data-email-id="cache-second"]')).toHaveCount(0);
      await requests.evaluate((controls) => controls.releaseVerification());
      const readMembers = () =>
        page.evaluate(() =>
          (window as unknown as { __ZUSTAND_STORE__: typeof useAppStore }).__ZUSTAND_STORE__
            .getState()
            .emails.map((email) => ({ id: email.id, labels: email.labelIds })),
        );
      if (scenario === "verification-error" || scenario === "deleted") {
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
        expect(await readMembers()).toEqual([{ id: "cache-first", labels: [] }]);
        await expect(page.locator('[data-email-id="cache-second"]')).toHaveCount(0);
      } else {
        await expect.poll(readMembers).toEqual([
          { id: "cache-first", labels: [] },
          { id: "cache-second", labels: [] },
        ]);
      }
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-thread-id="cache-thread"]')).toHaveCount(0);
      await requests.dispose();
    } finally {
      await closeApp(app);
    }
  });
}
