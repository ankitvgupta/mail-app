import { BrowserWindow, shell, nativeTheme, app } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { is } from "@electron-toolkit/utils";
import { getConfig } from "./ipc/settings.ipc";
import { createLogger } from "./services/logger";
import { shouldHideWindowOnClose } from "./window-lifecycle";

// __dirname is undefined in ESM. After the @anthropic-ai/claude-agent-sdk
// 0.3.x upgrade, electron-vite emits the main bundle as ESM, so we resolve
// the directory portably from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger("window");

export function getIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }
  return join(__dirname, "../../resources/icon.png");
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let createdWindowCount = 0;
let reusedWindowCount = 0;
let hiddenWindowCloseCount = 0;

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
  const window = new BrowserWindow({
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

  mainWindow = window;
  createdWindowCount += 1;
  log.info(
    `[Window] Created renderer window #${createdWindowCount} (reused=${reusedWindowCount}, hiddenCloses=${hiddenWindowCloseCount})`,
  );

  window.on("ready-to-show", () => {
    // Don't show window in test/headless mode
    if (!isTestMode) {
      window.show();
    }
  });

  window.on("close", (event) => {
    if (!shouldHideWindowOnClose(process.platform, isQuitting)) return;

    event.preventDefault();
    hiddenWindowCloseCount += 1;
    window.hide();
    log.info(
      `[Window] Hid renderer window instead of destroying it (hiddenCloses=${hiddenWindowCloseCount})`,
    );
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  // Intercept keyboard shortcuts before they reach the page.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    // Cmd/Ctrl+F → open find bar
    const isFindModifier = process.platform === "darwin" ? input.meta : input.control;
    if (input.key === "f" && isFindModifier) {
      event.preventDefault();
      window.webContents.send("find:open");
      return;
    }

    // Enter cycling is handled in the renderer (FindBar.tsx window-level
    // keydown listener) — before-input-event doesn't reliably fire for all
    // input methods (e.g. CDP key injection).
  });

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/**
 * Reveal the existing renderer when possible. This is the fast path used by
 * Dock activation after a macOS red-button close.
 */
export function showMainWindow(): BrowserWindow {
  const existing = getMainWindow();
  if (!existing) return createWindow();

  reusedWindowCount += 1;
  if (existing.isMinimized()) existing.restore();
  if (!existing.isVisible()) existing.show();
  existing.focus();
  log.info(
    `[Window] Reused renderer window (reused=${reusedWindowCount}, created=${createdWindowCount})`,
  );
  return existing;
}

/** Allow BrowserWindow close events to proceed during an intentional app quit. */
export function markAppQuitting(): void {
  isQuitting = true;
}
