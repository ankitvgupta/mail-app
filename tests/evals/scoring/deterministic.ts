/**
 * Deterministic scoring for email analysis evals.
 *
 * Scores the binary needs_reply classification with exact match.
 * No LLM calls — fast and fully reproducible.
 */

import type { AnalysisResult } from "../../../src/shared/types";

export interface EvalFixtureExpected {
  needs_reply: boolean;
}

export interface DeterministicResult {
  fixture_id: string;
  needs_reply_correct: boolean;
  /** 0-10 scale: 10 for needs_reply match, 0 otherwise. */
  score: number;
}

/**
 * Score a single analysis result against the expected fixture output.
 *
 * Scoring is binary: 10 points when needs_reply matches, 0 otherwise.
 * (Issue #143 collapsed the three-level priority into a single
 * Priority/Other classification, so there is nothing else to score.)
 */
export function scoreDeterministic(
  fixtureId: string,
  actual: AnalysisResult,
  expected: EvalFixtureExpected,
): DeterministicResult {
  const needsReplyCorrect = actual.needs_reply === expected.needs_reply;

  return {
    fixture_id: fixtureId,
    needs_reply_correct: needsReplyCorrect,
    score: needsReplyCorrect ? 10 : 0,
  };
}
