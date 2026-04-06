import { ipcMain, nativeTheme, BrowserWindow, shell, dialog } from "electron";
import Store from "electron-store";
import {
  type AppearanceConfig,
  type Config,
  type EAConfig,
  type IpcResponse,
  type ThemePreference,
  type ModelConfig,
  type ModelTier,
  DEFAULT_ANALYSIS_PROMPT,
  DEFAULT_DRAFT_PROMPT,
  DEFAULT_ARCHIVE_READY_PROMPT,
  DEFAULT_STYLE_PROMPT,
  DEFAULT_AGENT_DRAFTER_PROMPT,
  DEFAULT_MODEL_CONFIG,
  MODEL_TIER_IDS,
  resolveModelId,
} from "../../shared/types";
import { resetAnalyzer } from "./analysis.ipc";
import { resetArchiveReadyAnalyzer } from "./archive-ready.ipc";
import { resetClient, getUsageStats, getCallHistory } from "../services/anthropic-service";
import { prefetchService } from "../services/prefetch-service";
import { agentCoordinator } from "../agents/agent-coordinator";
import {
  getSenderProfile,
  clearInboxAnalyses,
  clearInboxPendingDraftsAndTraces,
  clearInboxArchiveReady,
  type SenderProfile,
} from "../db";
import { getEnrichmentBySender } from "../extensions/enrichment-store";
import { autoUpdateService } from "../services/auto-updater";

import { getDataDir } from "../data-dir";
import { createLogger } from "../services/logger";

const log = createLogger("settings-ipc");

// Lazy-initialized to avoid running before initDevData() — ES module import
// hoisting would otherwise cause the Store constructor to create files in
// .dev-data/ before production data is copied there.
let _store: Store<{ config: Config }> | null = null;
function getStore(): Store<{ config: Config }> {
  if (!_store) {
    _store = new Store<{ config: Config }>({
      name: "exo-config",
      encryptionKey: "exo-encryption-key",
      cwd: getDataDir(),
      defaults: {
        config: {
          maxEmails: 50,
          model: "claude-sonnet-4-20250514",
          modelConfig: DEFAULT_MODEL_CONFIG,
          dryRun: false,
          analysisPrompt: DEFAULT_ANALYSIS_PROMPT,
          draftPrompt: DEFAULT_DRAFT_PROMPT,
          enableSenderLookup: true,
          theme: "system" as const,
          inboxDensity: "compact" as const,
          undoSendDelay: 5,
          autoDraft: {
            enabled: true,
            priorities: ["high", "medium", "low"],
          },
          posthog: {
            enabled: false,
            sessionReplay: false,
          },
          keyboardBindings: "superhuman" as const,
          configVersion: 1,
        },
      },
    });
  }
  return _store;
}

export function getConfig(): Config {
  const config = getStore().get("config");

  // Migrate removed density values to "compact"
  if (config.inboxDensity && !["default", "compact"].includes(config.inboxDensity)) {
    config.inboxDensity = "compact";
    getStore().set("config", config);
  }

  // One-time migration: include "low" in autoDraft priorities for existing users
  // Gated on configVersion so it only runs once — users can later remove "low" if desired
  if ((config.configVersion ?? 0) < 1) {
    if (config.autoDraft?.priorities && !config.autoDraft.priorities.includes("low")) {
      config.autoDraft.priorities.push("low");
    }
    config.configVersion = 1;
    getStore().set("config", config);
  }

  // One-time migration: if user had a custom legacy `model` but no `modelConfig`,
  // map it to a per-feature config so the previous choice isn't silently dropped.
  if (!config.modelConfig && config.model && config.model !== "claude-sonnet-4-20250514") {
    const legacyTier =
      (Object.entries(MODEL_TIER_IDS) as [ModelTier, string][]).find(
        ([, id]) => id === config.model,
      )?.[0] ?? "sonnet";
    const migrated: ModelConfig = { ...DEFAULT_MODEL_CONFIG };
    for (const key of Object.keys(migrated) as (keyof ModelConfig)[]) {
      // Only migrate features that previously used config.model.
      // senderLookup was hardcoded to haiku; agentDrafter was hardcoded to sonnet 4.5;
      // agentChat is new (default opus).
      if (key === "senderLookup" || key === "agentDrafter" || key === "agentChat") continue;
      migrated[key] = legacyTier;
    }
    config.modelConfig = migrated;
    getStore().set("config", config);
  }

  return config;
}

/** Get the resolved modelConfig, falling back to defaults for any missing keys. */
export function getModelConfig(): ModelConfig {
  const config = getConfig();
  return { ...DEFAULT_MODEL_CONFIG, ...config.modelConfig };
}

/** Resolve the concrete model ID for a given feature. */
export function getModelIdForFeature(feature: keyof ModelConfig): string {
  const mc = getModelConfig();
  return resolveModelId(mc[feature]);
}

export function registerSettingsIpc(): void {
  // Validate an Anthropic API key with a minimal API call
  ipcMain.handle(
    "settings:validate-api-key",
    async (_, { apiKey }: { apiKey: string }): Promise<IpcResponse<void>> => {
      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;

        // Resolve model with fallback so config errors don't block validation
        let model: string;
        try {
          model = getModelIdForFeature("senderLookup");
        } catch {
          model = "claude-haiku-4-5-20251001";
        }

        const client = new Anthropic({ apiKey, timeout: 10_000 });
        await client.messages.create({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        return { success: true, data: undefined };
      } catch (error) {
        // Need Anthropic class for instanceof checks — safe to re-import (module cache)
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        if (error instanceof Anthropic.AuthenticationError) {
          return { success: false, error: "Invalid API key. Please check and try again." };
        }
        // Rate limiting, overload (529), and permission denied (403) all happen after
        // auth succeeds — the key is valid even if this specific request was rejected
        if (
          error instanceof Anthropic.RateLimitError ||
          error instanceof Anthropic.PermissionDeniedError ||
          (error instanceof Anthropic.APIError && error.status === 529)
        ) {
          return { success: true, data: undefined };
        }
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { success: false, error: `API key validation failed: ${msg}` };
      }
    },
  );

  // Get current config
  ipcMain.handle("settings:get", async (): Promise<IpcResponse<Config>> => {
    try {
      return { success: true, data: getConfig() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Update config
  ipcMain.handle("settings:set", async (_, config: Partial<Config>): Promise<IpcResponse<void>> => {
    try {
      const currentConfig = getConfig();
      const newConfig = { ...currentConfig, ...config };
      getStore().set("config", newConfig);

      // If githubToken changed, propagate to auto-updater immediately
      if ("githubToken" in config) {
        autoUpdateService.setGitHubToken(newConfig.githubToken);
      }

      // If pre-release preference actually changed, propagate to auto-updater.
      // Coerce with !! so undefined and false are treated as equivalent.
      if (
        "allowPrereleaseUpdates" in config &&
        !!newConfig.allowPrereleaseUpdates !== !!currentConfig.allowPrereleaseUpdates
      ) {
        autoUpdateService.setAllowPrerelease(!!newConfig.allowPrereleaseUpdates);
      }

      // If anthropicApiKey changed, propagate to process.env (for Anthropic SDK)
      // and to the agent worker (for Claude Agent SDK)
      if ("anthropicApiKey" in config) {
        if (newConfig.anthropicApiKey) {
          process.env.ANTHROPIC_API_KEY = newConfig.anthropicApiKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
        agentCoordinator.updateConfig({
          anthropicApiKey: newConfig.anthropicApiKey || undefined,
        });
      }

      // Propagate agent browser config changes
      if ("agentBrowser" in config) {
        const browser = newConfig.agentBrowser;
        agentCoordinator.updateConfig({
          browserConfig: browser
            ? {
                enabled: browser.enabled,
                chromeDebugPort: browser.chromeDebugPort,
                chromeProfilePath: browser.chromeProfilePath,
              }
            : undefined,
        });
      }

      // Propagate custom MCP server config changes
      if ("mcpServers" in config) {
        agentCoordinator.updateConfig({
          mcpServers: newConfig.mcpServers,
        });
      }

      // Propagate CLI tool config changes
      if ("cliTools" in config) {
        agentCoordinator.updateConfig({
          cliTools: newConfig.cliTools,
        });
      }

      // Propagate OpenClaw config to agent providers.
      // Each provider's updateConfig() picks out what it needs from the partial config.
      if ("openclaw" in config) {
        agentCoordinator.updateConfig({
          providers: {
            "openclaw-agent": {
              enabled: newConfig.openclaw?.enabled ?? false,
              gatewayUrl: newConfig.openclaw?.gatewayUrl ?? "",
              gatewayToken: newConfig.openclaw?.gatewayToken ?? "",
            },
          },
        });
      }

      // Propagate model config changes to the agent worker.
      // Only agentDrafter needs propagation here — it's the worker's default model for
      // auto-draft tasks that don't pass a per-task override. The agentChat model is
      // resolved fresh per-invocation in agent.ipc.ts via getModelIdForFeature("agentChat").
      if ("modelConfig" in config) {
        agentCoordinator.updateConfig({
          model: getModelIdForFeature("agentDrafter"),
        });
      }

      // Reset cached analyzer/service instances when model config or API key changes,
      // since they hold Anthropic client instances that capture the key at construction.
      if ("modelConfig" in config || "anthropicApiKey" in config) {
        resetClient();
        resetAnalyzer();
        resetArchiveReadyAnalyzer();
        prefetchService.reset();
      }

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Validate a GitHub PAT from the main process (renderer CSP blocks direct fetch)
  ipcMain.handle(
    "settings:validate-github-token",
    async (_, token: string): Promise<IpcResponse<void>> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const resp = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!resp.ok) {
          // 401 = bad token. 403 can be rate limiting OR bad token — check the
          // x-ratelimit-remaining header to distinguish.
          if (resp.status === 401) {
            return {
              success: false,
              error: "Invalid GitHub token — please check that it hasn't expired or been revoked.",
            };
          }
          if (resp.status === 403) {
            const remaining = resp.headers.get("x-ratelimit-remaining");
            if (remaining === "0") {
              // Rate limited — allow saving, token may be valid
              return { success: true, data: undefined };
            }
            return {
              success: false,
              error: "This token doesn't have access — please check the permissions.",
            };
          }
          // Other non-2xx (5xx, 429, etc.) — allow saving, don't blame the token
          return { success: true, data: undefined };
        }
        // Classic PATs return x-oauth-scopes; fine-grained PATs don't (header is absent).
        // Only enforce repo scope for classic PATs where we can check.
        const scopes = resp.headers.get("x-oauth-scopes");
        if (scopes !== null) {
          const hasRepo = scopes
            .split(",")
            .map((s) => s.trim())
            .includes("repo");
          if (!hasRepo) {
            return {
              success: false,
              error:
                "This token is missing the required 'repo' scope. Please create a new token with 'repo' selected.",
            };
          }
        }
        return { success: true, data: undefined };
      } catch {
        // Network error or timeout — allow saving anyway for offline setups
        return { success: true, data: undefined };
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  // Get prompts — getConfig() already strips old format suffixes
  ipcMain.handle(
    "settings:get-prompts",
    async (): Promise<
      IpcResponse<{
        analysisPrompt: string;
        draftPrompt: string;
        archiveReadyPrompt: string;
        stylePrompt: string;
        agentDrafterPrompt: string;
      }>
    > => {
      try {
        const config = getConfig();
        return {
          success: true,
          data: {
            analysisPrompt: config.analysisPrompt || DEFAULT_ANALYSIS_PROMPT,
            draftPrompt: config.draftPrompt || DEFAULT_DRAFT_PROMPT,
            archiveReadyPrompt: config.archiveReadyPrompt || DEFAULT_ARCHIVE_READY_PROMPT,
            stylePrompt: config.stylePrompt || DEFAULT_STYLE_PROMPT,
            agentDrafterPrompt: config.agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update prompts — detect changes, clear stale data, and re-trigger processing
  ipcMain.handle(
    "settings:set-prompts",
    async (
      _,
      {
        analysisPrompt,
        draftPrompt,
        archiveReadyPrompt,
        stylePrompt,
        agentDrafterPrompt,
      }: {
        analysisPrompt?: string;
        draftPrompt?: string;
        archiveReadyPrompt?: string;
        stylePrompt?: string;
        agentDrafterPrompt?: string;
      },
    ): Promise<
      IpcResponse<{
        analysisChanged: boolean;
        draftChanged: boolean;
        archiveReadyChanged: boolean;
        agentDrafterChanged: boolean;
      }>
    > => {
      try {
        // getConfig() already strips old baked-in format suffixes
        const currentConfig = getConfig();
        const updates: Partial<Config> = {};

        const currentAnalysis = currentConfig.analysisPrompt || DEFAULT_ANALYSIS_PROMPT;
        const currentDraft = currentConfig.draftPrompt || DEFAULT_DRAFT_PROMPT;
        const currentArchiveReady =
          currentConfig.archiveReadyPrompt || DEFAULT_ARCHIVE_READY_PROMPT;
        const currentAgentDrafter =
          currentConfig.agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT;

        // Determine new values (from UI, which never includes format suffixes)
        const newAnalysis =
          analysisPrompt !== undefined
            ? analysisPrompt || DEFAULT_ANALYSIS_PROMPT
            : currentAnalysis;
        const newDraft =
          draftPrompt !== undefined ? draftPrompt || DEFAULT_DRAFT_PROMPT : currentDraft;
        const newArchiveReady =
          archiveReadyPrompt !== undefined
            ? archiveReadyPrompt || DEFAULT_ARCHIVE_READY_PROMPT
            : currentArchiveReady;
        const newAgentDrafter =
          agentDrafterPrompt !== undefined
            ? agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT
            : currentAgentDrafter;

        // Detect which prompts actually changed
        const analysisChanged = newAnalysis !== currentAnalysis;
        const draftChanged = newDraft !== currentDraft;
        const archiveReadyChanged = newArchiveReady !== currentArchiveReady;
        const agentDrafterChanged = newAgentDrafter !== currentAgentDrafter;

        // Store clean prompts (without format suffixes — those are appended at runtime)
        if (analysisPrompt !== undefined) updates.analysisPrompt = newAnalysis;
        if (draftPrompt !== undefined) updates.draftPrompt = newDraft;
        if (archiveReadyPrompt !== undefined) updates.archiveReadyPrompt = newArchiveReady;
        if (stylePrompt !== undefined) {
          updates.stylePrompt = stylePrompt || DEFAULT_STYLE_PROMPT;
        }
        if (agentDrafterPrompt !== undefined) {
          updates.agentDrafterPrompt = agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT;
        }

        getStore().set("config", { ...currentConfig, ...updates });

        // Cancel running agent drafts FIRST so in-flight saveDraft messages
        // don't overwrite the cleared state below
        if (analysisChanged || draftChanged || agentDrafterChanged) {
          agentCoordinator.cancelByPrefix("auto-draft-");
        }

        // Clear stale data for changed prompts (inbox only — archived emails don't need re-processing)
        if (analysisChanged) {
          const cleared = clearInboxAnalyses();
          log.info(`[Settings] Analysis prompt changed — cleared ${cleared} inbox analyses`);
          // Drafts depend on analysis context, so clear them too (with their agent traces)
          const { draftsCleared: clearedDrafts, tracesCleared: clearedTraces } =
            clearInboxPendingDraftsAndTraces();
          log.info(
            `[Settings] Also cleared ${clearedDrafts} pending drafts, ${clearedTraces} agent traces (depend on analysis)`,
          );
          // Archive-ready depends on analysis too
          const clearedArchive = clearInboxArchiveReady();
          log.info(`[Settings] Also cleared ${clearedArchive} inbox archive-ready results`);
        } else {
          if (draftChanged || agentDrafterChanged) {
            const { draftsCleared: cleared, tracesCleared } = clearInboxPendingDraftsAndTraces();
            log.info(
              `[Settings] ${agentDrafterChanged ? "Agent drafter" : "Draft"} prompt changed — cleared ${cleared} pending drafts, ${tracesCleared} agent traces`,
            );
          }
          if (archiveReadyChanged) {
            const cleared = clearInboxArchiveReady();
            log.info(
              `[Settings] Archive-ready prompt changed — cleared ${cleared} inbox archive-ready results`,
            );
          }
        }

        // Reset service instances to pick up new prompts
        resetAnalyzer();
        resetArchiveReadyAnalyzer();

        const anyChanged =
          analysisChanged || draftChanged || archiveReadyChanged || agentDrafterChanged;

        if (anyChanged) {
          // Full clear to reset all tracking sets, then re-process
          prefetchService.clear();

          // Notify renderer to refresh emails (stale analysis/draft data is gone)
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send("prompts:changed", {
              analysisChanged,
              draftChanged,
              archiveReadyChanged,
              agentDrafterChanged,
            });
          }

          // Re-trigger background processing
          prefetchService.processAllPending().catch((error) => {
            log.error({ err: error }, "[Settings] Error re-processing after prompt change");
          });
        } else {
          prefetchService.reset();
        }

        return {
          success: true,
          data: { analysisChanged, draftChanged, archiveReadyChanged, agentDrafterChanged },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get style context (uses new style-profiler with few-shot examples)
  ipcMain.handle(
    "style:get-context",
    async (
      _,
      { toAddress, accountId }: { toAddress: string; accountId?: string },
    ): Promise<IpcResponse<string>> => {
      try {
        const { buildStyleContext } = await import("../services/style-profiler");
        const { getEmailSyncService } = await import("./sync.ipc");
        const config = getConfig();
        const resolvedAccountId = accountId ?? "default";
        const gmailClient = getEmailSyncService().getClientForAccount(resolvedAccountId);
        const context = await buildStyleContext(
          toAddress,
          resolvedAccountId,
          config.stylePrompt || DEFAULT_STYLE_PROMPT,
          gmailClient,
        );
        return { success: true, data: context };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get EA config
  ipcMain.handle("settings:get-ea", async (): Promise<IpcResponse<EAConfig>> => {
    try {
      const config = getConfig();
      return {
        success: true,
        data: config.ea || { enabled: false },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Set EA config
  ipcMain.handle("settings:set-ea", async (_, eaConfig: EAConfig): Promise<IpcResponse<void>> => {
    try {
      const currentConfig = getConfig();
      getStore().set("config", { ...currentConfig, ea: eaConfig });

      // Reset generator to use new config

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Get sender profile from database cache
  ipcMain.handle(
    "sender:get-profile",
    async (_, { email }: { email: string }): Promise<IpcResponse<SenderProfile | null>> => {
      try {
        const profile = getSenderProfile(email);
        return { success: true, data: profile };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get theme preference and resolved value
  ipcMain.handle(
    "theme:get",
    async (): Promise<IpcResponse<{ preference: ThemePreference; resolved: "light" | "dark" }>> => {
      try {
        const config = getConfig();
        const preference: ThemePreference = config.theme || "system";
        const resolved: "light" | "dark" =
          preference === "system"
            ? nativeTheme.shouldUseDarkColors
              ? "dark"
              : "light"
            : preference;
        return { success: true, data: { preference, resolved } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Set theme preference
  ipcMain.handle(
    "theme:set",
    async (_, theme: ThemePreference): Promise<IpcResponse<{ resolved: "light" | "dark" }>> => {
      try {
        const currentConfig = getConfig();
        getStore().set("config", { ...currentConfig, theme });

        const resolved: "light" | "dark" =
          theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;

        // Broadcast to all windows
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("theme:changed", { preference: theme, resolved });
        }

        return { success: true, data: { resolved } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get appearance config
  ipcMain.handle("appearance:get", async (): Promise<IpcResponse<AppearanceConfig>> => {
    try {
      const config = getConfig();
      return {
        success: true,
        data: config.appearance ?? { themePreset: "default", accentColor: null },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Set appearance config — saves to store, broadcasts to renderer
  ipcMain.handle(
    "appearance:set",
    async (_, appearance: AppearanceConfig): Promise<IpcResponse<void>> => {
      try {
        const currentConfig = getConfig();
        getStore().set("config", { ...currentConfig, appearance });

        // Broadcast to all renderer windows
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send("appearance:changed", appearance);
        }

        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Test OpenClaw connection by running `openclaw health`
  ipcMain.handle("settings:test-openclaw-connection", async (): Promise<IpcResponse<void>> => {
    const { execFile } = await import("node:child_process");
    const appConfig = getConfig();
    const env: Record<string, string> = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
    if (appConfig.openclaw?.gatewayUrl) {
      env.OPENCLAW_GATEWAY_URL = appConfig.openclaw.gatewayUrl;
    }
    if (appConfig.openclaw?.gatewayToken) {
      env.OPENCLAW_GATEWAY_TOKEN = appConfig.openclaw.gatewayToken;
    }
    return new Promise((resolve) => {
      execFile("openclaw", ["health"], { timeout: 10_000, env }, (error, stdout, stderr) => {
        if (error) {
          // execFile sets error.code to "ENOENT" when the binary isn't found
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            resolve({
              success: false,
              error: "OpenClaw CLI not found — install with `npm install -g openclaw`",
            });
            return;
          }
          const combined = (stderr || "") + (stdout || "");
          if (combined.includes("ECONNREFUSED") || combined.includes("not reachable")) {
            resolve({
              success: false,
              error: "OpenClaw gateway not running — start it with `openclaw gateway run`",
            });
            return;
          }
          resolve({ success: false, error: error.message });
          return;
        }
        // `openclaw health` outputs "Agents:" when the gateway is healthy
        if (stdout.includes("Agents:")) {
          resolve({ success: true, data: undefined });
        } else {
          resolve({ success: false, error: "Unexpected response from OpenClaw" });
        }
      });
    });
  });

  // Get sender profile from extension cache or legacy DB
  // New lookups are triggered by the background prefetch service
  ipcMain.handle(
    "sender:lookup",
    async (
      _,
      { from, email: emailAddr }: { from: string; email: string },
    ): Promise<IpcResponse<SenderProfile | null>> => {
      const isTestMode = process.env.EXO_TEST_MODE === "true";
      const isDemoMode = process.env.EXO_DEMO_MODE === "true";

      if (isTestMode || isDemoMode) {
        // Return mock data in demo mode
        const mockProfile: SenderProfile = {
          email: emailAddr,
          name: from.split("<")[0].trim() || "Demo Sender",
          summary: "Demo sender profile - web search disabled in demo mode.",
          lookupAt: Date.now(),
        };
        return { success: true, data: mockProfile };
      }

      try {
        // Check extension enrichment cache first (new system)
        const enrichment = getEnrichmentBySender(emailAddr.toLowerCase(), "web-search");
        if (enrichment?.data) {
          const data = enrichment.data as {
            name: string;
            summary: string;
            email: string;
            lookupAt?: number;
          };
          log.info(`[SenderProfile] Using extension cache for ${emailAddr}`);
          return {
            success: true,
            data: {
              email: emailAddr,
              name: data.name || from.split("<")[0].trim(),
              summary: data.summary || "No information found.",
              lookupAt: data.lookupAt || Date.now(),
            },
          };
        }

        // Fall back to legacy sender_profiles table
        const existingProfile = getSenderProfile(emailAddr);
        if (existingProfile) {
          log.info(`[SenderProfile] Using legacy cache for ${emailAddr}`);
          return { success: true, data: existingProfile };
        }

        // No cached data - return null (background prefetch will populate later)
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Usage / cost tracking
  ipcMain.handle(
    "settings:get-usage-stats",
    async (): Promise<IpcResponse<ReturnType<typeof getUsageStats>>> => {
      try {
        return { success: true, data: getUsageStats() };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  ipcMain.handle(
    "settings:get-call-history",
    async (
      _,
      args?: { limit?: number },
    ): Promise<IpcResponse<ReturnType<typeof getCallHistory>>> => {
      try {
        const limit = Math.min(Math.max(args?.limit ?? 50, 1), 500);
        return { success: true, data: getCallHistory(limit) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Export logs: zip the log directory and prompt the user to save
  ipcMain.handle("settings:export-logs", async (): Promise<IpcResponse<void>> => {
    try {
      if (process.platform !== "darwin") {
        return { success: false, error: "Log export is currently only supported on macOS." };
      }

      const { join } = await import("path");
      const { readdirSync, mkdirSync } = await import("fs");
      const { execFile } = await import("child_process");

      const logDir = join(getDataDir(), "logs");
      mkdirSync(logDir, { recursive: true });

      const logFiles = readdirSync(logDir).filter((f) => f.endsWith(".log"));
      if (logFiles.length === 0) {
        return { success: false, error: "No log files found." };
      }

      const defaultName = `exo-logs-${new Date().toISOString().split("T")[0]}.zip`;
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Export Logs",
        defaultPath: defaultName,
        filters: [{ name: "Zip Archive", extensions: ["zip"] }],
      });

      if (canceled || !filePath) {
        return { success: true, data: undefined };
      }

      // Use macOS ditto to create a zip of the logs directory
      await new Promise<void>((resolve, reject) => {
        execFile(
          "ditto",
          ["-c", "-k", "--sequesterRsrc", logDir, filePath],
          { timeout: 30_000 },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });

      // Reveal the exported file in Finder
      shell.showItemInFolder(filePath);

      return { success: true, data: undefined };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });
}
