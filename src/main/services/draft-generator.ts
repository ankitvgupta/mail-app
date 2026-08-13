import { createMessage } from "./llm-service";
import type { GmailClient } from "./gmail-client";
import { CalendaringAgent } from "./calendaring-agent";
import { quoteDisplayName } from "../utils/address-formatting";
import {
  DEFAULT_DRAFT_PROMPT,
  DRAFT_FORMAT_SUFFIX,
  type AnalysisResult,
  type DraftResult,
  type Email,
  type EAConfig,
  type GeneratedDraftResponse,
  type LlmProvider,
} from "../../shared/types";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../../shared/prompt-safety";
import { createLogger } from "./logger";

const log = createLogger("draft-generator");

// Lazy-imported to avoid pulling in ../extensions/enrichment-store → ../db
// → electron at module load. The eval / unit runner imports DraftGenerator
// outside Electron context; touching the enrichment cache before sender
// lookup is actually invoked would crash with
// `'electron' does not provide an export named 'BrowserWindow'`.
// Mirrors the pattern in email-analyzer.ts.
import type * as EnrichmentStoreModule from "../extensions/enrichment-store";
type GetEnrichmentBySenderFn = typeof EnrichmentStoreModule.getEnrichmentBySender;
let _getEnrichmentBySender: GetEnrichmentBySenderFn | null = null;
async function getEnrichmentBySenderLazy(
  ...args: Parameters<GetEnrichmentBySenderFn>
): Promise<ReturnType<GetEnrichmentBySenderFn>> {
  if (!_getEnrichmentBySender) {
    const mod = await import("../extensions/enrichment-store");
    _getEnrichmentBySender = mod.getEnrichmentBySender;
  }
  return _getEnrichmentBySender(...args);
}

/**
 * Extract reply-all CC recipients from an email's To/CC fields,
 * excluding the sender and the user's own email address.
 */
function extractReplyAllCc(
  email: { from: string; to: string; cc?: string },
  userEmail: string,
): string[] {
  const parseAddresses = (field: string): string[] =>
    (field.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map((e) => e.toLowerCase());

  const senderEmail = parseAddresses(email.from)[0];
  const exclude = new Set([senderEmail, userEmail.toLowerCase()].filter(Boolean));

  const seen = new Set<string>();
  return [...parseAddresses(email.to), ...(email.cc ? parseAddresses(email.cc) : [])].filter(
    (addr) => {
      const dominated = exclude.has(addr) || seen.has(addr);
      seen.add(addr);
      return !dominated;
    },
  );
}

export class DraftGenerator {
  private model: string;
  private calendaringModel: string;
  private prompt: string;
  private provider?: LlmProvider;
  private calendaringProvider?: LlmProvider;

  constructor(
    model: string = "claude-sonnet-4-20250514",
    prompt: string = DEFAULT_DRAFT_PROMPT,
    calendaringModel?: string,
    provider?: LlmProvider,
    calendaringProvider?: LlmProvider,
  ) {
    this.model = model;
    this.calendaringModel = calendaringModel ?? model;
    // Always append format suffix so the user can't accidentally remove it
    this.prompt = prompt + DRAFT_FORMAT_SUFFIX;
    this.provider = provider;
    this.calendaringProvider = calendaringProvider;
  }

  async generateDraft(
    email: Email,
    analysis: AnalysisResult,
    eaConfig?: EAConfig,
    options?: { enableSenderLookup?: boolean; userEmail?: string },
  ): Promise<GeneratedDraftResponse> {
    const cc: string[] = [];

    // Default to reply-all: include all original To/CC recipients except sender and user
    if (options?.userEmail) {
      cc.push(...extractReplyAllCc(email, options.userEmail));
    }
    let calendaringContext = "";
    let calendaringResult;
    let senderContext = "";

    // Look up sender information from extension cache if enabled (enabled by default)
    const enableSenderLookup = options?.enableSenderLookup ?? true;
    if (enableSenderLookup) {
      const senderEmail = this.extractSenderEmail(email.from);
      const cached = await getEnrichmentBySenderLazy(senderEmail, "web-search");
      if (cached?.data) {
        const profile = cached.data as { summary: string; name: string; email: string };
        if (profile.summary) {
          senderContext = `
SENDER CONTEXT (from web search):
${profile.summary}
---`;
          log.info(`[DraftGenerator] Using cached sender context for ${senderEmail}`);
        }
      }
    }

    // Check for scheduling if EA is enabled
    if (eaConfig?.enabled && eaConfig.email) {
      const calAgent = new CalendaringAgent(
        this.calendaringModel,
        undefined,
        this.calendaringProvider,
      );
      calendaringResult = await calAgent.analyze(email);

      if (calendaringResult.hasSchedulingContext && calendaringResult.action === "defer_to_ea") {
        // Format EA as "Name <email>" if name is available, otherwise just "email"
        if (eaConfig.name) {
          cc.push(`${quoteDisplayName(eaConfig.name)} <${eaConfig.email}>`);
        } else {
          cc.push(eaConfig.email);
        }
        const deferralLanguage = calAgent.generateEADeferralLanguage(eaConfig);
        calendaringContext = `
IMPORTANT SCHEDULING INSTRUCTION:
This email involves scheduling. INCLUDE this text verbatim in your response: "${deferralLanguage}"
Do NOT propose specific times yourself - defer to the assistant.`;
        calendaringResult.eaDeferralLanguage = deferralLanguage;
      }
    }

    const response = await createMessage(
      {
        model: this.model,
        max_tokens: 1024,
        system: [{ type: "text", text: `${this.prompt}\n\n${UNTRUSTED_DATA_INSTRUCTION}` }],
        messages: [
          {
            role: "user",
            content: `${senderContext}
${calendaringContext}
---
ANALYSIS (for context):
Reason for reply: ${analysis.reason}

---
ORIGINAL EMAIL:

${wrapUntrustedEmail(`From: ${email.from}\nTo: ${email.to}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.body}`)}`,
          },
        ],
      },
      { caller: "draft-generator", emailId: email.id, provider: this.provider },
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return {
      body: textBlock.text.trim(),
      cc: cc.length > 0 ? cc : undefined,
      calendaringResult,
    };
  }

  async composeNewEmail(
    to: string[],
    subject: string,
    instructions: string,
    options?: { enableSenderLookup?: boolean },
  ): Promise<GeneratedDraftResponse> {
    let recipientContext = "";

    // Look up recipient information from extension cache
    const enableSenderLookup = options?.enableSenderLookup ?? true;
    if (enableSenderLookup) {
      for (const recipient of to) {
        const recipientEmail = this.extractSenderEmail(recipient);
        const cached = await getEnrichmentBySenderLazy(recipientEmail, "web-search");
        if (cached?.data) {
          const profile = cached.data as { summary: string; name: string; email: string };
          if (profile.summary) {
            recipientContext += `
RECIPIENT CONTEXT (${recipient}, from web search):
${profile.summary}
---`;
            log.info(`[DraftGenerator] Using cached recipient context for ${recipientEmail}`);
          }
        }
      }
    }

    const response = await createMessage(
      {
        model: this.model,
        max_tokens: 1024,
        system: [{ type: "text", text: `${this.prompt}\n\n${UNTRUSTED_DATA_INSTRUCTION}` }],
        messages: [
          {
            role: "user",
            content: `${recipientContext}
---
Compose a new email (not a reply to an existing thread).

To: ${to.join(", ")}
Subject: ${subject}

INSTRUCTIONS:
${instructions}`,
          },
        ],
      },
      { caller: "draft-generator-compose", provider: this.provider },
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return { body: textBlock.text.trim() };
  }

  async generateForward(
    email: Email,
    instructions: string,
    options?: { enableSenderLookup?: boolean },
  ): Promise<GeneratedDraftResponse> {
    let recipientContext = "";

    // Look up original sender info from extension cache
    const enableSenderLookup = options?.enableSenderLookup ?? true;
    if (enableSenderLookup) {
      const senderEmail = this.extractSenderEmail(email.from);
      const cached = await getEnrichmentBySenderLazy(senderEmail, "web-search");
      if (cached?.data) {
        const profile = cached.data as { summary: string; name: string; email: string };
        if (profile.summary) {
          recipientContext = `
ORIGINAL SENDER CONTEXT (${email.from}, from web search):
${profile.summary}
---`;
          log.info(`[DraftGenerator] Using cached sender context for forward from ${senderEmail}`);
        }
      }
    }

    const lowerSubject = email.subject.toLowerCase();
    const subject =
      lowerSubject.startsWith("fwd:") || lowerSubject.startsWith("fw:")
        ? email.subject
        : `Fwd: ${email.subject}`;

    const response = await createMessage(
      {
        model: this.model,
        max_tokens: 1024,
        system: [{ type: "text", text: `${this.prompt}\n\n${UNTRUSTED_DATA_INSTRUCTION}` }],
        messages: [
          {
            role: "user",
            content: `${recipientContext}
---
Write the text for a forwarded email. The original email will be automatically appended as quoted content, so do not reproduce it.

INSTRUCTIONS:
${instructions}

---
ORIGINAL EMAIL BEING FORWARDED:

${wrapUntrustedEmail(`From: ${email.from}\nTo: ${email.to}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.body}`)}`,
          },
        ],
      },
      { caller: "draft-generator-forward", emailId: email.id, provider: this.provider },
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return { body: textBlock.text.trim(), subject };
  }

  async createDraft(
    gmailClient: GmailClient,
    email: Email,
    draftBody: string,
    dryRun: boolean = false,
  ): Promise<DraftResult> {
    // Extract reply-to address (or use from address)
    const replyTo = this.extractReplyAddress(email.from);

    // Format subject with Re: if not already present
    const subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;

    if (dryRun) {
      log.info("\n[DRY RUN] Would create draft:");
      log.info(`  To: ${replyTo}`);
      log.info(`  Subject: ${subject}`);
      log.info(`  Thread: ${email.threadId}`);
      log.info(
        `  Body:\n${draftBody
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")}`,
      );

      return {
        emailId: email.id,
        threadId: email.threadId,
        subject,
        draftBody,
        created: false,
      };
    }

    try {
      const result = await gmailClient.createDraft({
        to: replyTo,
        subject,
        body: draftBody,
        threadId: email.threadId,
      });

      return {
        emailId: email.id,
        threadId: email.threadId,
        subject,
        draftBody,
        draftId: result?.id,
        created: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        emailId: email.id,
        threadId: email.threadId,
        subject,
        draftBody,
        created: false,
        error: errorMessage,
      };
    }
  }

  private extractReplyAddress(from: string): string {
    // Handle formats like "Name <email@example.com>" or just "email@example.com"
    const match = from.match(/<([^>]+)>/);
    return match ? match[1] : from;
  }

  private extractSenderEmail(from: string): string {
    const match = from.match(/<([^>]+)>/);
    return (match ? match[1] : from).toLowerCase();
  }
}
