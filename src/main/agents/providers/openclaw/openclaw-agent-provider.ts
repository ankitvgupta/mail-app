import { z } from "zod";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  AgentContext,
  AgentFrameworkConfig,
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  SubAgentToolConfig,
} from "../../types";
import type { OpenClawProviderConfig } from "./types";
import { OpenClawAgentResponseSchema } from "./types";

function isDemoMode(): boolean {
  return process.env.EXO_DEMO_MODE === "true";
}

const TIMEOUT_MS = 300_000;
const SLOW_WARNING_MS = 30_000;
const OPENCLAW_PROVIDER_ID = "openclaw-agent";

export function buildOpenClawPrompt(_context: AgentContext, prompt: string): string {
  // The OpenClaw CLI has no per-request system-instruction channel. Do not put
  // retrieved knowledge beside the user request at equal authority. Email
  // drafts created through OpenClaw's mail tools are still enriched inside the
  // main-process draft pipeline, where a system-level trust boundary exists.
  return prompt;
}

function shortDigest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function buildOpenClawSessionKey(context: AgentContext, taskId: string): string {
  const accountPrefix = `exo-${shortDigest(context.accountId, 12)}-`;
  const prior = context.providerConversationIds?.[OPENCLAW_PROVIDER_ID];
  if (prior?.startsWith(accountPrefix) && /^exo-[a-f0-9]{12}-[a-f0-9]{24}$/.test(prior)) {
    return prior;
  }

  // A new Exo task must start a new OpenClaw session even when it targets the
  // same email. True follow-ups carry the validated prior key above.
  return `${accountPrefix}${shortDigest(taskId, 24)}`;
}

/**
 * Demo mode canned responses, rotated by a hash of the query string.
 */
const DEMO_RESPONSES = [
  `Sarah Chen is a General Partner at Sequoia Capital, where she's been since 2021. She led their Series A investment in Retool and sits on the boards of Notion and Linear. Previously, she was VP of Product at Stripe (2016-2021) where she built Stripe Atlas. Stanford CS undergrad, Harvard MBA. She's been actively tweeting about AI infrastructure plays and spoke at the All-In Summit last month about "why developer tools are underpriced." Her fund just closed a new $2.5B early-stage vehicle. She typically responds within 24 hours and prefers concise, data-driven pitches.`,

  `Marcus Rodriguez is the co-founder and CEO of Athena Labs, a Series B climate tech startup ($45M raised, led by a16z). They're building carbon capture monitoring software used by 12 Fortune 500 companies. He was previously a senior engineer at SpaceX (propulsion team, 2015-2020) and holds 3 patents in sensor fusion. Athena was in YC W21. Their last quarterly revenue was ~$3.2M ARR, growing 15% month-over-month. He's hiring aggressively — 8 open engineering roles. He's known for extremely detailed technical emails and expects the same in replies.`,

  `Jennifer Park is the CTO of Meridian Health Systems, a $4B healthcare company with 15,000 employees across 200 locations. She joined from Google Cloud (VP of Healthcare & Life Sciences) in 2023. Her current focus is migrating Meridian's EHR infrastructure to a hybrid cloud setup — they're evaluating vendors now with a Q3 decision deadline. She reports to CEO David Kim and manages a 400-person engineering org. She's methodical, prefers structured proposals with timelines, and typically involves her VP of Infrastructure (Tom Walsh) in technical decisions.`,

  `Alex Nakamura is a Staff Engineer at Vercel, working on the Edge Runtime team. He previously built internal developer tools at Netflix (2018-2022) and contributed to several popular open source projects including SWR and Turbopack. He maintains a well-read technical blog (alexnak.dev) where his recent post on "Edge Computing Tradeoffs in 2026" got significant traction on Hacker News. He's based in San Francisco, active in the local TypeScript meetup scene, and known for giving thoughtful, detailed code reviews. He usually responds to emails within a few days.`,
];

export function getDemoResponse(query: string): string {
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  }
  return DEMO_RESPONSES[Math.abs(hash) % DEMO_RESPONSES.length];
}

/**
 * Execute `openclaw agent` CLI and return the response text.
 * OpenClaw's gateway is WebSocket-based, so we shell out to the CLI
 * which handles the WS protocol and returns JSON with --json flag.
 *
 * Calls `onSlow` after SLOW_WARNING_MS if the response hasn't arrived yet,
 * so the caller can yield a "taking longer than expected" event.
 */
export function execOpenClaw(
  message: string,
  signal: AbortSignal,
  sessionKey: string,
  onSlow?: () => void,
  extraEnv?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let slowTimer: ReturnType<typeof setTimeout> | null = null;

    if (onSlow) {
      slowTimer = setTimeout(onSlow, SLOW_WARNING_MS);
    }

    // Define onAbort early so execFile callback can remove it on completion
    const childRef: { current: ReturnType<typeof execFile> | null } = { current: null };
    const onAbort = () => {
      if (slowTimer) clearTimeout(slowTimer);
      childRef.current?.kill("SIGTERM");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    childRef.current = execFile(
      "openclaw",
      ["agent", "--agent", "main", "--session-key", sessionKey, "--message", message, "--json"],
      { timeout: TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1", ...extraEnv } },
      (error, stdout, stderr) => {
        if (slowTimer) clearTimeout(slowTimer);
        signal.removeEventListener("abort", onAbort);

        if (signal.aborted) {
          reject(new Error("Request cancelled"));
          return;
        }
        if (error) {
          const combined = (stderr || "") + (stdout || "");
          if (combined.includes("No API key")) {
            reject(
              new Error(
                "OpenClaw: No API key configured — run `openclaw configure` to set up credentials",
              ),
            );
            return;
          }
          if (
            combined.includes("ECONNREFUSED") ||
            combined.includes("not reachable") ||
            combined.includes("gateway")
          ) {
            reject(
              new Error("OpenClaw: Gateway not running — start it with `openclaw gateway run`"),
            );
            return;
          }
          if (error.killed || combined.includes("ETIMEDOUT")) {
            reject(new Error("OpenClaw: Request timed out after 5m"));
            return;
          }
          reject(new Error(`OpenClaw: ${error.message}`));
          return;
        }

        // Parse JSON output to extract the response text
        const parsed = OpenClawAgentResponseSchema.safeParse(
          (() => {
            try {
              return JSON.parse(stdout);
            } catch {
              return null;
            }
          })(),
        );
        if (!parsed.success) {
          // Not valid JSON or doesn't match schema — return raw stdout
          resolve(stdout.trim() || "No response from OpenClaw");
          return;
        }
        const data = parsed.data;
        if (data.status !== "ok") {
          reject(
            new Error(
              `OpenClaw: Agent returned status "${data.status}" — ${data.summary ?? "unknown error"}`,
            ),
          );
          return;
        }
        const text = data.result?.payloads
          ?.map((p) => p.text)
          .filter(Boolean)
          .join("\n");
        if (text) {
          resolve(text);
        } else {
          resolve(data.summary || stdout.trim() || "No response from OpenClaw");
        }
      },
    );
  });
}

/**
 * OpenClaw Agent Provider — connects to a local OpenClaw instance.
 *
 * OpenClaw's gateway uses WebSocket, not HTTP REST. This provider shells
 * out to `openclaw agent --message "..." --json` which handles the WS
 * protocol and returns structured JSON.
 *
 * The user enables OpenClaw in Settings → Integrations. The actual queries
 * go through the CLI which reads its own config from ~/.openclaw/.
 *
 * The installed OpenClaw is local, not connected to the public internet,
 * and has no tools or file access — it's just a chatbot.
 */
export class OpenClawAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "openclaw-agent",
    name: "OpenClaw Agent",
    description: "Local OpenClaw agent for enrichment and context",
    auth: { type: "api_key", configKey: "OPENCLAW_AUTH_TOKEN" },
  };

  private enabled: boolean;
  private gatewayUrl: string;
  private gatewayToken: string;
  private inFlight = new Map<string, AbortController>();

  constructor(cfg: OpenClawProviderConfig) {
    this.enabled = cfg.enabled;
    this.gatewayUrl = cfg.gatewayUrl ?? "";
    this.gatewayToken = cfg.gatewayToken ?? "";
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    const oc = config.providers?.["openclaw-agent"];
    if (oc) {
      if ("enabled" in oc) this.enabled = Boolean(oc.enabled);
      if ("gatewayUrl" in oc) this.gatewayUrl = String(oc.gatewayUrl ?? "");
      if ("gatewayToken" in oc) this.gatewayToken = String(oc.gatewayToken ?? "");
    }
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    if (!this.enabled && !isDemoMode()) {
      yield { type: "error", message: "OPENCLAW_NOT_CONFIGURED" };
      return { state: "failed" };
    }

    yield { type: "state", state: "running" };

    // Create our own controller so cancel() can abort the CLI process.
    // Also listen to the caller's signal so external cancellation works too.
    const controller = new AbortController();
    const sessionKey = buildOpenClawSessionKey(params.context, params.taskId);
    this.inFlight.set(params.taskId, controller);
    const onParentAbort = () => controller.abort();
    params.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      // Race a 30s slow-warning timer against the CLI call so the warning
      // is yielded while the CLI is still running (not after it finishes).
      const slowWarning = Symbol("slow");
      const cliPromise = this.queryOpenClaw(
        buildOpenClawPrompt(params.context, params.prompt),
        controller.signal,
        sessionKey,
      );
      const timerPromise = new Promise<typeof slowWarning>((resolve) => {
        const id = setTimeout(() => resolve(slowWarning), SLOW_WARNING_MS);
        // If CLI finishes first (success or failure), cancel the timer.
        // Use .then(fn, fn) instead of .finally() to avoid dangling unhandled rejections.
        cliPromise.then(
          () => clearTimeout(id),
          () => clearTimeout(id),
        );
      });

      let response: string;
      const first = await Promise.race([cliPromise, timerPromise]);
      if (first === slowWarning) {
        yield { type: "text_delta", text: "\n⏳ OpenClaw is taking longer than expected...\n" };
        response = await cliPromise;
      } else {
        response = first;
      }

      yield { type: "text_delta", text: response };
      yield { type: "done", summary: "OpenClaw query completed" };
      return { state: "completed", providerTaskId: sessionKey };
    } catch (err) {
      if (controller.signal.aborted || params.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled", providerTaskId: sessionKey };
      }
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: msg };
      return { state: "failed", providerTaskId: sessionKey };
    } finally {
      params.signal.removeEventListener("abort", onParentAbort);
      this.inFlight.delete(params.taskId);
    }
  }

  cancel(taskId: string): void {
    const controller = this.inFlight.get(taskId);
    if (controller) {
      controller.abort();
      this.inFlight.delete(taskId);
    }
  }

  async isAvailable(): Promise<boolean> {
    if (isDemoMode()) return true;
    return this.enabled;
  }

  asSubAgentTool(): SubAgentToolConfig | null {
    if (!this.enabled && !isDemoMode()) return null;

    return {
      name: "ask_openclaw",
      description:
        "Query your local OpenClaw agent for context about a person, company, or topic. OpenClaw is a local AI assistant — it draws on its own knowledge to answer. Use this when you need more information about an email sender or topic to write a better response.",
      systemPromptGuidance: `You have access to the ask_openclaw tool which queries a local OpenClaw agent. OpenClaw is a standalone AI chatbot running locally — it has no internet access or tools, so it answers from its own knowledge. Use it when:
- You need background on an email sender (role, company, recent activity)
- You want context about a company or organization mentioned in an email
- The user asks you to look something up or get more context
- You're drafting a reply and would benefit from knowing more about the recipient

Pass a natural language question as the 'query' parameter. Be specific about what you want to know. Note that OpenClaw's knowledge may not be current — it's useful for general context but treat specific claims as approximate.`,
      inputSchema: z.object({
        query: z.string().describe("The question to ask OpenClaw"),
        conversation_id: z
          .string()
          .optional()
          .describe("Not used by OpenClaw — included for interface compatibility"),
      }),
    };
  }

  // --- Private ---

  private async queryOpenClaw(
    query: string,
    signal: AbortSignal,
    sessionKey: string,
  ): Promise<string> {
    // Use canned responses only in demo mode when OpenClaw is NOT enabled.
    // When the user has explicitly enabled OpenClaw, always use the real CLI
    // even in demo mode — this allows testing the real integration with mock Gmail data.
    if (isDemoMode() && !this.enabled) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return getDemoResponse(query);
    }

    const env: Record<string, string> = {};
    if (this.gatewayUrl) env.OPENCLAW_GATEWAY_URL = this.gatewayUrl;
    if (this.gatewayToken) env.OPENCLAW_GATEWAY_TOKEN = this.gatewayToken;
    return execOpenClaw(query, signal, sessionKey, undefined, env);
  }
}
