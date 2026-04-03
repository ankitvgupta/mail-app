import { createMessage } from "./anthropic-service";
import { stripJsonFences } from "../../shared/strip-json-fences";
import {
  ARCHIVE_READY_JSON_FORMAT,
  ArchiveReadyResultSchema,
  DEFAULT_ARCHIVE_READY_PROMPT,
  type ArchiveReadyResult,
  type DashboardEmail,
} from "../../shared/types";
import { stripQuotedContent } from "./strip-quoted-content";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../../shared/prompt-safety";
import { createLogger } from "./logger";

const log = createLogger("archive-ready");

export class ArchiveReadyAnalyzer {
  private model: string;
  private customPrompt: string | null;

  constructor(model: string = "claude-sonnet-4-20250514", prompt?: string) {
    this.model = model;
    this.customPrompt = prompt && prompt !== DEFAULT_ARCHIVE_READY_PROMPT ? prompt : null;
  }

  async analyzeThread(
    threadEmails: DashboardEmail[],
    userEmail?: string,
  ): Promise<ArchiveReadyResult> {
    const threadContent = this.formatThreadForAnalysis(threadEmails, userEmail);

    // Always append JSON format suffix to ensure structured output
    const systemPrompt = this.customPrompt
      ? this.customPrompt + ARCHIVE_READY_JSON_FORMAT
      : DEFAULT_ARCHIVE_READY_PROMPT + ARCHIVE_READY_JSON_FORMAT;

    const response = await createMessage(
      {
        model: this.model,
        max_tokens: 256,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: threadContent,
          },
        ],
      },
      { caller: "archive-ready-analyzer" },
    );

    // Log cache performance
    const usage = response.usage as unknown as Record<string, number>;
    log.info(
      `[ArchiveReady] Usage: input=${usage.input_tokens}, output=${usage.output_tokens}, cache_read=${usage.cache_read_input_tokens || 0}, cache_create=${usage.cache_creation_input_tokens || 0}`,
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    try {
      const parsed = JSON.parse(stripJsonFences(textBlock.text));
      return ArchiveReadyResultSchema.parse(parsed);
    } catch (_error) {
      log.error({ responseText: textBlock.text }, "Failed to parse archive-ready response");
      return {
        archive_ready: false,
        reason: "Failed to parse analysis - keeping in inbox for safety",
      };
    }
  }

  private formatThreadForAnalysis(emails: DashboardEmail[], userEmail?: string): string {
    // Sort by date ascending (conversation order)
    const sorted = [...emails].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    // Only the last 1-2 emails matter for archive-ready determination —
    // earlier messages just add token noise without improving accuracy.
    const recentEmails = sorted.slice(-2);

    const parts: string[] = [];
    parts.push(`Number of messages in thread: ${sorted.length}`);
    if (userEmail) {
      parts.push(`User's email: ${userEmail}`);
    }
    parts.push("");

    parts.push(UNTRUSTED_DATA_INSTRUCTION);
    parts.push("");
    parts.push(wrapUntrustedEmail(`Thread subject: ${sorted[0]?.subject || "(no subject)"}`));
    parts.push("");

    for (const email of recentEmails) {
      const isFromUser = userEmail && this.isFromUser(email, userEmail);
      parts.push(`--- Message ${isFromUser ? "(FROM USER)" : "(RECEIVED)"} ---`);

      // Include analysis if available (trusted system-generated data, outside tags)
      if (email.analysis) {
        parts.push(
          `Analysis: ${email.analysis.needsReply ? "Needs reply" : "No reply needed"} - ${email.analysis.reason}`,
        );
      }
      if (email.draft) {
        parts.push(`Draft status: ${email.draft.status}`);
      }

      // Strip quoted content and truncate body
      let body = stripQuotedContent(email.snippet || email.body || "");
      const maxLen = 1500;
      if (body.length > maxLen) {
        body = body.substring(0, maxLen) + "\n[... truncated ...]";
      }
      parts.push(wrapUntrustedEmail(`From: ${email.from}\nTo: ${email.to}\nDate: ${email.date}\nBody: ${body}`));
      parts.push("");
    }

    return parts.join("\n");
  }

  private isFromUser(email: DashboardEmail, userEmail: string): boolean {
    if (email.labelIds?.includes("SENT")) return true;
    const fromLower = email.from.toLowerCase();
    const userLower = userEmail.toLowerCase();
    const match = fromLower.match(/<([^>]+)>/);
    const fromEmail = match ? match[1] : fromLower;
    return fromEmail.trim() === userLower.trim();
  }
}
