import { app, BrowserWindow, ipcMain, session, nativeTheme } from "electron";
import { join } from "path";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { electronApp, optimizer } from "@electron-toolkit/utils";

import { getDataDir, initDevData } from "./data-dir";
import { createLogger, closeLogs } from "./services/logger";

initDevData();

const log = createLogger("app");

// Temporary debug IPC: renderer → main stdout/log
ipcMain.on("debug:log", (_, msg: string) => {
  log.info(`[renderer] ${msg}`);
});

import { ExtensionManifestSchema } from "../shared/extension-types";
import webSearchPackageJson from "../extensions/mail-ext-web-search/package.json";
import calendarPackageJson from "../extensions/mail-ext-calendar/package.json";
import { createWindow, getIconPath } from "./window";
import { registerGmailIpc } from "./ipc/gmail.ipc";
import { registerAnalysisIpc } from "./ipc/analysis.ipc";
import { registerDraftsIpc } from "./ipc/drafts.ipc";
import { registerSettingsIpc, getConfig } from "./ipc/settings.ipc";
import { registerSyncIpc, getEmailSyncService } from "./ipc/sync.ipc";
import { registerPrefetchIpc } from "./ipc/prefetch.ipc";
import { registerExtensionsIpc } from "./ipc/extensions.ipc";
import { registerComposeIpc } from "./ipc/compose.ipc";
import { registerSearchIpc } from "./ipc/search.ipc";
import { registerOutboxIpc, registerNetworkIpc } from "./ipc/outbox.ipc";
import { registerMemoryIpc } from "./ipc/memory.ipc";
import { registerSplitsIpc } from "./ipc/splits.ipc";
import { registerSnippetsIpc } from "./ipc/snippets.ipc";
import { registerArchiveReadyIpc } from "./ipc/archive-ready.ipc";
import { registerSnoozeIpc } from "./ipc/snooze.ipc";
import { registerScheduledSendIpc } from "./ipc/scheduled-send.ipc";
import { registerCalendarIpc } from "./ipc/calendar.ipc";
import { registerAttachmentsIpc } from "./ipc/attachments.ipc";
import { registerAgentIpc } from "./ipc/agent.ipc";
import { registerUpdatesIpc } from "./ipc/updates.ipc";
import { registerOnboardingIpc } from "./ipc/onboarding.ipc";
import { registerFindIpc } from "./ipc/find.ipc";
import { autoUpdateService } from "./services/auto-updater";
import { agentCoordinator } from "./agents/agent-coordinator";
import { initDatabase, closeDatabase, checkpointWal } from "./db";
import { getExtensionHost } from "./extensions";
import { registerPrivateExtensions } from "./extensions/private-extensions";
import { networkMonitor } from "./services/network-monitor";
import { outboxService } from "./services/outbox-service";
import { scheduledSendService } from "./services/scheduled-send-service";
import { snoozeService } from "./services/snooze-service";
import { calendarSyncService } from "./services/calendar-sync";
import { emailSyncService } from "./services/email-sync";
import * as webSearchExtension from "../extensions/mail-ext-web-search/src/index";
import * as calendarExtension from "../extensions/mail-ext-calendar/src/index";

// Skip Keychain for Chromium's internal cookie/localStorage encryption.
// Without this, macOS prompts "wants to access data from other apps" on first launch
// (and again after updates) because Chromium creates a Keychain item with restrictive ACLs.
// The app stores secrets in its own JSON/SQLite files, not in browser storage, so this is safe.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// Fix PATH for packaged macOS apps (launched from Finder/Dock get minimal PATH).
// We use a non-interactive login shell (`-lc`, not `-ilc`) to avoid running the
// user's .zshrc — interactive shell configs can access TCC-protected directories
// (e.g. iterm2_shell_integration, neofetch) which would trigger macOS permission
// prompts attributed to this app. A login shell still sources /etc/zprofile and
// ~/.zprofile, which is where PATH-modifying tools (homebrew, nvm) typically live.
if (app.isPackaged && process.platform === "darwin") {
  try {
    const userShell = process.env.SHELL || "/bin/zsh";
    const output = execSync(`${userShell} -lc 'echo $PATH'`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const shellPath = output.split("\n").pop() || "";
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    const fallbackPaths = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      `${process.env.HOME}/.nvm/current/bin`,
    ].join(":");
    process.env.PATH = `${fallbackPaths}:${process.env.PATH}`;
  }
}

// Load .env file if it exists (for API keys)
// Only check app bundle path in packaged builds. The process.cwd() fallback is only
// useful during development and causes spurious macOS permission prompts (e.g. Desktop
// access) in packaged apps where cwd can resolve to unexpected locations.
const envPath = join(app.getAppPath(), ".env");
const envFile = existsSync(envPath)
  ? envPath
  : !app.isPackaged && existsSync(join(process.cwd(), ".env"))
    ? join(process.cwd(), ".env")
    : null;

if (envFile) {
  try {
    const envContent = readFileSync(envFile, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=");
        if (key && value && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
    log.info("[Config] Loaded .env file");
  } catch (e) {
    log.warn({ err: e }, "[Config] Failed to load .env file");
  }
}

// Pending mailto URL received before the window was ready
let pendingMailtoUrl: string | null = null;

// Request single-instance lock so second-instance event works (Windows/Linux mailto handling).
// On macOS, open-url handles this instead.
// Skip in test/demo mode — E2E tests launch multiple Electron instances in parallel,
// and the lock would cause all but the first to exit immediately.
const isTestMode = process.env.EXO_DEMO_MODE === "true" || process.env.NODE_ENV === "test";
if (process.platform !== "darwin" && !isTestMode) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.exit(0);
  } else {
    // Cold-start: scan process.argv for a mailto URL passed by the OS when launching
    // the first instance (second-instance only fires for subsequent launches).
    const mailtoArg = process.argv.find((arg) => arg.toLowerCase().startsWith("mailto:"));
    if (mailtoArg) {
      pendingMailtoUrl = mailtoArg;
    }
  }
}

// ---------- mailto: default mail app support ----------

// Parse a mailto: URL into structured fields.
// Supports: mailto:addr?subject=...&cc=...&bcc=...&body=...
function parseMailtoUrl(raw: string): {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
} {
  const result = {
    to: [] as string[],
    cc: [] as string[],
    bcc: [] as string[],
    subject: "",
    body: "",
  };
  try {
    // Use URL parser — mailto: is a valid scheme.
    const url = new URL(raw);
    // The pathname contains the primary recipients (before the ?).
    // URL encodes spaces etc, so decode it.
    const primaryTo = decodeURIComponent(url.pathname)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    result.to.push(...primaryTo);

    // Query params: to (additional), cc, bcc, subject, body
    for (const [key, value] of url.searchParams) {
      switch (key.toLowerCase()) {
        case "to":
          result.to.push(
            ...value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          break;
        case "cc":
          result.cc.push(
            ...value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          break;
        case "bcc":
          result.bcc.push(
            ...value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          break;
        case "subject":
          result.subject = value;
          break;
        case "body":
          result.body = value;
          break;
      }
    }
  } catch {
    // If URL parsing fails, try to extract a bare email from the string
    const bare = raw
      .replace(/^mailto:/i, "")
      .split("?")[0]
      .trim();
    if (bare) result.to.push(bare);
  }
  return result;
}

function handleMailtoUrl(url: string): void {
  if (!url.toLowerCase().startsWith("mailto:")) return;
  const wins = BrowserWindow.getAllWindows();
  if (wins.length === 0) {
    // Queue the URL — the new window's renderer will pick it up via getPending()
    pendingMailtoUrl = url;
    // On macOS the app can be running with no windows; create one so the URL gets consumed
    if (app.isReady()) {
      createWindow();
    }
    return;
  }
  const win = wins[0];
  // If the page hasn't loaded yet, queue it so getPending() can deliver it
  if (win.webContents.isLoading()) {
    pendingMailtoUrl = url;
    return;
  }
  // Ensure window is visible
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send("mailto:open", parseMailtoUrl(url));
}

// macOS: open-url fires when the app is launched or focused via a URL scheme
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) {
    handleMailtoUrl(url);
  } else {
    pendingMailtoUrl = url;
  }
});

// Windows/Linux: second-instance fires when another instance is launched with args.
// Always focus the existing window so re-launching the app brings it to the front.
app.on("second-instance", (_event, argv) => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const win = wins[0];
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  const mailtoArg = argv.find((arg) => arg.toLowerCase().startsWith("mailto:"));
  if (mailtoArg) {
    handleMailtoUrl(mailtoArg);
  }
});

// ----------------------------------------------------------

// IPC: check if app is registered as default mailto handler
ipcMain.handle("default-mail-app:is-default", () => {
  return app.isDefaultProtocolClient("mailto");
});

// IPC: set/unset as default mailto handler
ipcMain.handle("default-mail-app:set", (_, enable: boolean) => {
  if (enable) {
    return app.setAsDefaultProtocolClient("mailto");
  } else {
    return app.removeAsDefaultProtocolClient("mailto");
  }
});

// IPC: get and consume pending mailto URL (pull-based, avoids cold-start race)
ipcMain.handle("default-mail-app:get-pending", () => {
  if (pendingMailtoUrl) {
    const parsed = parseMailtoUrl(pendingMailtoUrl);
    pendingMailtoUrl = null;
    return parsed;
  }
  return null;
});

// Initialize database on startup
const _db = initDatabase();

// Wire up AnthropicService cost tracking
import { setAnthropicServiceDb } from "./services/anthropic-service";
setAnthropicServiceDb(_db);

// If no ANTHROPIC_API_KEY in env (e.g. packaged app with no .env), read from stored config
// so that services using `new Anthropic()` pick it up automatically.
{
  const config = getConfig();
  if (!process.env.ANTHROPIC_API_KEY && config.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
}

app.whenReady().then(async () => {
  // Migrate tokens/credentials from old ~/.config/exo/ path (macOS only)
  const { migrateOldConfigIfNeeded } = await import("./services/gmail-client");
  await migrateOldConfigIfNeeded();

  // Set app user model id for windows
  electronApp.setAppUserModelId("com.exo.app");

  // Set dock icon on macOS (especially for dev mode where packaged icon isn't used)
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(getIconPath());
  }

  // Initialize network monitor
  networkMonitor.init();

  // Set up sync service network listeners
  emailSyncService.setupNetworkListeners();

  // Set up outbox service client resolver (gets GmailClient for account)
  outboxService.setClientResolver((accountId) =>
    getEmailSyncService().getClientForAccount(accountId),
  );

  // Set up scheduled send service client resolver and start background timer
  scheduledSendService.setClientResolver((accountId) =>
    getEmailSyncService().getClientForAccount(accountId),
  );
  scheduledSendService.start();

  // NOTE: outbox processing on "online" is handled by sync.ipc.ts
  // after account reconnection completes, to avoid racing against client init.
  // Startup outbox processing is also deferred to sync:init completing.

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Configure webRequest to allow email images to load
  // Many image servers block requests based on Referer or Origin headers
  // This strips those headers for image requests to allow loading
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp"];
  const _imageContentTypes = ["image/"];

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const url = details.url.toLowerCase();
      const isImageUrl =
        imageExtensions.some((ext) => url.includes(ext)) || details.resourceType === "image";

      if (isImageUrl) {
        // Remove headers that cause image servers to block requests
        delete details.requestHeaders["Referer"];
        delete details.requestHeaders["Origin"];
        // Some servers check for sec-fetch headers
        delete details.requestHeaders["Sec-Fetch-Site"];
        delete details.requestHeaders["Sec-Fetch-Mode"];
        delete details.requestHeaders["Sec-Fetch-Dest"];
      }

      callback({ requestHeaders: details.requestHeaders });
    },
  );

  // Also handle response headers to allow images from any origin
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const contentType =
        details.responseHeaders?.["content-type"]?.[0] ||
        details.responseHeaders?.["Content-Type"]?.[0] ||
        "";
      const isImage = contentType.startsWith("image/") || details.resourceType === "image";

      if (isImage) {
        // Remove restrictive CORS headers for images
        if (details.responseHeaders) {
          delete details.responseHeaders["x-frame-options"];
          delete details.responseHeaders["X-Frame-Options"];
          // Ensure CORS allows the image
          details.responseHeaders["access-control-allow-origin"] = ["*"];
        }
      }

      callback({ responseHeaders: details.responseHeaders });
    },
  );

  // Register IPC handlers
  registerGmailIpc();
  registerAnalysisIpc();
  registerDraftsIpc();
  registerSettingsIpc();
  registerSyncIpc();
  registerPrefetchIpc();
  registerExtensionsIpc();
  registerComposeIpc();
  registerSearchIpc();
  registerNetworkIpc();
  registerOutboxIpc();
  registerMemoryIpc();
  registerSplitsIpc();
  registerSnippetsIpc();
  registerArchiveReadyIpc();
  registerSnoozeIpc();
  registerScheduledSendIpc();
  registerCalendarIpc();
  registerAttachmentsIpc();
  registerAgentIpc();
  registerUpdatesIpc();
  registerOnboardingIpc();
  registerFindIpc();

  // Start auto-updater with config. Always set allowPrerelease (even to false)
  // to override electron-updater's default which auto-enables for prerelease versions.
  // Set before token so setGitHubToken's refreshFeedURL() picks up both values.
  {
    const config = getConfig();
    autoUpdateService.setAllowPrerelease(!!config.allowPrereleaseUpdates, {
      skipRefresh: !!config.githubToken,
    });
    if (config.githubToken) {
      autoUpdateService.setGitHubToken(config.githubToken);
    }
    autoUpdateService.start();
  }

  // Load and activate bundled extensions using inline manifests
  // (bypasses filesystem scanning — works in both dev and packaged builds)
  const extensionHost = getExtensionHost();

  const webSearchManifest = ExtensionManifestSchema.parse(webSearchPackageJson.mailExtension);
  const calendarManifest = ExtensionManifestSchema.parse(calendarPackageJson.mailExtension);

  Promise.all([
    extensionHost.registerBundledExtensionFull(webSearchManifest, webSearchExtension),
    extensionHost.registerBundledExtensionFull(calendarManifest, calendarExtension),
  ])
    .then(() => {
      log.info("[Extensions] Bundled extensions activated");
    })
    .catch((error) => {
      log.error({ err: error }, "[Extensions] Failed to activate bundled extensions");
    });

  // Load private extensions (optional, discovered at build time via import.meta.glob)
  registerPrivateExtensions(extensionHost).catch(() => {}); // Ignore errors - private extensions are optional

  // Wire up agent coordinator so installed extensions can load agent providers
  extensionHost.setAgentCoordinator(agentCoordinator);

  // Load installed (external) extensions from userData/extensions/
  const installedExtensionsDir = join(getDataDir(), "extensions");
  extensionHost.setInstalledExtensionsDir(installedExtensionsDir);
  extensionHost.loadInstalledExtensions().catch((error) => {
    log.error({ err: error }, "[Extensions] Failed to load installed extensions");
  });

  // Listen for OS theme changes — broadcast to renderer when preference is "system"
  nativeTheme.on("updated", () => {
    const config = getConfig();
    const preference = config.theme || "system";
    if (preference === "system") {
      const resolved = nativeTheme.shouldUseDarkColors ? "dark" : "light";
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("theme:changed", { preference, resolved });
      }
    }
  });

  const mainWindow = createWindow();

  // Start the agent coordinator with the main window for IPC relay
  agentCoordinator.start(mainWindow);

  app.on("activate", function () {
    // On macOS re-create a window when dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Periodic WAL checkpoint as a safety net — ensures writes are flushed to
// the main DB file even if the app is force-killed without a clean shutdown.
const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const walCheckpointInterval = setInterval(() => {
  checkpointWal();
}, WAL_CHECKPOINT_INTERVAL_MS);

// Flush WAL and close DB before the process exits to prevent data loss.
// Without this, infrequent writes (e.g. memories) can be stranded in the
// WAL file and lost if the file is corrupted or removed during an update.
app.on("before-quit", () => {
  // Stop all interval-based services before closing the DB —
  // otherwise their timers fire after the DB is gone and crash.
  clearInterval(walCheckpointInterval);
  snoozeService.stop();
  scheduledSendService.stop();
  emailSyncService.stopAllSync();
  calendarSyncService.stopSync();

  closeDatabase();
  closeLogs();
});
