/**
 * Unit tests for the draft generation pipeline logic.
 *
 * The pipeline (src/main/services/draft-pipeline.ts) imports from ../db and
 * electron, so we cannot import it directly. Instead, we re-implement and test
 * the pure logic: recipient email extraction, prompt assembly, account ID
 * fallback, and email-for-draft shaping.
 */
import { test, expect } from "@playwright/test";

// =============================================================================
// Re-implemented pure logic from draft-pipeline.ts
// =============================================================================

/**
 * Extract recipient email address from a "from" header.
 * Mirrors the regex logic on line 60 of draft-pipeline.ts.
 */
function extractRecipientEmail(from: string): string {
  const match = from.match(/<([^>]+)>/) ?? from.match(/([^\s<]+@[^\s>]+)/);
  return match ? match[1] : "";
}

/**
 * Resolve the effective account ID.
 * Mirrors line 62: `accountId || email.accountId || "default"`
 */
function resolveAccountId(
  optAccountId: string | undefined,
  emailAccountId: string | undefined,
): string {
  return optAccountId || emailAccountId || "default";
}

/**
 * Assemble the final prompt from parts.
 * Mirrors lines 75-84 of draft-pipeline.ts.
 */
function assemblePrompt(opts: {
  draftPrompt: string;
  styleContext: string;
  memoryContext: string;
  instructions?: string;
}): string {
  let prompt = opts.draftPrompt;
  if (opts.styleContext) {
    prompt = `${opts.styleContext}\n\n${prompt}`;
  }
  if (opts.memoryContext) {
    prompt = `${opts.memoryContext}\n\n${prompt}`;
  }
  if (opts.instructions) {
    prompt = `${prompt}\n\nADDITIONAL INSTRUCTIONS:\n${opts.instructions}`;
  }
  return prompt;
}

/**
 * Shape an email record for the draft generator.
 * Mirrors lines 86-96 of draft-pipeline.ts.
 */
interface EmailLike {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  date: string;
  body: string;
  snippet?: string;
  // Extra fields that should NOT appear in the shaped output
  labelIds?: string[];
  accountId?: string;
  analysis?: unknown;
}

function shapeEmailForDraft(email: EmailLike): {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string | undefined;
  date: string;
  body: string;
  snippet: string | undefined;
} {
  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    date: email.date,
    body: email.body,
    snippet: email.snippet,
  };
}

/**
 * Resolve enableSenderLookup from config.
 * Mirrors line 104: `config.enableSenderLookup ?? true`
 */
function resolveEnableSenderLookup(configValue: boolean | undefined): boolean {
  return configValue ?? true;
}

// =============================================================================
// Tests: extractRecipientEmail
// =============================================================================

test.describe("extractRecipientEmail", () => {
  test("extracts email from angle-bracket format", () => {
    expect(extractRecipientEmail("John Smith <john@example.com>")).toBe("john@example.com");
  });

  test("extracts email from bare email address", () => {
    expect(extractRecipientEmail("alice@company.com")).toBe("alice@company.com");
  });

  test("handles email with display name but no angle brackets", () => {
    // The second regex catches bare emails
    expect(extractRecipientEmail("bob@test.org")).toBe("bob@test.org");
  });

  test("returns empty string when no email found", () => {
    expect(extractRecipientEmail("No email here")).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(extractRecipientEmail("")).toBe("");
  });

  test("handles angle brackets with no display name", () => {
    expect(extractRecipientEmail("<solo@domain.com>")).toBe("solo@domain.com");
  });

  test("extracts first email when multiple angle brackets exist", () => {
    // The regex matches the first <...> group
    const result = extractRecipientEmail("Name <first@a.com> and <second@b.com>");
    expect(result).toBe("first@a.com");
  });
});

// =============================================================================
// Tests: resolveAccountId
// =============================================================================

test.describe("resolveAccountId", () => {
  test("prefers explicit accountId option", () => {
    expect(resolveAccountId("acct-1", "acct-2")).toBe("acct-1");
  });

  test("falls back to email's accountId", () => {
    expect(resolveAccountId(undefined, "acct-2")).toBe("acct-2");
  });

  test("falls back to empty string accountId from option", () => {
    // Empty string is falsy, so falls through
    expect(resolveAccountId("", "acct-2")).toBe("acct-2");
  });

  test("falls back to 'default' when both are missing", () => {
    expect(resolveAccountId(undefined, undefined)).toBe("default");
  });

  test("falls back to 'default' when both are empty strings", () => {
    expect(resolveAccountId("", "")).toBe("default");
  });
});

// =============================================================================
// Tests: assemblePrompt
// =============================================================================

test.describe("assemblePrompt", () => {
  test("returns draftPrompt alone when no context or instructions", () => {
    const result = assemblePrompt({
      draftPrompt: "Write a reply.",
      styleContext: "",
      memoryContext: "",
    });
    expect(result).toBe("Write a reply.");
  });

  test("prepends style context before draft prompt", () => {
    const result = assemblePrompt({
      draftPrompt: "Write a reply.",
      styleContext: "Use casual tone.",
      memoryContext: "",
    });
    expect(result).toBe("Use casual tone.\n\nWrite a reply.");
  });

  test("prepends memory context before style context", () => {
    const result = assemblePrompt({
      draftPrompt: "Write a reply.",
      styleContext: "Use casual tone.",
      memoryContext: "User prefers short emails.",
    });
    // Order: memory → style → draft
    expect(result).toBe("User prefers short emails.\n\nUse casual tone.\n\nWrite a reply.");
  });

  test("appends instructions after draft prompt", () => {
    const result = assemblePrompt({
      draftPrompt: "Write a reply.",
      styleContext: "",
      memoryContext: "",
      instructions: "Make it more formal.",
    });
    expect(result).toBe("Write a reply.\n\nADDITIONAL INSTRUCTIONS:\nMake it more formal.");
  });

  test("assembles all parts in correct order", () => {
    const result = assemblePrompt({
      draftPrompt: "Draft prompt.",
      styleContext: "Style context.",
      memoryContext: "Memory context.",
      instructions: "Extra instructions.",
    });

    const parts = result.split("\n\n");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("Memory context.");
    expect(parts[1]).toBe("Style context.");
    expect(parts[2]).toBe("Draft prompt.");
    expect(parts[3]).toBe("ADDITIONAL INSTRUCTIONS:\nExtra instructions.");
  });

  test("does not prepend style context when it is empty", () => {
    const result = assemblePrompt({
      draftPrompt: "prompt",
      styleContext: "",
      memoryContext: "memory",
    });
    expect(result).toBe("memory\n\nprompt");
  });

  test("does not prepend memory context when it is empty", () => {
    const result = assemblePrompt({
      draftPrompt: "prompt",
      styleContext: "style",
      memoryContext: "",
    });
    expect(result).toBe("style\n\nprompt");
  });

  test("does not append instructions when undefined", () => {
    const result = assemblePrompt({
      draftPrompt: "prompt",
      styleContext: "",
      memoryContext: "",
      instructions: undefined,
    });
    expect(result).toBe("prompt");
  });
});

// =============================================================================
// Tests: shapeEmailForDraft
// =============================================================================

test.describe("shapeEmailForDraft", () => {
  test("includes only the expected fields", () => {
    const input: EmailLike = {
      id: "msg-123",
      threadId: "thread-456",
      subject: "Re: Meeting notes",
      from: "alice@example.com",
      to: "user@example.com",
      cc: "bob@example.com",
      date: "2025-01-15T10:00:00Z",
      body: "<p>Hello</p>",
      snippet: "Hello...",
      labelIds: ["INBOX", "IMPORTANT"],
      accountId: "acct-1",
      analysis: { needsReply: true },
    };

    const shaped = shapeEmailForDraft(input);

    expect(shaped.id).toBe("msg-123");
    expect(shaped.threadId).toBe("thread-456");
    expect(shaped.subject).toBe("Re: Meeting notes");
    expect(shaped.from).toBe("alice@example.com");
    expect(shaped.to).toBe("user@example.com");
    expect(shaped.cc).toBe("bob@example.com");
    expect(shaped.date).toBe("2025-01-15T10:00:00Z");
    expect(shaped.body).toBe("<p>Hello</p>");
    expect(shaped.snippet).toBe("Hello...");

    // These should NOT be in the shaped object
    expect(shaped).not.toHaveProperty("labelIds");
    expect(shaped).not.toHaveProperty("accountId");
    expect(shaped).not.toHaveProperty("analysis");
  });

  test("handles undefined optional fields", () => {
    const input: EmailLike = {
      id: "msg-1",
      threadId: "thread-1",
      subject: "Test",
      from: "test@test.com",
      to: "me@test.com",
      date: "2025-01-01",
      body: "body",
    };

    const shaped = shapeEmailForDraft(input);
    expect(shaped.cc).toBeUndefined();
    expect(shaped.snippet).toBeUndefined();
  });
});

// =============================================================================
// Tests: resolveEnableSenderLookup
// =============================================================================

test.describe("resolveEnableSenderLookup", () => {
  test("defaults to true when config value is undefined", () => {
    expect(resolveEnableSenderLookup(undefined)).toBe(true);
  });

  test("respects explicit true", () => {
    expect(resolveEnableSenderLookup(true)).toBe(true);
  });

  test("respects explicit false", () => {
    expect(resolveEnableSenderLookup(false)).toBe(false);
  });
});

// =============================================================================
// Tests: Analysis result shaping
// =============================================================================

test.describe("analysis result shaping", () => {
  // Mirrors draft-pipeline.ts: convert stored analysis (camelCase) to
  // the snake_case AnalysisResult shape consumed by the draft generator.
  function shapeAnalysis(stored: { needsReply: boolean; reason: string }): {
    needs_reply: boolean;
    reason: string;
  } {
    return {
      needs_reply: stored.needsReply,
      reason: stored.reason,
    };
  }

  test("maps needsReply to needs_reply for Priority emails", () => {
    const result = shapeAnalysis({
      needsReply: true,
      reason: "Direct question",
    });
    expect(result.needs_reply).toBe(true);
    expect(result.reason).toBe("Direct question");
  });

  test("maps needsReply to needs_reply for Other emails", () => {
    const result = shapeAnalysis({
      needsReply: false,
      reason: "Newsletter",
    });
    expect(result.needs_reply).toBe(false);
  });
});
