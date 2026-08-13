/**
 * LLM-as-judge scorer for AI-feature evals.
 *
 * Grades a feature's output against a per-fixture markdown rubric using
 * Claude Sonnet, returning an integer 0-10 score and a free-text reason.
 *
 * Goes through AnthropicService.createMessage() — DO NOT instantiate
 * the SDK directly. The service handles retries with exponential
 * backoff on rate limits / server errors, and records every call to
 * the llm_calls table with caller="eval-judge:<fixtureId>" so judge
 * spend can be correlated back to specific fixtures.
 *
 * Failure modes:
 *   - Judge API throws, returns no text block, or returns unparseable
 *     JSON → return score 0 with `judgeError` set. The runner treats
 *     this distinct from a real score: no regression-delta check, and
 *     reports it separately so a Claude 5xx or parser bug doesn't
 *     masquerade as a model regression. (See #129 — a midpoint
 *     fallback score of 5 looked like a regression for any fixture
 *     baselined above 8.)
 *
 * Calibration is DEFERRED — see TODOS.md. Risk: judge might silently
 * mis-score for the first month. Mitigation is spot-checking the
 * traces in the report until we have a calibration suite.
 */

import { createMessage } from "../../../src/main/services/llm-service";

const JUDGE_MODEL = "claude-opus-4-7";

export interface JudgeResult {
  score: number;
  reason: string;
  /** Set when the judge itself failed (API error, no text block,
   *  unparseable response). The runner skips the baseline-delta check
   *  for these and reports them separately from real regressions. */
  judgeError?: string;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict grader evaluating the output of an AI feature against a rubric.

The rubric is a checklist of what good output looks like for this specific case.
Score from 0 to 10:
- 10 = meets every rubric point cleanly, no caveats
- 7-9 = meets the rubric with minor issues
- 4-6 = partially meets the rubric, notable gaps
- 1-3 = misses most of the rubric
- 0 = output is empty, malformed, or completely off-topic

Respond with ONLY a single JSON object on one line. No markdown, no prose:
{"score": <integer 0-10>, "reason": "<one short sentence>"}`;

function parseJudgeResponse(text: string): JudgeResult | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const candidates: string[] = [cleaned];
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match && match[0] !== cleaned) candidates.push(match[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) continue;
      const obj = parsed as { score?: unknown; reason?: unknown };
      const rawScore =
        typeof obj.score === "number"
          ? obj.score
          : typeof obj.score === "string"
            ? Number(obj.score)
            : NaN;
      if (!Number.isFinite(rawScore)) continue;
      const score = Math.max(0, Math.min(10, Math.round(rawScore)));
      const reason = typeof obj.reason === "string" ? obj.reason : String(obj.reason ?? "");
      return { score, reason };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Grade `featureOutput` against `rubric`. The fixtureId is included in
 * cost-tracking attribution so spend can be correlated to fixtures.
 */
export async function judge(
  featureOutput: string,
  rubric: string,
  fixtureId: string,
): Promise<JudgeResult> {
  const userContent = `RUBRIC (what good output looks like for this fixture):
${rubric}

FEATURE OUTPUT TO GRADE:
${featureOutput}

Grade strictly. Respond with the JSON object only.`;

  let responseText: string;
  try {
    const response = await createMessage(
      {
        model: JUDGE_MODEL,
        max_tokens: 512,
        system: [{ type: "text", text: JUDGE_SYSTEM_PROMPT }],
        messages: [{ role: "user", content: userContent }],
      },
      { caller: `eval-judge:${fixtureId}` },
    );
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      const reason = "judge returned no text block";
      console.warn(`[llm-judge] ${fixtureId}: ${reason}`);
      return { score: 0, reason, judgeError: reason };
    }
    responseText = block.text;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const reason = `judge API error: ${errMsg}`;
    console.warn(`[llm-judge] ${fixtureId}: ${reason}`);
    return { score: 0, reason, judgeError: reason };
  }

  const parsed = parseJudgeResponse(responseText);
  if (!parsed) {
    const reason = "judge response unparseable";
    console.warn(`[llm-judge] ${fixtureId}: ${reason}. Raw: ${responseText.slice(0, 200)}`);
    return { score: 0, reason, judgeError: reason };
  }
  return parsed;
}

/**
 * Legacy export for the old draft-quality stub. Throws unconditionally
 * because nothing currently consumes it — keep the symbol so any straggler
 * imports fail loudly during typecheck rather than at runtime.
 *
 * @deprecated Use `judge()` directly with a rubric.
 */
export async function judgeDraftQuality(_input: {
  fixtureId: string;
  email: unknown;
  draftBody: string;
  expectedFormality: "formal" | "casual" | "neutral";
}): Promise<never> {
  throw new Error("judgeDraftQuality is deprecated. Use judge(output, rubric, fixtureId) instead.");
}
