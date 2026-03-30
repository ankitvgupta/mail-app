import Anthropic from "@anthropic-ai/sdk";
import { AnalysisResultSchema, ANALYSIS_JSON_FORMAT, DEFAULT_ANALYSIS_PROMPT, type AnalysisResult, type Email } from "../../shared/types";
import { stripQuotedContent } from "./strip-quoted-content";
import { stripJsonFences } from "../../shared/strip-json-fences";
// Lazy-imported to avoid pulling in ../db → electron at module load time,
// which breaks unit tests running under plain Node (not Electron).
let _buildAnalysisMemoryContext: typeof import("./memory-context").buildAnalysisMemoryContext | null = null;
async function getBuildAnalysisMemoryContext() {
  if (!_buildAnalysisMemoryContext) {
    const mod = await import("./memory-context");
    _buildAnalysisMemoryContext = mod.buildAnalysisMemoryContext;
  }
  return _buildAnalysisMemoryContext;
}

// Extended system prompt with examples to enable prompt caching (requires 1024+ tokens)
// This prompt is ~1846 tokens which enables caching (minimum is 1024)
const ANALYSIS_SYSTEM_PROMPT = `You are an email triage assistant. Your job is to analyze emails and determine if they require a reply from the user.

The user's email address may be provided. If given, use it to understand the user's role in the conversation:
- If the "From" address matches the user's email, the user SENT this email. It almost never needs a reply from the user.
- If the user asked a question or made a request and someone replied with an answer, that does NOT need a reply unless the answer explicitly asks a follow-up question or requests action from the user.
- Focus on whether someone is asking something OF the user, not whether someone is responding TO the user's question.

INSTRUCTIONS:
Analyze the email and decide if it requires a reply. Respond with ONLY valid JSON (no markdown, no code blocks).

OUTPUT FORMAT:
{
  "needs_reply": true or false,
  "reason": "brief explanation",
  "priority": "high" or "medium" or "low" (only include if needs_reply is true)
}

SKIP REPLIES FOR:
- Newsletters, marketing emails, promotions, and advertising
- Automated notifications (GitHub, CI/CD, build status, receipts, shipping updates, alerts)
- Calendar invites and event notifications (handled by calendar app)
- CC'd emails where the user is not the primary recipient
- FYI-only messages with no question or action required
- Transactional emails (order confirmations, password resets, subscription confirmations)
- Social media notifications (LinkedIn, Twitter, Facebook, etc.)
- Mailing list digests and group announcements
- Read receipts and delivery confirmations
- Out-of-office auto-replies
- Spam or suspicious emails
- Replies that simply answer a question the user previously asked, without requesting further action

DRAFT REPLIES FOR:
- Direct questions addressed to the user
- Requests requiring the user's response or decision
- Meeting coordination needing the user's input
- Business or personal emails expecting a reply
- Action items assigned to the user
- Follow-ups on previous conversations
- Introductions that warrant a response

PRIORITY GUIDELINES:
- high: Urgent requests, time-sensitive matters, important business decisions, requests from executives/VIPs
- medium: Normal business correspondence, reasonable deadlines, standard requests
- low: Non-urgent inquiries, FYI with optional response, social/networking emails

EXAMPLES:

Example 1 - Newsletter (no reply needed):
Email Subject: "Weekly Tech Digest: Top 10 AI Stories This Week"
Email Body: "Welcome to your weekly tech newsletter! This week in AI: 1. OpenAI announces new model capabilities 2. Google releases Gemini updates 3. Microsoft expands Copilot features..."
Output: {"needs_reply": false, "reason": "Newsletter/marketing content - automated digest"}

Example 2 - Direct question (reply needed):
Email Subject: "Q3 Budget Proposal Review"
Email Body: "Hi, I've attached the Q3 budget proposal for your review. Could you please take a look at sections 3 and 4 specifically, as they relate to your department's allocations? I need your feedback by Friday so we can finalize before the board meeting next week. Let me know if you have any questions or concerns."
Output: {"needs_reply": true, "reason": "Direct request for document review with specific deadline", "priority": "medium"}

Example 3 - GitHub notification (no reply needed):
Email Subject: "[company/repo] Pull request #123: Fix authentication bug was merged"
Email Body: "Merged #123 into main. Fix authentication bug - Resolved race condition in OAuth flow - Added retry logic for token refresh - Updated tests for edge cases. View on GitHub..."
Output: {"needs_reply": false, "reason": "Automated GitHub notification for merged PR"}

Example 4 - Meeting request (reply needed):
Email Subject: "Sync on project timeline?"
Email Body: "Hey! I was reviewing our project roadmap and noticed we're a bit behind on the API integration milestone. Would you be available for a quick 30-min call tomorrow or Wednesday to discuss? I want to make sure we're aligned on priorities and can adjust timelines if needed. Let me know what works for you!"
Output: {"needs_reply": true, "reason": "Meeting coordination request to discuss project timeline", "priority": "medium"}

Example 5 - CC'd email (no reply needed):
Email To: john@company.com, CC: user@company.com
Email Subject: "Client request for proposal deadline"
Email Body: "John, the client has moved up the proposal deadline to next Monday. Please prioritize this and let me know if you need additional resources. I've CC'd the team for visibility."
Output: {"needs_reply": false, "reason": "CC'd for visibility only - action directed at John"}

Example 6 - Urgent escalation (high priority):
Email Subject: "URGENT: Production database issue"
Email Body: "Hi - we're seeing intermittent 500 errors on the production API. Initial investigation shows the primary database is hitting connection limits. I need your approval to scale up the database instance (will increase monthly costs by ~$200). Please respond ASAP as this is impacting customers."
Output: {"needs_reply": true, "reason": "Urgent production issue requiring immediate approval decision", "priority": "high"}

Example 7 - Shipping notification (no reply needed):
Email Subject: "Your Amazon order has shipped!"
Email Body: "Great news! Your order #123-4567890-1234567 is on its way. Track your package: [link]. Estimated delivery: January 30, 2025. Items in this shipment: USB-C Cable (2 pack), Wireless Mouse..."
Output: {"needs_reply": false, "reason": "Automated shipping notification from e-commerce"}

Example 8 - Personal introduction (reply needed):
Email Subject: "Introduction from Jared Friedman"
Email Body: "Hi! I hope this email finds you well. Jared Friedman mentioned that you're working on some interesting AI-powered productivity tools, and I'd love to learn more about your work. I'm currently leading product at a startup in the same space, and it seems like there could be some interesting synergies. Would you be open to a brief call sometime next week? No rush on this - just wanted to reach out and introduce myself."
Output: {"needs_reply": true, "reason": "Personal introduction from mutual connection requesting networking call", "priority": "low"}

Example 9 - LinkedIn notification (no reply needed):
Email Subject: "John Smith viewed your profile"
Email Body: "John Smith, Senior Engineer at Tech Corp, viewed your profile. See who else viewed your profile this week. Connect with John? [Accept] [Ignore]"
Output: {"needs_reply": false, "reason": "Automated LinkedIn notification - not a direct message"}

Example 10 - Internal announcement (no reply needed):
Email Subject: "[All Hands] Q4 Company Update"
Email Body: "Team, I wanted to share some exciting updates from Q4. We hit 150% of our revenue target, onboarded 3 new enterprise clients, and shipped 12 major features. Thanks to everyone for their hard work. Looking forward to an even better Q1! - CEO"
Output: {"needs_reply": false, "reason": "Company-wide announcement - FYI only, no response expected"}

Example 11 - Recruiter outreach (low priority):
Email Subject: "Exciting opportunity at [Company]"
Email Body: "Hi, I came across your profile and was impressed by your background. We're hiring for a senior role that I think would be a great fit. The position offers competitive compensation, equity, and great benefits. Would you be open to a quick call to discuss? Even if you're not actively looking, I'd love to connect."
Output: {"needs_reply": true, "reason": "Recruiter outreach - professional courtesy to respond", "priority": "low"}

Example 12 - Request for decision (high priority):
Email Subject: "Need your sign-off on vendor contract"
Email Body: "Hi, Legal has approved the contract with Acme Corp. We need your signature by EOD today to lock in the current pricing (they're raising rates next month). I've attached the final version with all the negotiated terms. The key changes from our discussion: 2-year term with option to extend, net-30 payment terms, and the custom SLA we requested. Please review and let me know if you have any concerns."
Output: {"needs_reply": true, "reason": "Time-sensitive contract requiring sign-off with deadline today", "priority": "high"}

Now analyze the following email:`;

export class EmailAnalyzer {
  private anthropic: Anthropic;
  private model: string;
  private customPrompt: string | null;

  constructor(model: string = "claude-sonnet-4-20250514", prompt?: string) {
    this.anthropic = new Anthropic();
    this.model = model;
    // Only use custom prompt if it differs from default
    this.customPrompt = prompt && prompt !== DEFAULT_ANALYSIS_PROMPT ? prompt : null;
  }

  async analyze(email: Email, userEmail?: string, accountId?: string): Promise<AnalysisResult> {
    const emailContent = this.formatEmailForAnalysis(email);

    // Always append JSON format suffix to ensure structured output,
    // whether using the default system prompt or a custom user prompt.
    const systemPrompt = this.customPrompt
      ? this.customPrompt + ANALYSIS_JSON_FORMAT
      : ANALYSIS_SYSTEM_PROMPT;

    const userIdentityLine = userEmail ? `Your email address: ${userEmail}\n\n` : "";

    // Inject analysis memories into the user message (not system) to preserve prompt caching.
    // The system prompt is static and cached; per-sender memories vary per email.
    const senderMatch = email.from.match(/<([^>]+)>/) ?? email.from.match(/([^\s<]+@[^\s>]+)/);
    const senderEmail = senderMatch ? senderMatch[1].toLowerCase() : email.from.toLowerCase();
    let analysisMemoryContext = "";
    if (accountId) {
      const buildCtx = await getBuildAnalysisMemoryContext();
      analysisMemoryContext = buildCtx(senderEmail, accountId);
    }

    // Prompt caching enabled via cache_control (requires 1024+ tokens in system)
    const response = await this.anthropic.messages.create({
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
          content: `${userIdentityLine}From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date}

${emailContent}${analysisMemoryContext}`,
        },
      ],
    });

    // Log cache performance
    const usage = response.usage as unknown as Record<string, number>;
    console.log(`[Analyzer] Usage: input=${usage.input_tokens}, output=${usage.output_tokens}, cache_read=${usage.cache_read_input_tokens || 0}, cache_create=${usage.cache_creation_input_tokens || 0}`);

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    try {
      const parsed = JSON.parse(stripJsonFences(textBlock.text));
      return AnalysisResultSchema.parse(parsed);
    } catch (error) {
      console.error("Failed to parse analysis response:", textBlock.text);
      // Default to not needing reply if parsing fails
      return {
        needs_reply: false,
        reason: "Failed to parse analysis - skipping for safety",
      };
    }
  }

  private formatEmailForAnalysis(email: Email): string {
    // Strip quoted content from previous messages in the thread —
    // only the new content of this message matters for analysis.
    let body = stripQuotedContent(email.body);

    // Truncate very long emails to avoid token limits
    const maxBodyLength = 4000;
    if (body.length > maxBodyLength) {
      body = body.substring(0, maxBodyLength) + "\n[... email truncated ...]";
    }

    return body;
  }
}
