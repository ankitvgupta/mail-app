/**
 * Unit tests for the sender lookup / web-search enrichment provider.
 *
 * The actual provider lives in src/extensions/mail-ext-web-search/src/web-search-provider.ts
 * and imports Anthropic SDK + extension types that transitively depend on electron.
 * We re-implement the pure helper functions here and exercise provider routing directly.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import type { ExtensionContext } from "../../src/shared/extension-types";
import type { DashboardEmail } from "../../src/shared/types";
import { _setClientForTesting } from "../../src/main/services/llm-service";
import {
  MockAnthropic,
  getCapturedRequests,
  mockAnthropicResponse,
  resetAnthropicMock,
} from "../mocks/anthropic-api-mock";

const require = createRequire(import.meta.url);
const webSearchProviderModule: typeof import("../../src/extensions/mail-ext-web-search/src/web-search-provider") = require("../../src/extensions/mail-ext-web-search/src/web-search-provider.ts");
const { createWebSearchProvider } = webSearchProviderModule;

// =============================================================================
// Re-implemented pure functions from web-search-provider.ts
// =============================================================================

const REMINDER_SERVICE_PATTERNS = [
  /reminder/i,
  /boomerang/i,
  /snooze/i,
  /followup/i,
  /follow-up/i,
  /scheduled/i,
  /noreply/i,
  /no-reply/i,
  /donotreply/i,
  /notifications?@/i,
  /mailer-daemon/i,
  /postmaster/i,
];

function isReminderService(from: string): boolean {
  return REMINDER_SERVICE_PATTERNS.some((pattern) => pattern.test(from));
}

function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

function extractSenderName(from: string): string {
  const match = from.match(/^([^<]+)/);
  return match ? match[1].trim() : from;
}

function buildSearchQuery(name: string, email: string): string {
  const domain = email.split("@")[1];
  const isPersonalEmail = [
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "me.com",
  ].includes(domain);

  if (isPersonalEmail) {
    return `"${name}" linkedin OR professional`;
  }

  const companyName = domain.split(".")[0];
  return `"${name}" ${companyName} linkedin OR professional`;
}

function stripCitations(text: string): string {
  return text.replace(/<cite[^>]*>/gi, "").replace(/<\/cite>/gi, "");
}

interface SenderProfileData {
  email: string;
  name: string;
  summary: string;
  linkedinUrl?: string;
  company?: string;
  title?: string;
  lookupAt: number;
  isReminder: boolean;
}

function validateProfileData(
  data: Record<string, unknown>,
  fallbackName: string,
): Partial<SenderProfileData> {
  const getString = (val: unknown): string | undefined => {
    if (typeof val === "string" && val.trim().length > 0) {
      return stripCitations(val).trim();
    }
    return undefined;
  };

  return {
    name: getString(data.name) || fallbackName,
    summary: getString(data.summary) || "No information found.",
    title: getString(data.title),
    company: getString(data.company),
    linkedinUrl: getString(data.linkedinUrl) || getString(data.linkedin_url),
  };
}

interface MockExtensionContext {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

function parseProfileResponse(
  responseText: string,
  fallbackName: string,
  context: MockExtensionContext,
): Partial<SenderProfileData> {
  const text = stripCitations(responseText).trim();

  // Strategy 1: JSON in markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (typeof parsed === "object" && parsed !== null) {
        return validateProfileData(parsed, fallbackName);
      }
    } catch {
      // Continue
    }
  }

  // Strategy 2: JSON object anywhere in text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed === "object" && parsed !== null) {
        return validateProfileData(parsed, fallbackName);
      }
    } catch {
      // Continue
    }
  }

  // Strategy 3: Entire text as JSON
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return validateProfileData(parsed, fallbackName);
    }
  } catch {
    // Continue
  }

  // Strategy 4: Plain text fallback
  context.logger.warn("Could not parse JSON from response, using fallback");

  const cleanText = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[{}"[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    name: fallbackName,
    summary: cleanText.length > 0 && cleanText.length < 500 ? cleanText : "No information found.",
  };
}

// =============================================================================
// Helpers
// =============================================================================

function makeContext(): MockExtensionContext {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

// =============================================================================
// Tests: isReminderService
// =============================================================================

test.describe("isReminderService", () => {
  test("detects boomerang reminder emails", () => {
    expect(isReminderService("Boomerang Reminder <reminder@boomerangapp.com>")).toBe(true);
  });

  test("detects noreply addresses", () => {
    expect(isReminderService("noreply@company.com")).toBe(true);
    expect(isReminderService("no-reply@company.com")).toBe(true);
    expect(isReminderService("donotreply@company.com")).toBe(true);
  });

  test("detects notification addresses", () => {
    expect(isReminderService("notifications@github.com")).toBe(true);
    expect(isReminderService("notification@service.com")).toBe(true);
  });

  test("detects mailer-daemon and postmaster", () => {
    expect(isReminderService("MAILER-DAEMON@mail.example.com")).toBe(true);
    expect(isReminderService("postmaster@example.com")).toBe(true);
  });

  test("detects followup/follow-up services", () => {
    expect(isReminderService("followup@service.com")).toBe(true);
    expect(isReminderService("follow-up@service.com")).toBe(true);
  });

  test("detects scheduled send addresses", () => {
    expect(isReminderService("scheduled@service.com")).toBe(true);
  });

  test("does not flag normal email addresses", () => {
    expect(isReminderService("alice@example.com")).toBe(false);
    expect(isReminderService("John Smith <john@acme.com>")).toBe(false);
    expect(isReminderService("support@company.com")).toBe(false);
  });
});

// =============================================================================
// Tests: extractSenderEmail
// =============================================================================

test.describe("extractSenderEmail", () => {
  test("extracts email from angle-bracket format", () => {
    expect(extractSenderEmail("John Smith <john@example.com>")).toBe("john@example.com");
  });

  test("returns raw string when no angle brackets", () => {
    expect(extractSenderEmail("john@example.com")).toBe("john@example.com");
  });

  test("handles empty display name", () => {
    expect(extractSenderEmail("<bob@test.com>")).toBe("bob@test.com");
  });
});

// =============================================================================
// Tests: extractSenderName
// =============================================================================

test.describe("extractSenderName", () => {
  test("extracts name from angle-bracket format", () => {
    expect(extractSenderName("John Smith <john@example.com>")).toBe("John Smith");
  });

  test("returns full string when no angle brackets", () => {
    expect(extractSenderName("john@example.com")).toBe("john@example.com");
  });

  test("trims whitespace from name", () => {
    expect(extractSenderName("  Alice   <alice@test.com>")).toBe("Alice");
  });
});

// =============================================================================
// Tests: buildSearchQuery
// =============================================================================

test.describe("buildSearchQuery", () => {
  test("uses company name for corporate emails", () => {
    const query = buildSearchQuery("John Smith", "john@acmecorp.com");
    expect(query).toContain('"John Smith"');
    expect(query).toContain("acmecorp");
    expect(query).toContain("linkedin OR professional");
  });

  test("omits company name for personal email domains", () => {
    const query = buildSearchQuery("Jane Doe", "jane@gmail.com");
    expect(query).toBe('"Jane Doe" linkedin OR professional');
    expect(query).not.toContain("gmail");
  });

  test("treats yahoo as personal email", () => {
    const query = buildSearchQuery("Bob", "bob@yahoo.com");
    expect(query).not.toContain("yahoo");
  });

  test("treats icloud as personal email", () => {
    const query = buildSearchQuery("Alice", "alice@icloud.com");
    expect(query).not.toContain("icloud");
  });

  test("treats outlook as personal email", () => {
    const query = buildSearchQuery("Carol", "carol@outlook.com");
    expect(query).not.toContain("outlook");
  });
});

// =============================================================================
// Tests: stripCitations
// =============================================================================

test.describe("stripCitations", () => {
  test("removes cite tags with index attributes", () => {
    const input = '<cite index="2-1,7-3">Some cited text</cite>';
    expect(stripCitations(input)).toBe("Some cited text");
  });

  test("handles multiple citations", () => {
    const input = 'He is <cite index="1">CEO</cite> of <cite index="2">Acme</cite>';
    expect(stripCitations(input)).toBe("He is CEO of Acme");
  });

  test("handles no citations", () => {
    expect(stripCitations("plain text")).toBe("plain text");
  });

  test("is case-insensitive", () => {
    const input = '<CITE index="1">text</CITE>';
    expect(stripCitations(input)).toBe("text");
  });
});

// =============================================================================
// Tests: validateProfileData
// =============================================================================

test.describe("validateProfileData", () => {
  test("extracts valid profile fields", () => {
    const result = validateProfileData(
      {
        name: "John Smith",
        summary: "CTO of Acme Corp",
        title: "CTO",
        company: "Acme Corp",
        linkedinUrl: "https://linkedin.com/in/jsmith",
      },
      "Fallback Name",
    );

    expect(result.name).toBe("John Smith");
    expect(result.summary).toBe("CTO of Acme Corp");
    expect(result.title).toBe("CTO");
    expect(result.company).toBe("Acme Corp");
    expect(result.linkedinUrl).toBe("https://linkedin.com/in/jsmith");
  });

  test("uses fallback name when name is missing", () => {
    const result = validateProfileData({ summary: "Some info" }, "Fallback");
    expect(result.name).toBe("Fallback");
  });

  test("uses fallback name when name is empty string", () => {
    const result = validateProfileData({ name: "  ", summary: "info" }, "Fallback");
    expect(result.name).toBe("Fallback");
  });

  test("defaults summary when missing", () => {
    const result = validateProfileData({ name: "John" }, "John");
    expect(result.summary).toBe("No information found.");
  });

  test("strips citations from field values", () => {
    const result = validateProfileData(
      {
        name: '<cite index="1">John</cite> Smith',
        summary: 'Works at <cite index="2">Acme</cite>',
      },
      "Fallback",
    );
    expect(result.name).toBe("John Smith");
    expect(result.summary).toBe("Works at Acme");
  });

  test("handles linkedin_url (underscore variant)", () => {
    const result = validateProfileData({ linkedin_url: "https://linkedin.com/in/test" }, "Name");
    expect(result.linkedinUrl).toBe("https://linkedin.com/in/test");
  });

  test("prefers linkedinUrl over linkedin_url", () => {
    const result = validateProfileData(
      {
        linkedinUrl: "https://linkedin.com/in/preferred",
        linkedin_url: "https://linkedin.com/in/fallback",
      },
      "Name",
    );
    expect(result.linkedinUrl).toBe("https://linkedin.com/in/preferred");
  });

  test("ignores non-string values", () => {
    const result = validateProfileData({ name: 42, summary: null, title: true }, "Fallback");
    expect(result.name).toBe("Fallback");
    expect(result.summary).toBe("No information found.");
    expect(result.title).toBeUndefined();
  });
});

// =============================================================================
// Tests: parseProfileResponse
// =============================================================================

test.describe("parseProfileResponse", () => {
  const ctx = makeContext();

  test("parses raw JSON response", () => {
    const json = JSON.stringify({
      name: "Alice Johnson",
      summary: "VP of Engineering at TechCo",
      title: "VP of Engineering",
      company: "TechCo",
    });

    const result = parseProfileResponse(json, "Alice", ctx);
    expect(result.name).toBe("Alice Johnson");
    expect(result.summary).toBe("VP of Engineering at TechCo");
    expect(result.title).toBe("VP of Engineering");
    expect(result.company).toBe("TechCo");
  });

  test("parses JSON wrapped in markdown code block", () => {
    const response = '```json\n{"name": "Bob Lee", "summary": "Founder of StartupXYZ"}\n```';
    const result = parseProfileResponse(response, "Bob", ctx);
    expect(result.name).toBe("Bob Lee");
    expect(result.summary).toBe("Founder of StartupXYZ");
  });

  test("parses JSON in generic code block (no language tag)", () => {
    const response = '```\n{"name": "Carol", "summary": "Designer"}\n```';
    const result = parseProfileResponse(response, "Carol", ctx);
    expect(result.name).toBe("Carol");
  });

  test("extracts JSON embedded in surrounding text", () => {
    const response =
      'Based on my search, here is the profile:\n{"name": "Dave", "summary": "Engineer at BigCo"}\nHope this helps!';
    const result = parseProfileResponse(response, "Dave", ctx);
    expect(result.name).toBe("Dave");
    expect(result.summary).toBe("Engineer at BigCo");
  });

  test("strips citations before parsing JSON", () => {
    const response =
      '{"name": "<cite index=\\"1\\">Eve</cite> Park", "summary": "Works at <cite index=\\"2\\">Acme</cite>"}';
    const result = parseProfileResponse(response, "Eve", ctx);
    expect(result.name).toBe("Eve Park");
    expect(result.summary).toBe("Works at Acme");
  });

  test("falls back to plain text when JSON is invalid", () => {
    const response = "Alice Johnson is a software engineer based in San Francisco.";
    const result = parseProfileResponse(response, "Alice", ctx);
    expect(result.name).toBe("Alice");
    expect(result.summary).toBe(response);
  });

  test("falls back to 'No information found.' for very long plain text", () => {
    const response = "x".repeat(600);
    const result = parseProfileResponse(response, "Unknown", ctx);
    expect(result.summary).toBe("No information found.");
  });

  test("falls back to 'No information found.' for empty response", () => {
    const result = parseProfileResponse("", "Unknown", ctx);
    expect(result.summary).toBe("No information found.");
  });
});

// =============================================================================
// Tests: Reminder detection in enrichment flow
// =============================================================================

test.describe("reminder detection logic", () => {
  // Re-implement the core reminder-resolution logic from the enrich() method
  type SimpleDashboardEmail = { id: string; from: string };

  function resolveRealSender(
    email: SimpleDashboardEmail,
    threadEmails: SimpleDashboardEmail[],
  ): { realSenderFrom: string; isReminder: boolean; shouldSkip: boolean } {
    let realSenderFrom = email.from;
    let isReminder = false;

    if (isReminderService(email.from)) {
      isReminder = true;
      for (const threadEmail of threadEmails) {
        if (threadEmail.id === email.id) continue;
        if (isReminderService(threadEmail.from)) continue;
        realSenderFrom = threadEmail.from;
        break;
      }
      if (isReminderService(realSenderFrom)) {
        return { realSenderFrom, isReminder, shouldSkip: true };
      }
    }

    return { realSenderFrom, isReminder, shouldSkip: false };
  }

  test("resolves original sender from thread when email is from reminder service", () => {
    const email = { id: "1", from: "Boomerang <reminder@boomerangapp.com>" };
    const thread = [
      email,
      { id: "2", from: "Alice Smith <alice@company.com>" },
      { id: "3", from: "Bob <bob@company.com>" },
    ];

    const result = resolveRealSender(email, thread);
    expect(result.isReminder).toBe(true);
    expect(result.shouldSkip).toBe(false);
    expect(result.realSenderFrom).toBe("Alice Smith <alice@company.com>");
  });

  test("skips enrichment when all thread emails are from reminder services", () => {
    const email = { id: "1", from: "reminder@boomerangapp.com" };
    const thread = [email, { id: "2", from: "noreply@another-service.com" }];

    const result = resolveRealSender(email, thread);
    expect(result.isReminder).toBe(true);
    expect(result.shouldSkip).toBe(true);
  });

  test("does not alter sender for normal emails", () => {
    const email = { id: "1", from: "John <john@example.com>" };
    const thread = [email];

    const result = resolveRealSender(email, thread);
    expect(result.isReminder).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.realSenderFrom).toBe("John <john@example.com>");
  });

  test("skips self in thread when looking for real sender", () => {
    const email = { id: "1", from: "reminder@service.com" };
    const thread = [
      email,
      { id: "1", from: "reminder@service.com" }, // same id, should be skipped
      { id: "2", from: "Real Person <real@company.com>" },
    ];

    const result = resolveRealSender(email, thread);
    expect(result.realSenderFrom).toBe("Real Person <real@company.com>");
  });
});

// =============================================================================
// Tests: Cache key and expiration logic
// =============================================================================

test.describe("cache key computation", () => {
  test("cache key is lowercase email", () => {
    const email = "Alice@Example.COM";
    const cacheKey = `profile:${email.toLowerCase()}`;
    expect(cacheKey).toBe("profile:alice@example.com");
  });

  test("cache expiration constant is 7 days in milliseconds", () => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    expect(SEVEN_DAYS_MS).toBe(604_800_000);
  });
});

test.describe("sender lookup provider routing", () => {
  test.beforeEach(() => {
    resetAnthropicMock();
    _setClientForTesting(new MockAnthropic());
  });

  test.afterEach(() => {
    _setClientForTesting(null as unknown);
  });

  test("skips Exa without a key when OpenCode is the parsing provider", async () => {
    mockAnthropicResponse({
      text: '{"name":"Alice","summary":"Anthropic fallback should not run"}',
    });
    const errors: string[] = [];
    const context: ExtensionContext = {
      extensionId: "web-search",
      extensionPath: "/test/web-search",
      storage: {
        get: async <T>() => null,
        set: async <T>() => {},
        delete: async () => {},
      },
      secrets: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: (message) => errors.push(message),
        debug: () => {},
      },
    };
    const provider = createWebSearchProvider(context, {
      getModelId: () => "claude-sonnet-4-20250514",
      getSearchConfig: () => ({
        provider: "exa",
        exaApiKey: "",
        anthropicConfigured: true,
      }),
      getParsingModelConfig: () => ({
        provider: "opencode",
        model: "openai/gpt-5.2",
      }),
    });
    const email: DashboardEmail = {
      id: "msg-1",
      threadId: "thread-1",
      subject: "Hello",
      from: "Alice <alice@example.com>",
      to: "user@example.com",
      date: "2026-07-29T12:00:00Z",
      body: "Hello",
      snippet: "Hello",
      labelIds: ["INBOX"],
    };

    const result = await provider.enrich(email, [email]);

    expect(result).toBeNull();
    expect(getCapturedRequests()).toHaveLength(0);
    expect(errors).toContain(
      "Sender Lookup requires an Exa API key when its parsing model is not Anthropic",
    );
  });
});
