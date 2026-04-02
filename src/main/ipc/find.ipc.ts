import { ipcMain, BrowserWindow } from "electron";

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

// Shared find state — used by window.ts to intercept Enter in before-input-event.
let lastFindText = "";
let listenerAttached = false;

export const findState = {
  isActive: (): boolean => lastFindText !== "",
  getText: (): string => lastFindText,
};

export function registerFindIpc(): void {
  function ensureListener(w: BrowserWindow): void {
    if (listenerAttached) return;
    listenerAttached = true;

    w.webContents.on("found-in-page", (_event, result) => {
      w.webContents.send("find:result", {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    });

    w.on("closed", () => {
      listenerAttached = false;
      lastFindText = "";
    });
  }

  // Fire-and-forget: call findInPage, results come back via found-in-page.
  // Always use findNext: true — Electron doesn't fire found-in-page for
  // findNext: false when called from an IPC handler.
  // Deferred via setImmediate — calling findInPage synchronously inside an
  // IPC handler prevents the found-in-page event from firing.
  ipcMain.on(
    "find:find",
    (
      _event,
      { text, forward }: { text: string; forward?: boolean; findNext?: boolean },
    ) => {
      const w = getMainWindow();
      if (!w || !text) return;
      ensureListener(w);
      lastFindText = text;
      setImmediate(() => {
        if (!w.isDestroyed()) {
          w.webContents.findInPage(text, { forward: forward ?? true, findNext: true });
        }
      });
    },
  );

  ipcMain.on("find:stop", () => {
    const w = getMainWindow();
    if (!w) return;
    lastFindText = "";
    w.webContents.stopFindInPage("clearSelection");
  });
}
