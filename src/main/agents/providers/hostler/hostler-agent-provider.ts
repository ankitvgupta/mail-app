// Type-only imports — @hostler/sdk is ESM-only ("type": "module", no
// `require` export condition) and the worker bundle is CJS, so the SDK is
// loaded at runtime via dynamic import (see loadHostlerSdk); same pattern as
// the OpenCode provider.
import type {
  AgentConfig,
  CreateSessionOptions,
  ModelConfig,
  SessionEvent,
  SessionInfo,
  StreamOptions,
  ToolResult,
} from "@hostler/sdk";
import type {
  AgentContext,
  AgentEvent,
  AgentFrameworkConfig,
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentToolSpec,
  ToolExecutorFn,
} from "../../types";
import {
  buildAgentConfig,
  ensureAgent,
  stableStringify,
  type HostlerAgentsApi,
} from "./agent-sync";
import { createHostlerEventMapper } from "./event-mapper";
import { createLogger } from "../../../services/logger";
import { DEFAULT_HOSTLER_HARNESS } from "../../../../shared/types";

const log = createLogger("hostler-agent");

/** Default pairing: the opencode harness driving GLM 5.2 through Hostler's
 *  own model broker (GET /v1/models catalog id "glm-5.2", provider "openai" —
 *  open-weights models ride the broker's openai wire shape). GLM 5.2 is the
 *  same model the app's Ollama Cloud integration defaults to
 *  (DEFAULT_OLLAMA_MODEL), chosen there after a 16-task agent benchmark.
 *  Model ids are validated against the catalog at session create, so a
 *  mistyped id fails fast rather than after the sandbox starts billing. */
export const DEFAULT_HOSTLER_MODEL: ModelConfig = {
  provider: "openai",
  id: "glm-5.2",
};

/**
 * Resolve the configured model selector. Accepts "provider/model" (e.g.
 * "openai/kimi-k2.5") or a bare model id, which pairs with "anthropic" —
 * bare Claude ids are the common case, and Hostler's session-create catalog
 * validation rejects a wrong pairing fast with a clear 400. Exported for
 * tests.
 */
export function resolveHostlerModel(selector: string | undefined): ModelConfig {
  const trimmed = selector?.trim();
  if (!trimmed) return DEFAULT_HOSTLER_MODEL;
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  }
  return { provider: "anthropic", id: trimmed };
}

/**
 * Structural view of the SDK surface this provider uses. The provider types
 * against these (which the real SDK client satisfies) rather than the SDK
 * classes themselves — the classes carry `#private` nominal markers, so test
 * fakes could never satisfy them. Mirrors the HostlerAgentsApi pattern in
 * agent-sync.ts.
 */
export interface HostlerSessionLike {
  readonly id: string;
  info(): Promise<SessionInfo>;
  send(text: string, options?: { signal?: AbortSignal }): Promise<void>;
  interrupt(): Promise<void>;
  terminate(): Promise<SessionInfo>;
  events(options?: { since?: number }): Promise<SessionEvent[]>;
  submitToolResult(result: ToolResult, options?: { signal?: AbortSignal }): Promise<void>;
  stream(options?: StreamOptions): AsyncGenerator<SessionEvent, void, void>;
}

export interface HostlerClientLike {
  agents: HostlerAgentsApi;
  sessions: {
    create(options: CreateSessionOptions): Promise<HostlerSessionLike>;
    get(id: string): Promise<HostlerSessionLike>;
    list(): Promise<SessionInfo[]>;
  };
}

export type HostlerSdkModule = {
  Hostler: new (options: { apiKey: string | undefined; baseUrl?: string }) => HostlerClientLike;
};

const importDynamic = new Function("s", "return import(s)") as (
  specifier: string,
) => Promise<unknown>;
let sdkCache: HostlerSdkModule | null = null;
async function loadHostlerSdk(): Promise<HostlerSdkModule> {
  if (sdkCache) return sdkCache;
  const mod = (await importDynamic("@hostler/sdk")) as HostlerSdkModule;
  sdkCache = { Hostler: mod.Hostler };
  return sdkCache;
}

interface ActiveRun {
  session: HostlerSessionLike | null;
  abort: AbortController;
  cleanup: () => void;
}

interface PendingToolCall {
  name: string;
  input: unknown;
  locale: "client" | "sandbox" | "mcp";
}

/** How long a session sandbox stays warm after its last run before we
 *  terminate it. Warm sessions make follow-ups instant (no 10–30s sandbox
 *  launch), but Hostler sandboxes bill until deleted, so the window is short.
 *  A follow-up after termination still works — the provider creates a fresh
 *  session and replays context.conversationHistory. Changing this also
 *  requires updating the "kept warm for 5 minutes" copy on the Hostler card
 *  in ExtensionsTab.tsx. */
const IDLE_SESSION_TTL_MS = 5 * 60 * 1000;

/** Yielded whenever a run has to launch a fresh sandbox (new conversation or
 *  dead-session recreate) so the sidebar shows why nothing streams yet. */
const SANDBOX_STARTING_EVENT: AgentEvent = {
  type: "state",
  state: "running",
  message: "Starting Hostler cloud sandbox (~10-30s)…",
};

/** Boot-sweep threshold for reaping non-idle mail-app sessions — see
 *  sweepOrphanedSessions. */
const STALE_RUNNING_SESSION_MS = 60 * 60 * 1000;

/**
 * Hostler Agent Provider — hosted cloud backend for the agent sidebar
 * (https://hostler.dev).
 *
 * Architecture:
 *
 *   Worker process                        Hostler platform
 *     └── HostlerAgentProvider              ├── control plane (/v1 API)
 *           • syncs one versioned agent  ──►│    agents.create/createVersion
 *           • one session per sidebar    ──►│    sessions.create (sandbox,
 *             conversation                  │    ~10–30s launch)
 *           • streams the session event  ◄──│    SSE event log (durable,
 *             log, maps to AgentEvents      │    replayable via seq cursor)
 *           • executes client tools      ──►│    tool_results park-and-post
 *             locally via toolExecutor      └── sandbox runs the harness
 *
 * Why this shape:
 *   - The model loop runs in Hostler's sandbox, but every mail tool executes
 *     inside this worker via the orchestrator's toolExecutor — so the same
 *     PermissionGate, confirmation flow, and DB/Gmail proxies apply, and
 *     email data never lives in the sandbox beyond what tool results return.
 *   - Model API keys never enter the sandbox either: Hostler's broker holds
 *     provider credentials, which is why the app's Anthropic/Ollama routing
 *     (modelOverride) is deliberately ignored here — the hostler.model
 *     setting names a model in Hostler's brokered catalog instead.
 *   - Sessions map 1:1 to sidebar conversations. The session id is returned
 *     as providerTaskId so follow-ups reuse the live sandbox (via
 *     context.providerConversationIds), and an idle reaper terminates warm
 *     sessions after IDLE_SESSION_TTL_MS since sandboxes bill until deleted.
 */
export class HostlerAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "hostler",
    name: "Hostler",
    description: "Hosted cloud agent (hostler.dev) — sandboxed harness, tools run locally",
    auth: { type: "api_key" },
  };

  private frameworkConfig: AgentFrameworkConfig;
  private client: HostlerClientLike | null = null;
  private activeRuns = new Map<string, ActiveRun>();
  /** Latest agent sync result, keyed by desired-config fingerprint. */
  private agentSync: { fingerprint: string; id: string; version: number } | null = null;
  private agentSyncPromise: Promise<{ fingerprint: string; id: string; version: number }> | null =
    null;
  /** Per-session event-log high-water mark, so follow-up streams resume past
   *  events already rendered instead of replaying the whole log. */
  private sessionSeq = new Map<string, number>();
  private idleTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; session: HostlerSessionLike }
  >();
  private orphanSweepDone = false;
  private orphanSweep: Promise<void> | null = null;
  private readonly idleSessionTtlMs: number;

  constructor(
    frameworkConfig: AgentFrameworkConfig,
    opts?: {
      /** Test hook — shrinks the reaper TTL so tests don't wait 5 minutes. */ idleSessionTtlMs?: number;
    },
  ) {
    this.frameworkConfig = frameworkConfig;
    this.idleSessionTtlMs = opts?.idleSessionTtlMs ?? IDLE_SESSION_TTL_MS;
  }

  /** Test hook: inject a fake SDK module (mirrors AnthropicService._setClientForTesting). */
  _setSdkForTesting(sdk: HostlerSdkModule | null): void {
    sdkCache = sdk;
    this.client = null;
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const { taskId, prompt, context, tools, toolExecutor, signal, recordSessionStart } = params;

    yield { type: "state", state: "running" };

    const settings = this.frameworkConfig.hostler;
    if (!settings?.enabled) {
      yield { type: "error", message: "Hostler provider is not enabled in Settings" };
      return { state: "failed" };
    }
    if (!settings.apiKey) {
      yield {
        type: "error",
        message: "Hostler API key not configured — add one in Settings → Extensions",
      };
      return { state: "failed" };
    }

    const model = resolveHostlerModel(settings.model);
    const harness = settings.harness?.trim() || DEFAULT_HOSTLER_HARNESS;

    // The sandbox's LLM calls go through Hostler's broker, invisible to our
    // AnthropicService — without this row there'd be no record the session ran.
    // LlmProvider is a closed union (anthropic | ollama-cloud); non-Anthropic
    // brokered models (GLM, Kimi, DeepSeek, ...) are the open-weights family
    // the app otherwise runs via Ollama Cloud, so stamp them "ollama-cloud" —
    // an approximation, but truer than "anthropic".
    recordSessionStart({
      harness: "hostler",
      provider: model.provider === "anthropic" ? "anthropic" : "ollama-cloud",
      model: model.id,
      accountId: context.accountId,
      emailId: context.currentEmailId,
    });

    let client: HostlerClientLike;
    let agentRef: { id: string; version: number };
    try {
      client = await this.ensureClient(settings);
      agentRef = await this.ensureAgent(client, tools, model, harness);
    } catch (err) {
      yield { type: "error", message: describeHostlerError(err, "sync the Hostler agent") };
      return { state: "failed" };
    }

    // Pre-aborted signal short-circuit — addEventListener after the event has
    // fired is a no-op (mirrors the OpenCode provider's guard).
    if (signal.aborted) {
      yield { type: "state", state: "cancelled" };
      return { state: "cancelled" };
    }
    const abortController = new AbortController();
    const onParentAbort = () => abortController.abort();
    signal.addEventListener("abort", onParentAbort, { once: true });
    const cleanup = () => {
      signal.removeEventListener("abort", onParentAbort);
      this.activeRuns.delete(taskId);
    };
    const active: ActiveRun = { session: null, abort: abortController, cleanup };
    this.activeRuns.set(taskId, active);

    try {
      // --- Acquire a session: reuse the conversation's live sandbox if the
      // renderer passed one back, else launch a fresh one. The prior session's
      // idle timer is cleared only AFTER reuse is confirmed — clearing it
      // before the probe would orphan a live, billing sandbox whenever the
      // probe fails transiently (network blip ≠ dead session; the still-armed
      // timer remains its reaper).
      let session: HostlerSessionLike | null = null;
      let isNewSession = false;
      const rawPriorId = context.providerConversationIds?.[this.config.id];
      // Session ids are platform-generated (`ses_…`) but round-trip through
      // the renderer, and the SDK splices them into authenticated URL paths
      // unencoded — validate the shape before use.
      const priorId =
        rawPriorId && /^ses_[A-Za-z0-9_-]+$/.test(rawPriorId) ? rawPriorId : undefined;
      if (priorId) {
        // One stream per session: two concurrent runs on one session would
        // both claim its tool parks and double-execute local side effects.
        // The sidebar disables follow-ups while a run is active; enforce the
        // invariant here too so non-UI callers can't bypass it.
        for (const other of this.activeRuns.values()) {
          if (other !== active && other.session?.id === priorId) {
            cleanup();
            yield {
              type: "error",
              message: "Another run is already active on this Hostler conversation",
            };
            return { state: "failed", providerTaskId: priorId };
          }
        }
        session = await client.sessions.get(priorId).catch(() => null);
        if (session) {
          const info = await session.info().catch(() => null);
          if (!info || info.status === "terminated") session = null;
        }
        if (session) this.clearIdleTimer(priorId);
      }
      if (!session) {
        isNewSession = true;
        yield SANDBOX_STARTING_EVENT;
        session = await this.createSession(client, agentRef, taskId);
      }
      active.session = session;

      if (abortController.signal.aborted) {
        this.scheduleIdleTermination(session);
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled", providerTaskId: session.id };
      }

      // --- Cursor: stream only events newer than the durable log's CURRENT
      // tail. The tail must be re-fetched on every reuse — the in-memory
      // high-water mark only covers events the previous run consumed, and a
      // cancelled run stops consuming before the platform appends its
      // status_idle(interrupted) (plus any trailing events). Trusting the
      // stale mark would replay that idle into this turn's stream and
      // instantly mis-terminate it (and could re-execute the cancelled turn's
      // unanswered tool calls). sessionSeq is kept purely as a fetch hint so
      // long conversations don't re-download their whole log. An events()
      // failure fails the run — a silent cursor=0 would replay historical
      // client tools (side effects!) and complete on the first turn's idle.
      let cursor = 0;
      if (!isNewSession) {
        const known = this.sessionSeq.get(session.id) ?? 0;
        const tail = await session.events({ since: known });
        const lastSeq = tail.length > 0 ? tail[tail.length - 1].seq : known;
        // seq is server-supplied: a non-finite value would fall through the
        // SDK's `since ?? 0` default and replay the entire log — the exact
        // side-effect replay this cursor exists to prevent.
        if (typeof lastSeq !== "number" || !Number.isFinite(lastSeq)) {
          throw new Error("Hostler event log returned a malformed tail (non-numeric seq)");
        }
        cursor = lastSeq;
      }

      // --- Send the message. A reused session can die between the info()
      // check and send() (Hostler sessions are ephemeral across platform
      // restarts) — recreate once and resend rather than failing the run. ---
      const message = isNewSession ? buildFirstMessage(context, prompt) : prompt;
      try {
        await session.send(message, { signal: abortController.signal });
      } catch (err) {
        if (isNewSession || !isConflict(err)) throw err;
        log.info(`Session ${session.id} no longer live; recreating for task ${taskId}`);
        this.sessionSeq.delete(session.id);
        yield SANDBOX_STARTING_EVENT;
        session = await this.createSession(client, agentRef, taskId);
        active.session = session;
        isNewSession = true;
        cursor = 0;
        await session.send(buildFirstMessage(context, prompt), {
          signal: abortController.signal,
        });
      }

      // --- Stream the event log until the turn settles. ---
      const mapper = createHostlerEventMapper();
      const toolInputs = new Map<string, PendingToolCall>();
      let terminal: AgentRunResult | null = null;
      let approvalParked: string | null = null;

      for await (const ev of session.stream({
        since: cursor,
        signal: abortController.signal,
      })) {
        if (typeof ev.seq === "number" && Number.isFinite(ev.seq)) {
          this.sessionSeq.set(session.id, ev.seq);
        }

        for (const mapped of mapper.next(ev)) {
          yield mapped;
        }

        if (ev.type === "agent.tool_use") {
          // The only event carrying the input — remember it for tool_pending.
          toolInputs.set(ev.toolCallId, { name: ev.name, input: ev.input, locale: ev.locale });
        } else if (ev.type === "agent.tool_pending") {
          if (ev.pendingState === "approval") {
            // We never configure always_ask, and this app has no operator
            // console UX to answer an approval park. Left alone, the park
            // holds the turn open indefinitely — and a requires_action
            // session never settles to "idle", so even the reaper couldn't
            // stop the sandbox from billing. Interrupt and fail instead.
            approvalParked = ev.name;
            yield {
              type: "error",
              message:
                `Hostler parked tool "${ev.name}" for operator approval, which this app ` +
                `cannot answer — interrupting the turn. Decide it in the Hostler console ` +
                `or remove the tool's always_ask policy from the agent config.`,
            };
            void session.interrupt().catch((err: unknown) => {
              log.warn(
                `interrupt after approval park failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          } else {
            this.handleToolPending(session, ev, toolInputs, toolExecutor, abortController.signal);
          }
        } else if (ev.type === "session.status_idle") {
          const stop = ev.stopReason;
          if (stop.type === "requires_action") {
            // Parked client tools are still being answered — keep streaming;
            // the turn resumes once results are posted.
            continue;
          }
          terminal = {
            state: approvalParked
              ? "failed"
              : stop.type === "end_turn"
                ? "completed"
                : stop.type === "interrupted"
                  ? "cancelled"
                  : "failed",
            providerTaskId: session.id,
          };
          break;
        } else if (ev.type === "session.status_terminated") {
          yield { type: "error", message: `Hostler session terminated: ${ev.reason}` };
          this.sessionSeq.delete(session.id);
          cleanup();
          return { state: "failed", providerTaskId: session.id };
        }
      }

      this.scheduleIdleTermination(session);

      if (!terminal) {
        // Stream ended without an idle event: local abort (cancel) or the
        // stream closed unexpectedly.
        cleanup();
        if (approvalParked) {
          return { state: "failed", providerTaskId: session.id };
        }
        if (abortController.signal.aborted) {
          yield { type: "state", state: "cancelled" };
          return { state: "cancelled", providerTaskId: session.id };
        }
        yield { type: "error", message: "Hostler event stream ended unexpectedly" };
        return { state: "failed", providerTaskId: session.id };
      }

      cleanup();
      if (terminal.state === "completed") {
        yield { type: "done", summary: mapper.lastMessage()?.trim() || "Completed" };
      } else if (terminal.state === "cancelled") {
        yield { type: "state", state: "cancelled" };
      }
      // failed: the mapper already yielded the error from the stopReason; a
      // second error/state event here would double-surface it in the UI
      // (matches the OpenCode provider's pattern).
      return terminal;
    } catch (err) {
      cleanup();
      const session = active.session;
      if (session) this.scheduleIdleTermination(session);
      if (abortController.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled", providerTaskId: session?.id };
      }
      yield { type: "error", message: describeHostlerError(err, "run the Hostler session") };
      return { state: "failed", providerTaskId: session?.id };
    }
  }

  cancel(taskId: string): void {
    const active = this.activeRuns.get(taskId);
    if (!active) return;
    active.abort.abort();
    // Interrupt (not terminate): the turn aborts but the sandbox stays warm
    // for follow-ups; the idle reaper handles eventual termination.
    const session = active.session;
    if (session) {
      session.interrupt().catch((err: unknown) => {
        log.warn(
          `session.interrupt failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    active.cleanup();
  }

  async isAvailable(): Promise<boolean> {
    const settings = this.frameworkConfig.hostler;
    return Boolean(settings?.enabled && settings.apiKey);
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.frameworkConfig = { ...this.frameworkConfig, ...config };
    // The orchestrator broadcasts every config change to every provider;
    // only hostler settings affect our cached client and synced agent.
    if (!("hostler" in config)) return;

    this.client = null;
    this.agentSync = null;

    // Terminate warm sessions on ANY hostler settings change, not just
    // disable. The warm handles are bound to the previous client (old
    // apiKey/baseUrl) — after a key rotation their idle-timer terminate()
    // would 401 and the sandboxes would bill until the platform reaps them.
    void this.terminateWarmSessions();
  }

  // --- Internals ---

  private async ensureClient(settings: {
    apiKey?: string;
    baseUrl?: string;
  }): Promise<HostlerClientLike> {
    if (this.client) return this.client;
    const sdk = await loadHostlerSdk();
    this.client = new sdk.Hostler({
      apiKey: settings.apiKey,
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    });
    this.sweepOrphanedSessions(this.client);
    return this.client;
  }

  /**
   * Launch a sandbox session. The platform reserves credit per LIVE session,
   * so a create can 402 ("insufficient credit") even with a positive balance
   * while our own warm-but-idle sessions hold reservations (verified against
   * the live platform, July 2026). In that case, reap the warm sessions now
   * — exactly what the idle TTL would do later — and retry once.
   */
  private async createSession(
    client: HostlerClientLike,
    agentRef: { id: string; version: number },
    taskId: string,
  ): Promise<HostlerSessionLike> {
    const options: CreateSessionOptions = {
      agentId: agentRef.id,
      // Pin the version we just synced — deterministic even if another
      // device publishes a newer version mid-run.
      agentVersion: agentRef.version,
      title: `mail-app:${taskId}`,
    };
    try {
      return await client.sessions.create(options);
    } catch (err) {
      if (errorStatus(err) !== 402) throw err;
      // Reservations may be held by our own warm sessions OR by orphans the
      // boot-time sweep (fire-and-forget) is still reaping — settle both,
      // then retry once. A genuine out-of-credit state throws again here.
      log.info("Session create hit a credit reservation (402); freeing our sessions and retrying");
      await this.orphanSweep?.catch(() => undefined);
      await this.terminateWarmSessions();
      return await client.sessions.create(options);
    }
  }

  /** Terminate every warm (idle, timer-held) session now. Awaited so callers
   *  can rely on the reservations actually being released. */
  private async terminateWarmSessions(): Promise<void> {
    const entries = [...this.idleTimers.values()];
    for (const [sessionId, entry] of this.idleTimers) {
      clearTimeout(entry.timer);
      this.sessionSeq.delete(sessionId);
    }
    this.idleTimers.clear();
    await Promise.allSettled(
      entries.map((entry) =>
        entry.session.terminate().catch((err: unknown) => {
          log.warn(
            `warm terminate failed for ${entry.session.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
      ),
    );
  }

  /**
   * Reap sandboxes leaked by an app quit or worker crash — in those cases the
   * unref'd idle timer dies with the process and nothing else terminates the
   * session, which bills until deleted. Once per worker lifetime, terminate
   * idle mail-app sessions. Live turns (status running/starting) are spared;
   * if this races another instance's about-to-be-reused idle session, that
   * instance's send() gets a 409 and its recreate path transparently
   * launches a fresh sandbox.
   */
  private sweepOrphanedSessions(client: HostlerClientLike): void {
    if (this.orphanSweepDone) return;
    this.orphanSweepDone = true;
    // Fire-and-forget, but the promise is kept: createSession awaits it on a
    // 402 so a session create that races the sweep can retry after the
    // orphans' credit reservations are actually released.
    this.orphanSweep = (async () => {
      const rows = await client.sessions.list();
      // Idle mail-app sessions are always orphans worth reaping. Running/
      // starting ones usually belong to a live turn — but a session stuck
      // mid-turn when the app died (e.g. a park the dead app never answered)
      // never settles to idle, so also reap non-idle sessions older than an
      // hour; no legitimate sidebar turn runs that long.
      const staleBefore = Date.now() - STALE_RUNNING_SESSION_MS;
      const orphans = rows.filter((row) => {
        if (!(row.title ?? "").startsWith("mail-app:")) return false;
        if (row.status === "idle") return true;
        const created = Date.parse(row.createdAt);
        return Number.isFinite(created) && created < staleBefore;
      });
      for (const row of orphans) {
        const session = await client.sessions.get(row.id).catch(() => null);
        await session?.terminate().catch((err: unknown) => {
          log.warn(
            `orphan terminate failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      if (orphans.length > 0) {
        log.info(`Reaped ${orphans.length} orphaned Hostler session(s) from a previous run`);
      }
    })();
    this.orphanSweep.catch((err: unknown) => {
      log.warn(`orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Sync the versioned Hostler agent to the desired config. Cached by config
   * fingerprint (tool set, model, harness are stable across runs), with
   * single-flight so concurrent first runs don't race duplicate creates.
   * Waiters loop rather than chain once: a run whose fingerprint mismatches
   * the in-flight sync must wait for it to settle and re-check the cache, or
   * concurrent mismatched runs would each publish their own (identical)
   * version — and one run's failed sync must not reject unrelated runs.
   */
  private async ensureAgent(
    client: HostlerClientLike,
    tools: AgentToolSpec[],
    model: ModelConfig,
    harness: string,
  ): Promise<{ id: string; version: number }> {
    const desired = buildAgentConfig({ tools, model, harness });
    const fingerprint = stableStringify(desired);

    for (;;) {
      if (this.agentSync?.fingerprint === fingerprint) return this.agentSync;
      const inFlight = this.agentSyncPromise;
      if (!inFlight) break;
      // Await whatever is running; its failure belongs to the run that
      // started it, not to us. Loop: another waiter may have started a new
      // sync (or populated the cache) while we awaited.
      await inFlight.catch(() => undefined);
    }

    this.agentSyncPromise = this.syncAgent(client.agents, desired, fingerprint).finally(() => {
      this.agentSyncPromise = null;
    });
    return this.agentSyncPromise;
  }

  private async syncAgent(
    agents: HostlerAgentsApi,
    desired: AgentConfig,
    fingerprint: string,
  ): Promise<{ fingerprint: string; id: string; version: number }> {
    const ref = await ensureAgent(agents, desired);
    const synced = { fingerprint, ...ref };
    this.agentSync = synced;
    return synced;
  }

  /**
   * React to an async-parked tool call: run it through the orchestrator's
   * toolExecutor (PermissionGate + confirmation included) and post the result
   * back. The execution is deliberately not awaited so the stream loop keeps
   * consuming events — the sandbox holds the turn open until the result
   * arrives, and parallel tool calls park concurrently. (Approval parks are
   * handled inline in the run loop, which interrupts the turn.)
   */
  private handleToolPending(
    session: HostlerSessionLike,
    ev: Extract<SessionEvent, { type: "agent.tool_pending" }>,
    toolInputs: Map<string, PendingToolCall>,
    toolExecutor: ToolExecutorFn,
    signal: AbortSignal,
  ): void {
    // The park itself is authoritative — only client-tool calls park for the
    // API client. The locale stash can lag it: the platform emits one call
    // twice (harness dispatch as locale "sandbox", then the park as locale
    // "client"), so a pending that lands between them finds the stale
    // sandbox-locale stash. Trust the park over the stash; only mcp-locale
    // calls (runtime-side dispatch) are never ours to answer.
    const call = toolInputs.get(ev.toolCallId);
    if (!call || call.locale === "mcp") return;
    toolInputs.delete(ev.toolCallId);
    void this.executeClientTool(session, ev.toolCallId, call, toolExecutor, signal);
  }

  private async executeClientTool(
    session: HostlerSessionLike,
    toolCallId: string,
    call: PendingToolCall,
    toolExecutor: ToolExecutorFn,
    signal: AbortSignal,
  ): Promise<void> {
    let result: ToolResult;
    try {
      if (!isRecord(call.input)) {
        throw new Error(`Tool input for "${call.name}" was not an object`);
      }
      const value = await toolExecutor(call.name, call.input);
      result = {
        toolCallId,
        content: typeof value === "string" ? value : JSON.stringify(value ?? null),
      };
    } catch (err) {
      // Includes PermissionGate rejections ("Tool X was rejected by user") —
      // the message is shown to the model verbatim so it can adjust.
      result = { toolCallId, error: err instanceof Error ? err.message : String(err) };
    }
    // A cancelled run must not keep shipping results (which may carry email
    // content) to the cloud session — mirrors the SDK run()'s own invariant.
    if (signal.aborted) return;
    try {
      await session.submitToolResult(result, { signal });
    } catch (err) {
      // The session can idle/terminate while a slow tool runs; nothing to do.
      log.warn(
        `submitToolResult failed for ${toolCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleIdleTermination(session: HostlerSessionLike): void {
    this.clearIdleTimer(session.id);
    const timer = setTimeout(() => {
      this.idleTimers.delete(session.id);
      // TOCTOU guard: a follow-up may have re-entered this session in the
      // instant between the timer firing and this callback running — don't
      // kill a sandbox with a live run on it.
      for (const active of this.activeRuns.values()) {
        if (active.session?.id === session.id) return;
      }
      this.sessionSeq.delete(session.id);
      session.terminate().catch((err: unknown) => {
        log.warn(
          `idle terminate failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.idleSessionTtlMs);
    // Don't hold the worker process open just to reap a sandbox.
    timer.unref?.();
    this.idleTimers.set(session.id, { timer, session });
  }

  private clearIdleTimer(sessionId: string): void {
    const entry = this.idleTimers.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.idleTimers.delete(sessionId);
  }
}

/**
 * First message of a session: per-run context that must NOT live in the
 * versioned agent config (it changes every conversation). Follow-ups within
 * a live session skip this — the context is already established in-session.
 */
export function buildFirstMessage(context: AgentContext, prompt: string): string {
  const lines: string[] = ["Context for this conversation:"];
  lines.push(`- Account: ${context.userEmail}${context.userName ? ` (${context.userName})` : ""}`);
  lines.push(`- Account ID: ${context.accountId}`);
  if (context.currentEmailId) {
    lines.push(`- Currently viewing email ID: ${context.currentEmailId}`);
  }
  if (context.currentThreadId) {
    lines.push(`- Current thread ID: ${context.currentThreadId}`);
  }
  if (context.selectedEmailIds && context.selectedEmailIds.length > 0) {
    lines.push(`- Selected emails: ${context.selectedEmailIds.join(", ")}`);
  }
  if (context.currentDraftId) {
    lines.push(`- Currently editing draft ID: ${context.currentDraftId}`);
  }

  if (context.memoryContext) {
    lines.push("", context.memoryContext);
  }

  // Present when this conversation started on a session that has since been
  // reaped/terminated — replay the transcript so the fresh sandbox has the
  // history the user can still see in the sidebar.
  if (context.conversationHistory) {
    lines.push("", "## Previous conversation", context.conversationHistory);
  }

  lines.push("", "---", "", `User request: ${prompt}`);
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** HostlerError without importing the class at runtime (ESM/CJS gap): the
 *  SDK's errors carry a numeric `status` of the failing HTTP response. */
function errorStatus(err: unknown): number | null {
  if (err instanceof Error && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  return null;
}

function isConflict(err: unknown): boolean {
  const status = errorStatus(err);
  // 409: session exists but is not live. 404: session row is gone entirely.
  return status === 409 || status === 404;
}

function describeHostlerError(err: unknown, doing: string): string {
  const message = err instanceof Error ? err.message : String(err);
  switch (errorStatus(err)) {
    case 401:
      return "Hostler rejected the API key — re-check it in Settings → Extensions";
    case 402:
      return `Hostler billing: ${message} — an active subscription with credit is required (hostler.dev → Billing)`;
    case 502:
      return `Hostler sandbox provisioning failed — safe to retry (${message})`;
    default:
      return `Failed to ${doing}: ${message}`;
  }
}
