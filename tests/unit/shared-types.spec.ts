/**
 * Unit tests for shared type schemas (Zod validation) and utility functions.
 * Tests the domain model schemas and resolveModelId function.
 */
import { test, expect } from "@playwright/test";
import {
  EmailSchema,
  AnalysisResultSchema,
  DraftResultSchema,
  ConfigSchema,
  ModelConfigSchema,
  EAConfigSchema,
  CliToolConfigSchema,
  resolveModelId,
  MODEL_TIER_IDS,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_ANALYSIS_PROMPT,
  DEFAULT_DRAFT_PROMPT,
  type ModelTier,
} from "../../src/shared/types";

// ============================================================
// EmailSchema validation
// ============================================================

test.describe("EmailSchema", () => {
  test("validates a complete email", () => {
    const email = {
      id: "msg-001",
      threadId: "thread-001",
      subject: "Test Subject",
      from: "sender@example.com",
      to: "recipient@example.com",
      date: "2025-01-06T15:45:00Z",
      body: "<div>Hello</div>",
    };
    const result = EmailSchema.safeParse(email);
    expect(result.success).toBe(true);
  });

  test("validates email with optional fields", () => {
    const email = {
      id: "msg-002",
      threadId: "thread-002",
      subject: "With optionals",
      from: "sender@example.com",
      to: "recipient@example.com",
      date: "2025-01-06T15:45:00Z",
      body: "plain text body",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      snippet: "plain text body",
      labelIds: ["INBOX", "UNREAD"],
      attachments: [
        { id: "att-1", filename: "doc.pdf", mimeType: "application/pdf", size: 1024 },
      ],
      messageIdHeader: "<msg-002@mail.gmail.com>",
    };
    const result = EmailSchema.safeParse(email);
    expect(result.success).toBe(true);
  });

  test("rejects email missing required fields", () => {
    const email = {
      id: "msg-003",
      // missing threadId, subject, from, to, date, body
    };
    const result = EmailSchema.safeParse(email);
    expect(result.success).toBe(false);
  });

  test("rejects email with wrong type for id", () => {
    const email = {
      id: 123, // should be string
      threadId: "thread-001",
      subject: "Test",
      from: "a@b.com",
      to: "c@d.com",
      date: "2025-01-06",
      body: "hi",
    };
    const result = EmailSchema.safeParse(email);
    expect(result.success).toBe(false);
  });
});

// ============================================================
// AnalysisResultSchema validation
// ============================================================

test.describe("AnalysisResultSchema", () => {
  test("validates needs_reply=true with priority", () => {
    const result = AnalysisResultSchema.safeParse({
      needs_reply: true,
      reason: "Direct question",
      priority: "high",
    });
    expect(result.success).toBe(true);
  });

  test("validates needs_reply=false without priority", () => {
    const result = AnalysisResultSchema.safeParse({
      needs_reply: false,
      reason: "Newsletter",
    });
    expect(result.success).toBe(true);
  });

  test("validates all priority levels", () => {
    for (const priority of ["high", "medium", "low", "skip"]) {
      const result = AnalysisResultSchema.safeParse({
        needs_reply: true,
        reason: "test",
        priority,
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid priority", () => {
    const result = AnalysisResultSchema.safeParse({
      needs_reply: true,
      reason: "test",
      priority: "critical", // not a valid enum value
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing needs_reply", () => {
    const result = AnalysisResultSchema.safeParse({
      reason: "test",
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// DraftResultSchema validation
// ============================================================

test.describe("DraftResultSchema", () => {
  test("validates successful draft", () => {
    const result = DraftResultSchema.safeParse({
      emailId: "msg-001",
      threadId: "thread-001",
      subject: "Re: Test",
      draftBody: "Thanks for your email.",
      draftId: "draft-001",
      created: true,
    });
    expect(result.success).toBe(true);
  });

  test("validates failed draft with error", () => {
    const result = DraftResultSchema.safeParse({
      emailId: "msg-001",
      threadId: "thread-001",
      subject: "Re: Test",
      draftBody: "draft body",
      created: false,
      error: "API error",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// ModelConfig and resolveModelId
// ============================================================

test.describe("ModelConfig", () => {
  test("validates default model config", () => {
    const result = ModelConfigSchema.safeParse(DEFAULT_MODEL_CONFIG);
    expect(result.success).toBe(true);
  });

  test("applies defaults for missing fields", () => {
    const result = ModelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.analysis).toBe("sonnet");
      expect(result.data.senderLookup).toBe("haiku");
      expect(result.data.agentChat).toBe("opus");
    }
  });

  test("rejects invalid tier", () => {
    const result = ModelConfigSchema.safeParse({
      analysis: "gpt-4", // not a valid tier
    });
    expect(result.success).toBe(false);
  });
});

test.describe("resolveModelId", () => {
  test("resolves haiku tier to model ID", () => {
    const id = resolveModelId("haiku");
    expect(id).toBe(MODEL_TIER_IDS.haiku);
    expect(id).toContain("haiku");
  });

  test("resolves sonnet tier to model ID", () => {
    const id = resolveModelId("sonnet");
    expect(id).toBe(MODEL_TIER_IDS.sonnet);
    expect(id).toContain("sonnet");
  });

  test("resolves opus tier to model ID", () => {
    const id = resolveModelId("opus");
    expect(id).toBe(MODEL_TIER_IDS.opus);
    expect(id).toContain("opus");
  });

  test("all tiers have non-empty model IDs", () => {
    const tiers: ModelTier[] = ["haiku", "sonnet", "opus"];
    for (const tier of tiers) {
      expect(resolveModelId(tier)).toBeTruthy();
    }
  });
});

// ============================================================
// EAConfig validation
// ============================================================

test.describe("EAConfigSchema", () => {
  test("validates enabled EA config", () => {
    const result = EAConfigSchema.safeParse({
      enabled: true,
      name: "Jane Doe",
      email: "jane@example.com",
    });
    expect(result.success).toBe(true);
  });

  test("validates disabled EA config", () => {
    const result = EAConfigSchema.safeParse({
      enabled: false,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// ConfigSchema validation
// ============================================================

test.describe("ConfigSchema", () => {
  test("validates empty config (all defaults)", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxEmails).toBe(50);
      expect(result.data.dryRun).toBe(false);
      expect(result.data.theme).toBe("system");
      expect(result.data.undoSendDelay).toBe(5);
      expect(result.data.inboxDensity).toBe("compact");
    }
  });

  test("validates full config", () => {
    const result = ConfigSchema.safeParse({
      maxEmails: 100,
      model: "claude-sonnet-4-20250514",
      dryRun: true,
      anthropicApiKey: "sk-test-key",
      theme: "dark",
      undoSendDelay: 10,
      inboxDensity: "default",
      enableSenderLookup: false,
      modelConfig: {
        analysis: "haiku",
        drafts: "opus",
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid theme", () => {
    const result = ConfigSchema.safeParse({
      theme: "midnight", // not a valid enum
    });
    expect(result.success).toBe(false);
  });

  test("rejects undoSendDelay out of range", () => {
    const result = ConfigSchema.safeParse({
      undoSendDelay: 60, // max is 30
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative undoSendDelay", () => {
    const result = ConfigSchema.safeParse({
      undoSendDelay: -1,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// CliToolConfigSchema validation
// ============================================================

test.describe("CliToolConfigSchema", () => {
  test("validates a tool with command and instructions", () => {
    const result = CliToolConfigSchema.safeParse({
      command: "curl",
      instructions: "Use to fetch URLs",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.command).toBe("curl");
      expect(result.data.instructions).toBe("Use to fetch URLs");
    }
  });

  test("validates a tool with command only (instructions defaults to empty)", () => {
    const result = CliToolConfigSchema.safeParse({ command: "jq" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.command).toBe("jq");
      expect(result.data.instructions).toBe("");
    }
  });

  test("rejects empty command string", () => {
    const result = CliToolConfigSchema.safeParse({ command: "" });
    expect(result.success).toBe(false);
  });

  test("rejects missing command", () => {
    const result = CliToolConfigSchema.safeParse({ instructions: "some text" });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// ConfigSchema — cliTools field
// ============================================================

test.describe("ConfigSchema cliTools", () => {
  test("validates config with cliTools array", () => {
    const result = ConfigSchema.safeParse({
      cliTools: [
        { command: "curl", instructions: "Fetch URLs" },
        { command: "jq", instructions: "" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cliTools).toHaveLength(2);
      expect(result.data.cliTools![0].command).toBe("curl");
    }
  });

  test("validates config without cliTools (optional)", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cliTools).toBeUndefined();
    }
  });

  test("validates config with empty cliTools array", () => {
    const result = ConfigSchema.safeParse({ cliTools: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cliTools).toHaveLength(0);
    }
  });

  test("rejects cliTools with invalid tool entry", () => {
    const result = ConfigSchema.safeParse({
      cliTools: [{ command: "" }], // empty command violates min(1)
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Default prompts exist and are non-empty
// ============================================================

test.describe("default prompts", () => {
  test("DEFAULT_ANALYSIS_PROMPT is non-empty", () => {
    expect(DEFAULT_ANALYSIS_PROMPT.length).toBeGreaterThan(50);
  });

  test("DEFAULT_DRAFT_PROMPT is non-empty", () => {
    expect(DEFAULT_DRAFT_PROMPT.length).toBeGreaterThan(50);
  });
});
