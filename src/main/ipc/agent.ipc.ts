import { ipcMain } from "electron";
import { execFile, execFileSync } from "child_process";
import { agentCoordinator } from "../agents/agent-coordinator";
import { authenticateProvider } from "../agents/private-providers-main";
import { getConfig, getModelIdForFeature } from "./settings.ipc";
import { resolveAgentOllamaConfig } from "../../shared/types";
import { getAccounts, getAgentTrace, getEmail, getLocalDraft } from "../db";
import { canAnyAgentProviderUseKnowledgeContext, type AgentContext } from "../agents/types";
import type { ScopedAgentEvent } from "../agents/types";
import type { IpcResponse } from "../../shared/types";
import { buildGBrainAgentQuery, fetchGBrainAgentContext } from "../services/gbrain-service";

const pendingAgentRuns = new Map<string, AbortController>();

/** Check if `claude` CLI is available on PATH. Cached after first check. */
let claudeCliAvailable: boolean | null = null;
function isClaudeCliAvailable(): boolean {
  if (claudeCliAvailable !== null) return claudeCliAvailable;
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execFileSync("claude", ["--version"], {
      timeout: 5000,
      stdio: "ignore",
      env,
    });
    claudeCliAvailable = true;
  } catch {
    claudeCliAvailable = false;
  }
  return claudeCliAvailable;
}

export function registerAgentIpc(): void {
  ipcMain.handle(
    "agent:run",
    async (
      _,
      {
        taskId,
        providerIds,
        prompt,
        context,
      }: {
        taskId: string;
        providerIds: string[];
        prompt: string;
        context: AgentContext;
      },
    ): Promise<IpcResponse<{ taskId: string }>> => {
      const pendingRun = new AbortController();
      pendingAgentRuns.get(taskId)?.abort();
      pendingAgentRuns.set(taskId, pendingRun);
      try {
        // Interactive agent tasks use the agentChat model (defaults to opus).
        // Pick the model based on the worker's actual destination — using
        // resolveAgentOllamaConfig which requires BOTH agentChat AND
        // agentDrafter to be ollama-cloud before routing the worker there.
        // If only agentChat is set to ollama-cloud (mismatched config), the
        // worker is still on Anthropic and would 400 with invalid_model
        // unless we send an Anthropic name.
        const config = getConfig();
        const ollamaConfig = resolveAgentOllamaConfig(config);
        const modelOverride = ollamaConfig?.model ?? getModelIdForFeature("agentChat");
        const account = getAccounts().find((candidate) => candidate.id === context.accountId);
        if (!account) {
          return { success: false, error: "The selected email account is not connected." };
        }
        if (context.currentEmailId && context.currentDraftId) {
          return {
            success: false,
            error: "Agent context cannot target an email and draft together.",
          };
        }

        const trustedContext: AgentContext = {
          accountId: account.id,
          userEmail: account.email,
          userName: account.displayName,
          selectedEmailIds: context.selectedEmailIds,
          providerConversationIds: context.providerConversationIds,
          conversationHistory: context.conversationHistory,
          memoryContext: context.memoryContext,
          knowledgeQuery: context.knowledgeQuery,
        };

        if (context.currentEmailId) {
          const email = getEmail(context.currentEmailId);
          if (!email) return { success: false, error: "The selected email no longer exists." };
          const ownerAccountId = email.accountId || "default";
          if (ownerAccountId !== account.id) {
            return { success: false, error: "The selected account does not own this email." };
          }
          trustedContext.currentEmailId = email.id;
          trustedContext.currentThreadId = email.threadId;
          trustedContext.emailSubject = email.subject;
          trustedContext.emailFrom = email.from;
          trustedContext.emailTo = email.to;
          trustedContext.emailBody = email.body;
        } else if (context.currentDraftId) {
          const draft = getLocalDraft(context.currentDraftId);
          if (!draft) return { success: false, error: "The selected draft no longer exists." };
          if (draft.accountId !== account.id) {
            return { success: false, error: "The selected account does not own this draft." };
          }
          trustedContext.currentDraftId = draft.id;
          trustedContext.currentThreadId = draft.threadId;
          trustedContext.emailSubject = draft.subject;
          trustedContext.emailTo = draft.to.join(", ");
          trustedContext.emailBody = draft.bodyText || draft.bodyHtml;
        }

        if (trustedContext.selectedEmailIds) {
          const selectionIsOwned = trustedContext.selectedEmailIds.every((emailId) => {
            const selected = getEmail(emailId);
            return selected && (selected.accountId || "default") === account.id;
          });
          if (!selectionIsOwned) {
            return { success: false, error: "The selected emails span multiple accounts." };
          }
        }

        const knowledgeContext = canAnyAgentProviderUseKnowledgeContext(providerIds)
          ? await fetchGBrainAgentContext(
              config.gbrain,
              buildGBrainAgentQuery(prompt, trustedContext),
              trustedContext.accountId,
              pendingRun.signal,
            )
          : "";
        if (pendingRun.signal.aborted) return { success: true, data: { taskId } };
        const enrichedContext = knowledgeContext
          ? { ...trustedContext, knowledgeContext }
          : trustedContext;
        await agentCoordinator.runAgent(
          taskId,
          providerIds,
          prompt,
          enrichedContext,
          modelOverride,
          pendingRun.signal,
        );
        return { success: true, data: { taskId } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      } finally {
        if (pendingAgentRuns.get(taskId) === pendingRun) {
          pendingAgentRuns.delete(taskId);
        }
      }
    },
  );

  ipcMain.handle(
    "agent:cancel",
    async (_, { taskId }: { taskId: string }): Promise<IpcResponse<void>> => {
      try {
        pendingAgentRuns.get(taskId)?.abort();
        agentCoordinator.cancel(taskId);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle(
    "agent:confirm",
    async (
      _,
      { toolCallId, approved }: { toolCallId: string; approved: boolean },
    ): Promise<IpcResponse<void>> => {
      try {
        agentCoordinator.resolveConfirmation(toolCallId, approved);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  ipcMain.handle("agent:providers", async (): Promise<IpcResponse<void>> => {
    try {
      agentCoordinator.listProviders();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(
    "agent:authenticate",
    async (
      _,
      { providerId }: { providerId: string },
    ): Promise<IpcResponse<{ success: boolean }>> => {
      try {
        const success = await authenticateProvider(providerId);
        return { success: true, data: { success } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Check if Claude CLI is available and whether it has stored OAuth credentials
  ipcMain.handle(
    "agent:claude-auth-status",
    async (): Promise<
      IpcResponse<{
        cliAvailable: boolean;
        authenticated: boolean;
        email?: string;
        authMethod?: string;
      }>
    > => {
      try {
        if (!isClaudeCliAvailable()) {
          return { success: true, data: { cliAvailable: false, authenticated: false } };
        }
        const result = await new Promise<{
          cliAvailable: boolean;
          authenticated: boolean;
          email?: string;
          authMethod?: string;
        }>((resolve) => {
          // Strip CLAUDECODE env var to avoid "nested session" error
          const env = { ...process.env };
          delete env.CLAUDECODE;
          execFile(
            "claude",
            ["auth", "status", "--json"],
            { env, timeout: 10000 },
            (error, stdout) => {
              if (error) {
                resolve({ cliAvailable: true, authenticated: false });
                return;
              }
              try {
                const parsed = JSON.parse(stdout.trim());
                resolve({
                  cliAvailable: true,
                  authenticated: Boolean(parsed.loggedIn),
                  email: parsed.email,
                  authMethod: parsed.authMethod,
                });
              } catch {
                resolve({ cliAvailable: true, authenticated: false });
              }
            },
          );
        });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Load persisted agent trace events from DB (for viewing auto-draft traces after restart)
  ipcMain.handle(
    "agent:get-trace",
    async (
      _,
      { taskId }: { taskId: string },
    ): Promise<IpcResponse<{ events: ScopedAgentEvent[] }>> => {
      try {
        const mirror = getAgentTrace(taskId);
        if (!mirror) {
          return { success: true, data: { events: [] } };
        }
        const events = JSON.parse(mirror.messagesJson) as ScopedAgentEvent[];

        // Truncate large string values before sending over IPC.
        // Agent traces can be 100MB+ when tool inputs/outputs contain full email
        // bodies. IPC serialization of that data blocks both processes.
        const MAX_STR = 5_000;
        const truncateValue = (val: unknown): unknown => {
          if (typeof val === "string") {
            return val.length > MAX_STR ? val.slice(0, MAX_STR) + "\n…[truncated]" : val;
          }
          if (Array.isArray(val)) return val.map(truncateValue);
          if (val && typeof val === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(val)) {
              out[k] = truncateValue(v);
            }
            return out;
          }
          return val;
        };

        const trimmedEvents = events.map((evt) => {
          if (evt.type === "tool_call_start" && evt.input) {
            return { ...evt, input: truncateValue(evt.input) };
          }
          if (evt.type === "tool_call_end" && evt.result !== undefined) {
            return { ...evt, result: truncateValue(evt.result) };
          }
          return evt;
        });

        return { success: true, data: { events: trimmedEvents } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Launch Claude Code OAuth login flow
  ipcMain.handle(
    "agent:claude-login",
    async (): Promise<IpcResponse<{ success: boolean; error?: string }>> => {
      try {
        const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const env = { ...process.env };
          delete env.CLAUDECODE;
          // `claude auth login` opens a browser for OAuth — wait for it to complete
          const child = execFile(
            "claude",
            ["auth", "login"],
            { env, timeout: 120000 },
            (error, _stdout, stderr) => {
              if (error) {
                resolve({ success: false, error: stderr?.trim() || error.message });
              } else {
                resolve({ success: true });
              }
            },
          );
          child.stdin?.end();
        });
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
