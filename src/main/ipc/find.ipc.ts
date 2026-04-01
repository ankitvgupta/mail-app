import { ipcMain, BrowserWindow } from "electron";

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

export function registerFindIpc(): void {
  const win = getMainWindow();
  if (win) {
    win.webContents.on("found-in-page", (_event, result) => {
      win.webContents.send("find:result", {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    });
  }

  ipcMain.handle(
    "find:find",
    (
      _event,
      { text, forward, findNext }: { text: string; forward?: boolean; findNext?: boolean },
    ) => {
      const w = getMainWindow();
      if (!w || !text) return;
      w.webContents.findInPage(text, { forward: forward ?? true, findNext: findNext ?? false });
    },
  );

  ipcMain.handle("find:stop", () => {
    const w = getMainWindow();
    if (!w) return;
    w.webContents.stopFindInPage("clearSelection");
  });
}
