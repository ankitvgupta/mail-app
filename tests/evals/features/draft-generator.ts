/**
 * Feature-eval runner for the draft-generator service.
 *
 * Given a fixture with an Email and an AnalysisResult, generates a draft
 * via DraftGenerator and returns the draft body as the string the LLM
 * judge will grade against the fixture's rubric.
 *
 * The judge sees only the draft body — not the rubric inputs and not the
 * fixture's expected behavior. That keeps the grading honest.
 */

import { DraftGenerator } from "../../../src/main/services/draft-generator";
import { resolveModelId, DEFAULT_MODEL_CONFIG } from "../../../src/shared/types";
import type { Email, AnalysisResult } from "../../../src/shared/types";

interface DraftGeneratorFixtureInput {
  email: Email;
  analysis: AnalysisResult;
}

function isDraftGeneratorFixtureInput(value: unknown): value is DraftGeneratorFixtureInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { email?: unknown; analysis?: unknown };
  return (
    typeof v.email === "object" &&
    v.email !== null &&
    typeof v.analysis === "object" &&
    v.analysis !== null
  );
}

export async function runDraftGeneratorFixture(
  input: unknown,
  fixtureId: string,
): Promise<string> {
  if (!isDraftGeneratorFixtureInput(input)) {
    throw new Error(
      `[draft-generator] fixture ${fixtureId}: input must be { email, analysis }`,
    );
  }

  // Use the default prompt + default model so the eval reflects what
  // ships, not a test-only configuration. EA + sender lookup are off so
  // we isolate the draft-generation behavior; those flows have their
  // own (TODO) eval suites.
  const generator = new DraftGenerator(resolveModelId(DEFAULT_MODEL_CONFIG.drafts));
  const response = await generator.generateDraft(input.email, input.analysis, undefined, {
    enableSenderLookup: false,
  });
  return response.body;
}
