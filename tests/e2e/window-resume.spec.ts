import { test, expect, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

test.describe("macOS window resume", () => {
  test.skip(process.platform !== "darwin", "macOS owns the close-to-hide lifecycle");

  let electronApp: ElectronApplication;

  test.beforeAll(async ({}, testInfo) => {
    ({ app: electronApp } = await launchElectronApp({ workerIndex: testInfo.workerIndex }));
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("red-button close and Dock activation reuse the same renderer", async () => {
    const result = await electronApp.evaluate(async ({ app, BrowserWindow }) => {
      const originalWindow = BrowserWindow.getAllWindows()[0];
      if (!originalWindow) throw new Error("No BrowserWindow found");

      const originalWebContentsId = originalWindow.webContents.id;
      await originalWindow.webContents.executeJavaScript(
        'window.__exoResumeMarker = "renderer-retained"',
      );

      originalWindow.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const hiddenWindowCount = BrowserWindow.getAllWindows().length;
      const hiddenAfterClose = !originalWindow.isVisible();

      app.emit("activate");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const resumedWindow = BrowserWindow.getAllWindows()[0];
      const marker = await resumedWindow.webContents.executeJavaScript(
        "window.__exoResumeMarker",
      );

      return {
        hiddenWindowCount,
        hiddenAfterClose,
        visibleAfterActivate: resumedWindow.isVisible(),
        sameWebContents: resumedWindow.webContents.id === originalWebContentsId,
        marker,
      };
    });

    expect(result).toEqual({
      hiddenWindowCount: 1,
      hiddenAfterClose: true,
      visibleAfterActivate: true,
      sameWebContents: true,
      marker: "renderer-retained",
    });
  });
});
