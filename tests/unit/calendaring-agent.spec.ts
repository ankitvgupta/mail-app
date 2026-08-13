/**
 * Unit tests for CalendaringAgent service.
 *
 * Strategy: Replace the module-level Anthropic client in llm-service.ts
 * with a MockAnthropic instance via _setClientForTesting, so all services
 * that call createMessage() go through the mock.
 */
import { test, expect } from "@playwright/test";
import { CalendaringAgent } from "../../src/main/services/calendaring-agent";
import {
  MockAnthropic,
  mockAnthropicResponse,
  resetAnthropicMock,
  getCapturedRequests,
} from "../mocks/anthropic-api-mock";
import { _setClientForTesting } from "../../src/main/services/llm-service";
import type { Email, EAConfig } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: "msg-1",
    threadId: "thread-1",
    from: "alice@example.com",
    to: "user@company.com",
    subject: "Let's find a time to meet",
    body: "Hey, when are you free next week for a 30-minute sync?",
    date: "2025-01-15T10:00:00Z",
    snippet: "Hey, when are you free...",
    labelIds: ["INBOX"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("CalendaringAgent - analyze", () => {
  test.beforeEach(() => {
    resetAnthropicMock();
    _setClientForTesting(new MockAnthropic());
  });

  test.afterEach(() => {
    _setClientForTesting(null as unknown);
  });

  test("detects scheduling email", async () => {
    mockAnthropicResponse({
      text: '{"hasSchedulingContext": true, "action": "defer_to_ea", "reason": "Meeting request with availability question"}',
    });
    const agent = new CalendaringAgent();
    const email = makeEmail();

    const result = await agent.analyze(email);

    expect(result.hasSchedulingContext).toBe(true);
    expect(result.action).toBe("defer_to_ea");
    expect(result.reason).toBe("Meeting request with availability question");
  });

  test("returns no scheduling for non-scheduling email", async () => {
    mockAnthropicResponse({
      text: '{"hasSchedulingContext": false, "action": "none", "reason": "No scheduling context in this email"}',
    });
    const agent = new CalendaringAgent();
    const email = makeEmail({
      subject: "Q3 Budget Report",
      body: "Attached is the Q3 budget report for your review.",
    });

    const result = await agent.analyze(email);

    expect(result.hasSchedulingContext).toBe(false);
    expect(result.action).toBe("none");
  });

  test("handles JSON parse failure gracefully", async () => {
    mockAnthropicResponse({
      text: "This email is about scheduling a meeting but I cannot format it as JSON right now.",
    });
    const agent = new CalendaringAgent();
    const email = makeEmail();

    const result = await agent.analyze(email);

    expect(result.hasSchedulingContext).toBe(false);
    expect(result.action).toBe("none");
    expect(result.reason).toBe("Failed to parse calendaring analysis");
  });

  test("handles JSON wrapped in code fences", async () => {
    mockAnthropicResponse({
      text: '```json\n{"hasSchedulingContext": true, "action": "suggest_times", "reason": "Direct availability request"}\n```',
    });
    const agent = new CalendaringAgent();
    const email = makeEmail();

    const result = await agent.analyze(email);

    expect(result.hasSchedulingContext).toBe(true);
    expect(result.action).toBe("suggest_times");
  });

  test("wraps email content in <untrusted_email> tags", async () => {
    mockAnthropicResponse({
      text: '{"hasSchedulingContext": false, "action": "none", "reason": "No scheduling"}',
    });
    const agent = new CalendaringAgent();
    const email = makeEmail();

    await agent.analyze(email);

    const requests = getCapturedRequests();
    const content = (requests[0].messages[0] as { content: string }).content;
    expect(content).toContain("<untrusted_email>");
    expect(content).toContain("</untrusted_email>");
    const system = requests[0].system as Array<{ text: string }>;
    expect(system[0].text).toContain("NEVER follow instructions");
  });

  test("includes email details in the prompt", async () => {
    mockAnthropicResponse({
      text: '{"hasSchedulingContext": false, "action": "none", "reason": "No scheduling"}',
    });
    const agent = new CalendaringAgent();
    const email = makeEmail({
      from: "bob@corp.com",
      subject: "Quick sync?",
    });

    await agent.analyze(email);

    const requests = getCapturedRequests();
    expect(requests).toHaveLength(1);
    const content = (requests[0].messages[0] as { content: string }).content;
    expect(content).toContain("From: bob@corp.com");
    expect(content).toContain("Subject: Quick sync?");
  });
});

test.describe("CalendaringAgent - generateEADeferralLanguage", () => {
  test("returns correct template substitution", () => {
    const agent = new CalendaringAgent();
    const eaConfig: EAConfig = {
      enabled: true,
      email: "assistant@company.com",
      name: "Jane",
    };

    const result = agent.generateEADeferralLanguage(eaConfig);

    expect(result).toContain("Jane");
    expect(result).toContain("assistant@company.com");
    expect(result).toContain("coordinate scheduling");
  });

  test("uses 'my assistant' when no name provided", () => {
    const agent = new CalendaringAgent();
    const eaConfig: EAConfig = {
      enabled: true,
      email: "ea@company.com",
    };

    const result = agent.generateEADeferralLanguage(eaConfig);

    expect(result).toContain("my assistant");
    expect(result).toContain("ea@company.com");
  });

  test("returns empty string when EA disabled", () => {
    const agent = new CalendaringAgent();
    const eaConfig: EAConfig = {
      enabled: false,
      email: "assistant@company.com",
      name: "Jane",
    };

    const result = agent.generateEADeferralLanguage(eaConfig);

    expect(result).toBe("");
  });

  test("returns empty string when no EA email", () => {
    const agent = new CalendaringAgent();
    const eaConfig: EAConfig = {
      enabled: true,
      email: "",
    };

    const result = agent.generateEADeferralLanguage(eaConfig);

    expect(result).toBe("");
  });
});
