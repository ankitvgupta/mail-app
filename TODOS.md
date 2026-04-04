# TODOS

## Observability UI

Settings panels for AI Usage (cost breakdown by model/caller), Debug Logs (filterable log viewer from pino JSON files), and System Health (sync status, error rates, agent task history). The backend data is already available: `llm_calls` table for usage, daily log files for logs, and `agent_audit_log` for agent history. This is purely a renderer-side feature.

**Depends on:** AnthropicService cost tracking (done), Logger file output (done)
**Added:** 2026-03-29, Exo infrastructure review

## Circuit Breaker + Concurrency Control for AnthropicService

AnthropicService retries on transient errors but has no circuit breaker (continued retries when the API is down for extended periods) and no concurrency limit (PrefetchService can fire many parallel calls). Add a circuit breaker that opens after N consecutive failures and a semaphore to cap concurrent in-flight requests.

**Depends on:** AnthropicService (done)
**Added:** 2026-03-29, Exo infrastructure review

## Dynamic Pricing Updates

Model pricing in AnthropicService is hardcoded. Move pricing to a config file or fetch from a pricing endpoint so costs stay accurate without code changes when Anthropic updates prices.

**Depends on:** AnthropicService (done)
**Added:** 2026-03-29, Exo infrastructure review

## P3: Enrichment source badge on sidebar panels
Show a small badge ("Web Search", "YC") on each enrichment sidebar panel so users know where data came from. Currently no attribution on enrichment data. Renderer-only change — enrichment data already carries extensionId.
- **Effort:** S (CC: ~5 min)
- **Depends on:** Nothing — can be done anytime
- **Context:** Surfaced during CEO review of OpenClaw agent provider feature. Not related to agent provider itself — applies to existing enrichment extension panels.

## Memory System

### P2: Memory conflict detection
- **What:** Warn users in Settings > Memories when contradictory memories exist (e.g., global "be formal" vs person "be casual with Sarah")
- **Why:** As memory count grows across multiple learning sources, invisible conflicts will cause confusing AI behavior
- **Effort:** M (human: ~1 week / CC: ~30 min)
- **Depends on:** Unified memory learner pipeline
- **Context:** Contradiction detection is fuzzy — needs an LLM call (Haiku) to compare memory pairs. The scope hierarchy (person > domain > category > global) handles precedence implicitly, but users have no visibility into conflicts. Start with same-scope contradictions, then cross-scope.

### P2: Re-analyze sibling emails after priority override
- **What:** After a priority override, optionally re-analyze other emails from the same sender that were previously classified differently
- **Why:** If you override one email from recruiter@company.com to "low", the other 9 from the same sender stay at their old classification until next sync cycle — which may never re-analyze already-analyzed emails
- **Effort:** M (human: ~3 days / CC: ~20 min)
- **Depends on:** Unified memory learner pipeline (memories must exist before re-analysis makes sense)
- **Context:** Could be automatic (re-analyze all from sender) or prompted ("Apply this classification to 9 other emails from this sender?"). The latter is better UX — gives user control.

### P3: Full-text search in Memories tab
- **What:** Add a search input in Settings > Memories that filters memories by content text
- **Why:** Finding specific memories gets harder as count grows across manual, draft-edit, and priority-override sources
- **Effort:** S (human: ~1 hr / CC: ~5 min)
- **Depends on:** Nothing
- **Context:** Simple client-side filter on existing data. The memory list is already loaded in the MemoriesTab component.

### P3: Memory effectiveness tracking
- **What:** After an override creates a memory, track whether the next email from the same sender/domain is classified according to the memory. Log a "memory effectiveness" metric.
- **Why:** Without validation, memories accumulate but you never know if they're working. Could lead to memory bloat with redundant rules.
- **Effort:** M (human: ~3 days / CC: ~15 min)
- **Depends on:** Unified memory learner pipeline
- **Context:** The design doc's "after shipping" assignment (override 10-15 emails, track which memories form) partially addresses this manually. An automated metric would be more rigorous — track `memory_injected` + `classification_matched_memory` events to compute hit rate per memory.

### P3: Undo promoted memory on override revert
- **What:** Handle edge case where user undoes an override but the memory was already promoted (crossed vote threshold)
- **Why:** Promoted memories actively influence future classifications. Deleting them has broader impact than deleting draft memories.
- **Effort:** S (human: ~2 hrs / CC: ~10 min)
- **Depends on:** Undo override feature
- **Context:** Current undo only handles the simple case (delete draft memory or most recent memory). If a memory was promoted and has influenced other analyses, deleting it may cause re-classification inconsistency. Options: (A) delete regardless, (B) redirect to Settings > Memories for manual disable.

## Performance

### P2: Optimize getInboxEmails() query performance
- **What:** Add indexes on label_ids, avoid scanning all emails for thread merge when merge cache is already warm, reduce column selection for non-renderer callers
- **Why:** Non-startup callers of processAllPending (prompt change, rerun drafts) still hit the expensive 2-query + Union-Find path. With large inboxes (1000+ emails), this takes 50-100ms on the main thread.
- **Effort:** M (human: ~1 day / CC: ~15 min)
- **Depends on:** Nothing
- **Context:** The startup path was fixed by caching sync:get-emails results (see prefetch cache PR). But callers 2-5 of processAllPending still run the full query. The merge cache (`_mergeGroupsByAccount`) is usually warm, so `buildMergeCache` could short-circuit. The LIKE '%"INBOX"%' pattern on label_ids defeats indexes — consider a boolean `is_inbox` column or a normalized labels table.
- **Added:** 2026-04-03, eng review of prefetch startup fix
