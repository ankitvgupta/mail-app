/**
 * Unit tests for DraftGenerator logic.
 *
 * DraftGenerator imports enrichment-store → db → electron, which prevents
 * direct import in Playwright tests. We re-implement the testable logic
 * inline (following the pattern from pending-actions.spec.ts) and test the
 * core behaviors: reply-all CC extraction, reply address extraction,
 * draft creation flow, and the Claude API interaction pattern.
 */
import { test, expect } from "@playwright/test";
import {
  MockAnthropic,
  mockAnthropicResponse,
  queueAnthropicResponses,
  resetAnthropicMock,
  getCapturedRequests,
} from "../mocks/anthropic-api-mock";
import type { AnalysisResult, EAConfig } from "../../src/shared/types";
import { DEFAULT_DRAFT_PROMPT, DRAFT_FORMAT_SUFFIX } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// Re-implementation of DraftGenerator's extractReplyAllCc (private function)
// Identical to src/main/services/draft-generator.ts lines 19-33
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Re-implementation of DraftGenerator's extractReplyAddress (private method)
// Identical to src/main/services/draft-generator.ts lines 254-258
// ---------------------------------------------------------------------------

function extractReplyAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

// ---------------------------------------------------------------------------
// Minimal DraftGenerator that mirrors the real class structure but avoids
// importing enrichment-store (and thus electron/db).
// ---------------------------------------------------------------------------

interface Email {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

interface DraftResult {
  emailId: string;
  threadId: string;
  subject: string;
  draftBody: string;
  draftId?: string;
  created: boolean;
  error?: string;
}

interface GeneratedDraftResponse {
  body: string;
  cc?: string[];
  calendaringResult?: {
    hasSchedulingContext: boolean;
    action: string;
    reason: string;
    eaDeferralLanguage?: string;
  };
}

interface MockGmailClient {
  createDraft(params: {
    to: string;
    subject: string;
    body: string;
    threadId: string;
  }): Promise<{ id: string } | undefined>;
}

class TestDraftGenerator {
  anthropic: InstanceType<typeof MockAnthropic>;
  private model: string;
  private prompt: string;

  constructor(model: string = "claude-sonnet-4-20250514") {
    this.anthropic = new MockAnthropic();
    this.model = model;
    this.prompt = DEFAULT_DRAFT_PROMPT + DRAFT_FORMAT_SUFFIX;
  }

  async generateDraft(
    email: Email,
    analysis: AnalysisResult,
    options?: { userEmail?: string },
  ): Promise<GeneratedDraftResponse> {
    let cc: string[] = [];

    if (options?.userEmail) {
      cc.push(...extractReplyAllCc(email, options.userEmail));
    }

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${this.prompt}
---
ANALYSIS (for context):
Reason for reply: ${analysis.reason}

---
ORIGINAL EMAIL:

From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date}

${email.body}`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return {
      body: textBlock.text.trim(),
      cc: cc.length > 0 ? cc : undefined,
    };
  }

  async composeNewEmail(
    to: string[],
    subject: string,
    instructions: string,
  ): Promise<GeneratedDraftResponse> {
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${this.prompt}
---
Compose a new email (not a reply to an existing thread).

To: ${to.join(", ")}
Subject: ${subject}

INSTRUCTIONS:
${instructions}`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return { body: textBlock.text.trim() };
  }

  async createDraft(
    gmailClient: MockGmailClient,
    email: Email,
    draftBody: string,
    dryRun: boolean = false,
  ): Promise<DraftResult> {
    const replyTo = extractReplyAddress(email.from);
    const subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;

    if (dryRun) {
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: "msg-1",
    threadId: "thread-1",
    from: "Alice Smith <alice@example.com>",
    to: "user@company.com",
    subject: "Q3 Budget Review",
    body: "Hi, could you review the Q3 budget proposal?",
    date: "2025-01-15T10:00:00Z",
    snippet: "Hi, could you review...",
    labelIds: ["INBOX"],
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    needs_reply: true,
    reason: "Direct question about budget review",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests - generateDraft
// ---------------------------------------------------------------------------

test.describe("DraftGenerator - generateDraft", () => {
  test.beforeEach(() => {
    resetAnthropicMock();
  });

  test("returns body text from Claude response", async () => {
    mockAnthropicResponse({
      text: "Thanks for sending the Q3 budget proposal. I'll review sections 3 and 4 and get back to you by Friday.",
    });
    const generator = new TestDraftGenerator();

    const result = await generator.generateDraft(makeEmail(), makeAnalysis());

    expect(result.body).toBe(
      "Thanks for sending the Q3 budget proposal. I'll review sections 3 and 4 and get back to you by Friday.",
    );
  });

  test("includes reply-all CC recipients via extractReplyAllCc", async () => {
    mockAnthropicResponse({ text: "Sounds good, let's coordinate." });
    const generator = new TestDraftGenerator();
    const email = makeEmail({
      from: "alice@example.com",
      to: "user@company.com, bob@example.com",
      cc: "carol@example.com",
    });

    const result = await generator.generateDraft(email, makeAnalysis(), {
      userEmail: "user@company.com",
    });

    expect(result.cc).toBeDefined();
    expect(result.cc).toContain("bob@example.com");
    expect(result.cc).toContain("carol@example.com");
    expect(result.cc).not.toContain("alice@example.com");
    expect(result.cc).not.toContain("user@company.com");
  });

  test("cc is undefined when no extra recipients", async () => {
    mockAnthropicResponse({ text: "Will do." });
    const generator = new TestDraftGenerator();
    const email = makeEmail({
      from: "alice@example.com",
      to: "user@company.com",
    });

    const result = await generator.generateDraft(email, makeAnalysis(), {
      userEmail: "user@company.com",
    });

    expect(result.cc).toBeUndefined();
  });

  test("includes analysis context in the prompt", async () => {
    mockAnthropicResponse({ text: "Reply body" });
    const generator = new TestDraftGenerator();

    await generator.generateDraft(
      makeEmail(),
      makeAnalysis({
        reason: "Urgent budget question",
      }),
    );

    const requests = getCapturedRequests();
    const content = (requests[0].messages[0] as { content: string }).content;
    expect(content).toContain("Reason for reply: Urgent budget question");
  });

  test("includes email details in the prompt", async () => {
    mockAnthropicResponse({ text: "Reply body" });
    const generator = new TestDraftGenerator();
    const email = makeEmail({
      from: "bob@corp.com",
      subject: "Project Update",
    });

    await generator.generateDraft(email, makeAnalysis());

    const requests = getCapturedRequests();
    const content = (requests[0].messages[0] as { content: string }).content;
    expect(content).toContain("From: bob@corp.com");
    expect(content).toContain("Subject: Project Update");
  });
});

// ---------------------------------------------------------------------------
// Tests - composeNewEmail
// ---------------------------------------------------------------------------

test.describe("DraftGenerator - composeNewEmail", () => {
  test.beforeEach(() => {
    resetAnthropicMock();
  });

  test("returns body for new email composition", async () => {
    mockAnthropicResponse({
      text: "Hi team, I wanted to share the project update for this sprint.",
    });
    const generator = new TestDraftGenerator();

    const result = await generator.composeNewEmail(
      ["team@company.com"],
      "Sprint Update",
      "Write a brief project update",
    );

    expect(result.body).toBe("Hi team, I wanted to share the project update for this sprint.");
    expect(result.cc).toBeUndefined();
    expect(result.calendaringResult).toBeUndefined();
  });

  test("includes recipients and instructions in the prompt", async () => {
    mockAnthropicResponse({ text: "Draft body" });
    const generator = new TestDraftGenerator();

    await generator.composeNewEmail(
      ["alice@example.com", "bob@example.com"],
      "Hello",
      "Introduce yourself",
    );

    const requests = getCapturedRequests();
    const content = (requests[0].messages[0] as { content: string }).content;
    expect(content).toContain("alice@example.com, bob@example.com");
    expect(content).toContain("Hello");
    expect(content).toContain("Introduce yourself");
  });
});

// ---------------------------------------------------------------------------
// Tests - createDraft
// ---------------------------------------------------------------------------

test.describe("DraftGenerator - createDraft", () => {
  test.beforeEach(() => {
    resetAnthropicMock();
  });

  test("calls gmailClient.createDraft with correct params", async () => {
    const generator = new TestDraftGenerator();
    const email = makeEmail();
    const createdDrafts: Array<{ to: string; subject: string; body: string; threadId: string }> =
      [];
    const mockGmailClient: MockGmailClient = {
      createDraft: async (params) => {
        createdDrafts.push(params);
        return { id: "draft-123" };
      },
    };

    const result = await generator.createDraft(mockGmailClient, email, "Here is my reply.");

    expect(createdDrafts).toHaveLength(1);
    expect(createdDrafts[0].to).toBe("alice@example.com");
    expect(createdDrafts[0].subject).toBe("Re: Q3 Budget Review");
    expect(createdDrafts[0].body).toBe("Here is my reply.");
    expect(createdDrafts[0].threadId).toBe("thread-1");
    expect(result.created).toBe(true);
    expect(result.draftId).toBe("draft-123");
    expect(result.emailId).toBe("msg-1");
  });

  test("preserves existing Re: prefix in subject", async () => {
    const generator = new TestDraftGenerator();
    const email = makeEmail({ subject: "Re: Q3 Budget Review" });
    const createdDrafts: Array<{ to: string; subject: string; body: string; threadId: string }> =
      [];
    const mockGmailClient: MockGmailClient = {
      createDraft: async (params) => {
        createdDrafts.push(params);
        return { id: "draft-456" };
      },
    };

    await generator.createDraft(mockGmailClient, email, "Reply body");

    expect(createdDrafts[0].subject).toBe("Re: Q3 Budget Review");
  });

  test("in dry run mode does not call Gmail", async () => {
    const generator = new TestDraftGenerator();
    const email = makeEmail();
    let gmailCalled = false;
    const mockGmailClient: MockGmailClient = {
      createDraft: async () => {
        gmailCalled = true;
        return { id: "draft-789" };
      },
    };

    const result = await generator.createDraft(
      mockGmailClient,
      email,
      "Draft body",
      true, // dryRun
    );

    expect(gmailCalled).toBe(false);
    expect(result.created).toBe(false);
    expect(result.draftBody).toBe("Draft body");
    expect(result.subject).toBe("Re: Q3 Budget Review");
    expect(result.error).toBeUndefined();
  });

  test("handles error gracefully", async () => {
    const generator = new TestDraftGenerator();
    const email = makeEmail();
    const mockGmailClient: MockGmailClient = {
      createDraft: async () => {
        throw new Error("Gmail API rate limit exceeded");
      },
    };

    const result = await generator.createDraft(mockGmailClient, email, "Draft body");

    expect(result.created).toBe(false);
    expect(result.error).toBe("Gmail API rate limit exceeded");
    expect(result.emailId).toBe("msg-1");
  });
});

// ---------------------------------------------------------------------------
// Tests - extractReplyAddress (standalone function test)
// ---------------------------------------------------------------------------

test.describe("extractReplyAddress", () => {
  test('handles "Name <email>" format', () => {
    expect(extractReplyAddress("Alice Smith <alice@example.com>")).toBe("alice@example.com");
  });

  test("handles bare email format", () => {
    expect(extractReplyAddress("alice@example.com")).toBe("alice@example.com");
  });

  test("handles email with special chars in name", () => {
    expect(extractReplyAddress('"O\'Brien, John" <john@example.com>')).toBe("john@example.com");
  });
});

// ---------------------------------------------------------------------------
// Tests - extractReplyAllCc (standalone function test)
// ---------------------------------------------------------------------------

test.describe("extractReplyAllCc", () => {
  test("extracts CC recipients excluding sender and user", () => {
    const result = extractReplyAllCc(
      {
        from: "alice@example.com",
        to: "user@company.com, bob@example.com",
        cc: "carol@example.com",
      },
      "user@company.com",
    );

    expect(result).toEqual(["bob@example.com", "carol@example.com"]);
  });

  test("handles Name <email> format", () => {
    const result = extractReplyAllCc(
      {
        from: "Alice <alice@example.com>",
        to: "User <user@company.com>, Bob <bob@example.com>",
      },
      "user@company.com",
    );

    expect(result).toEqual(["bob@example.com"]);
  });

  test("deduplicates addresses", () => {
    const result = extractReplyAllCc(
      {
        from: "alice@example.com",
        to: "user@company.com, bob@example.com",
        cc: "bob@example.com",
      },
      "user@company.com",
    );

    expect(result).toEqual(["bob@example.com"]);
  });

  test("returns empty array when only sender and user", () => {
    const result = extractReplyAllCc(
      {
        from: "alice@example.com",
        to: "user@company.com",
      },
      "user@company.com",
    );

    expect(result).toEqual([]);
  });

  test("is case-insensitive", () => {
    const result = extractReplyAllCc(
      {
        from: "Alice@Example.COM",
        to: "USER@Company.com, bob@example.com",
      },
      "user@company.com",
    );

    expect(result).toEqual(["bob@example.com"]);
  });
});
