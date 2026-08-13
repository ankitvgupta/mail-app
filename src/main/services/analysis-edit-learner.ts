/**
 * Analysis Edit Learner
 *
 * When a user overrides an email's needs-reply classification (Priority vs Other),
 * this service:
 *
 * 1. If the user provides a reason:
 *    - Classifies scope (person/domain/category/global) via Claude
 *    - Saves directly as a promoted Memory with memory_type='analysis'
 *
 * 2. If no reason is provided:
 *    - Uses Claude to infer generalizable patterns from the email + override
 *    - Saves as draft memories (low-confidence) with memory_type='analysis'
 *    - Promotes to real Memory after 2 confirmations (lower threshold than drafting
 *      because priority overrides are rarer)
 *
 * Analysis memories are injected into the analysis prompt (not the draft prompt).
 */
import { randomUUID } from "crypto";
import { createMessage } from "./llm-service";
import { getFeatureModelConfig } from "../ipc/settings.ipc";
import {
  getDraftMemories,
  saveDraftMemory,
  incrementDraftMemoryVote,
  deleteDraftMemory,
  evictOldestDraftMemories,
  saveMemory,
  getMemories,
} from "../db";
import { consolidateMemoryScopes, filterAgainstPromotedMemories } from "./draft-edit-learner";
import { parseJsonArray, normalizeScope, CONSUMER_DOMAINS } from "./memory-learner-utils";
import type { Memory, MemoryScope, DraftMemory } from "../../shared/types";
import { createLogger } from "./logger";

const log = createLogger("analysis-edit-learner");

/** Promotion threshold — lower than drafting (3) since priority overrides are rarer */
const PROMOTION_THRESHOLD = 2;

/** Maximum number of analysis draft memories per account */
const MAX_DRAFT_MEMORIES = 500;

interface AnalysisOverride {
  emailId: string;
  accountId: string;
  senderEmail: string;
  senderDomain: string;
  subject: string;
  bodySnippet: string; // first ~500 chars of email body
  originalNeedsReply: boolean;
  newNeedsReply: boolean;
}

interface AnalysisObservation {
  scope: MemoryScope;
  scopeValue: string | null;
  content: string;
  emailContext: string | null;
}

export interface AnalysisLearnResult {
  promoted: Memory[];
  draftMemoriesCreated: number;
}

/**
 * Learn from a priority override with an explicit reason.
 * Saves directly as a promoted memory — no draft memory tier needed.
 */
export async function learnFromPriorityOverrideWithReason(params: {
  accountId: string;
  senderEmail: string;
  senderDomain: string;
  reason: string;
  emailId: string;
}): Promise<{ memory: Memory; saved: boolean }> {
  const { accountId, senderEmail, senderDomain, reason, emailId } = params;

  // Classify scope via Claude (cheap Haiku call)
  const scope = await classifyScope(reason, senderEmail, senderDomain);

  const now = Date.now();
  const memory: Memory = {
    id: randomUUID(),
    accountId,
    scope: scope.scope,
    scopeValue: scope.scopeValue,
    content: reason,
    source: "priority-override",
    sourceEmailId: emailId,
    enabled: true,
    memoryType: "analysis",
    createdAt: now,
    updatedAt: now,
  };

  // Check for duplicates against existing analysis memories
  const existing = getMemories(accountId, "analysis").filter((m) => m.enabled);
  const result = await consolidateMemoryScopes(
    { content: memory.content, scope: memory.scope, scopeValue: memory.scopeValue },
    existing,
    accountId,
    { source: "priority-override", memoryType: "analysis" },
  );

  if (result.action === "duplicate") {
    log.info(`[AnalysisEditLearner] Memory with reason already covered — skipping`);
    return { memory, saved: false };
  } else if (result.action === "consolidate") {
    // consolidateMemoryScopes already persisted changes (deleted overlapping, possibly created global)
    if (result.createdGlobal) {
      log.info(
        `[AnalysisEditLearner] Consolidated into global memory: ${result.createdGlobal.content}`,
      );
      return { memory: result.createdGlobal, saved: true };
    }
    log.info(`[AnalysisEditLearner] Consolidated existing memories — not saving original`);
    return { memory, saved: false };
  } else {
    saveMemory(memory);
    log.info(
      `[AnalysisEditLearner] Saved analysis memory with reason: [${scope.scope}${scope.scopeValue ? `:${scope.scopeValue}` : ""}] ${reason}`,
    );
    return { memory, saved: true };
  }
}

/**
 * Learn from a priority override without a reason.
 * Uses Claude to infer patterns, saves as draft memories, promotes after threshold.
 */
export async function learnFromPriorityOverrideInferred(
  override: AnalysisOverride,
): Promise<AnalysisLearnResult> {
  const { accountId, senderEmail, senderDomain, subject } = override;

  log.info(
    `[AnalysisEditLearner] Inferring patterns from priority override: ${formatOverrideDescription(override)}`,
  );

  // 1. Extract observations via Claude
  const observations = await analyzeOverride(override);
  if (!observations || observations.length === 0) {
    log.info(`[AnalysisEditLearner] No observations extracted — nothing to save`);
    return { promoted: [], draftMemoriesCreated: 0 };
  }

  // 2. Filter against already-promoted analysis memories
  const promotedMemories = getMemories(accountId, "analysis").filter((m) => m.enabled);
  const filteredObservations = await filterAgainstPromotedMemories(observations, promotedMemories);
  if (filteredObservations.length === 0) {
    log.info(`[AnalysisEditLearner] All observations already covered by promoted memories`);
    return { promoted: [], draftMemoriesCreated: 0 };
  }

  // 3. Get existing analysis draft memories for matching
  const existingDraftMemories = getDraftMemories(accountId, "analysis");

  // 4. Match observations to existing draft memories
  let matches: Array<{ observationIndex: number; matchedDraftMemoryId: string | null }>;
  if (existingDraftMemories.length > 0) {
    matches = await matchAnalysisDraftMemories(filteredObservations, existingDraftMemories);
  } else {
    matches = filteredObservations.map((_, i) => ({
      observationIndex: i,
      matchedDraftMemoryId: null,
    }));
  }

  // 5. Process each observation
  const promoted: Memory[] = [];
  let draftMemoriesCreated = 0;
  const now = Date.now();
  const sourceEmailId = override.emailId;

  for (const match of matches) {
    const observation = filteredObservations[match.observationIndex];
    if (!observation) continue;

    if (match.matchedDraftMemoryId) {
      // Vote on existing draft memory
      const updated = incrementDraftMemoryVote(match.matchedDraftMemoryId, sourceEmailId);
      if (!updated) continue;

      log.info(
        `[AnalysisEditLearner] Voted on draft memory ${match.matchedDraftMemoryId} (now ${updated.voteCount} votes): ${updated.content}`,
      );

      // Check for promotion (threshold = 2 for analysis)
      if (updated.voteCount >= PROMOTION_THRESHOLD) {
        const currentPromoted = getMemories(accountId, "analysis").filter((m) => m.enabled);
        const result = await consolidateMemoryScopes(
          {
            content: updated.content,
            scope: updated.scope,
            scopeValue:
              updated.scopeValue === null || updated.scope === "global" ? null : updated.scopeValue,
          },
          currentPromoted,
          accountId,
          { source: "priority-override", memoryType: "analysis" },
        );

        if (result.action === "duplicate") {
          log.info(
            `[AnalysisEditLearner] Draft memory "${updated.content}" already covered — deleting`,
          );
          deleteDraftMemory(updated.id);
          continue;
        }

        log.info(`[AnalysisEditLearner] Promoting draft memory: ${updated.content}`);
        const memory: Memory = {
          id: randomUUID(),
          accountId,
          scope: updated.scope,
          scopeValue: updated.scope === "global" ? null : updated.scopeValue,
          content: updated.content,
          source: "priority-override",
          enabled: true,
          memoryType: "analysis",
          createdAt: now,
          updatedAt: now,
        };

        if (result.action === "consolidate") {
          // Remove any previously-promoted memories that consolidation just deleted
          if (result.deletedIds.length > 0) {
            const deletedSet = new Set(result.deletedIds);
            for (let i = promoted.length - 1; i >= 0; i--) {
              if (deletedSet.has(promoted[i].id)) {
                promoted.splice(i, 1);
              }
            }
          }
          if (result.createdGlobal) {
            promoted.push(result.createdGlobal);
          }
          // else: global already exists, candidate is covered — don't save
        } else {
          saveMemory(memory);
          promoted.push(memory);
        }
        deleteDraftMemory(updated.id);
      } else {
        draftMemoriesCreated++;
      }
    } else {
      // Create new draft memory
      const dm: DraftMemory = {
        id: randomUUID(),
        accountId,
        scope: observation.scope,
        scopeValue: observation.scopeValue,
        content: observation.content,
        voteCount: 1,
        sourceEmailIds: [sourceEmailId],
        senderEmail,
        senderDomain,
        subject,
        emailContext: observation.emailContext,
        memoryType: "analysis",
        createdAt: now,
        lastVotedAt: now,
      };
      saveDraftMemory(dm);
      draftMemoriesCreated++;
      log.info(
        `[AnalysisEditLearner] Created draft memory: [${dm.scope}${dm.scopeValue ? `:${dm.scopeValue}` : ""}] ${dm.content}`,
      );
    }
  }

  // 6. Enforce cap
  evictOldestDraftMemories(accountId, MAX_DRAFT_MEMORIES, "analysis");

  log.info(
    `[AnalysisEditLearner] Done: ${promoted.length} promoted, ${draftMemoriesCreated} draft memories`,
  );
  return { promoted, draftMemoriesCreated };
}

/**
 * Use Claude to extract generalizable observations from a priority override.
 */
async function analyzeOverride(override: AnalysisOverride): Promise<AnalysisObservation[] | null> {
  // Skip API call in test/demo mode
  if (process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true") {
    return null;
  }

  // Honor the user's provider choice for analysis. When routed to Ollama, we
  // use the configured Ollama model — the hardcoded Claude model below would
  // be invalid there. (For Anthropic the hardcoded model wins as before.)
  const { provider, model: ollamaModel } = getFeatureModelConfig("analysis");
  const isOllama = provider === "ollama-cloud";

  const overrideDesc = formatOverrideDescription(override);

  const response = await createMessage(
    {
      model: isOllama ? ollamaModel : "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are analyzing why a user changed the Priority/Other classification of an email. Each email is classified as either Priority (needs a reply from the user) or Other (no reply needed). Extract up to 3 generalizable rules about how this type of email should be classified in the future.

CONTEXT:
- From: <sender_email>${override.senderEmail}</sender_email> (domain: <sender_domain>${override.senderDomain}</sender_domain>)
- Subject: <subject>${override.subject}</subject>
- Body preview: <body>${override.bodySnippet}</body>

OVERRIDE:
${overrideDesc}

ANALYSIS FRAMEWORK:
Think about WHY the user changed this classification:
1. Is it about this specific sender? (e.g., "emails from my manager always need a reply")
2. Is it about the domain/organization? (e.g., "emails from @ourcompany.com are always important")
3. Is it about the type of email? (e.g., "recruiter outreach always needs a reply")
4. Is it a global rule? (e.g., "emails with direct questions always need replies")

SCOPE RULES:
- "person": applies only to ${override.senderEmail}
- "domain": applies to everyone at ${override.senderDomain}${CONSUMER_DOMAINS.has(override.senderDomain) ? " — WARNING: this is a consumer domain (gmail.com etc), so domain scope is rarely appropriate. Use person scope instead." : ""}
- "category": applies to a type of email (specify category name, e.g. "recruiter-outreach", "github-notifications")
- "global": applies to ALL emails — use sparingly

OUTPUT FORMAT:
Return a JSON array. Each item:
{"scope":"...","scopeValue":"...or null","content":"directive about how to classify these emails","emailContext":"5-10 word description of the email"}

Content should be a clear directive for an email triage system, like:
- "Emails from this sender always need a reply — they are my manager"
- "GitHub review requests (not just notifications) should be marked as priority"
- "Recruiter outreach should be marked as priority"
- "Emails with direct questions to me should never be skipped"

Return [] if the override seems purely situational with no generalizable pattern.
Respond with ONLY the JSON array.`,
        },
      ],
    },
    {
      caller: "analysis-edit-learner-analyze",
      provider,
      emailId: override.emailId,
      accountId: override.accountId,
    },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";

  const parsed = parseJsonArray<{
    scope: string;
    scopeValue: string | null;
    content: string;
    emailContext?: string;
  }>(text);

  if (!parsed || parsed.length === 0) return null;

  return parsed
    .filter((item) => item.content && typeof item.content === "string")
    .slice(0, 3)
    .map((item) => ({ ...item, content: item.content.slice(0, 500) }))
    .map((item) => {
      const normalized = normalizeScope(
        item.scope,
        item.scopeValue,
        override.senderEmail,
        override.senderDomain,
      );
      return {
        scope: normalized.scope,
        scopeValue: normalized.scopeValue,
        content: item.content,
        emailContext: item.emailContext?.slice(0, 200) ?? null,
      };
    });
}

/**
 * Match new observations against existing analysis draft memories.
 */
async function matchAnalysisDraftMemories(
  observations: AnalysisObservation[],
  draftMemories: DraftMemory[],
): Promise<Array<{ observationIndex: number; matchedDraftMemoryId: string | null }>> {
  // Skip API call in test/demo mode
  if (process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true") {
    return observations.map((_, i) => ({ observationIndex: i, matchedDraftMemoryId: null }));
  }

  const { provider, model: ollamaModel } = getFeatureModelConfig("analysis");
  const isOllama = provider === "ollama-cloud";

  const response = await createMessage(
    {
      model: isOllama ? ollamaModel : "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Match each new observation to an existing draft memory that describes the SAME underlying priority/classification preference, or mark it as new.

EXISTING DRAFT MEMORIES:
${draftMemories.map((dm, i) => `[${i}] id=${dm.id} [${dm.scope}${dm.scopeValue ? `:${dm.scopeValue}` : ""}] ${dm.content}`).join("\n")}

NEW OBSERVATIONS:
${observations.map((o, i) => `[${i}] [${o.scope}${o.scopeValue ? `:${o.scopeValue}` : ""}] ${o.content}`).join("\n")}

For each observation, return the id of the matching draft memory, or null if new.
Respond with ONLY a JSON array: [{"observationIndex": 0, "matchedDraftMemoryId": "..." or null}, ...]`,
        },
      ],
    },
    { caller: "analysis-edit-learner-match", provider },
  );

  // Find the first text block — Ollama-routed thinking models emit a
  // `thinking` block before the `text` block, so content[0] would be the
  // wrong type and we'd silently parse "" → degraded match results.
  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";
  const parsed = parseJsonArray<{
    observationIndex: number;
    matchedDraftMemoryId: string | null;
  }>(text);

  if (!parsed) {
    return observations.map((_, i) => ({ observationIndex: i, matchedDraftMemoryId: null }));
  }

  const validIds = new Set(draftMemories.map((dm) => dm.id));
  return parsed.map((item) => ({
    observationIndex: item.observationIndex,
    matchedDraftMemoryId:
      item.matchedDraftMemoryId && validIds.has(item.matchedDraftMemoryId)
        ? item.matchedDraftMemoryId
        : null,
  }));
}

/**
 * Classify the scope for an explicit user-provided reason.
 */
async function classifyScope(
  reason: string,
  senderEmail: string,
  senderDomain: string,
): Promise<{ scope: MemoryScope; scopeValue: string | null }> {
  // Skip API call in test/demo mode — default to person scope
  if (process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true") {
    return { scope: "person", scopeValue: senderEmail.toLowerCase() };
  }

  const { provider, model: ollamaModel } = getFeatureModelConfig("analysis");
  const isOllama = provider === "ollama-cloud";

  const response = await createMessage(
    {
      model: isOllama ? ollamaModel : "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `Classify the scope of this email priority preference.

Preference: "${reason}"
Sender: ${senderEmail} (domain: ${senderDomain})

Scopes:
- "person": specific to this sender (${senderEmail})
- "domain": applies to the organization (${senderDomain})${CONSUMER_DOMAINS.has(senderDomain) ? " — consumer domain, almost never appropriate" : ""}
- "category": applies to a type of email (provide category name like "recruiter-outreach")
- "global": applies to ALL emails

Return ONLY JSON: {"scope":"...","scopeValue":"...or null"}
For person: scopeValue = "${senderEmail.toLowerCase()}"
For domain: scopeValue = "${senderDomain.toLowerCase()}"
For category: scopeValue = "category-name"
For global: scopeValue = null`,
        },
      ],
    },
    { caller: "analysis-edit-learner-classify-scope", provider },
  );

  // Find the first text block — Ollama-routed thinking models emit a
  // `thinking` block before the `text` block, so content[0] would be the
  // wrong type and we'd silently parse "" → degraded match results.
  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";
  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("no JSON");
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      scope: string;
      scopeValue: string | null;
    };
    return normalizeScope(
      parsed.scope,
      parsed.scopeValue,
      senderEmail.toLowerCase(),
      senderDomain.toLowerCase(),
    );
  } catch {
    // Default to person scope
    return { scope: "person", scopeValue: senderEmail.toLowerCase() };
  }
}

function formatOverrideDescription(override: AnalysisOverride): string {
  const fromLabel = override.originalNeedsReply ? "Priority (needs reply)" : "Other (no reply)";
  const toLabel = override.newNeedsReply ? "Priority (needs reply)" : "Other (no reply)";
  return `Changed from "${fromLabel}" to "${toLabel}"`;
}
