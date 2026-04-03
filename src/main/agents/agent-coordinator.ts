import { utilityProcess, MessageChannelMain, type BrowserWindow, net } from "electron";
import path from "path";
import { existsSync } from "fs";
import type {
  AgentContext,
  AgentFrameworkConfig,
  CoordinatorMessage,
  ScopedAgentEvent,
  WorkerMessage,
} from "./types";
import { getEmailSyncService } from "../ipc/sync.ipc";
import { getConfig, getModelIdForFeature } from "../ipc/settings.ipc";
import * as db from "../db";
import { buildStyleContext } from "../services/style-profiler";
import { buildAgentMemoryContext } from "../services/memory-context";
import { DraftGenerator } from "../services/draft-generator";
import { generateDraftForEmail, generateForwardForEmail } from "../services/draft-pipeline";
import { saveDraftAndSync } from "../services/gmail-draft-sync";
import { DEFAULT_STYLE_PROMPT } from "../../shared/types";
import { populatePrivateProviderConfig } from "./private-providers-main";
import { createLogger } from "../services/logger";

const log = createLogger("agent-coordinator");

/**
 * Coordinates the agent utility process from the main process.
 *
 * Responsibilities:
 * - Forks the utility process and establishes MessagePort channels
 * - Proxies DB and Gmail requests from the worker (since it can't import native modules)
 * - Relays streaming events and confirmation requests to the renderer
 */
export class AgentCoordinator {
  private worker: Electron.UtilityProcess | null = null;
  private mainWindow: BrowserWindow | null = null;
  private started = false;
  private workerReady: Promise<void> | null = null;

  /** Installed provider paths for re-loading on worker respawn */
  private installedProviders = new Map<string, string>();

  private providerLoadCallbacks = new Map<
    string,
    { resolve: (result: { success: boolean; error?: string }) => void }
  >();
  private providerHealthCallbacks = new Map<
    string,
    {
      resolve: (result: {
        status: "connected" | "not_configured" | "error";
        message?: string;
      }) => void;
    }
  >();

  // DB proxy methods available to the worker.
  // No explicit Record type — each method retains its specific signature.
  // In handleDbRequest we cast to a generic callable since the IPC boundary is untyped.
  private readonly dbMethods = {
    getEmail: (emailId: string) => db.getEmail(emailId),
    getEmailsByThread: (threadId: string, accountId?: string) =>
      db.getEmailsByThread(threadId, accountId),
    getEmailsByIds: (ids: string[]) => db.getEmailsByIds(ids),
    getInboxEmails: (accountId?: string) => db.getInboxEmails(accountId),
    getAllEmails: (accountId?: string) => db.getAllEmails(accountId),
    searchEmails: (query: string, options?: db.SearchOptions) => db.searchEmails(query, options),
    saveAnalysis: (emailId: string, needsReply: boolean, reason: string, priority?: string) =>
      db.saveAnalysis(emailId, needsReply, reason, priority),
    saveDraft: (
      emailId: string,
      draftBody: string,
      status?: string,
      gmailDraftId?: string,
      options?: { cc?: string[]; bcc?: string[] },
    ) => db.saveDraft(emailId, draftBody, status, gmailDraftId, options),
    saveDraftAndSync: (
      emailId: string,
      body: string,
      status: string,
      cc?: string[],
      bcc?: string[],
    ) => saveDraftAndSync(emailId, body, status, cc, bcc),
    getSenderProfile: (email: string) => db.getSenderProfile(email),
    saveSenderProfile: (profile: db.SenderProfile) => db.saveSenderProfile(profile),
    getAccounts: () => db.getAccounts(),
    // Audit log methods
    saveAuditEntry: (...args: unknown[]) =>
      db.saveAuditEntry(args[0] as Parameters<typeof db.saveAuditEntry>[0]),
    getAuditEntries: (taskId: string) => db.getAuditEntries(taskId),
    cleanupExpiredAudit: () => db.cleanupExpiredAudit(),
    // Conversation mirror methods
    upsertConversationMirror: (...args: unknown[]) =>
      db.upsertConversationMirror(
        args[0] as string,
        args[1] as string,
        args[2] as Parameters<typeof db.upsertConversationMirror>[2],
      ),
    getConversationMirror: (providerId: string, conversationId: string) =>
      db.getConversationMirror(providerId, conversationId),
    listConversationMirrors: (providerId?: string) => db.listConversationMirrors(providerId),
    getCalendarEventsForDate: (dateStr: string) => db.getCalendarEventsForDate(dateStr),
    // Memory methods for agent save_memory tool
    saveMemory: (...args: unknown[]) =>
      db.saveMemory(args[0] as Parameters<typeof db.saveMemory>[0]),
    getMemories: (accountId: string) => db.getMemories(accountId),
    // Local drafts (new emails not tied to threads)
    saveLocalDraft: (...args: unknown[]) =>
      db.saveLocalDraft(args[0] as Parameters<typeof db.saveLocalDraft>[0]),
    getLocalDraft: (draftId: string) => db.getLocalDraft(draftId),
    getLocalDrafts: (accountId?: string) => db.getLocalDrafts(accountId),
    // Generate a draft reply using the exact same pipeline as the "Generate Draft" button.
    // Runs DraftGenerator with the user's configured model, style context, EA config, and sender enrichment.
    generateDraft: async (emailId: string, accountId: string, instructions?: string) =>
      generateDraftForEmail({ emailId, accountId, instructions }),
    // Generate a new email (not a reply) using the same DraftGenerator pipeline.
    // Style context is based on the primary recipient.
    generateNewEmail: async (
      accountId: string,
      to: string[],
      subject: string,
      instructions: string,
    ) => {
      const config = getConfig();

      // Style context based on primary recipient — extract bare email from "Name <email>" format
      const primaryRecipient = to.length > 0 ? to[0] : "";
      const emailMatch = primaryRecipient.match(/<([^>]+)>/);
      const primaryEmail = emailMatch ? emailMatch[1] : primaryRecipient;
      const gmailClient = getEmailSyncService().getClientForAccount(accountId);
      const styleContext = primaryEmail
        ? await buildStyleContext(
            primaryEmail,
            accountId,
            config.stylePrompt ?? DEFAULT_STYLE_PROMPT,
            gmailClient,
          )
        : "";

      let prompt = config.draftPrompt;
      if (styleContext) {
        prompt = `${styleContext}\n\n${prompt}`;
      }

      const enableSenderLookup = config.enableSenderLookup ?? true;
      const generator = new DraftGenerator(
        getModelIdForFeature("drafts"),
        prompt,
        getModelIdForFeature("calendaring"),
      );
      return generator.composeNewEmail(to, subject, instructions, { enableSenderLookup });
    },
    generateForward: async (
      emailId: string,
      accountId: string,
      instructions: string,
      to?: string[],
      cc?: string[],
      bcc?: string[],
    ) => generateForwardForEmail({ emailId, accountId, instructions, to, cc, bcc }),
  } as const;

  start(mainWindow: BrowserWindow): void {
    if (this.started) return;
    this.mainWindow = mainWindow;
    this.started = true;
    // Worker is spawned lazily on first use via ensureWorker()
  }

  private spawnWorker(): void {
    // Worker lives in out/worker/, one level up from out/main/ where __dirname points
    const workerPath = path.join(__dirname, "..", "worker", "agent-worker.cjs");
    if (!existsSync(workerPath)) {
      log.warn(
        `[AgentCoordinator] Worker not found at ${workerPath} — agent commands will fail until the worker is built`,
      );
      return;
    }
    this.worker = utilityProcess.fork(workerPath, [], { stdio: ["ignore", "pipe", "pipe"] });

    // Forward utility process stdout/stderr to main process console
    // so agent logs (including [ClaudeAgent:stderr]) appear in the log file.
    this.worker.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trimEnd().split("\n");
      for (const line of lines) {
        log.info(`[AgentWorker:out] ${line}`);
      }
    });
    this.worker.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trimEnd().split("\n");
      for (const line of lines) {
        log.error(`[AgentWorker:err] ${line}`);
      }
    });

    this.worker.on("message", (msg: CoordinatorMessage) => {
      this.handleWorkerMessage(msg);
    });

    this.worker.on("exit", (code) => {
      log.info(`[AgentCoordinator] Worker exited with code ${code}`);
      this.worker = null;
      // Close all active MessagePorts to prevent resource leaks
      for (const [, port] of this.activePorts) {
        port.close();
      }
      this.activePorts.clear();
      // Clean up accumulated events
      this.taskEvents.clear();
      // Reject all pending completion promises
      for (const [taskId, resolver] of this.taskCompletionResolvers) {
        resolver.reject(new Error(`Worker exited with code ${code}`));
        this.taskCompletionPromises.delete(taskId);
      }
      this.taskCompletionResolvers.clear();
    });

    // Auto-init the worker with framework config so it's ready for commands.
    // Config is enriched asynchronously by private provider modules before being sent.
    // Read API key from app config first, fall back to env var; use undefined (not "")
    // when neither exists so the SDK falls through to Claude Code's stored OAuth.
    const appConfig = getConfig();
    const apiKey = appConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined;
    const browser = appConfig.agentBrowser;
    const baseConfig: AgentFrameworkConfig = {
      model: getModelIdForFeature("agentDrafter"),
      anthropicApiKey: apiKey,
      browserConfig: browser
        ? {
            enabled: browser.enabled,
            chromeDebugPort: browser.chromeDebugPort,
            chromeProfilePath: browser.chromeProfilePath,
          }
        : undefined,
      mcpServers: appConfig.mcpServers,
      cliTools: appConfig.cliTools,
      providers: {
        "openclaw-agent": {
          enabled: appConfig.openclaw?.enabled ?? false,
          gatewayUrl: appConfig.openclaw?.gatewayUrl ?? "",
          gatewayToken: appConfig.openclaw?.gatewayToken ?? "",
        },
      },
    };
    this.workerReady = populatePrivateProviderConfig(baseConfig).then(
      (enrichedConfig) => {
        this.initWorker(enrichedConfig);
      },
      () => {
        this.initWorker(baseConfig);
      }, // Fallback to base config on error
    );

    // After worker init, re-load any installed providers (respawn recovery)
    if (this.installedProviders.size > 0) {
      this.workerReady = this.workerReady.then(() => {
        for (const [providerId, providerPath] of this.installedProviders) {
          log.info(`[AgentCoordinator] Re-loading installed provider on respawn: ${providerId}`);
          this.sendToWorker({
            type: "load_provider",
            providerId,
            providerPath,
            config: {
              model: getModelIdForFeature("agentDrafter"),
              anthropicApiKey:
                getConfig().anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined,
            },
          });
        }
      });
    }
  }

  private ensureWorker(): Electron.UtilityProcess {
    if (!this.worker) {
      this.spawnWorker();
    }
    if (!this.worker) {
      throw new Error(
        "Agent worker failed to start — worker file may be missing. Run 'npm run build:worker' first.",
      );
    }
    return this.worker;
  }

  private sendToWorker(msg: WorkerMessage): void {
    this.ensureWorker().postMessage(msg);
  }

  /** Initialize the worker with framework config */
  initWorker(config: AgentFrameworkConfig): void {
    this.sendToWorker({ type: "init", config });
  }

  // Track active ports so we can close them when tasks finish
  private activePorts = new Map<string, Electron.MessagePortMain>();

  // Accumulate events per task for persistence on completion
  private taskEvents = new Map<string, ScopedAgentEvent[]>();

  // Track task completion so callers can await agent finishing (not just starting)
  private taskCompletionResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private taskCompletionPromises = new Map<string, Promise<void>>();

  /** Start an agent task, setting up a MessagePort for streaming events to the renderer */
  async runAgent(
    taskId: string,
    providerIds: string[],
    prompt: string,
    context: AgentContext,
    modelOverride?: string,
  ): Promise<void> {
    const worker = this.ensureWorker();

    // Wait for worker init (including private provider config enrichment) to complete
    if (this.workerReady) {
      await this.workerReady;
    }

    // Build memory context in the main process (where DB access is available)
    // and attach it to context so the worker can include it in the system prompt
    if (context.memoryContext === undefined) {
      const senderEmail = context.emailFrom
        ? (
            context.emailFrom.match(/<([^>]+)>/)?.[1] ??
            context.emailFrom.match(/([^\s<]+@[^\s>]+)/)?.[1]
          )?.toLowerCase()
        : undefined;
      context.memoryContext = buildAgentMemoryContext(context.accountId, senderEmail);
    }

    // Create a completion promise so callers can await the agent actually finishing
    const completionPromise = new Promise<void>((resolve, reject) => {
      this.taskCompletionResolvers.set(taskId, { resolve, reject });
    });
    this.taskCompletionPromises.set(taskId, completionPromise);

    // Prevent unhandled rejection warnings for tasks where callers don't await completion
    // (e.g. user-initiated tasks via agent:run IPC that never call waitForCompletion)
    completionPromise.catch(() => {});

    // Create a MessageChannel: port1 goes to renderer, port2 goes to worker
    const { port1, port2 } = new MessageChannelMain();
    this.activePorts.set(taskId, port1);

    // Initialize event accumulator for this task
    this.taskEvents.set(taskId, []);

    // Create session in DB
    const now = Date.now();
    const sessionRow: db.AgentSessionRow = {
      id: taskId,
      title:
        (prompt.length > 40 ? prompt.slice(0, 40).replace(/\s+\S*$/, "") : prompt) || "Untitled",
      email_id: context.currentEmailId || null,
      thread_id: context.currentThreadId || null,
      account_id: context.accountId,
      provider_ids: JSON.stringify(providerIds),
      created_at: now,
      updated_at: now,
      status: "active",
    };
    try {
      db.saveAgentSession(sessionRow);
    } catch (err) {
      log.error({ err, taskId }, "Failed to save agent session");
    }

    // Forward events from port1 to the renderer via IPC
    port1.on("message", (event) => {
      const agentEvent = event.data as ScopedAgentEvent;
      this.mainWindow?.webContents.send("agent:event", {
        taskId,
        event: agentEvent,
      });

      // Accumulate events for later persistence
      this.taskEvents.get(taskId)?.push(agentEvent);

      // Close port on terminal state events from the orchestrator.
      // Do NOT close on "done" — the orchestrator emits a final "state" event
      // with providerConversationId after "done", and closing early drops it.
      // Also skip events with nestedRunId — those are from sub-agent tools and
      // do NOT mean the parent orchestrator is finished.
      if (
        !agentEvent.nestedRunId &&
        agentEvent.type === "state" &&
        (agentEvent.state === "completed" ||
          agentEvent.state === "failed" ||
          agentEvent.state === "cancelled")
      ) {
        const state = agentEvent.state;
        this.persistTaskEvents(taskId, state);
        const terminalStatus =
          state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed";
        try {
          db.updateAgentSessionStatus(taskId, terminalStatus);
        } catch (err) {
          log.error({ err, taskId, terminalStatus }, "Failed to update agent session status");
        }
        this.closePort(taskId);
        this.resolveTaskCompletion(taskId, state);
      }
    });
    port1.start();

    // Send the run command with port2 to the worker
    worker.postMessage({ type: "run", taskId, providerIds, prompt, context, modelOverride }, [
      port2,
    ]);
  }

  /**
   * Returns a promise that resolves when an agent task reaches a terminal state.
   * Use this to await actual completion instead of just task launch.
   */
  waitForCompletion(taskId: string): Promise<void> {
    return this.taskCompletionPromises.get(taskId) ?? Promise.resolve();
  }

  private resolveTaskCompletion(taskId: string, state: string): void {
    const resolver = this.taskCompletionResolvers.get(taskId);
    if (resolver) {
      if (state === "completed") {
        resolver.resolve();
      } else {
        resolver.reject(new Error(`Agent task ${taskId} ${state}`));
      }
      this.taskCompletionResolvers.delete(taskId);
      this.taskCompletionPromises.delete(taskId);
    }
  }

  /**
   * Persist accumulated events to the conversation mirror table so traces
   * survive app restarts. Called on terminal state (completed/failed/cancelled).
   */
  private persistTaskEvents(taskId: string, state: string = "completed"): void {
    const events = this.taskEvents.get(taskId);
    if (!events || events.length === 0) {
      this.taskEvents.delete(taskId);
      return;
    }

    try {
      db.upsertConversationMirror("auto-draft", taskId, {
        localTaskId: taskId,
        status: state,
        messagesJson: JSON.stringify(events),
      });
      log.info(`[AgentCoordinator] Persisted ${events.length} events for task ${taskId}`);
    } catch (err) {
      log.error({ err: err }, `[AgentCoordinator] Failed to persist events for task ${taskId}`);
    }

    this.taskEvents.delete(taskId);
  }

  cancel(taskId: string): void {
    this.sendToWorker({ type: "cancel", taskId });
    // Persist partial trace before closing port — the worker's "cancelled" event
    // won't arrive after closePort() kills the message handler.
    this.persistTaskEvents(taskId, "cancelled");
    try {
      db.updateAgentSessionStatus(taskId, "cancelled");
    } catch (err) {
      log.error({ err, taskId }, "Failed to update agent session status on cancel");
    }
    this.closePort(taskId);
    this.resolveTaskCompletion(taskId, "cancelled");
  }

  /** Cancel all currently running agent tasks. */
  cancelAll(): void {
    const taskIds = [...this.activePorts.keys()];
    for (const taskId of taskIds) {
      this.cancel(taskId);
    }
  }

  /** Cancel only agent tasks whose taskId starts with the given prefix. */
  cancelByPrefix(prefix: string): void {
    for (const taskId of [...this.activePorts.keys()]) {
      if (taskId.startsWith(prefix)) {
        this.cancel(taskId);
      }
    }
  }

  private closePort(taskId: string): void {
    const port = this.activePorts.get(taskId);
    if (port) {
      port.close();
      this.activePorts.delete(taskId);
    }
  }

  /** Push a partial config update to the running worker (e.g. new API key). */
  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    if (this.worker) {
      this.sendToWorker({ type: "config_update", config });
    }
  }

  resolveConfirmation(toolCallId: string, approved: boolean): void {
    this.sendToWorker({ type: "confirm", toolCallId, approved });
  }

  listProviders(): void {
    this.sendToWorker({ type: "list_providers" });
  }

  /**
   * Load an installed agent provider into the worker.
   * Sends config_update first, then load_provider.
   */
  async loadProvider(
    providerId: string,
    providerPath: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Ensure worker is spawned, then wait for it to be ready (config enrichment + orchestrator init)
    // Note: we add to installedProviders AFTER ensureWorker to avoid the respawn recovery
    // path in spawnWorker() from double-loading the provider we're about to load here.
    this.ensureWorker();
    if (this.workerReady) {
      await this.workerReady;
    }
    this.installedProviders.set(providerId, providerPath);

    // Send config_update first so worker has latest config
    const appConfig = getConfig();
    const config: AgentFrameworkConfig = {
      model: getModelIdForFeature("agentDrafter"),
      anthropicApiKey: appConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined,
    };
    this.sendToWorker({ type: "config_update", config });

    // Then send load_provider and wait for response
    return new Promise((resolve) => {
      this.providerLoadCallbacks.set(providerId, { resolve });
      this.sendToWorker({ type: "load_provider", providerId, providerPath, config });

      // Timeout after 10s
      setTimeout(() => {
        if (this.providerLoadCallbacks.has(providerId)) {
          this.providerLoadCallbacks.delete(providerId);
          resolve({ success: false, error: "Provider load timed out" });
        }
      }, 10_000);
    });
  }

  /**
   * Unload an installed agent provider from the worker.
   */
  unloadProvider(providerId: string): void {
    this.installedProviders.delete(providerId);
    if (this.worker) {
      this.sendToWorker({ type: "unload_provider", providerId });
    }
  }

  /**
   * Check health of an installed provider.
   */
  async checkProviderHealth(
    providerId: string,
  ): Promise<{ status: "connected" | "not_configured" | "error"; message?: string }> {
    if (!this.worker) {
      return { status: "error", message: "Worker not running" };
    }

    if (this.workerReady) {
      await this.workerReady;
    }

    return new Promise((resolve) => {
      this.providerHealthCallbacks.set(providerId, { resolve });
      this.sendToWorker({ type: "check_health", providerId });

      // Timeout after 10s
      setTimeout(() => {
        if (this.providerHealthCallbacks.has(providerId)) {
          this.providerHealthCallbacks.delete(providerId);
          resolve({ status: "error", message: "Health check timed out" });
        }
      }, 10_000);
    });
  }

  private handleWorkerMessage(msg: CoordinatorMessage): void {
    switch (msg.type) {
      case "db_request":
        this.handleDbRequest(msg.requestId, msg.method, msg.args);
        break;
      case "gmail_request":
        this.handleGmailRequest(msg.requestId, msg.method, msg.accountId, msg.args);
        break;
      case "net_fetch_request":
        this.handleNetFetchRequest(msg.requestId, msg.url, msg.options);
        break;
      case "confirmation_request":
        this.mainWindow?.webContents.send("agent:confirmation", {
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          input: msg.input,
          description: msg.description,
        });
        break;
      case "providers_list":
        this.mainWindow?.webContents.send("agent:providers", {
          providers: msg.providers,
        });
        break;
      case "provider_loaded": {
        const cb = this.providerLoadCallbacks.get(msg.providerId);
        if (cb) {
          cb.resolve({ success: true });
          this.providerLoadCallbacks.delete(msg.providerId);
        }
        break;
      }
      case "provider_load_error": {
        const cb = this.providerLoadCallbacks.get(msg.providerId);
        if (cb) {
          cb.resolve({ success: false, error: msg.error });
          this.providerLoadCallbacks.delete(msg.providerId);
        }
        log.error(`[AgentCoordinator] Provider ${msg.providerId} load error: ${msg.error}`);
        break;
      }
      case "provider_health": {
        const cb = this.providerHealthCallbacks.get(msg.providerId);
        if (cb) {
          cb.resolve({ status: msg.status, message: msg.message });
          this.providerHealthCallbacks.delete(msg.providerId);
        }
        break;
      }
    }
  }

  private handleDbRequest(requestId: string, method: string, args: unknown[]): void {
    const fn = this.dbMethods[method as keyof typeof this.dbMethods];
    if (!fn) {
      this.sendToWorker({
        type: "db_error",
        requestId,
        error: `Unknown DB method: ${method}`,
      });
      return;
    }

    try {
      // The IPC proxy boundary is inherently untyped — args come from the worker as unknown[]
      const result = (fn as (...a: unknown[]) => unknown)(...args);
      // Handle both sync and async DB methods
      if (result instanceof Promise) {
        result
          .then((data) => {
            this.sendToWorker({ type: "db_response", requestId, result: data });
            this.notifyRendererOnSideEffect(method, args, data);
          })
          .catch((err) => {
            this.sendToWorker({
              type: "db_error",
              requestId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      } else {
        this.sendToWorker({ type: "db_response", requestId, result });
        this.notifyRendererOnSideEffect(method, args, result);
      }
    } catch (err) {
      this.sendToWorker({
        type: "db_error",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * When certain DB writes happen via the agent, notify the renderer so it
   * can update its in-memory store. Without this, the agent can save a draft
   * to the DB but the UI won't reflect it until a full reload.
   */
  private notifyRendererOnSideEffect(method: string, args: unknown[], result?: unknown): void {
    if ((method === "saveDraft" || method === "saveDraftAndSync") && args.length >= 2) {
      const [emailId, draftBody, status] = args as [string, string, string?];
      // Extract cc/bcc: saveDraft passes them in options (arg 4), saveDraftAndSync as args 3/4
      const options =
        method === "saveDraft"
          ? (args[4] as { cc?: string[]; bcc?: string[] } | undefined)
          : { cc: args[3] as string[] | undefined, bcc: args[4] as string[] | undefined };
      this.mainWindow?.webContents.send("agent:draft-saved", {
        emailId,
        draft: {
          body: draftBody,
          status: status ?? "draft",
          createdAt: Date.now(),
          ...(options?.cc?.length ? { cc: options.cc } : {}),
          ...(options?.bcc?.length ? { bcc: options.bcc } : {}),
        },
      });
    }
    // generateDraft saves the draft internally — notify the renderer with the result
    if (method === "generateDraft" && result && typeof result === "object" && "body" in result) {
      const emailId = args[0] as string;
      const genResult = result as { body: string; cc?: string[]; bcc?: string[] };
      this.mainWindow?.webContents.send("agent:draft-saved", {
        emailId,
        draft: {
          body: genResult.body,
          status: "pending",
          createdAt: Date.now(),
          ...(genResult.cc?.length ? { cc: genResult.cc } : {}),
          ...(genResult.bcc?.length ? { bcc: genResult.bcc } : {}),
        },
      });
    }
    if (method === "saveLocalDraft" && args.length >= 1) {
      const draft = args[0] as Record<string, unknown>;
      this.mainWindow?.webContents.send("agent:local-draft-saved", { draft });
    }
    // generateForward now saves via saveDraftAndSync (same as generateDraft) —
    // notify the renderer so the inline draft appears on the email
    if (method === "generateForward" && result && typeof result === "object" && "body" in result) {
      const emailId = args[0] as string;
      const forwardTo = (args.length >= 4 ? args[3] : undefined) as string[] | undefined;
      const forwardCc = (args.length >= 5 ? args[4] : undefined) as string[] | undefined;
      const forwardBcc = (args.length >= 6 ? args[5] : undefined) as string[] | undefined;
      const genResult = result as { body: string };
      this.mainWindow?.webContents.send("agent:draft-saved", {
        emailId,
        draft: {
          body: genResult.body,
          status: "pending",
          composeMode: "forward",
          createdAt: Date.now(),
          ...(forwardTo?.length ? { to: forwardTo } : {}),
          ...(forwardCc?.length ? { cc: forwardCc } : {}),
          ...(forwardBcc?.length ? { bcc: forwardBcc } : {}),
        },
      });
    }
  }

  // Whitelist of Gmail methods callable via the agent proxy.
  // Without this, the agent could invoke internal methods like disconnect() or saveCredentials().
  private readonly allowedGmailMethods = new Set([
    "archiveMessage",
    "restoreToInbox",
    "trashMessage",
    "setStarred",
    "setRead",
    "createDraft",
    "sendMessage",
    "modifyLabels",
    "getProfile",
    "searchEmails",
    "readEmail",
  ]);

  private async handleGmailRequest(
    requestId: string,
    method: string,
    accountId: string,
    args: unknown[],
  ): Promise<void> {
    try {
      if (!this.allowedGmailMethods.has(method)) {
        this.sendToWorker({
          type: "gmail_error",
          requestId,
          error: `Disallowed Gmail method: ${method}`,
        });
        return;
      }

      const syncService = getEmailSyncService();
      const client = syncService.getClientForAccount(accountId);
      if (!client) {
        this.sendToWorker({
          type: "gmail_error",
          requestId,
          error: `No Gmail client for account: ${accountId}`,
        });
        return;
      }

      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        this.sendToWorker({
          type: "gmail_error",
          requestId,
          error: `Unknown Gmail method: ${method}`,
        });
        return;
      }

      const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(client, ...args);
      this.sendToWorker({ type: "gmail_response", requestId, result });
    } catch (err) {
      this.sendToWorker({
        type: "gmail_error",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Proxy an HTTP request through Electron's net.fetch, which shares the
   * Chromium networking stack (session cookies, TLS state, proxy config).
   * This is the only way to make authenticated requests to services that
   * use browser-session-based auth (SSO, ALB OIDC, etc.) from the worker.
   */
  /** Block non-HTTPS and private/loopback addresses to prevent SSRF. */
  private validateFetchUrl(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error(`net.fetch proxy only allows HTTPS (got ${parsed.protocol})`);
    }
    const host = parsed.hostname;
    if (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error(`net.fetch proxy blocked private address: ${host}`);
    }
  }

  private async handleNetFetchRequest(
    requestId: string,
    url: string,
    options: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<void> {
    try {
      this.validateFetchUrl(url);
      const response = await net.fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body ?? undefined,
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      this.sendToWorker({
        type: "net_fetch_response",
        requestId,
        result: { status: response.status, headers, body },
      });
    } catch (err) {
      this.sendToWorker({
        type: "net_fetch_error",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Singleton instance
export const agentCoordinator = new AgentCoordinator();
