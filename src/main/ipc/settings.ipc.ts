import { ipcMain, nativeTheme, BrowserWindow, shell, dialog } from "electron";
import Store from "electron-store";
import {
  type Config,
  type EAConfig,
  type IpcResponse,
  type ThemePreference,
  type ModelConfig,
  type ModelTier,
  type LlmProvider,
  type SenderLookupProvider,
  DEFAULT_ANALYSIS_PROMPT,
  DEFAULT_DRAFT_PROMPT,
  DEFAULT_ARCHIVE_READY_PROMPT,
  DEFAULT_STYLE_PROMPT,
  DEFAULT_AGENT_DRAFTER_PROMPT,
  DEFAULT_MODEL_CONFIG,
  MODEL_TIER_IDS,
  resolveModelId,
  resolveAgentOllamaConfig,
  resolveBackgroundAgentProviderId,
  DEFAULT_BACKGROUND_AGENT_PROVIDER,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_HOSTLER_HARNESS,
} from "../../shared/types";
import { resetAnalyzer } from "./analysis.ipc";
import { resetArchiveReadyAnalyzer } from "./archive-ready.ipc";
import {
  resetClient,
  setOllamaConfig,
  getUsageStats,
  getCallHistory,
} from "../services/llm-service";
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

import { existsSync } from "fs";
import { getDataDir } from "../data-dir";
import { createLogger } from "../services/logger";

const log = createLogger("settings-ipc");

/** True only for URLs whose host is the local machine — the one baseUrl
 *  class safe to accept over the renderer-reachable settings IPC. */
function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

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
          senderLookupProvider: "anthropic" as const,
          syncDraftsToGmail: false,
          theme: "system" as const,
          inboxDensity: "compact" as const,
          undoSendDelay: 5,
          sendAndArchive: false,
          showExoBranding: true,
          autoDraft: {
            enabled: true,
          },
          // posthog intentionally omitted from defaults — getConfig() applies
          // a version-aware default so pre-existing installs (configVersion < 2)
          // are not silently opted in to analytics + session replay.
          keyboardBindings: "superhuman" as const,
          // Keep in sync with the latest migration version in getConfig() so a
          // fresh install starts current and doesn't trigger a no-op migration
          // write on first load.
          configVersion: 3,
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

  // configVersion 1 baseline — pre-existing per-priority autoDraft configs are
  // no longer meaningful (issue #143: collapsed to binary Priority/Other) but we
  // keep the version bump so subsequent migrations key off the same scheme.
  if ((config.configVersion ?? 0) < 1) {
    config.configVersion = 1;
    getStore().set("config", config);
  }

  // v2 migration: set posthog defaults explicitly so we can distinguish a brand-new
  // install (where we opt in to analytics + session replay) from a pre-existing
  // install with no persisted posthog choice (where we opt out, to avoid silently
  // enabling session replay on upgrade for users who never saw the wizard step).
  if ((config.configVersion ?? 0) < 2) {
    if (!config.posthog) {
      config.posthog = { enabled: false, sessionReplay: false };
    }
    config.configVersion = 2;
    getStore().set("config", config);
  } else if (!config.posthog) {
    // Fresh install at configVersion >= 2 with no persisted posthog (e.g., user
    // hasn't completed the wizard yet) — opt in by default. Wizard will overwrite
    // with the user's actual choice.
    config.posthog = { enabled: true, sessionReplay: true };
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

  // v3 migration: GLM 5.2 replaced kimi-k2.6 as the default Ollama model. Existing
  // installs persisted ollamaCloud.defaultModel under the old constant (SetupWizard
  // and ExtensionsTab write DEFAULT_OLLAMA_MODEL on save), so the stored value would
  // otherwise pin them to kimi-k2.6 forever — making the new default a no-op for
  // anyone who already enabled Ollama. Flip the old default to the new one; leave any
  // other (explicitly chosen) model untouched.
  if ((config.configVersion ?? 0) < 3) {
    if (config.ollamaCloud?.defaultModel === "kimi-k2.6:cloud") {
      config.ollamaCloud = { ...config.ollamaCloud, defaultModel: DEFAULT_OLLAMA_MODEL };
    }
    config.configVersion = 3;
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

/**
 * Resolve which search backend sender lookup should use, plus the Exa key,
 * plus whether an Anthropic API key is configured. The Anthropic flag lets
 * the extension know whether the Anthropic web_search fallback is even an
 * option — relevant on the Ollama+Exa-only path where there's no Anthropic
 * key at all, and silently falling back would just produce an AuthError.
 */
export function getSenderLookupConfig(): {
  provider: SenderLookupProvider;
  exaApiKey: string;
  anthropicConfigured: boolean;
} {
  const config = getConfig();
  return {
    provider: config.senderLookupProvider ?? "anthropic",
    exaApiKey: config.exaApiKey ?? "",
    // process.env fallback covers dev (.env) and packaged builds where the
    // SDK reads ANTHROPIC_API_KEY directly. Same lookup the LLM service uses.
    anthropicConfigured: Boolean(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
  };
}

/** Resolve provider + model for a feature, supporting Ollama Cloud routing. */
export function getFeatureModelConfig(feature: keyof ModelConfig): {
  provider: LlmProvider;
  model: string;
} {
  const config = getConfig();
  const provider = (config.featureProviders?.[feature] ?? "anthropic") as LlmProvider;
  if (provider === "ollama-cloud") {
    const model =
      config.ollamaCloud?.featureModels?.[feature] ??
      config.ollamaCloud?.defaultModel ??
      DEFAULT_OLLAMA_MODEL;
    return { provider, model };
  }
  const mc = getModelConfig();
  return { provider: "anthropic", model: resolveModelId(mc[feature]) };
}

/**
 * Which agent provider background auto-drafts should launch right now.
 *
 * Wraps the pure resolveBackgroundAgentProviderId with the one gate it can't
 * express: OpenCode also needs an LLM credential (its isAvailable() requires
 * Ollama or Anthropic), and the Anthropic key may come from process.env,
 * which the renderer-safe resolver can't read. Without this, enabling
 * OpenCode with no credentials would fail every background draft — and each
 * failed email is skipped for the rest of the session.
 *
 * The bundled opencode binary is deliberately not checked here: it ships
 * with the app, so its absence is a broken install that should fail loudly
 * in the provider, not silently fall back.
 */
export function getBackgroundAgentProviderId(): string {
  const config = getConfig();
  const resolved = resolveBackgroundAgentProviderId(config);
  if (resolved === "opencode") {
    const hasAnthropic = Boolean(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
    const hasOllama = Boolean(config.ollamaCloud?.apiKey);
    if (!hasAnthropic && !hasOllama) return DEFAULT_BACKGROUND_AGENT_PROVIDER;
  }
  return resolved;
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

  // Validate an Ollama Cloud API key by listing models
  ipcMain.handle(
    "settings:validate-ollama-key",
    async (_, { apiKey }: { apiKey: string }): Promise<IpcResponse<void>> => {
      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({
          baseURL: "https://ollama.com",
          authToken: apiKey,
          // apiKey: null prevents the SDK from leaking process.env.ANTHROPIC_API_KEY
          // to ollama.com (the SDK reads it as a default fallback for X-Api-Key
          // alongside our Bearer authToken — credential leak for users with both keys).
          apiKey: null,
          timeout: 10_000,
        });
        // Validate by making a real messages.create call. The default Ollama
        // model emits thinking blocks before text, so max_tokens needs to be
        // high enough that Ollama doesn't reject the request and the user's
        // key gets a fair test. 4096 mirrors the floor adjustParamsForOllama
        // uses for runtime calls.
        await client.messages.create({
          model: DEFAULT_OLLAMA_MODEL,
          max_tokens: 4096,
          messages: [{ role: "user", content: "hi" }],
        });
        return { success: true, data: undefined };
      } catch (error) {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        if (error instanceof Anthropic.AuthenticationError) {
          return { success: false, error: "Invalid API key. Please check and try again." };
        }
        if (
          error instanceof Anthropic.RateLimitError ||
          error instanceof Anthropic.PermissionDeniedError
        ) {
          return { success: true, data: undefined };
        }
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { success: false, error: `Ollama Cloud validation failed: ${msg}` };
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
      // Shallow-merge most fields. Deep-merge ollamaCloud so partial updates from
      // different UIs don't clobber each other — ExtensionsTab writes
      // { apiKey, defaultModel } while the General tab writes { featureModels }.
      // With a shallow merge, whichever caller wrote second would overwrite the other
      // (Devin caught this: SettingsPanel reads stale react-query data and stomps the key).
      let newConfig: Config = { ...currentConfig, ...config };
      if ("ollamaCloud" in config) {
        const incoming = config.ollamaCloud;
        const existing = currentConfig.ollamaCloud;
        if (incoming === undefined) {
          // Caller wants to clear it
          newConfig = { ...newConfig, ollamaCloud: undefined };
        } else {
          newConfig = {
            ...newConfig,
            ollamaCloud: {
              apiKey: incoming.apiKey ?? existing?.apiKey ?? "",
              defaultModel: incoming.defaultModel ?? existing?.defaultModel ?? DEFAULT_OLLAMA_MODEL,
              featureModels: incoming.featureModels ?? existing?.featureModels,
            },
          };
        }
      }
      // backgroundAgentProvider routes every background auto-draft to an
      // agent provider. IPC payloads are compile-time-typed only, so guard
      // the type here — a persisted non-string would wedge every future
      // auto-draft on "Unknown provider".
      if (
        "backgroundAgentProvider" in config &&
        typeof config.backgroundAgentProvider !== "string"
      ) {
        newConfig = {
          ...newConfig,
          backgroundAgentProvider: currentConfig.backgroundAgentProvider,
        };
      }
      // Deep-merge hostler for the same reason as ollamaCloud: the Extensions
      // card never sends baseUrl (a dev/test escape hatch), so a shallow
      // merge would silently erase it on every UI save.
      if ("hostler" in config) {
        const incoming = config.hostler;
        const existing = currentConfig.hostler;
        // baseUrl redirects the Bearer API key AND every tool result (email
        // content) to a different control plane, so it must not be settable
        // from the renderer (untrusted email HTML renders there — a
        // compromised renderer could silently point the provider at an
        // attacker host). Accept it over IPC only for loopback targets (the
        // mock-server dev flow); anything else keeps the stored value.
        const incomingBaseUrl =
          incoming?.baseUrl === "" || isLoopbackUrl(incoming?.baseUrl)
            ? incoming?.baseUrl
            : existing?.baseUrl;
        newConfig = {
          ...newConfig,
          hostler: incoming
            ? {
                enabled: incoming.enabled,
                apiKey: incoming.apiKey ?? existing?.apiKey ?? "",
                harness: incoming.harness ?? existing?.harness ?? DEFAULT_HOSTLER_HARNESS,
                model: incoming.model ?? existing?.model,
                baseUrl: incomingBaseUrl,
              }
            : undefined,
        };
      }
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

      // Propagate OpenCode config to the agent framework.
      // The provider's updateConfig() will close the existing opencode server
      // so the next run picks up new model / enable state.
      if ("opencode" in config) {
        agentCoordinator.updateConfig({
          opencode: {
            enabled: newConfig.opencode?.enabled ?? false,
            model: newConfig.opencode?.model,
          },
        });
      }

      // Propagate Hostler config to the agent framework. The provider's
      // updateConfig() drops its cached client / agent sync and, on disable,
      // terminates any warm cloud sessions so they stop billing.
      if ("hostler" in config) {
        agentCoordinator.updateConfig({
          hostler: {
            enabled: newConfig.hostler?.enabled ?? false,
            apiKey: newConfig.hostler?.apiKey || undefined,
            harness: newConfig.hostler?.harness,
            model: newConfig.hostler?.model,
            baseUrl: newConfig.hostler?.baseUrl,
          },
        });
      }

      // Propagate Ollama Cloud config to LLM service whenever the apiKey/defaultModel
      // changes (used by non-agent createMessage routing).
      if ("ollamaCloud" in config) {
        const oc = newConfig.ollamaCloud;
        setOllamaConfig(oc?.apiKey ?? "");
      }

      // Propagate Ollama Cloud config to the agent framework when EITHER ollamaCloud
      // or featureProviders changes. resolveAgentOllamaConfig encapsulates the rule
      // (must have an apiKey AND agentChat must be explicitly routed to ollama-cloud).
      if ("ollamaCloud" in config || "featureProviders" in config) {
        agentCoordinator.updateConfig({
          ollamaCloud: resolveAgentOllamaConfig(newConfig),
        });
      }

      // Propagate model config changes to the agent worker.
      // Only agentDrafter needs propagation here — it's the worker's default model for
      // auto-draft tasks that don't pass a per-task override. The agentChat model is
      // resolved fresh per-invocation in agent.ipc.ts via getModelIdForFeature("agentChat").
      // When Ollama is the agent destination (both agent features opted in via
      // resolveAgentOllamaConfig), use the Ollama model rather than the per-feature
      // Anthropic-tier resolver, otherwise the env-var-remapped destination and the
      // model param in query() can disagree (Anthropic model name → ollama.com → 404).
      if ("modelConfig" in config || "featureProviders" in config || "ollamaCloud" in config) {
        const ollamaConfig = resolveAgentOllamaConfig(newConfig);
        agentCoordinator.updateConfig({
          // When ollamaConfig is undefined the worker is on Anthropic — must use
          // an Anthropic model name (getModelIdForFeature, which ignores
          // featureProviders) rather than getFeatureModelConfig which could
          // return an Ollama model name if agentDrafter is solo-set to ollama.
          model: ollamaConfig?.model ?? getModelIdForFeature("agentDrafter"),
        });
      }

      // Append any new extra PATH directories so they take effect without restart
      if ("extraPathDirs" in config) {
        const pathEntries = new Set((process.env.PATH || "").split(":"));
        for (const dir of newConfig.extraPathDirs ?? []) {
          if (dir && !pathEntries.has(dir) && existsSync(dir)) {
            process.env.PATH = `${dir}:${process.env.PATH}`;
            pathEntries.add(dir);
          }
        }
      }

      // Reset cached analyzer/service instances when model config, API keys, provider
      // routing, or Ollama config changes. These services capture { provider, model } at
      // construction time, so any of these changes can leave them holding stale values.
      if (
        "modelConfig" in config ||
        "anthropicApiKey" in config ||
        "ollamaCloud" in config ||
        "featureProviders" in config
      ) {
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
          // Clear tracking sets to re-process; use clearForRerun so the DB-seeded
          // processedDrafts doesn't re-block the emails whose pending drafts/traces
          // we just cleared above.
          prefetchService.clearForRerun();

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

  // Infer writing style from sent emails using Claude Opus
  ipcMain.handle("style:infer", async (): Promise<IpcResponse<string>> => {
    try {
      const { inferStyleFromSentEmails } = await import("../services/style-profiler");
      const { getEmailSyncService } = await import("./sync.ipc");
      // Use any available gmail client for fallback (style is cross-account)
      const syncService = getEmailSyncService();
      const { getAccounts: getDbAccounts } = await import("../db");
      const accounts = getDbAccounts();
      const firstAccountId = accounts.length > 0 ? accounts[0].id : undefined;
      const gmailClient = firstAccountId ? syncService.getClientForAccount(firstAccountId) : null;
      const result = await inferStyleFromSentEmails(gmailClient, firstAccountId);
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

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
