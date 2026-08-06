/**
 * Feature-eval runner for the archive-ready-analyzer.
 *
 * Takes a thread (array of DashboardEmail) and runs
 * ArchiveReadyAnalyzer.analyzeThread() against it. Returns the JSON
 * result for the judge.
 */
import { ArchiveReadyAnalyzer } from "../../../src/main/services/archive-ready-analyzer";
import type { DashboardEmail } from "../../../src/shared/types";
import { resolveModelId, DEFAULT_MODEL_CONFIG } from "../../../src/shared/types";

interface ArchiveReadyFixtureInput {
  thread: DashboardEmail[];
  userEmail?: string;
}

function isInput(value: unknown): value is ArchiveReadyFixtureInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { thread?: unknown };
  return Array.isArray(v.thread);
}

export async function runArchiveReadyFixture(
  input: unknown,
  fixtureId: string,
): Promise<string> {
  if (!isInput(input)) {
    throw new Error(
      `[archive-ready] fixture ${fixtureId}: input must be { thread: DashboardEmail[], userEmail? }`,
    );
  }
  const analyzer = new ArchiveReadyAnalyzer(resolveModelId(DEFAULT_MODEL_CONFIG.archiveReady));
  const result = await analyzer.analyzeThread(input.thread, input.userEmail);
  return JSON.stringify(result, null, 2);
}
