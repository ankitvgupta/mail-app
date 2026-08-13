import { ipcMain, BrowserWindow, dialog } from "electron";
import { readFileSync } from "fs";
import { getExtensionHost } from "../extensions";
import { checkExtensionAuth, hasCheckAuth } from "../extensions/extension-api";
import { prefetchService } from "../services/prefetch-service";
import { deleteNeedsAuthEnrichments, getEmail, getEmailsByThread } from "../db";
import { getProvidersNeedingAuth } from "../agents/private-providers-main";
import type {
  ExtensionPanelInfo,
  ExtensionEnrichmentResult,
  InstalledExtensionInfo,
} from "../../shared/extension-types";
import { createLogger } from "../services/logger";

const log = createLogger("extensions-ipc");

/**
 * Register IPC handlers for extension system
 */
export function registerExtensionsIpc(): void {
  const extensionHost = getExtensionHost();

  // Get registered sidebar panels
  ipcMain.handle("extensions:get-panels", (): { success: boolean; data: ExtensionPanelInfo[] } => {
    const t0 = performance.now();
    const result = { success: true, data: extensionHost.getSidebarPanels() };
    const elapsed = performance.now() - t0;
    if (elapsed > 5) log.info(`[PERF] extensions:get-panels took ${elapsed.toFixed(1)}ms`);
    return result;
  });

  // Get cached enrichments for an email
  ipcMain.handle(
    "extensions:get-enrichments",
    (
      _,
      { emailId }: { emailId: string },
    ): { success: boolean; data: ExtensionEnrichmentResult[] } => {
      const t0 = performance.now();
      const result = { success: true, data: extensionHost.getCachedEnrichments(emailId) };
      const elapsed = performance.now() - t0;
      if (elapsed > 5)
        log.info(
          `[PERF] extensions:get-enrichments ${emailId.slice(0, 8)} took ${elapsed.toFixed(1)}ms`,
        );
      return result;
    },
  );

  // Trigger enrichment for an email
  // Returns cached data immediately. If any panels are missing cached data,
  // triggers on-demand enrichment in the background — results arrive via
  // the "extensions:enrichment-ready" event.
  ipcMain.handle(
    "extensions:enrich-email",
    async (
      _,
      { emailId }: { emailId: string },
    ): Promise<{
      success: boolean;
      data?: ExtensionEnrichmentResult[];
      pending?: boolean;
      error?: string;
    }> => {
      const t0 = performance.now();
      try {
        const enrichments = extensionHost.getCachedEnrichments(emailId);

        // Check if all panels have cached data
        const panels = extensionHost.getSidebarPanels();
        const allCached =
          panels.length > 0 &&
          panels.every((p) =>
            enrichments.some((e) => e.extensionId === p.extensionId && e.panelId === p.id),
          );

        const elapsed = performance.now() - t0;
        if (elapsed > 5)
          log.info(
            `[PERF] extensions:enrich-email ${emailId.slice(0, 8)} took ${elapsed.toFixed(1)}ms`,
          );

        if (!allCached) {
          // Trigger on-demand enrichment in the background.
          // Results will arrive via "extensions:enrichment-ready" IPC event.
          const email = getEmail(emailId);
          if (email) {
            const threadEmails = getEmailsByThread(email.threadId, email.accountId);
            extensionHost
              .enrichEmail(email, threadEmails, { allowNewLookups: true })
              .catch((err) => {
                log.error({ err: err }, "[Extensions IPC] Background enrichment failed");
              });
          }
        }

        return { success: true, data: enrichments, pending: !allCached };
      } catch (error) {
        log.error({ err: error }, "[Extensions IPC] enrich-email error");
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Get extension setting
  ipcMain.handle(
    "extensions:get-setting",
    async <T>(
      _: unknown,
      { extensionId, key }: { extensionId: string; key: string },
    ): Promise<{ success: boolean; data?: T; error?: string }> => {
      try {
        const value = await extensionHost.getExtensionSetting<T>(extensionId, key);
        return { success: true, data: value ?? undefined };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Set extension setting
  ipcMain.handle(
    "extensions:set-setting",
    async (
      _,
      { extensionId, key, value }: { extensionId: string; key: string; value: unknown },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        await extensionHost.setExtensionSetting(extensionId, key, value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Get loaded extensions
  ipcMain.handle("extensions:list", () => {
    return extensionHost.getLoadedExtensions();
  });

  // Get extensions + agent providers that need authentication (for onboarding flow)
  ipcMain.handle(
    "extensions:get-pending-auths",
    async (): Promise<
      | {
          success: true;
          data: Array<{
            extensionId: string;
            displayName: string;
            needsAuth: boolean;
            authType: "extension" | "agent";
          }>;
        }
      | { success: false; error: string }
    > => {
      try {
        const [extensionAuths, providerAuths] = await Promise.all([
          extensionHost.getExtensionsNeedingAuth(),
          getProvidersNeedingAuth(),
        ]);

        const combined = [
          ...extensionAuths.map((e) => ({ ...e, authType: "extension" as const })),
          ...providerAuths.map((p) => ({
            extensionId: p.providerId,
            displayName: p.displayName,
            needsAuth: p.needsAuth,
            authType: "agent" as const,
          })),
        ];

        return { success: true, data: combined };
      } catch (error) {
        log.error({ err: error }, "[Extensions IPC] get-pending-auths error");
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Trigger authentication for an extension (called from banner "Authenticate" button)
  ipcMain.handle(
    "extensions:authenticate",
    async (
      _,
      { extensionId }: { extensionId: string },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        await extensionHost.triggerAuth(extensionId);

        // The auth handler is typed () => Promise<void> — it doesn't signal
        // success/failure. Verify actual auth state via checkAuth if available.
        if (hasCheckAuth(extensionId)) {
          const authed = await checkExtensionAuth(extensionId);
          if (!authed) {
            return { success: false, error: "Authentication was cancelled or failed" };
          }
        }

        // Auth succeeded - clear stale needsAuth placeholders from enrichments cache, then re-queue
        const clearedEnrichments = deleteNeedsAuthEnrichments(extensionId);
        log.info(
          `[Extensions IPC] Auth succeeded for ${extensionId}, cleared ${clearedEnrichments} needsAuth enrichments, re-queuing`,
        );
        prefetchService.resetExtensionEnrichments();
        prefetchService.processAllPending();

        return { success: true };
      } catch (error) {
        log.error({ err: error }, `[Extensions IPC] authenticate error for ${extensionId}`);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Install extension from .zip file
  ipcMain.handle(
    "extensions:install",
    async (
      _,
      { filePath }: { filePath?: string },
    ): Promise<{ success: boolean; data?: InstalledExtensionInfo; error?: string }> => {
      try {
        let targetPath = filePath;

        // If no path provided, open a file picker
        if (!targetPath) {
          const focusedWindow = BrowserWindow.getFocusedWindow();
          const result = await dialog.showOpenDialog(
            focusedWindow ?? BrowserWindow.getAllWindows()[0],
            {
              title: "Install Extension",
              filters: [{ name: "Mail Extensions", extensions: ["zip"] }],
              properties: ["openFile"],
            },
          );

          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: "Installation cancelled" };
          }
          targetPath = result.filePaths[0];
        }

        const info = await extensionHost.installExtension(targetPath);

        // Notify all windows that the extension list changed
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("extensions:installed", info);
        }

        return { success: true, data: info };
      } catch (error) {
        log.error({ err: error }, "[Extensions IPC] install error");
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Uninstall an installed extension
  ipcMain.handle(
    "extensions:uninstall",
    async (
      _,
      { extensionId }: { extensionId: string },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const removed = await extensionHost.uninstallExtension(extensionId);
        if (!removed) {
          return { success: false, error: "Extension not found or could not be removed" };
        }

        // Notify all windows
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("extensions:uninstalled", { extensionId });
        }

        return { success: true };
      } catch (error) {
        log.error({ err: error }, `[Extensions IPC] uninstall error for ${extensionId}`);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // List installed (non-bundled) extensions
  ipcMain.handle(
    "extensions:list-installed",
    (): { success: boolean; data: InstalledExtensionInfo[] } => {
      return { success: true, data: extensionHost.getInstalledExtensions() };
    },
  );

  // Get renderer bundle for an installed extension (used by renderer to dynamically load panels)
  ipcMain.handle(
    "extensions:get-renderer-bundle",
    (
      _,
      { extensionId }: { extensionId: string },
    ): { success: boolean; data?: string; error?: string } => {
      try {
        const bundlePath = extensionHost.getRendererBundlePath(extensionId);
        if (!bundlePath) {
          return { success: false, error: "No renderer bundle found" };
        }
        const code = readFileSync(bundlePath, "utf-8");
        return { success: true, data: code };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Check health of an installed agent provider
  ipcMain.handle(
    "extensions:check-provider-health",
    async (
      _,
      { providerId }: { providerId: string },
    ): Promise<{
      success: boolean;
      data?: { status: "connected" | "not_configured" | "error"; message?: string };
      error?: string;
    }> => {
      try {
        const { agentCoordinator } = await import("../agents/agent-coordinator");
        const result = await agentCoordinator.checkProviderHealth(providerId);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Save settings for an installed agent provider
  ipcMain.handle(
    "extensions:save-provider-settings",
    async (
      _,
      { providerId, settings }: { providerId: string; settings: Record<string, unknown> },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        // Save each setting via the extension host's storage
        for (const [key, value] of Object.entries(settings)) {
          await extensionHost.setExtensionSetting(providerId, key, value);
        }
        // Trigger config update to worker so provider picks up new settings
        const { agentCoordinator } = await import("../agents/agent-coordinator");
        const { populatePrivateProviderConfig } = await import("../agents/private-providers-main");
        const { getConfig, getModelIdForFeature } = await import("./settings.ipc");
        const { resolveAgentOllamaConfig } = await import("../../shared/types");
        const appConfig = getConfig();
        // Match the worker's actual destination — when resolveAgentOllamaConfig
        // returns a config (both agent features opted into Ollama), use its
        // Ollama model. Otherwise force an Anthropic model name (the
        // featureProviders map could solo-set agentDrafter to ollama, but
        // the worker stays on Anthropic in that case and would 400 with
        // invalid_model if we sent the Ollama name).
        const ollamaConfig = resolveAgentOllamaConfig(appConfig);
        const baseConfig = {
          model: ollamaConfig?.model ?? getModelIdForFeature("agentDrafter"),
          anthropicApiKey: appConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined,
          ollamaCloud: ollamaConfig,
        };
        const enrichedConfig = await populatePrivateProviderConfig(baseConfig);
        agentCoordinator.updateConfig(enrichedConfig);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Get settings for an installed agent provider
  ipcMain.handle(
    "extensions:get-provider-settings",
    async (
      _,
      { providerId, settingIds }: { providerId: string; settingIds: string[] },
    ): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> => {
      try {
        if (!Array.isArray(settingIds)) {
          return { success: false, error: "settingIds must be an array" };
        }
        const result: Record<string, unknown> = {};
        for (const key of settingIds) {
          result[key] = await extensionHost.getExtensionSetting(providerId, key);
        }
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Setup event forwarding to renderer
  extensionHost.onEnrichmentReady((emailId, enrichment) => {
    // Send to all windows
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("extensions:enrichment-ready", { emailId, enrichment });
    }
  });
}
