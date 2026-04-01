import { BrowserWindow, shell, nativeTheme, app } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import { getConfig } from "./ipc/settings.ipc";

export function getIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }
  return join(__dirname, "../../resources/icon.png");
}

let mainWindow: BrowserWindow | null = null;

// Check if running in test/headless mode
const isTestMode = process.env.NODE_ENV === "test" || process.env.EXO_HEADLESS === "true";

// Resolve initial background color from persisted theme to prevent white flash
function getInitialBackgroundColor(): string {
  try {
    const config = getConfig();
    const theme = config.theme || "system";
    const isDark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
    return isDark ? "#111827" : "#f3f4f6"; // gray-900 / gray-100
  } catch {
    return "#f3f4f6"; // default to light
  }
}

export function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: getInitialBackgroundColor(),
    icon: getIconPath(),
    // Prevent Chromium from throttling timers in hidden windows during tests.
    // Without this, setTimeout-based logic (e.g. undo-send toast auto-dismiss)
    // gets frozen indefinitely when the window is never shown.
    ...(isTestMode && { backgroundThrottling: false }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false, // ESM preload requires sandbox disabled
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading external images in emails
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    // Don't show window in test/headless mode
    if (!isTestMode) {
      mainWindow?.show();
    }
  });

  // Relay found-in-page results to the renderer. This permanent listener
  // fires when webContents.findInPage() finds matches. We relay via send()
  // rather than resolving a handle() promise because Electron deadlocks
  // when found-in-page fires while an IPC handle response is pending.
  mainWindow.webContents.on("found-in-page", (_event, result) => {
    mainWindow?.webContents.send("find:result", {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });

  // Electron's default Edit menu captures Cmd+F for its built-in Find.
  // Intercept it here: prevent the menu from handling it, then tell the
  // renderer to open our custom find bar instead.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isFindModifier = process.platform === "darwin" ? input.meta : input.control;
    if (input.type === "keyDown" && input.key === "f" && isFindModifier) {
      event.preventDefault();
      mainWindow?.webContents.send("find:open");
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
