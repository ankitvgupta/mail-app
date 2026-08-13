/**
 * Agent utility process entry point.
 *
 * Runs in an Electron utility process (separate from main and renderer).
 * Cannot import better-sqlite3 or googleapis — all DB and Gmail access
 * goes through proxy messages to the main process via parentPort.
 */

import type {
  AgentFrameworkConfig,
  AgentSessionStartFn,
  CoordinatorMessage,
  DbProxyFn,
  GmailProxyFn,
  NetFetchProxyFn,
  ScopedAgentEvent,
  WorkerMessage,
} from "./types";
import { AgentOrchestrator } from "./orchestrator";
import { createLogger } from "../services/logger";

const log = createLogger("agent-worker");

// --- State ---

// Per-task message ports for streaming events to the renderer
const messagePorts = new Map<string, Electron.MessagePortMain>();
let config: AgentFrameworkConfig | null = null;
let orchestrator: AgentOrchestrator | null = null;

/** Pending proxy requests awaiting responses from the main process */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    taskId: string | null;
  }
>();

let requestCounter = 0;

// Tracks the currently executing task so proxy calls can be scoped.
// Set by the orchestrator's tool executor before each tool invocation.
let activeTaskId: string | null = null;

// --- Proxy functions ---

function generateRequestId(): string {
  return `req_${++requestCounter}_${Date.now()}`;
}

/**
 * Send a message to the main process and wait for a response.
 * DB requests have a 10s timeout, Gmail requests have a 30s timeout.
 */
function proxyRequest(msg: CoordinatorMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = (msg as { requestId: string }).requestId;

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Proxy request timed out after ${timeoutMs}ms: ${msg.type}`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer, taskId: activeTaskId });
    process.parentPort.postMessage(msg);
  });
}

// Methods that make LLM API calls and need a longer timeout than standard DB operations
const LONG_RUNNING_DB_METHODS = new Set(["generateDraft", "generateNewEmail"]);
const LONG_RUNNING_TIMEOUT_MS = 120_000;
const DB_TIMEOUT_MS = 10_000;

const dbProxy: DbProxyFn = (method: string, ...args: unknown[]): Promise<unknown> => {
  const requestId = generateRequestId();
  const timeoutMs = LONG_RUNNING_DB_METHODS.has(method) ? LONG_RUNNING_TIMEOUT_MS : DB_TIMEOUT_MS;
  return proxyRequest({ type: "db_request", requestId, method, args }, timeoutMs);
};

const gmailProxy: GmailProxyFn = (
  method: string,
  accountId: string,
  ...args: unknown[]
): Promise<unknown> => {
  const requestId = generateRequestId();
  return proxyRequest({ type: "gmail_request", requestId, method, accountId, args }, 30_000);
};

const netFetchProxy: NetFetchProxyFn = (
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string },
) => {
  const requestId = generateRequestId();
  // The coordinator always sends a NetFetchResult; the proxy boundary is untyped.
  return proxyRequest(
    { type: "net_fetch_request", requestId, url, options },
    300_000,
  ) as ReturnType<NetFetchProxyFn>;
};

// Fire-and-forget. The DB insert is small and synchronous on the main side;
// we don't need to await it from the provider's hot path.
const recordAgentSessionStart: AgentSessionStartFn = (args) => {
  dbProxy("recordAgentSessionStart", args).catch((err: unknown) => {
    log.warn(
      `[AgentWorker] recordAgentSessionStart failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
};

// --- Emit to renderer via MessagePort ---

function emitToRenderer(taskId: string, event: ScopedAgentEvent): void {
  const port = messagePorts.get(taskId);
  if (port) {
    port.postMessage(event);
  }
}

function closeTaskPort(taskId: string): void {
  const port = messagePorts.get(taskId);
  if (port) {
    port.close();
    messagePorts.delete(taskId);
  }
}

function requestConfirmation(details: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  description: string;
}): void {
  process.parentPort.postMessage({
    type: "confirmation_request",
    ...details,
  } satisfies CoordinatorMessage);
}

// --- Message handling ---

function handleMainMessage(msg: WorkerMessage): void {
  switch (msg.type) {
    case "init":
      config = msg.config;
      orchestrator = new AgentOrchestrator({
        emitToRenderer,
        requestConfirmation,
        dbProxy,
        gmailProxy,
        netFetchProxy,
        recordAgentSessionStart,
        config: msg.config,
        setActiveTaskId: (taskId) => {
          activeTaskId = taskId;
        },
      });
      log.info("[AgentWorker] Initialized with orchestrator");
      break;

    case "run": {
      if (!orchestrator) {
        emitToRenderer(msg.taskId, {
          type: "error",
          message: "Agent orchestrator not initialized",
        });
        emitToRenderer(msg.taskId, {
          type: "state",
          state: "failed",
          message: "Orchestrator not initialized",
        });
        closeTaskPort(msg.taskId);
        return;
      }
      orchestrator
        .runCommand(msg.taskId, msg.providerIds, msg.prompt, msg.context, msg.modelOverride)
        .then(() => {
          closeTaskPort(msg.taskId);
        })
        .catch((err) => {
          emitToRenderer(msg.taskId, {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          emitToRenderer(msg.taskId, { type: "state", state: "failed" });
          closeTaskPort(msg.taskId);
        });
      break;
    }

    case "cancel":
      if (orchestrator) {
        orchestrator.cancel(msg.taskId);
      }
      // Only fail proxy requests belonging to this task
      failPendingRequestsForTask(msg.taskId, "Task cancelled");
      break;

    case "confirm":
      if (orchestrator) {
        orchestrator.resolveConfirmation(msg.toolCallId, msg.approved);
      }
      break;

    case "config_update":
      if (config && msg.config) {
        config = { ...config, ...msg.config };
        // Propagate to the orchestrator so providers pick up the new config
        if (orchestrator) {
          orchestrator.updateConfig(msg.config);
        }
      }
      break;

    case "list_providers":
      if (orchestrator) {
        orchestrator.listAvailableProviders().then((providers) => {
          process.parentPort.postMessage({
            type: "providers_list",
            providers,
          } satisfies CoordinatorMessage);
        });
      } else {
        process.parentPort.postMessage({
          type: "providers_list",
          providers: [],
        } satisfies CoordinatorMessage);
      }
      break;

    case "load_provider": {
      if (!orchestrator) {
        process.parentPort.postMessage({
          type: "provider_load_error",
          providerId: msg.providerId,
          error: "Orchestrator not initialized",
        } satisfies CoordinatorMessage);
        return;
      }
      try {
        // Worker is CJS — plain require() works for loading provider bundles
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(msg.providerPath);
        const factory = mod.default || mod.createProvider;
        if (typeof factory !== "function") {
          throw new Error(
            `Provider module at ${msg.providerPath} does not export a factory function (default or createProvider)`,
          );
        }
        const provider = factory(msg.config);
        orchestrator.registerProvider(provider);
        process.parentPort.postMessage({
          type: "provider_loaded",
          providerId: msg.providerId,
        } satisfies CoordinatorMessage);
        log.info(`[AgentWorker] Loaded installed provider: ${msg.providerId}`);
      } catch (err) {
        process.parentPort.postMessage({
          type: "provider_load_error",
          providerId: msg.providerId,
          error: err instanceof Error ? err.message : String(err),
        } satisfies CoordinatorMessage);
        log.error({ err: err }, `[AgentWorker] Failed to load provider ${msg.providerId}`);
      }
      break;
    }

    case "unload_provider": {
      if (orchestrator) {
        orchestrator.unregisterProvider(msg.providerId);
        log.info(`[AgentWorker] Unloaded provider: ${msg.providerId}`);
      }
      break;
    }

    case "check_health": {
      if (!orchestrator) {
        process.parentPort.postMessage({
          type: "provider_health",
          providerId: msg.providerId,
          status: "error",
          message: "Orchestrator not initialized",
        } satisfies CoordinatorMessage);
        return;
      }
      const provider = orchestrator.getProviderRegistry().get(msg.providerId);
      if (!provider) {
        process.parentPort.postMessage({
          type: "provider_health",
          providerId: msg.providerId,
          status: "error",
          message: "Provider not found",
        } satisfies CoordinatorMessage);
        return;
      }
      const healthTimeout = setTimeout(() => {
        process.parentPort.postMessage({
          type: "provider_health",
          providerId: msg.providerId,
          status: "error",
          message: "Health check timed out",
        } satisfies CoordinatorMessage);
      }, 5000);
      provider
        .isAvailable()
        .then((available) => {
          clearTimeout(healthTimeout);
          process.parentPort.postMessage({
            type: "provider_health",
            providerId: msg.providerId,
            status: available ? "connected" : "not_configured",
          } satisfies CoordinatorMessage);
        })
        .catch((err) => {
          clearTimeout(healthTimeout);
          process.parentPort.postMessage({
            type: "provider_health",
            providerId: msg.providerId,
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          } satisfies CoordinatorMessage);
        });
      break;
    }

    // DB/Gmail responses resolve pending proxy requests
    case "db_response":
      resolvePendingRequest(msg.requestId, msg.result);
      break;
    case "db_error":
      rejectPendingRequest(msg.requestId, msg.error);
      break;
    case "gmail_response":
      resolvePendingRequest(msg.requestId, msg.result);
      break;
    case "gmail_error":
      rejectPendingRequest(msg.requestId, msg.error);
      break;
    case "net_fetch_response":
      resolvePendingRequest(msg.requestId, msg.result);
      break;
    case "net_fetch_error":
      rejectPendingRequest(msg.requestId, msg.error);
      break;
  }
}

function resolvePendingRequest(requestId: string, result: unknown): void {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.resolve(result);
  }
}

function rejectPendingRequest(requestId: string, error: string): void {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.reject(new Error(error));
  }
}

function failPendingRequestsForTask(taskId: string, reason: string): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.taskId === taskId) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      pendingRequests.delete(requestId);
    }
  }
}

// --- Bootstrap ---

// Listen for messages from the main process
process.parentPort.on("message", (event) => {
  const msg = event.data as WorkerMessage;

  // Store transferred MessagePort keyed by taskId for per-task event routing
  if (event.ports && event.ports.length > 0 && msg.type === "run") {
    const port = event.ports[0];
    messagePorts.set(msg.taskId, port);
    port.start();
  }

  handleMainMessage(msg);
});

log.info("[AgentWorker] Utility process started");
