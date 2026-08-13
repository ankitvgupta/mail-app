/**
 * Feature-eval runner for the calendaring-agent.
 *
 * Given a fixture with an Email, calls CalendaringAgent.analyze() and
 * returns the JSON-stringified result for the judge to grade against
 * the rubric.
 */
import { CalendaringAgent } from "../../../src/main/services/calendaring-agent";
import type { Email } from "../../../src/shared/types";
import { resolveModelId, DEFAULT_MODEL_CONFIG } from "../../../src/shared/types";

interface CalendaringFixtureInput {
  email: Email;
}

function isInput(value: unknown): value is CalendaringFixtureInput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { email?: unknown }).email === "object" &&
    (value as { email?: unknown }).email !== null
  );
}

export async function runCalendaringFixture(
  input: unknown,
  fixtureId: string,
): Promise<string> {
  if (!isInput(input)) {
    throw new Error(`[calendaring-agent] fixture ${fixtureId}: input must be { email }`);
  }
  const agent = new CalendaringAgent(resolveModelId(DEFAULT_MODEL_CONFIG.calendaring));
  const result = await agent.analyze(input.email);
  return JSON.stringify(result, null, 2);
}
