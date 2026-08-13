import { z } from "zod";
import { type ToolDefinition, ToolRiskLevel } from "./types";
import type { DashboardEmail } from "../../../shared/types";
import { draftBodyToHtml } from "../../../shared/draft-utils";
import { htmlToPlainText } from "../../util/html-to-text";

const readEmail: ToolDefinition<{ emailId: string }> = {
  name: "read_email",
  description:
    "Read a single email by ID. Returns the full email including subject, from, to, date, body, and any existing analysis.",
  category: "email",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    emailId: z.string().describe("The email ID to read"),
  }),
  async execute(input, ctx) {
    const email = (await ctx.db("getEmail", input.emailId)) as DashboardEmail | null;
    if (!email) {
      throw new Error(`Email not found: ${input.emailId}`);
    }
    // Return with plain text body — agents don't need HTML markup and it wastes tokens
    return { ...email, body: email.body ? htmlToPlainText(email.body) : email.body };
  },
};

const readDraft: ToolDefinition<{ draftId: string }> = {
  name: "read_draft",
  description:
    "Read a local draft by ID. Returns the draft including subject, to, cc, bcc, body, and whether it is a reply or forward.",
  category: "email",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    draftId: z.string().describe("The draft ID to read"),
  }),
  async execute(input, ctx) {
    const draft = await ctx.db("getLocalDraft", input.draftId);
    if (!draft) {
      throw new Error(`Draft not found: ${input.draftId}`);
    }
    return draft;
  },
};

const updateDraft: ToolDefinition<{
  draftId: string;
  body?: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
}> = {
  name: "update_draft",
  description:
    "Update an existing local draft. Use this to modify a draft the user is currently composing — for example, to make it more formal, shorter, or to change the subject. Pass the full updated body text (not a diff). Only fields you provide will be changed.",
  category: "email",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    draftId: z.string().describe("The draft ID to update"),
    body: z.string().optional().describe("The full updated body text (replaces existing body)"),
    subject: z.string().optional().describe("Updated subject line"),
    to: z.array(z.string()).optional().describe("Updated recipient list"),
    cc: z.array(z.string()).optional().describe("Updated CC list"),
    bcc: z.array(z.string()).optional().describe("Updated BCC list"),
  }),
  async execute(input, ctx) {
    const existing = (await ctx.db("getLocalDraft", input.draftId)) as Record<
      string,
      unknown
    > | null;
    if (!existing) {
      throw new Error(`Draft not found: ${input.draftId}`);
    }

    const updated = { ...existing };
    if (input.body !== undefined) {
      updated.bodyText = input.body;
      updated.bodyHtml = draftBodyToHtml(input.body);
    }
    if (input.subject !== undefined) updated.subject = input.subject;
    if (input.to !== undefined) updated.to = input.to;
    if (input.cc !== undefined) updated.cc = input.cc;
    if (input.bcc !== undefined) updated.bcc = input.bcc;
    updated.updatedAt = Date.now();

    await ctx.db("saveLocalDraft", updated);

    return {
      updated: true,
      draftId: input.draftId,
      body: updated.bodyText,
      subject: updated.subject,
    };
  },
};

const readThread: ToolDefinition<{ threadId: string; accountId?: string }> = {
  name: "read_thread",
  description:
    "Read all emails in a thread, ordered chronologically. Useful for understanding the full conversation context.",
  category: "email",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    threadId: z.string().describe("The thread ID to read"),
    accountId: z.string().optional().describe("Account ID to filter by (optional)"),
  }),
  async execute(input, ctx) {
    const emails = (await ctx.db(
      "getEmailsByThread",
      input.threadId,
      input.accountId,
    )) as DashboardEmail[];
    // Return with plain text bodies — agents don't need HTML markup and it wastes tokens
    return emails.map((e) => ({ ...e, body: e.body ? htmlToPlainText(e.body) : e.body }));
  },
};

const searchEmails: ToolDefinition<{ query: string; accountId?: string; limit?: number }> = {
  name: "search_emails",
  description:
    "Full-text search across emails. Searches subject, body, sender, and recipient fields.",
  category: "email",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    accountId: z.string().optional().describe("Limit search to a specific account"),
    limit: z.number().optional().describe("Maximum results to return (default 20)"),
  }),
  async execute(input, ctx) {
    const results = await ctx.db("searchEmails", input.query, {
      accountId: input.accountId,
      limit: input.limit ?? 20,
    });
    return results;
  },
};

const listEmails: ToolDefinition<{ accountId: string }> = {
  name: "list_emails",
  description:
    "List inbox emails for an account. Returns emails with their analysis and draft status.",
  category: "email",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID to list emails for"),
  }),
  async execute(input, ctx) {
    const emails = (await ctx.db("getInboxEmails", input.accountId)) as DashboardEmail[];
    // Return a summary to avoid overwhelming context
    return emails.map((e) => ({
      id: e.id,
      threadId: e.threadId,
      subject: e.subject,
      from: e.from,
      date: e.date,
      snippet: e.snippet,
      isUnread: e.isUnread,
      needsReply: e.analysis?.needsReply,
      hasDraft: !!e.draft,
    }));
  },
};

const _archiveEmail: ToolDefinition<{ accountId: string; emailId: string }> = {
  name: "archive_email",
  description:
    "Archive an email by removing the INBOX label. The email remains accessible via search.",
  category: "email",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID"),
    emailId: z.string().describe("The email ID to archive"),
  }),
  async execute(input, ctx) {
    await ctx.gmail("archiveMessage", input.accountId, input.emailId);
    return { archived: true, emailId: input.emailId };
  },
};

const modifyLabels: ToolDefinition<{
  accountId: string;
  emailId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}> = {
  name: "modify_labels",
  description:
    "Modify Gmail labels on an email. Can add and remove labels. Common labels: UNREAD, STARRED, IMPORTANT, TRASH, SPAM. Note: removing the INBOX label (archiving) is disabled.",
  category: "email",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID"),
    emailId: z.string().describe("The email ID to modify"),
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
    removeLabelIds: z
      .array(z.string())
      .optional()
      .describe(
        "Label IDs to remove (e.g. ['UNREAD'] to mark as read). Removing INBOX is disabled.",
      ),
  }),
  async execute(input, ctx) {
    // Block archiving (removing INBOX label) before any mutations
    if (input.removeLabelIds?.includes("INBOX")) {
      throw new Error("Archiving (removing INBOX label) is disabled — too disruptive");
    }

    // The GmailClient doesn't have a generic modifyLabels, so we use
    // specific methods based on what's being changed
    if (input.addLabelIds?.includes("STARRED")) {
      await ctx.gmail("setStarred", input.accountId, input.emailId, true);
    }
    if (input.removeLabelIds?.includes("STARRED")) {
      await ctx.gmail("setStarred", input.accountId, input.emailId, false);
    }
    if (input.addLabelIds?.includes("UNREAD")) {
      await ctx.gmail("setRead", input.accountId, input.emailId, false);
    }
    if (input.removeLabelIds?.includes("UNREAD")) {
      await ctx.gmail("setRead", input.accountId, input.emailId, true);
    }
    if (input.addLabelIds?.includes("INBOX")) {
      await ctx.gmail("restoreToInbox", input.accountId, input.emailId);
    }
    if (input.addLabelIds?.includes("TRASH")) {
      await ctx.gmail("trashMessage", input.accountId, input.emailId);
    }
    return { modified: true, emailId: input.emailId };
  },
};

const createDraft: ToolDefinition<{
  accountId: string;
  emailId: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}> = {
  name: "create_draft",
  description:
    "Create a draft reply to an email. The draft is saved locally and (if Gmail is connected) synced to Gmail. The user can review and edit the draft in the app before sending.",
  category: "email",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID"),
    emailId: z.string().describe("The email ID to reply to"),
    body: z.string().describe("The draft reply body text"),
    cc: z.array(z.string()).optional().describe("CC recipients to add"),
    bcc: z.array(z.string()).optional().describe("BCC recipients to add"),
  }),
  async execute(input, ctx) {
    // Save draft locally and sync to Gmail in one call — same code path as
    // the UI's "Generate Draft" / "Save" / "Refine" buttons.
    await ctx.db("saveDraftAndSync", input.emailId, input.body, "pending", input.cc, input.bcc);

    return {
      saved: true,
      emailId: input.emailId,
      body: input.body,
    };
  },
};

const generateDraft: ToolDefinition<{
  accountId: string;
  emailId: string;
  instructions?: string;
}> = {
  name: "generate_draft",
  description:
    "Generate a draft reply using the app's draft generation pipeline. This uses the user's configured model, writing style for the recipient, executive assistant settings, and sender context — exactly the same as the 'Generate Draft' button in the UI. Use this instead of writing the body yourself in create_draft, since it ensures consistent style matching with the user's configured model. Optionally pass instructions to guide the content (e.g., 'mention I will be out next week', 'decline politely').",
  category: "email",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID"),
    emailId: z.string().describe("The email ID to reply to"),
    instructions: z
      .string()
      .optional()
      .describe(
        "Optional instructions to guide the draft content (e.g., 'decline the meeting', 'ask for more details')",
      ),
  }),
  async execute(input, ctx) {
    const result = await ctx.db(
      "generateDraft",
      input.emailId,
      input.accountId,
      input.instructions,
    );
    return result;
  },
};

const composeNewEmail: ToolDefinition<{
  accountId: string;
  to: string[];
  subject: string;
  instructions: string;
  cc?: string[];
  bcc?: string[];
}> = {
  name: "compose_new_email",
  description:
    "Compose a new email (not a reply to an existing thread). Generates the body using the app's draft generation pipeline — same configured model, writing style for the recipient, and sender enrichment as the 'Generate Draft' button. The draft is saved locally for the user to review, edit, and send. Provide instructions describing what the email should say, NOT the literal body text.",
  category: "email",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID to send from"),
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string().describe("Email subject line"),
    instructions: z
      .string()
      .describe(
        "Instructions describing what the email should say (e.g., 'ask about scheduling a meeting to discuss Q1 results', 'introduce myself and request a demo')",
      ),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
  }),
  async execute(input, ctx) {
    // Generate body via the same pipeline as replies
    const result = (await ctx.db(
      "generateNewEmail",
      input.accountId,
      input.to,
      input.subject,
      input.instructions,
    )) as { body: string };

    const { randomUUID } = await import("crypto");
    const draftId = randomUUID();
    const now = Date.now();

    const bodyHtml = draftBodyToHtml(result.body);

    const draft = {
      id: draftId,
      accountId: input.accountId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      bodyHtml,
      bodyText: result.body,
      isReply: false,
      isForward: false,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.db("saveLocalDraft", draft);

    return {
      saved: true,
      draftId,
      to: input.to,
      subject: input.subject,
      body: result.body,
    };
  },
};

const forwardEmail: ToolDefinition<{
  accountId: string;
  emailId: string;
  instructions: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
}> = {
  name: "forward_email",
  description:
    "Forward an email to other recipients. Generates an introductory message using the app's draft generation pipeline (same configured model, writing style, and sender enrichment as other drafts). The original email is included as quoted content. The draft is saved locally for the user to review, edit recipients, and send. Provide instructions describing who to forward to and why.",
  category: "email",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID to forward from"),
    emailId: z.string().describe("The email ID to forward"),
    instructions: z
      .string()
      .describe(
        "Instructions describing who to forward to and why (e.g., 'forward to alice@co.com — she handles vendor invoices', 'forward to the team for awareness')",
      ),
    to: z
      .array(z.string())
      .optional()
      .describe("Forward recipient email addresses (can also be left empty for user to fill in)"),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
  }),
  async execute(input, ctx) {
    const result = await ctx.db(
      "generateForward",
      input.emailId,
      input.accountId,
      input.instructions,
      input.to,
      input.cc,
      input.bcc,
    );

    return result;
  },
};

interface SendReplyInput {
  accountId: string;
  to: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  cc?: string[];
  bcc?: string[];
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

const _sendReply: ToolDefinition<SendReplyInput> = {
  name: "send_reply",
  description:
    "Send a reply email. This is irreversible - the email will be delivered to recipients.",
  category: "email",
  riskLevel: ToolRiskLevel.HIGH,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID"),
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string().describe("Email subject line"),
    bodyText: z.string().optional().describe("Plain text body"),
    bodyHtml: z.string().optional().describe("HTML body"),
    cc: z.array(z.string()).optional().describe("CC recipients"),
    bcc: z.array(z.string()).optional().describe("BCC recipients"),
    threadId: z.string().optional().describe("Thread ID for replies"),
    inReplyTo: z.string().optional().describe("Message-ID of the email being replied to"),
    references: z.string().optional().describe("References header for threading"),
  }),
  async execute(input, ctx) {
    const { accountId, ...options } = input;
    const result = await ctx.gmail("sendMessage", accountId, options);
    return result;
  },
};

interface GmailSearchResult {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
}

const searchGmail: ToolDefinition<{ accountId: string; query: string; maxResults?: number }> = {
  name: "search_gmail",
  description:
    "Search emails via the Gmail API using Gmail's full search syntax (same as the Gmail search bar). " +
    "This searches the complete remote mailbox, not just locally synced emails. " +
    "Use this when the local search_emails tool returns insufficient results, or when you need to find older emails " +
    "that may not be in the local index. Supports Gmail query operators like from:, to:, subject:, has:attachment, " +
    "before:, after:, is:starred, label:, etc.",
  category: "email",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID to search"),
    query: z
      .string()
      .describe(
        "Gmail search query (same syntax as Gmail search bar). " +
          "Examples: 'from:alice@example.com', 'subject:quarterly report', 'from:bob after:2024/01/01'",
      ),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default 10, max 25)"),
  }),
  async execute(input, ctx) {
    const limit = Math.min(input.maxResults ?? 10, 25);

    // Search Gmail API — returns { results, nextPageToken }
    const searchResult = (await ctx.gmail("searchEmails", input.accountId, input.query, limit)) as {
      results: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    };
    const hits = searchResult.results;

    if (hits.length === 0) {
      return { results: [], returnedCount: 0 };
    }

    // Fetch full email details concurrently
    const settled = await Promise.allSettled(
      hits.map(async (hit) => {
        const email = (await ctx.gmail("readEmail", input.accountId, hit.id)) as {
          id: string;
          threadId: string;
          subject: string;
          from: string;
          to: string;
          date: string;
          snippet: string;
          body: string;
        } | null;
        return email;
      }),
    );

    const results: GmailSearchResult[] = [];
    for (const entry of settled) {
      if (entry.status === "fulfilled" && entry.value) {
        const email = entry.value;
        results.push({
          id: email.id,
          threadId: email.threadId,
          subject: email.subject,
          from: email.from,
          to: email.to,
          date: email.date,
          snippet: email.snippet || (email.body ? htmlToPlainText(email.body).slice(0, 200) : ""),
        });
      }
    }

    return { results, returnedCount: results.length };
  },
};

// Each tool has a specific input generic, but the registry stores ToolDefinition (unknown input).
// The cast is safe: tools validate input at runtime via inputSchema before execute() is called.
export const tools: ToolDefinition[] = [
  readEmail as ToolDefinition,
  readDraft as ToolDefinition,
  updateDraft as ToolDefinition,
  readThread as ToolDefinition,
  searchEmails as ToolDefinition,
  searchGmail as ToolDefinition,
  listEmails as ToolDefinition,
  modifyLabels as ToolDefinition,
  generateDraft as ToolDefinition,
  createDraft as ToolDefinition,
  composeNewEmail as ToolDefinition,
  forwardEmail as ToolDefinition,
];
