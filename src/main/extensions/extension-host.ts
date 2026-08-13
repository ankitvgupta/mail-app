import { join } from "path";
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  realpathSync,
} from "fs";
import type {
  ExtensionManifest,
  ExtensionModule,
  LoadedExtension,
  EnrichmentProvider,
  BadgeProvider,
  SidebarPanelRegistration,
  ExtensionPanelInfo,
  ExtensionEnrichmentResult,
  InstalledExtensionInfo,
  AgentProviderManifest,
} from "../../shared/extension-types";
import {
  ExtensionManifestSchema,
  AgentProviderManifestSchema,
  checkApiCompatibility,
} from "../../shared/extension-types";
import type { AgentCoordinator } from "../agents/agent-coordinator";
import { registerProviderAuth, unregisterProviderAuth } from "../agents/private-providers-main";
import type { DashboardEmail } from "../../shared/types";
import { loadManifest, findExtensionPaths } from "./manifest-loader";
import { createExtensionContext } from "./extension-context";
import {
  createExtensionAPI,
  setRegistries,
  setAuthRequiredCallback,
  registerExtensionDisplayName,
  getAuthHandler,
  getAuthExtensions,
  checkExtensionAuth,
  hasCheckAuth,
} from "./extension-api";
import {
  saveEnrichment,
  getEnrichments,
  hasValidEnrichment,
  getEnrichmentBySender,
} from "./enrichment-store";
import { createLogger } from "../services/logger";

const log = createLogger("extension-host");

// Memory logging helper
function logMemory(label: string): void {
  const used = process.memoryUsage();
  log.info(
    `[Memory:${label}] RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap: ${Math.round(used.heapUsed / 1024 / 1024)}/${Math.round(used.heapTotal / 1024 / 1024)}MB`,
  );
}

/**
 * Extract sender email from "from" field (e.g., "John Doe <john@example.com>" -> "john@example.com")
 */
function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase();
}

/**
 * Central extension host that manages extension lifecycle
 */
export class ExtensionHost {
  private extensions: Map<string, LoadedExtension> = new Map();
  private enrichmentProviders: Map<string, EnrichmentProvider> = new Map();
  private badgeProviders: Map<string, BadgeProvider> = new Map();
  private sidebarPanels: Map<string, SidebarPanelRegistration> = new Map();
  private bundledModules: Map<string, ExtensionModule> = new Map();
  private agentCoordinator: AgentCoordinator | null = null;

  // Callbacks for notifying renderer of enrichment updates
  private enrichmentCallbacks: ((
    emailId: string,
    enrichment: ExtensionEnrichmentResult,
  ) => void)[] = [];

  // Batching for enrichment notifications to avoid flooding renderer
  private pendingEnrichmentNotifications: {
    emailId: string;
    enrichment: ExtensionEnrichmentResult;
  }[] = [];
  private enrichmentNotifyTimer: NodeJS.Timeout | null = null;
  private static readonly ENRICHMENT_BATCH_MS = 500; // Batch notifications every 500ms

  // Concurrency control for enrichment
  private enrichmentInProgress: Set<string> = new Set(); // emailIds currently being enriched
  private enrichmentQueue: Map<
    string,
    { resolve: (results: ExtensionEnrichmentResult[]) => void }
  > = new Map();

  // Callbacks for extension auth required events
  private authRequiredCallbacks: ((
    extensionId: string,
    displayName: string,
    message?: string,
  ) => void)[] = [];

  constructor() {
    // Set the registries for extension-api to use
    setRegistries(this.enrichmentProviders, this.badgeProviders);

    // Wire up extension auth required events from extension-api to our callbacks
    setAuthRequiredCallback((extensionId, displayName, message) => {
      for (const callback of this.authRequiredCallbacks) {
        callback(extensionId, displayName, message);
      }
    });
  }

  /**
   * Set the agent coordinator for loading/unloading agent providers.
   * Must be called at app startup before loading installed extensions.
   */
  setAgentCoordinator(coordinator: AgentCoordinator): void {
    this.agentCoordinator = coordinator;
  }

  /**
   * Load all extensions from the given paths
   */
  async loadExtensions(bundledPath: string, installedPath?: string): Promise<void> {
    const extensionPaths = findExtensionPaths(bundledPath, installedPath);
    log.info(`[Extensions] Found ${extensionPaths.length} extension(s) to load`);

    for (const extPath of extensionPaths) {
      await this.loadExtension(extPath);
    }
  }

  /**
   * Load a single extension
   */
  async loadExtension(extensionPath: string): Promise<boolean> {
    const manifest = loadManifest(extensionPath);
    if (!manifest) {
      return false;
    }

    // Check if already loaded
    if (this.extensions.has(manifest.id)) {
      log.warn(`[Extensions] Extension ${manifest.id} already loaded, skipping`);
      return false;
    }

    // Create context for this extension
    const context = createExtensionContext(manifest.id, extensionPath);

    // Register contributed sidebar panels
    if (manifest.contributes?.sidebarPanels) {
      for (const panel of manifest.contributes.sidebarPanels) {
        const registration: SidebarPanelRegistration = {
          id: panel.id,
          extensionId: manifest.id,
          title: panel.title,
          priority: panel.priority,
          scope: panel.scope ?? "sender",
        };
        this.sidebarPanels.set(`${manifest.id}:${panel.id}`, registration);
        log.info(`[Extensions] Registered sidebar panel: ${manifest.id}:${panel.id}`);
      }
    }

    // Initialize default settings (storage.get returns null for missing keys, not throw)
    if (manifest.contributes?.settings) {
      for (const setting of manifest.contributes.settings) {
        const existing = await context.storage.get(`setting:${setting.id}`);
        if (existing === null) {
          await context.storage.set(`setting:${setting.id}`, setting.default);
        }
      }
    }

    // Create loaded extension record (module loaded later during activate)
    const loadedExt: LoadedExtension = {
      manifest,
      path: extensionPath,
      module: null,
      context,
      isActive: false,
    };

    this.extensions.set(manifest.id, loadedExt);
    registerExtensionDisplayName(manifest.id, manifest.displayName);
    log.info(`[Extensions] Loaded extension: ${manifest.id}`);

    return true;
  }

  /**
   * Activate all loaded extensions
   */
  async activateAll(): Promise<void> {
    for (const [id, ext] of this.extensions) {
      if (!ext.isActive) {
        await this.activateExtension(id);
      }
    }
  }

  /**
   * Activate a specific extension
   */
  async activateExtension(extensionId: string): Promise<boolean> {
    const ext = this.extensions.get(extensionId);
    if (!ext) {
      log.error(`[Extensions] Extension ${extensionId} not found`);
      return false;
    }

    if (ext.isActive) {
      log.warn(`[Extensions] Extension ${extensionId} already active`);
      return true;
    }

    try {
      // For bundled extensions, use pre-registered modules
      const module = this.bundledModules.get(extensionId);
      if (!module) {
        log.error(`[Extensions] No module registered for ${extensionId}`);
        return false;
      }

      ext.module = module;

      // Create API for this extension
      const api = createExtensionAPI(extensionId);

      // Call activate
      await module.activate(ext.context, api);

      ext.isActive = true;
      log.info(`[Extensions] Activated extension: ${extensionId}`);
      return true;
    } catch (error) {
      log.error({ err: error }, `[Extensions] Failed to activate extension ${extensionId}`);
      return false;
    }
  }

  /**
   * Register a bundled extension module (called at build time)
   */
  registerBundledModule(extensionId: string, module: ExtensionModule): void {
    this.bundledModules.set(extensionId, module);
    log.info(`[Extensions] Registered bundled module: ${extensionId}`);
  }

  /**
   * Register a bundled extension from an inline manifest + pre-imported module.
   * Bypasses filesystem scanning — manifest data is already in the JS bundle.
   */
  async registerBundledExtensionFull(
    manifest: ExtensionManifest,
    module: ExtensionModule,
  ): Promise<void> {
    if (this.extensions.has(manifest.id)) {
      log.warn(`[Extensions] Extension ${manifest.id} already loaded, skipping`);
      return;
    }

    // Register the module
    this.bundledModules.set(manifest.id, module);

    // Register sidebar panels from manifest
    if (manifest.contributes?.sidebarPanels) {
      for (const panel of manifest.contributes.sidebarPanels) {
        const registration: SidebarPanelRegistration = {
          id: panel.id,
          extensionId: manifest.id,
          title: panel.title,
          priority: panel.priority,
          scope: panel.scope ?? "sender",
        };
        this.sidebarPanels.set(`${manifest.id}:${panel.id}`, registration);
        log.info(`[Extensions] Registered sidebar panel: ${manifest.id}:${panel.id}`);
      }
    }

    // Create context (extensionPath is unused at runtime for bundled extensions)
    const context = createExtensionContext(manifest.id, "");

    // Initialize default settings
    if (manifest.contributes?.settings) {
      for (const setting of manifest.contributes.settings) {
        const existing = await context.storage.get(`setting:${setting.id}`);
        if (existing === null) {
          await context.storage.set(`setting:${setting.id}`, setting.default);
        }
      }
    }

    // Create loaded extension record
    const loadedExt: LoadedExtension = {
      manifest,
      path: "",
      module: null,
      context,
      isActive: false,
    };

    this.extensions.set(manifest.id, loadedExt);
    registerExtensionDisplayName(manifest.id, manifest.displayName);

    // Activate immediately
    await this.activateExtension(manifest.id);
  }

  /**
   * Deactivate a specific extension
   */
  async deactivateExtension(extensionId: string): Promise<boolean> {
    const ext = this.extensions.get(extensionId);
    if (!ext || !ext.isActive) {
      return false;
    }

    try {
      if (ext.module?.deactivate) {
        await ext.module.deactivate();
      }

      // Remove providers registered by this extension
      for (const [key] of this.enrichmentProviders) {
        if (key.startsWith(`${extensionId}:`)) {
          this.enrichmentProviders.delete(key);
        }
      }
      for (const [key] of this.badgeProviders) {
        if (key.startsWith(`${extensionId}:`)) {
          this.badgeProviders.delete(key);
        }
      }

      ext.isActive = false;
      ext.module = null;
      log.info(`[Extensions] Deactivated extension: ${extensionId}`);
      return true;
    } catch (error) {
      log.error({ err: error }, `[Extensions] Failed to deactivate extension ${extensionId}`);
      return false;
    }
  }

  /**
   * Enrich an email using all registered providers.
   * IMPORTANT: This now only returns cached data when called from navigation.
   * New lookups are only triggered via queueEnrichment() from the prefetch service.
   */
  async enrichEmail(
    email: DashboardEmail,
    /** Thread emails for provider context. May be empty when allowNewLookups
     *  is false (cache-hit path) since providers are not called. */
    threadEmails: DashboardEmail[],
    options: { allowNewLookups?: boolean } = {},
  ): Promise<ExtensionEnrichmentResult[]> {
    const { allowNewLookups = false } = options;
    const results: ExtensionEnrichmentResult[] = [];
    const senderEmail = extractSenderEmail(email.from);

    logMemory(`enrichEmail:${email.id.slice(0, 8)}`);

    // Sort providers by priority (higher first)
    const sortedProviders = [...this.enrichmentProviders.values()].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );

    for (const provider of sortedProviders) {
      // Yield between providers so sync DB cache checks don't pile up
      // and starve the event loop when multiple enrichEmail calls resolve
      // near-simultaneously from a Promise.all batch.
      await new Promise((resolve) => setImmediate(resolve));

      // Get extension ID from the enrichment data (more reliable than parsing provider.id)
      const extensionId = this.getExtensionIdForProvider(provider);

      // Check if we already have valid cached enrichment for this email
      if (hasValidEnrichment(email.id, extensionId)) {
        const cached = getEnrichments(email.id).find(
          (e) => e.extensionId === extensionId && e.panelId === provider.panelId,
        );
        if (cached) {
          results.push(cached);
          continue;
        }
      }

      // Check if we have cached enrichment for this sender email (cross-email cache)
      const cachedBySender = getEnrichmentBySender(senderEmail, extensionId);
      if (cachedBySender && cachedBySender.panelId === provider.panelId) {
        // Save a copy for this email ID so future lookups are faster
        saveEnrichment(
          email.id,
          {
            extensionId: cachedBySender.extensionId,
            panelId: cachedBySender.panelId,
            data: cachedBySender.data,
          },
          senderEmail,
        );
        results.push(cachedBySender);

        // Notify listeners (batched to avoid flooding renderer)
        this.notifyEnrichmentReady(email.id, cachedBySender);
        continue;
      }

      // Skip new lookups if not allowed (navigation mode)
      if (!allowNewLookups) {
        continue;
      }

      // Skip if already processing this email
      if (this.enrichmentInProgress.has(email.id)) {
        continue;
      }

      // Check if provider can handle this email
      if (provider.canEnrich && !provider.canEnrich(email)) {
        continue;
      }

      // Mark as in progress
      this.enrichmentInProgress.add(email.id);

      try {
        log.info(`[Extensions] Starting enrichment for ${email.id}`);
        const enrichment = await provider.enrich(email, threadEmails);
        if (enrichment) {
          // Save to database with sender email for cross-email caching
          saveEnrichment(email.id, enrichment, senderEmail);

          const result: ExtensionEnrichmentResult = {
            panelId: enrichment.panelId,
            extensionId: enrichment.extensionId,
            data: enrichment.data as Record<string, unknown>,
            isLoading: false,
          };
          results.push(result);

          // Notify listeners (batched to avoid flooding renderer)
          this.notifyEnrichmentReady(email.id, result);
        }
      } catch (error) {
        log.error({ err: error }, `[Extensions] Enrichment provider ${provider.id} failed`);
      } finally {
        this.enrichmentInProgress.delete(email.id);
      }
    }

    return results;
  }

  /**
   * Get the extension ID for a provider by looking up its registration
   */
  private getExtensionIdForProvider(provider: EnrichmentProvider): string {
    // Find which extension registered this provider
    for (const [key] of this.enrichmentProviders) {
      if (key.includes(":") && this.enrichmentProviders.get(key) === provider) {
        return key.split(":")[0];
      }
    }
    // Fallback to the common case where provider belongs to web-search extension
    return "web-search";
  }

  /**
   * Get cached enrichments for an email
   */
  getCachedEnrichments(emailId: string): ExtensionEnrichmentResult[] {
    return getEnrichments(emailId);
  }

  /**
   * Get all registered sidebar panels
   */
  getSidebarPanels(): ExtensionPanelInfo[] {
    return [...this.sidebarPanels.values()]
      .sort((a, b) => b.priority - a.priority)
      .map((panel) => ({
        id: panel.id,
        extensionId: panel.extensionId,
        title: panel.title,
        priority: panel.priority,
        scope: panel.scope,
      }));
  }

  /**
   * Register a callback for enrichment updates
   */
  onEnrichmentReady(
    callback: (emailId: string, enrichment: ExtensionEnrichmentResult) => void,
  ): () => void {
    this.enrichmentCallbacks.push(callback);
    return () => {
      const idx = this.enrichmentCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.enrichmentCallbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Register a callback for extension auth required events.
   * Called when any extension invokes api.emitAuthRequired().
   */
  onAuthRequired(
    callback: (extensionId: string, displayName: string, message?: string) => void,
  ): () => void {
    this.authRequiredCallbacks.push(callback);
    return () => {
      const idx = this.authRequiredCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.authRequiredCallbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Get all extensions that have registered auth handlers, along with their current auth status.
   * Used during onboarding to show a "Connect Services" step.
   */
  async getExtensionsNeedingAuth(): Promise<
    Array<{ extensionId: string; displayName: string; needsAuth: boolean }>
  > {
    const authExtensions = getAuthExtensions();
    const results: Array<{ extensionId: string; displayName: string; needsAuth: boolean }> = [];
    for (const ext of authExtensions) {
      // Skip extensions without checkAuth — we can't determine their auth state
      if (!hasCheckAuth(ext.extensionId)) continue;
      const isAuthed = await checkExtensionAuth(ext.extensionId);
      results.push({ ...ext, needsAuth: !isAuthed });
    }
    return results;
  }

  /**
   * Trigger authentication for a specific extension.
   * Calls the auth handler registered by the extension via api.registerAuthHandler().
   */
  async triggerAuth(extensionId: string): Promise<void> {
    const handler = getAuthHandler(extensionId);
    if (!handler) {
      throw new Error(`No auth handler registered for extension: ${extensionId}`);
    }

    log.info(`[Extensions] Triggering auth for ${extensionId}`);
    await handler();
    log.info(`[Extensions] Auth completed for ${extensionId}`);
  }

  /**
   * Queue enrichment notification (batched to avoid flooding renderer)
   */
  private notifyEnrichmentReady(emailId: string, enrichment: ExtensionEnrichmentResult): void {
    this.pendingEnrichmentNotifications.push({ emailId, enrichment });

    // If no timer running, start one to flush the batch
    if (!this.enrichmentNotifyTimer) {
      this.enrichmentNotifyTimer = setTimeout(() => {
        this.flushEnrichmentNotifications();
      }, ExtensionHost.ENRICHMENT_BATCH_MS);
    }
  }

  /**
   * Flush all pending enrichment notifications
   */
  private flushEnrichmentNotifications(): void {
    this.enrichmentNotifyTimer = null;

    if (this.pendingEnrichmentNotifications.length === 0) return;

    // Copy and clear pending notifications
    const notifications = this.pendingEnrichmentNotifications;
    this.pendingEnrichmentNotifications = [];

    // Send all notifications
    for (const { emailId, enrichment } of notifications) {
      for (const callback of this.enrichmentCallbacks) {
        callback(emailId, enrichment);
      }
    }
  }

  /**
   * Get extension setting
   */
  async getExtensionSetting<T>(extensionId: string, key: string): Promise<T | null> {
    const ext = this.extensions.get(extensionId);
    if (!ext) return null;

    return ext.context.storage.get<T>(`setting:${key}`);
  }

  /**
   * Set extension setting
   */
  async setExtensionSetting<T>(extensionId: string, key: string, value: T): Promise<void> {
    const ext = this.extensions.get(extensionId);
    if (!ext) return;

    await ext.context.storage.set(`setting:${key}`, value);
  }

  /**
   * Get all loaded extension manifests
   */
  getLoadedExtensions(): ExtensionManifest[] {
    return [...this.extensions.values()].map((ext) => ext.manifest);
  }

  /**
   * Check if an extension is active
   */
  isExtensionActive(extensionId: string): boolean {
    return this.extensions.get(extensionId)?.isActive ?? false;
  }

  // ===========================================================================
  // Installed (external) extension management
  // ===========================================================================

  private installedExtensionsDir: string | null = null;

  /**
   * Set the directory where installed extensions are stored.
   * Must be called before loadInstalledExtensions().
   */
  setInstalledExtensionsDir(dir: string): void {
    this.installedExtensionsDir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Get the installed extensions directory path.
   */
  getInstalledExtensionsDir(): string | null {
    return this.installedExtensionsDir;
  }

  /**
   * Load and activate all installed extensions from the extensions directory.
   * Called at startup after bundled extensions are registered.
   */
  async loadInstalledExtensions(): Promise<void> {
    if (!this.installedExtensionsDir) return;
    if (!existsSync(this.installedExtensionsDir)) return;

    const entries = readdirSync(this.installedExtensionsDir);
    let loaded = 0;

    for (const entry of entries) {
      const extDir = join(this.installedExtensionsDir, entry);
      if (!statSync(extDir).isDirectory()) continue;

      const pkgPath = join(extDir, "package.json");
      if (!existsSync(pkgPath)) continue;

      try {
        await this.loadInstalledExtension(extDir);
        loaded++;
      } catch (error) {
        log.error({ err: error }, `[Extensions] Failed to load installed extension at ${extDir}`);
      }
    }

    if (loaded > 0) {
      log.info(`[Extensions] Loaded ${loaded} installed extension(s)`);
    }
  }

  /**
   * Load a single installed extension from a directory containing
   * package.json with mailExtension and/or agentProvider fields.
   */
  private async loadInstalledExtension(extDir: string): Promise<void> {
    const pkgPath = join(extDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    // Package must have mailExtension OR agentProvider (or both)
    if (!pkg.mailExtension && !pkg.agentProvider) {
      throw new Error(`No mailExtension or agentProvider field in ${pkgPath}`);
    }

    // Parse agent provider manifest if present
    let agentProviderManifest: AgentProviderManifest | undefined;
    if (pkg.agentProvider) {
      agentProviderManifest = AgentProviderManifestSchema.parse(pkg.agentProvider);
    }

    // Parse extension manifest if present
    let manifest: ExtensionManifest | undefined;
    if (pkg.mailExtension) {
      manifest = ExtensionManifestSchema.parse(pkg.mailExtension);
      manifest.builtIn = false;
    }

    // Determine the canonical ID — prefer extension ID, fall back to provider ID
    const id = manifest?.id ?? agentProviderManifest?.id;
    if (!id) {
      throw new Error(`No ID found in mailExtension or agentProvider in ${pkgPath}`);
    }

    // Check API version compatibility
    const displayName = manifest?.displayName ?? agentProviderManifest?.displayName ?? id;
    const engines = manifest?.engines ?? agentProviderManifest?.engines;
    const compat = checkApiCompatibility(engines, displayName);
    if (!compat.compatible) {
      throw new Error(compat.reason);
    }

    if (this.extensions.has(id)) {
      log.warn(`[Extensions] Extension ${id} already loaded, skipping installed version`);
      return;
    }

    // Load extension module if mailExtension is present and dist/main.js exists
    if (manifest) {
      const mainJsPath = join(extDir, "dist", "main.js");
      if (existsSync(mainJsPath)) {
        const { createRequire } = await import("module");
        const extensionRequire = createRequire(mainJsPath);
        const module = extensionRequire(mainJsPath) as ExtensionModule;
        this.bundledModules.set(id, module);

        // Register sidebar panels
        if (manifest.contributes?.sidebarPanels) {
          for (const panel of manifest.contributes.sidebarPanels) {
            const registration: SidebarPanelRegistration = {
              id: panel.id,
              extensionId: id,
              title: panel.title,
              priority: panel.priority,
              scope: panel.scope ?? "sender",
            };
            this.sidebarPanels.set(`${id}:${panel.id}`, registration);
          }
        }
      }
    }

    const context = createExtensionContext(id, extDir);

    // Initialize default settings from both extension and provider manifests
    const allSettings = [
      ...(manifest?.contributes?.settings ?? []),
      ...(agentProviderManifest?.contributes?.settings ?? []),
    ];
    for (const setting of allSettings) {
      const existing = await context.storage.get(`setting:${setting.id}`);
      if (existing === null) {
        await context.storage.set(`setting:${setting.id}`, setting.default);
      }
    }

    const loadedExt: LoadedExtension = {
      manifest:
        manifest ??
        ExtensionManifestSchema.parse({
          id,
          displayName,
          description: agentProviderManifest?.description,
          version: agentProviderManifest?.version ?? "1.0.0",
          builtIn: false,
        }),
      path: extDir,
      module: null,
      context,
      isActive: false,
    };

    this.extensions.set(id, loadedExt);
    registerExtensionDisplayName(id, displayName);

    // Activate extension module if present
    if (manifest && this.bundledModules.has(id)) {
      await this.activateExtension(id);
    }

    // Load agent provider if present
    if (agentProviderManifest) {
      await this.loadAgentProvider(id, extDir, agentProviderManifest);
      // Provider-only packages (no mailExtension) are active once the provider loads
      if (!manifest) {
        const ext = this.extensions.get(id);
        if (ext && !ext.isActive) {
          ext.isActive = true;
        }
      }
    }

    log.info(`[Extensions] Loaded installed package: ${displayName} (${id})`);
  }

  /**
   * Load an agent provider from an installed package.
   * Handles main-setup.js (auth/config) and provider.js (factory).
   */
  private async loadAgentProvider(
    id: string,
    extDir: string,
    _manifest: AgentProviderManifest,
  ): Promise<void> {
    // Load main-setup.js in main process (auth handlers, config enrichers)
    const mainSetupPath = join(extDir, "dist", "main-setup.js");
    if (existsSync(mainSetupPath)) {
      try {
        const { createRequire } = await import("module");
        const setupRequire = createRequire(mainSetupPath);
        const setupModule = setupRequire(mainSetupPath);
        const setup = setupModule.default || setupModule;
        registerProviderAuth(id, setup);
      } catch (err) {
        log.error({ err: err }, `[Extensions] Failed to load main-setup.js for ${id}`);
      }
    }

    // Load provider.js in the utility process worker via coordinator
    const providerJsPath = join(extDir, "dist", "provider.js");
    if (existsSync(providerJsPath) && this.agentCoordinator) {
      const result = await this.agentCoordinator.loadProvider(id, providerJsPath);
      if (!result.success) {
        // Store load error on the extension record
        const ext = this.extensions.get(id);
        if (ext) {
          (ext as unknown as { loadError: string }).loadError =
            result.error ?? "Unknown load error";
        }
        log.error(`[Extensions] Agent provider ${id} failed to load: ${result.error}`);
      }
    }
  }

  /**
   * Install an extension from a .zip file.
   * Extracts to the installed extensions directory and activates it.
   */
  async installExtension(zipPath: string): Promise<InstalledExtensionInfo> {
    if (!this.installedExtensionsDir) {
      throw new Error("Installed extensions directory not configured");
    }

    if (!existsSync(zipPath)) {
      throw new Error(`Extension file not found: ${zipPath}`);
    }

    // Extract to a temp directory first to read the manifest
    const { execFileSync } = await import("child_process");
    const tempDir = join(this.installedExtensionsDir, `.installing-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      // Use execFileSync (no shell) to prevent shell injection via zipPath
      execFileSync("unzip", ["-o", zipPath, "-d", tempDir], { stdio: "pipe" });
    } catch (_error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error("Failed to extract extension — is it a valid zip archive?");
    }

    // Read and validate manifest
    const pkgPath = join(tempDir, "package.json");
    if (!existsSync(pkgPath)) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error("Invalid extension: no package.json found");
    }

    let manifest: ExtensionManifest;
    let agentProviderManifest: AgentProviderManifest | undefined;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (!pkg.mailExtension && !pkg.agentProvider) {
        throw new Error("No mailExtension or agentProvider field in package.json");
      }
      if (pkg.mailExtension) {
        manifest = ExtensionManifestSchema.parse(pkg.mailExtension);
      }
      if (pkg.agentProvider) {
        agentProviderManifest = AgentProviderManifestSchema.parse(pkg.agentProvider);
      }
      // Use extension manifest if available, otherwise create one from provider manifest
      if (!manifest!) {
        manifest = ExtensionManifestSchema.parse({
          id: agentProviderManifest!.id,
          displayName: agentProviderManifest!.displayName,
          description: agentProviderManifest!.description,
          version: agentProviderManifest!.version,
          builtIn: false,
        });
      }
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error(
        `Invalid package manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Validate manifest.id to prevent path traversal
    if (!manifest.id || /[/\\]|^\.\.?$/.test(manifest.id)) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`Invalid extension id: ${manifest.id}`);
    }

    // Check API version compatibility
    const engines = manifest.engines ?? agentProviderManifest?.engines;
    const compat = checkApiCompatibility(engines, manifest.displayName);
    if (!compat.compatible) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error(compat.reason);
    }

    // Check for dist/main.js OR dist/provider.js — at least one must exist
    const hasMainJs = existsSync(join(tempDir, "dist", "main.js"));
    const hasProviderJs = existsSync(join(tempDir, "dist", "provider.js"));
    if (!hasMainJs && !hasProviderJs) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error("Invalid package: no dist/main.js or dist/provider.js found");
    }

    // Uninstall existing version if present
    if (this.extensions.has(manifest.id)) {
      await this.uninstallExtension(manifest.id);
    }

    // Move to final location
    const finalDir = join(this.installedExtensionsDir, manifest.id);
    if (existsSync(finalDir)) {
      rmSync(finalDir, { recursive: true, force: true });
    }
    cpSync(tempDir, finalDir, { recursive: true });
    rmSync(tempDir, { recursive: true, force: true });

    // Load and activate
    await this.loadInstalledExtension(finalDir);

    return {
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      isActive: this.isExtensionActive(manifest.id),
      path: finalDir,
      hasRenderer: existsSync(join(finalDir, "dist", "renderer.js")),
      hasAgentProvider: !!agentProviderManifest,
      agentProviderManifest,
    };
  }

  /**
   * Uninstall an installed extension by ID.
   * Deactivates it and removes its directory.
   */
  async uninstallExtension(extensionId: string): Promise<boolean> {
    const ext = this.extensions.get(extensionId);
    if (!ext) return false;

    // Don't allow uninstalling bundled extensions
    if (ext.manifest.builtIn) {
      throw new Error(`Cannot uninstall bundled extension: ${extensionId}`);
    }

    // Deactivate
    await this.deactivateExtension(extensionId);

    // Unload agent provider if coordinator is set
    if (this.agentCoordinator) {
      this.agentCoordinator.unloadProvider(extensionId);
    }
    unregisterProviderAuth(extensionId);

    // Remove sidebar panels
    for (const [key] of this.sidebarPanels) {
      if (key.startsWith(`${extensionId}:`)) {
        this.sidebarPanels.delete(key);
      }
    }

    // Remove from registries
    this.extensions.delete(extensionId);
    this.bundledModules.delete(extensionId);

    // Clear Node.js require cache so reinstalling loads the new module from disk.
    // We use createRequire to access the cache since the main process is ESM-bundled.
    // Cache keys use realpath (symlinks resolved), so we must resolve ext.path too.
    if (ext.path && existsSync(ext.path)) {
      const { createRequire } = await import("module");
      const cache = createRequire(join(ext.path, "x")).cache;
      const resolvedPath = realpathSync(ext.path);
      const extPathPrefix = resolvedPath.endsWith("/") ? resolvedPath : resolvedPath + "/";
      for (const cached of Object.keys(cache)) {
        if (cached.startsWith(extPathPrefix)) {
          delete cache[cached];
        }
      }
    }

    // Remove files
    if (ext.path && existsSync(ext.path)) {
      rmSync(ext.path, { recursive: true, force: true });
    }

    log.info(`[Extensions] Uninstalled extension: ${extensionId}`);
    return true;
  }

  /**
   * Get info about all installed (non-bundled) extensions.
   */
  getInstalledExtensions(): InstalledExtensionInfo[] {
    const results: InstalledExtensionInfo[] = [];
    for (const ext of this.extensions.values()) {
      if (!ext.manifest.builtIn) {
        const hasProviderJs = ext.path ? existsSync(join(ext.path, "dist", "provider.js")) : false;
        // Read agentProvider manifest from package.json if present
        let agentProviderManifest: AgentProviderManifest | undefined;
        if (hasProviderJs && ext.path) {
          try {
            const pkg = JSON.parse(readFileSync(join(ext.path, "package.json"), "utf-8"));
            if (pkg.agentProvider) {
              agentProviderManifest = AgentProviderManifestSchema.parse(pkg.agentProvider);
            }
          } catch {
            /* ignore parse errors */
          }
        }
        results.push({
          id: ext.manifest.id,
          displayName: ext.manifest.displayName,
          description: ext.manifest.description,
          version: ext.manifest.version,
          isActive: ext.isActive,
          path: ext.path,
          hasRenderer: ext.path ? existsSync(join(ext.path, "dist", "renderer.js")) : false,
          hasAgentProvider: hasProviderJs,
          agentProviderManifest,
          loadError: (ext as unknown as { loadError?: string }).loadError,
        });
      }
    }
    return results;
  }

  /**
   * Get the renderer bundle path for an installed extension.
   * Returns null if no renderer bundle exists.
   */
  getRendererBundlePath(extensionId: string): string | null {
    const ext = this.extensions.get(extensionId);
    if (!ext || !ext.path) return null;

    const rendererPath = join(ext.path, "dist", "renderer.js");
    return existsSync(rendererPath) ? rendererPath : null;
  }
}

// Singleton instance
let extensionHost: ExtensionHost | null = null;

/**
 * Get the singleton extension host instance
 */
export function getExtensionHost(): ExtensionHost {
  if (!extensionHost) {
    extensionHost = new ExtensionHost();
  }
  return extensionHost;
}
