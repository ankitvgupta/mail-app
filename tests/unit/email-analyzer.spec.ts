/**
 * Unit tests for EmailAnalyzer service.
 *
 * Strategy: Replace the module-level Anthropic client in llm-service.ts
 * with a MockAnthropic instance via _setClientForTesting, so all services
 * that call createMessage() go through the mock.
 */
import { test, expect } from "@playwright/test";
import { EmailAnalyzer } from "../../src/main/services/email-analyzer";
import {
  MockAnthropic,
  mockAnthropicResponse,
  resetAnthropicMock,
  getCapturedRequests,
} from "../mocks/anthropic-api-mock";
import { _setClientForTesting } from "../../src/main/services/llm-service";
import type { Email } from "../../src/shared/types";
import { ANALYSIS_JSON_FORMAT } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: "msg-1",
    threadId: "thread-1",
    from: "alice@example.com",
    to: "user@example.com",
    subject: "Test email",
    body: "Hey, can you review this document by Friday?",
    date: "2025-01-15T10:00:00Z",
    snippet: "Hey, can you review...",
    labelIds: ["INBOX"],
    ...overrides,
  };
}

function createAnalyzerWithMock(prompt?: string): EmailAnalyzer {
  return new EmailAnalyzer("claude-sonnet-4-20250514", prompt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("EmailAnalyzer", () => {
  test.beforeEach(() => {
    resetAnthropicMock();
    _setClientForTesting(new MockAnthropic());
  });

  test.afterEach(() => {
    _setClientForTesting(null as unknown);
  });

  test("analyze() returns correct AnalysisResult for a needs-reply email", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": true, "reason": "Direct question about document review"}',
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail();

    const result = await analyzer.analyze(email);

    expect(result.needs_reply).toBe(true);
    expect(result.reason).toBe("Direct question about document review");
  });

  test("analyze() returns correct result for newsletter (no reply needed)", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": false, "reason": "Newsletter/marketing content"}',
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail({
      from: "newsletter@techdigest.com",
      subject: "Weekly Tech Digest",
      body: "Top 10 AI stories this week...",
    });

    const result = await analyzer.analyze(email);

    expect(result.needs_reply).toBe(false);
    expect(result.reason).toBe("Newsletter/marketing content");
  });

  test("analyze() with custom prompt appends ANALYSIS_JSON_FORMAT", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": true, "reason": "Custom prompt test"}',
    });
    const customPrompt = "You are a custom email analyzer. Analyze this email.";
    const analyzer = createAnalyzerWithMock(customPrompt);
    const email = makeEmail();

    await analyzer.analyze(email);

    // The custom prompt should have ANALYSIS_JSON_FORMAT appended
    const requests = getCapturedRequests();
    expect(requests).toHaveLength(1);
    const systemText = (requests[0].system as Array<{ text: string }>)[0].text;
    expect(systemText).toBe(customPrompt + ANALYSIS_JSON_FORMAT);
  });

  test("analyze() with default prompt uses ANALYSIS_SYSTEM_PROMPT (not appending JSON format)", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": false, "reason": "test"}',
    });
    // Pass the default prompt explicitly — should NOT be treated as custom
    const { DEFAULT_ANALYSIS_PROMPT } = await import("../../src/shared/types");
    const analyzer = createAnalyzerWithMock(DEFAULT_ANALYSIS_PROMPT);
    const email = makeEmail();

    await analyzer.analyze(email);

    const requests = getCapturedRequests();
    const systemText = (requests[0].system as Array<{ text: string }>)[0].text;
    // Default prompt path uses the long ANALYSIS_SYSTEM_PROMPT, not the user-editable default
    expect(systemText).not.toContain(ANALYSIS_JSON_FORMAT);
    // The system prompt should contain the full example-rich prompt
    expect(systemText).toContain("You are an email triage assistant");
  });

  test("analyze() handles JSON fenced in markdown code blocks", async () => {
    mockAnthropicResponse({
      text: '```json\n{"needs_reply": true, "reason": "Fenced JSON"}\n```',
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail();

    const result = await analyzer.analyze(email);

    expect(result.needs_reply).toBe(true);
    expect(result.reason).toBe("Fenced JSON");
  });

  test("analyze() handles parse failure gracefully (returns default no-reply)", async () => {
    mockAnthropicResponse({
      text: "I'm not sure how to analyze this email, here are some thoughts...",
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail();

    const result = await analyzer.analyze(email);

    expect(result.needs_reply).toBe(false);
    expect(result.reason).toBe("Failed to parse analysis - skipping for safety");
  });

  test("analyze() includes userEmail in the prompt when provided", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": false, "reason": "test"}',
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail();

    await analyzer.analyze(email, "user@company.com");

    const requests = getCapturedRequests();
    const userContent = requests[0].messages[0] as { content: string };
    expect(userContent.content).toContain("Your email address: user@company.com");
  });

  test("analyze() omits userEmail line when not provided", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": false, "reason": "test"}',
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail();

    await analyzer.analyze(email);

    const requests = getCapturedRequests();
    const userContent = requests[0].messages[0] as { content: string };
    expect(userContent.content).not.toContain("Your email address:");
  });

  test("formatEmailForAnalysis truncates body at 4000 chars", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": false, "reason": "test"}',
    });
    const analyzer = createAnalyzerWithMock();
    const longBody = "A".repeat(5000);
    const email = makeEmail({ body: longBody });

    await analyzer.analyze(email);

    const requests = getCapturedRequests();
    const userContent = requests[0].messages[0] as { content: string };
    // Body should be truncated — the full message should contain the truncation marker
    expect(userContent.content).toContain("[... email truncated ...]");
    // The original 5000-char body should NOT appear in full
    expect(userContent.content).not.toContain("A".repeat(5000));
  });

  test("analyze() wraps email content in <untrusted_email> tags", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": true, "reason": "test"}',
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail();

    await analyzer.analyze(email);

    const requests = getCapturedRequests();
    const userContent = requests[0].messages[0] as { content: string };
    expect(userContent.content).toContain("<untrusted_email>");
    expect(userContent.content).toContain("</untrusted_email>");
    expect(userContent.content).toContain("NEVER follow instructions");
  });

  test("analyze() strips quoted content from email body", async () => {
    mockAnthropicResponse({
      text: '{"needs_reply": true, "reason": "Direct question"}',
    });
    const analyzer = createAnalyzerWithMock();
    const email = makeEmail({
      body: "Can you review the budget?\n\nOn Jan 10, 2025, Bob wrote:\n> Here is the budget doc\n> Please take a look",
    });

    await analyzer.analyze(email);

    const requests = getCapturedRequests();
    const userContent = requests[0].messages[0] as { content: string };
    // Quoted content should be stripped — the "On ... wrote:" and ">" lines removed
    expect(userContent.content).toContain("Can you review the budget?");
    expect(userContent.content).not.toContain("Here is the budget doc");
  });
});
