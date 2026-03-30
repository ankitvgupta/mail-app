import { z } from "zod";
import { execFile } from "node:child_process";
import type {
  AgentFrameworkConfig,
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  SubAgentToolConfig,
} from "../../types";
import type { ClocloProviderConfig } from "./types";
import { ClocloResponseSchema } from "./types";

const TIMEOUT_MS = 300_000;
const SLOW_WARNING_MS = 30_000;

/** Flags that must not be overridden by user-supplied extraFlags. */
const RESERVED_FLAGS = new Set(["-p", "--print", "--json", "-m", "--model"]);

/**
 * Execute `cloclo` CLI and return the response text.
 * Cloclo outputs structured JSON via `--json` flag.
 */
function execCloclo(
  message: string,
  signal: AbortSignal,
  model?: string,
  extraFlags?: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile>;
    const onAbort = () => {
      child?.kill("SIGTERM");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const args = ["-p", message, "--json"];
    if (model) args.push("-m", model);
    if (extraFlags) {
      const safe = extraFlags.filter((f) => !RESERVED_FLAGS.has(f.split("=")[0]));
      args.push(...safe);
    }

    child = execFile(
      "cloclo",
      args,
      { timeout: TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        signal.removeEventListener("abort", onAbort);

        if (signal.aborted) {
          reject(new Error("Request cancelled"));
          return;
        }
        if (error) {
          const combined = (stderr || "") + (stdout || "");
          if (combined.includes("No API key") || combined.includes("Auth failure")) {
            reject(new Error("Cloclo: No API key configured — set ANTHROPIC_API_KEY or run `cloclo --login`"));
            return;
          }
          if (error.killed || combined.includes("ETIMEDOUT")) {
            reject(new Error("Cloclo: Request timed out after 5m"));
            return;
          }
          reject(new Error(`Cloclo: ${error.message}`));
          return;
        }

        const parsed = ClocloResponseSchema.safeParse(
          (() => { try { return JSON.parse(stdout); } catch { return null; } })(),
        );
        if (!parsed.success) {
          resolve(stdout.trim() || "No response from Cloclo");
          return;
        }
        resolve(parsed.data.content);
      },
    );
  });
}

/**
 * Cloclo Agent Provider — connects to a local Cloclo instance.
 *
 * Cloclo is an open-source, provider-agnostic CLI for AI agents.
 * It supports 13 LLM providers (Anthropic, OpenAI, Gemini, DeepSeek,
 * Mistral, Groq, Ollama, LM Studio, etc.) and comes with built-in
 * tools for file processing (PDF, DOCX, XLSX), browser automation,
 * code execution, and more.
 *
 * Unlike OpenClaw (which is a chatbot with no tools), Cloclo can
 * actually process email attachments, run code, browse the web,
 * and execute multi-step workflows — making it useful for tasks
 * like invoice processing, data extraction, and research.
 *
 * Install: npm install -g cloclo
 * Repo: https://github.com/SeifBenayed/claude-code-sdk
 */
export class ClocloAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "cloclo-agent",
    name: "Cloclo Agent",
    description: "Provider-agnostic AI agent with built-in tools (PDF, XLSX, browser, code execution)",
    auth: { type: "none" },
  };

  private enabled: boolean;
  private model: string | undefined;
  private extraFlags: string[];
  private inFlight = new Map<string, AbortController>();

  constructor(cfg: ClocloProviderConfig) {
    this.enabled = cfg.enabled;
    this.model = cfg.model;
    this.extraFlags = cfg.extraFlags ?? [];
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    const cc = config.providers?.["cloclo-agent"];
    if (cc) {
      if ("enabled" in cc) this.enabled = Boolean(cc.enabled);
      if ("model" in cc) this.model = cc.model;
      if ("extraFlags" in cc) this.extraFlags = Array.isArray(cc.extraFlags) ? cc.extraFlags : [];
    }
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    if (!this.enabled) {
      yield { type: "error", message: "CLOCLO_NOT_CONFIGURED" };
      return { state: "failed" };
    }

    yield { type: "state", state: "running" };

    const controller = new AbortController();
    this.inFlight.set(params.taskId, controller);
    const onParentAbort = () => controller.abort();
    params.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const slowWarning = Symbol("slow");
      const cliPromise = execCloclo(
        params.prompt,
        controller.signal,
        this.model,
        this.extraFlags,
      );
      const timerPromise = new Promise<typeof slowWarning>((resolve) => {
        const id = setTimeout(() => resolve(slowWarning), SLOW_WARNING_MS);
        cliPromise.then(() => clearTimeout(id), () => clearTimeout(id));
      });

      let response: string;
      const first = await Promise.race([cliPromise, timerPromise]);
      if (first === slowWarning) {
        yield { type: "text_delta", text: "\n⏳ Cloclo is processing...\n" };
        response = await cliPromise;
      } else {
        response = first;
      }

      yield { type: "text_delta", text: response };
      yield { type: "done", summary: "Cloclo query completed" };
      return { state: "completed" };
    } catch (err) {
      if (controller.signal.aborted || params.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: msg };
      return { state: "failed" };
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
    return this.enabled;
  }

  asSubAgentTool(): SubAgentToolConfig | null {
    if (!this.enabled) return null;

    return {
      name: "ask_cloclo",
      description:
        "Query a local Cloclo agent for tasks that require tools — processing attachments (PDF, XLSX, DOCX), running code, browsing the web, or executing multi-step workflows. Cloclo is provider-agnostic and can use any LLM backend.",
      systemPromptGuidance: `You have access to the ask_cloclo tool which queries a local Cloclo agent. Cloclo is a provider-agnostic CLI with built-in tools for file processing, code execution, and web browsing. Use it when:
- An email has attachments that need processing (invoices, spreadsheets, documents)
- You need to run code or scripts to answer a question
- You need to browse a URL mentioned in an email for context
- A task requires multiple steps (extract data from PDF, compute totals, draft response)
- You want to use a different LLM provider than Claude for a specific sub-task

Pass a natural language instruction as the 'query' parameter. Be specific about what you want done and what output you expect.`,
      inputSchema: z.object({
        query: z.string().describe("The task or question for Cloclo to handle"),
        conversation_id: z
          .string()
          .optional()
          .describe("Not used by Cloclo — included for interface compatibility"),
      }),
    };
  }
}
