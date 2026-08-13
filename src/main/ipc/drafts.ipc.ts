import { ipcMain } from "electron";
import { createMessage } from "../services/llm-service";
import {
  getEmail,
  deleteDraft,
  deleteAgentTrace,
  clearInboxPendingDraftsAndTraces,
  getInboxPendingDraftsWithGmail,
  updateDraftAgentTaskId,
} from "../db";
import {
  saveDraftAndSync,
  deleteGmailDraftById,
  deleteGmailDraftsBatch,
} from "../services/gmail-draft-sync";
import { getConfig, getFeatureModelConfig, getBackgroundAgentProviderId } from "./settings.ipc";
import { buildMemoryContext } from "../services/memory-context";
import { prefetchService } from "../services/prefetch-service";
import { agentCoordinator } from "../agents/agent-coordinator";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../../shared/prompt-safety";
import type { IpcResponse } from "../../shared/types";
import { DEMO_INBOX_EMAILS } from "../demo/fake-inbox";
import { createLogger } from "../services/logger";

const log = createLogger("drafts-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

export function registerDraftsIpc(): void {
  // Save an edited draft
  ipcMain.handle(
    "drafts:save",
    async (
      _,
      {
        emailId,
        body,
        composeMode,
        to,
        cc,
        bcc,
      }: {
        emailId: string;
        body: string;
        composeMode?: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
      },
    ): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        log.info(`[DEMO] Saving draft for email ${emailId}`);
        return { success: true, data: undefined };
      }

      try {
        if (body) {
          saveDraftAndSync(emailId, body, "edited", cc, bcc, composeMode, to);
        } else {
          // Extract Gmail draft ID synchronously before deleting local record
          const email = getEmail(emailId);
          const gmailDraftId = email?.draft?.gmailDraftId;
          const accountId = email?.accountId || "default";
          deleteDraft(emailId);
          if (gmailDraftId) {
            deleteGmailDraftById(accountId, gmailDraftId).catch(() => {});
          }
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

  // Refine a draft based on critique
  ipcMain.handle(
    "drafts:refine",
    async (
      _,
      {
        emailId,
        currentDraft,
        critique,
      }: { emailId: string; currentDraft: string; critique: string },
    ): Promise<IpcResponse<string>> => {
      // In demo mode, return a simple refined version
      if (useFakeData) {
        const email = DEMO_INBOX_EMAILS.find((e) => e.id === emailId);
        if (!email) {
          return { success: false, error: "Email not found in demo data" };
        }

        // Simulate refinement — return draft unchanged in demo mode
        await new Promise((resolve) => setTimeout(resolve, 800));
        return { success: true, data: currentDraft };
      }

      try {
        const email = getEmail(emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }

        const _config = getConfig();

        // Include relevant memories so refinement doesn't contradict saved preferences
        const senderMatch = email.from.match(/<([^>]+)>/) ?? email.from.match(/([^\s<]+@[^\s>]+)/);
        const senderEmail = senderMatch ? senderMatch[1].toLowerCase() : "";
        const memoryContext = senderEmail
          ? buildMemoryContext(senderEmail, email.accountId || "default")
          : "";
        const memorySection = memoryContext ? `\n${memoryContext}\n---\n` : "";

        const refinementConfig = getFeatureModelConfig("refinement");
        const response = await createMessage(
          {
            model: refinementConfig.model,
            max_tokens: 1024,
            system: [{ type: "text", text: UNTRUSTED_DATA_INSTRUCTION }],
            messages: [
              {
                role: "user",
                content: `Refine this email draft based on the feedback provided.
${memorySection}
ORIGINAL EMAIL BEING REPLIED TO:
${wrapUntrustedEmail(`From: ${email.from}\nSubject: ${email.subject}\n---\n${email.body}`)}
---

CURRENT DRAFT:
${currentDraft}
---

FEEDBACK TO INCORPORATE:
${critique}
---

Output ONLY the refined draft text - no explanations, no preamble. Just the improved email body.

FORMATTING: Write plain text paragraphs separated by blank lines. Do NOT use HTML tags of any kind (<p>, <br>, <div>, <b>, <i>, <ul>, <ol>, etc.). For bold, wrap text in double asterisks like **bold text**. For italic, wrap text in single asterisks like *italic text*. For bullet lists, use lines starting with "- ". For numbered lists, use "1. ", "2. ", etc.`,
              },
            ],
          },
          {
            caller: "drafts-refine",
            emailId,
            accountId: email.accountId,
            provider: refinementConfig.provider,
          },
        );

        const textBlock = response.content.find((block) => block.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw new Error("No text response from Claude");
        }

        const refinedDraft = textBlock.text.trim();

        // Save refined draft and sync to Gmail
        saveDraftAndSync(emailId, refinedDraft, "edited");

        return { success: true, data: refinedDraft };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Rerun agent draft for a single email
  ipcMain.handle(
    "drafts:rerun-agent",
    async (
      _,
      { emailId }: { emailId: string },
    ): Promise<IpcResponse<{ taskId: string; providerIds: string[] }>> => {
      if (useFakeData) {
        return { success: false, error: "Agent drafting is not available in demo/test mode" };
      }
      try {
        // Get existing draft's agent task ID so we can clean up old trace
        const email = getEmail(emailId);
        if (!email) {
          return { success: false, error: "Email not found" };
        }

        const oldAgentTaskId = email.draft?.agentTaskId;
        // Also check for in-flight agents that haven't saved a draft yet
        const activeTaskId = prefetchService.getActiveAgentTaskId(emailId);

        // Cancel any in-flight agent for this email before starting a new one
        if (oldAgentTaskId) {
          agentCoordinator.cancel(oldAgentTaskId);
        }
        if (activeTaskId && activeTaskId !== oldAgentTaskId) {
          agentCoordinator.cancel(activeTaskId);
        }

        // Extract Gmail draft ID synchronously, then delete local record, then clean up Gmail
        const gmailDraftId = email.draft?.gmailDraftId;
        const emailAccountId = email.accountId || "default";
        deleteDraft(emailId);
        if (gmailDraftId) {
          deleteGmailDraftById(emailAccountId, gmailDraftId).catch(() => {});
        }
        if (oldAgentTaskId) {
          deleteAgentTrace(oldAgentTaskId);
        }
        if (activeTaskId && activeTaskId !== oldAgentTaskId) {
          deleteAgentTrace(activeTaskId);
        }

        // Allow re-processing
        prefetchService.removeFromProcessedDrafts(emailId);

        // Build context and launch agent
        const draftInfo = prefetchService.buildAgentDraftContext(emailId);
        if (!draftInfo) {
          return { success: false, error: "Could not build draft context" };
        }

        const { prompt, context, taskId } = draftInfo;

        // Track in prefetch service BEFORE launching so a concurrent rerun
        // can find and cancel this agent via getActiveAgentTaskId
        prefetchService.addToProcessedDrafts(emailId);
        prefetchService.trackManualAgentDraft(emailId, taskId);

        // Launch agent — events auto-stream to renderer via agent:event IPC
        const providerId = getBackgroundAgentProviderId();
        await agentCoordinator.runAgent(taskId, [providerId], prompt, context);

        // Link draft to agent task when it completes (async, don't block response)
        agentCoordinator
          .waitForCompletion(taskId)
          .then(() => {
            try {
              updateDraftAgentTaskId(emailId, taskId);
            } catch (err) {
              log.warn(
                { err: err },
                `[Drafts] Failed to link agent task ${taskId} to draft for ${emailId}`,
              );
            }
            prefetchService.markAgentDraftDone(emailId, "completed");
          })
          .catch((err) => {
            log.warn({ err: err }, `[Drafts] Agent task ${taskId} did not complete successfully`);
            prefetchService.markAgentDraftDone(emailId, "failed");
          });

        return { success: true, data: { taskId, providerIds: [providerId] } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Rerun all agent drafts (bulk — clears pending drafts and re-triggers pipeline)
  ipcMain.handle(
    "drafts:rerun-all-agents",
    async (): Promise<IpcResponse<{ clearedCount: number }>> => {
      if (useFakeData) {
        return { success: false, error: "Agent drafting is not available in demo/test mode" };
      }
      try {
        // Cancel all in-flight agents before clearing state to prevent them from
        // saving drafts that would overwrite newly-queued agents' results
        agentCoordinator.cancelByPrefix("auto-draft-");

        // Read Gmail draft IDs synchronously before clearing local records
        const draftsWithGmail = getInboxPendingDraftsWithGmail();
        deleteGmailDraftsBatch(draftsWithGmail).catch(() => {});

        const { draftsCleared: clearedCount, tracesCleared } = clearInboxPendingDraftsAndTraces();

        log.info(
          `[Drafts] Rerun all: cleared ${clearedCount} pending drafts, ${tracesCleared} agent traces`,
        );

        // Reset prefetch tracking so emails can be re-queued.
        // Use clearForRerun() so the next processAllPending() does NOT re-seed
        // processedDrafts from DB — the seed would re-block all the just-cleared drafts.
        prefetchService.clearForRerun();

        // Re-trigger the full prefetch pipeline (fire-and-forget, but catch errors)
        prefetchService.processAllPending().catch((err) => {
          log.error({ err: err }, "[Drafts] Error re-processing after rerun-all");
        });

        return { success: true, data: { clearedCount } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
