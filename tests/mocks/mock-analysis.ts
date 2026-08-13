import type { AnalysisResult, Email } from "../../src/shared/types";
import { EXPECTED_ANALYSIS } from "../fixtures/fake-emails";

// Mock email analyzer that returns deterministic results based on the fake emails
export class MockEmailAnalyzer {
  async analyze(email: Email): Promise<AnalysisResult> {
    // Return expected results based on email ID
    const expected = EXPECTED_ANALYSIS[email.id as keyof typeof EXPECTED_ANALYSIS];

    if (expected) {
      return {
        needs_reply: expected.needsReply,
        reason: expected.needsReply
          ? `This email requires a reply (test fixture: ${email.id})`
          : `This email does not need a reply (test fixture: ${email.id})`,
      };
    }

    // Default analysis for unknown emails
    return {
      needs_reply: false,
      reason: "Unknown email ID - defaulting to no reply needed",
    };
  }
}

// Mock draft generator that creates simple responses
export class MockDraftGenerator {
  async generateDraft(email: Email, analysis: AnalysisResult): Promise<string> {
    // Generate a simple mock reply based on the original email
    const senderName = email.from.split("<")[0].trim() || "there";

    return `Hi ${senderName},

Thank you for your email regarding "${email.subject}".

[This is a mock-generated draft for testing purposes]

Analysis reason: ${analysis.reason}

Best regards`;
  }
}

export const mockAnalyzer = new MockEmailAnalyzer();
export const mockDraftGenerator = new MockDraftGenerator();
