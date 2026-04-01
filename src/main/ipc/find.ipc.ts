import { ipcMain, BrowserWindow } from "electron";

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

export function registerFindIpc(): void {
  // Fire-and-forget: just call findInPage. Results are relayed via the
  // permanent "found-in-page" listener in window.ts → "find:result" IPC.
  // We intentionally avoid ipcMain.handle here because returning a promise
  // that waits on "found-in-page" deadlocks — Electron won't dispatch the
  // webContents event while an IPC handle response is pending.
  ipcMain.on(
    "find:find",
    (
      _event,
      { text, forward, findNext }: { text: string; forward?: boolean; findNext?: boolean },
    ) => {
      const w = getMainWindow();
      if (!w || !text) return;
      // Always use findNext: true — Electron's found-in-page event doesn't
      // fire for the initial search (findNext: false) when called from an IPC
      // handler. Using findNext: true works for both initial and subsequent
      // searches: Electron starts a new search if the text differs from the
      // active search, and advances to the next match if it's the same text.
      setImmediate(() => {
        w.webContents.findInPage(text, { forward: forward ?? true, findNext: true });
      });
    },
  );

  ipcMain.on("find:stop", () => {
    const w = getMainWindow();
    if (!w) return;
    w.webContents.stopFindInPage("clearSelection");
  });
}
