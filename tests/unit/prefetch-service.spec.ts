/**
 * Unit tests for PrefetchService (src/main/services/prefetch-service.ts)
 *
 * The PrefetchService cannot be imported directly because it transitively
 * imports electron, DB, and many other main-process modules. We re-implement
 * the pure/testable logic inline and test it in isolation.
 *
 * Testable pure logic:
 * - extractSenderEmail: parses sender email from "Name <email>" format
 * - Priority sorting: queue ordering by priority number
 * - Sender deduplication: pendingSenderLookups tracking
 * - Progress reporting: getProgress shape and state
 * - markAgentDraftDone: ring buffer management for completed drafts
 * - queueSenderProfiles: priority-based sorting and filtering
 *
 * What needs integration tests (not covered here):
 * - processQueue orchestration (requires DB, Anthropic API, electron IPC)
 * - processAnalysis / processSenderProfile / processAgentDraft / processArchiveReady
 * - queueEmails (calls getEmail from DB)
 * - processAllPending (calls getInboxEmails, getConfig, etc.)
 */
import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Re-implement extractSenderEmail
// ---------------------------------------------------------------------------

function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase();
}

// ---------------------------------------------------------------------------
// Re-implement priority queue sorting
// ---------------------------------------------------------------------------

interface PrefetchTask {
  emailId: string;
  type: "analysis" | "sender-profile" | "agent-draft" | "archive-ready";
  threadId?: string;
  accountId?: string;
  priority: number;
}

function sortByPriority(queue: PrefetchTask[]): PrefetchTask[] {
  return [...queue].sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// Re-implement AgentDraftItem tracking (ring buffer)
// ---------------------------------------------------------------------------

interface AgentDraftItem {
  emailId: string;
  subject: string;
  from: string;
  priority: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
}

class AgentDraftTracker {
  private agentDraftItems = new Map<string, AgentDraftItem>();
  private completedAgentDraftLog: AgentDraftItem[] = [];

  addItem(item: AgentDraftItem): void {
    this.agentDraftItems.set(item.emailId, item);
  }

  getItem(emailId: string): AgentDraftItem | undefined {
    return this.agentDraftItems.get(emailId);
  }

  markDone(emailId: string, status: "completed" | "failed"): void {
    const item = this.agentDraftItems.get(emailId);
    if (item) {
      item.status = status;
      item.completedAt = Date.now();
      this.completedAgentDraftLog.push({ ...item });
      if (this.completedAgentDraftLog.length > 50) {
        this.completedAgentDraftLog.shift();
      }
      this.agentDraftItems.delete(emailId);
    }
  }

  get activeCount(): number {
    return this.agentDraftItems.size;
  }

  get completedLog(): AgentDraftItem[] {
    return this.completedAgentDraftLog;
  }
}

// ---------------------------------------------------------------------------
// Re-implement sender deduplication logic
// ---------------------------------------------------------------------------

class SenderDeduplicator {
  private pendingSenderLookups = new Map<string, string[]>();
  private processedSenderProfiles = new Set<string>();

  shouldQueue(senderEmail: string, emailId: string): "queue" | "deduplicate" | "skip" {
    if (this.processedSenderProfiles.has(senderEmail)) return "skip";
    if (this.pendingSenderLookups.has(senderEmail)) {
      this.pendingSenderLookups.get(senderEmail)!.push(emailId);
      return "deduplicate";
    }
    this.pendingSenderLookups.set(senderEmail, [emailId]);
    return "queue";
  }

  markProcessed(senderEmail: string): void {
    this.processedSenderProfiles.add(senderEmail);
  }

  getWaitingEmails(senderEmail: string): string[] {
    return this.pendingSenderLookups.get(senderEmail) || [];
  }

  cleanupPending(senderEmail: string): void {
    this.pendingSenderLookups.delete(senderEmail);
  }
}

// ---------------------------------------------------------------------------
// Re-implement progress reporting shape
// ---------------------------------------------------------------------------

type PrefetchStatus = "idle" | "running" | "error";

interface PrefetchProgress {
  status: PrefetchStatus;
  queueLength: number;
  currentTask?: {
    emailId: string;
    type: PrefetchTask["type"];
  };
  processed: {
    analysis: number;
    senderProfile: number;
    draft: number;
    extensionEnrichment: number;
  };
}

function buildProgress(
  status: PrefetchStatus,
  queueLength: number,
  processedCounts: PrefetchProgress["processed"],
  currentTask?: PrefetchTask,
): PrefetchProgress {
  return {
    status,
    queueLength,
    currentTask: currentTask ? { emailId: currentTask.emailId, type: currentTask.type } : undefined,
    processed: { ...processedCounts },
  };
}

// ---------------------------------------------------------------------------
// Re-implement priority assignment for sender profiles
// ---------------------------------------------------------------------------

function assignSenderProfilePriority(
  needsReply: boolean,
  analysisPriority?: "high" | "medium" | "low" | "skip",
): number {
  let priority = 40; // Default: no reply needed
  if (needsReply) {
    switch (analysisPriority) {
      case "high":
        priority = 10;
        break;
      case "medium":
        priority = 20;
        break;
      case "low":
        priority = 30;
        break;
    }
  }
  return priority;
}

// ---------------------------------------------------------------------------
// Tests: extractSenderEmail
// ---------------------------------------------------------------------------

test.describe("extractSenderEmail", () => {
  test("extracts email from angle bracket format", () => {
    expect(extractSenderEmail("Alice Smith <alice@example.com>")).toBe("alice@example.com");
  });

  test("handles bare email address", () => {
    expect(extractSenderEmail("alice@example.com")).toBe("alice@example.com");
  });

  test("lowercases the result", () => {
    expect(extractSenderEmail("Alice <ALICE@Example.COM>")).toBe("alice@example.com");
  });

  test("lowercases bare email", () => {
    expect(extractSenderEmail("ALICE@EXAMPLE.COM")).toBe("alice@example.com");
  });

  test("handles name with special characters", () => {
    expect(extractSenderEmail('"O\'Brien, John" <john@example.com>')).toBe("john@example.com");
  });

  test("handles empty string", () => {
    expect(extractSenderEmail("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests: priority queue sorting
// ---------------------------------------------------------------------------

test.describe("priority queue sorting", () => {
  test("sorts by priority number ascending (lower = higher priority)", () => {
    const queue: PrefetchTask[] = [
      { emailId: "c", type: "archive-ready", priority: 90 },
      { emailId: "a", type: "agent-draft", priority: 5 },
      { emailId: "b", type: "sender-profile", priority: 20 },
      { emailId: "d", type: "analysis", priority: 0 },
    ];

    const sorted = sortByPriority(queue);

    expect(sorted.map((t) => t.emailId)).toEqual(["d", "a", "b", "c"]);
  });

  test("preserves order for equal priorities", () => {
    const queue: PrefetchTask[] = [
      { emailId: "a", type: "analysis", priority: 10 },
      { emailId: "b", type: "analysis", priority: 10 },
    ];

    const sorted = sortByPriority(queue);

    expect(sorted.map((t) => t.emailId)).toEqual(["a", "b"]);
  });

  test("analysis (0) < agent-draft high (5) < sender-profile high (10)", () => {
    const queue: PrefetchTask[] = [
      { emailId: "sender", type: "sender-profile", priority: 10 },
      { emailId: "draft", type: "agent-draft", priority: 5 },
      { emailId: "analysis", type: "analysis", priority: 0 },
    ];

    const sorted = sortByPriority(queue);

    expect(sorted[0].type).toBe("analysis");
    expect(sorted[1].type).toBe("agent-draft");
    expect(sorted[2].type).toBe("sender-profile");
  });
});

// ---------------------------------------------------------------------------
// Tests: AgentDraftTracker (ring buffer)
// ---------------------------------------------------------------------------

test.describe("AgentDraftTracker", () => {
  test("tracks active items", () => {
    const tracker = new AgentDraftTracker();
    tracker.addItem({
      emailId: "e1",
      subject: "Test",
      from: "alice@example.com",
      priority: "high",
      status: "running",
      startedAt: Date.now(),
    });

    expect(tracker.activeCount).toBe(1);
    expect(tracker.getItem("e1")?.status).toBe("running");
  });

  test("markDone moves item to completed log and removes from active", () => {
    const tracker = new AgentDraftTracker();
    tracker.addItem({
      emailId: "e1",
      subject: "Test",
      from: "alice@example.com",
      priority: "high",
      status: "running",
      startedAt: Date.now(),
    });

    tracker.markDone("e1", "completed");

    expect(tracker.activeCount).toBe(0);
    expect(tracker.getItem("e1")).toBeUndefined();
    expect(tracker.completedLog).toHaveLength(1);
    expect(tracker.completedLog[0].status).toBe("completed");
    expect(tracker.completedLog[0].completedAt).toBeDefined();
  });

  test("markDone with 'failed' status is tracked", () => {
    const tracker = new AgentDraftTracker();
    tracker.addItem({
      emailId: "e1",
      subject: "Test",
      from: "alice@example.com",
      priority: "high",
      status: "running",
    });

    tracker.markDone("e1", "failed");

    expect(tracker.completedLog[0].status).toBe("failed");
  });

  test("ring buffer caps at 50 entries", () => {
    const tracker = new AgentDraftTracker();

    // Add and complete 60 items
    for (let i = 0; i < 60; i++) {
      tracker.addItem({
        emailId: `e${i}`,
        subject: `Test ${i}`,
        from: "alice@example.com",
        priority: "medium",
        status: "running",
      });
      tracker.markDone(`e${i}`, "completed");
    }

    expect(tracker.completedLog).toHaveLength(50);
    // First 10 should have been shifted out
    expect(tracker.completedLog[0].emailId).toBe("e10");
    expect(tracker.completedLog[49].emailId).toBe("e59");
  });

  test("markDone is a no-op for unknown emailId", () => {
    const tracker = new AgentDraftTracker();
    tracker.markDone("nonexistent", "completed");
    expect(tracker.completedLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: SenderDeduplicator
// ---------------------------------------------------------------------------

test.describe("SenderDeduplicator", () => {
  test("first occurrence returns 'queue'", () => {
    const dedup = new SenderDeduplicator();
    const result = dedup.shouldQueue("alice@example.com", "e1");
    expect(result).toBe("queue");
  });

  test("second occurrence of same sender returns 'deduplicate'", () => {
    const dedup = new SenderDeduplicator();
    dedup.shouldQueue("alice@example.com", "e1");
    const result = dedup.shouldQueue("alice@example.com", "e2");
    expect(result).toBe("deduplicate");
  });

  test("different senders are tracked independently", () => {
    const dedup = new SenderDeduplicator();
    expect(dedup.shouldQueue("alice@example.com", "e1")).toBe("queue");
    expect(dedup.shouldQueue("bob@example.com", "e2")).toBe("queue");
  });

  test("already-processed sender returns 'skip'", () => {
    const dedup = new SenderDeduplicator();
    dedup.markProcessed("alice@example.com");
    expect(dedup.shouldQueue("alice@example.com", "e1")).toBe("skip");
  });

  test("getWaitingEmails returns all queued emailIds for a sender", () => {
    const dedup = new SenderDeduplicator();
    dedup.shouldQueue("alice@example.com", "e1");
    dedup.shouldQueue("alice@example.com", "e2");
    dedup.shouldQueue("alice@example.com", "e3");

    const waiting = dedup.getWaitingEmails("alice@example.com");
    expect(waiting).toEqual(["e1", "e2", "e3"]);
  });

  test("cleanupPending removes pending lookups", () => {
    const dedup = new SenderDeduplicator();
    dedup.shouldQueue("alice@example.com", "e1");
    dedup.cleanupPending("alice@example.com");

    // After cleanup, a new queue for the same sender is treated as fresh
    const result = dedup.shouldQueue("alice@example.com", "e2");
    expect(result).toBe("queue");
  });

  test("getWaitingEmails returns empty array for unknown sender", () => {
    const dedup = new SenderDeduplicator();
    expect(dedup.getWaitingEmails("unknown@example.com")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: progress reporting
// ---------------------------------------------------------------------------

test.describe("buildProgress", () => {
  test("builds idle progress with no current task", () => {
    const progress = buildProgress("idle", 0, {
      analysis: 0,
      senderProfile: 0,
      draft: 0,
      extensionEnrichment: 0,
    });

    expect(progress.status).toBe("idle");
    expect(progress.queueLength).toBe(0);
    expect(progress.currentTask).toBeUndefined();
    expect(progress.processed.analysis).toBe(0);
  });

  test("builds running progress with current task", () => {
    const task: PrefetchTask = {
      emailId: "e1",
      type: "analysis",
      priority: 0,
    };
    const progress = buildProgress(
      "running",
      5,
      { analysis: 3, senderProfile: 1, draft: 0, extensionEnrichment: 2 },
      task,
    );

    expect(progress.status).toBe("running");
    expect(progress.queueLength).toBe(5);
    expect(progress.currentTask).toEqual({
      emailId: "e1",
      type: "analysis",
    });
    expect(progress.processed.analysis).toBe(3);
    expect(progress.processed.senderProfile).toBe(1);
    expect(progress.processed.extensionEnrichment).toBe(2);
  });

  test("processed counts are a copy (not a reference)", () => {
    const counts = {
      analysis: 5,
      senderProfile: 3,
      draft: 1,
      extensionEnrichment: 0,
    };
    const progress = buildProgress("idle", 0, counts);
    counts.analysis = 100;
    expect(progress.processed.analysis).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tests: assignSenderProfilePriority
// ---------------------------------------------------------------------------

test.describe("assignSenderProfilePriority", () => {
  test("returns 10 for high priority needs-reply email", () => {
    expect(assignSenderProfilePriority(true, "high")).toBe(10);
  });

  test("returns 20 for medium priority needs-reply email", () => {
    expect(assignSenderProfilePriority(true, "medium")).toBe(20);
  });

  test("returns 30 for low priority needs-reply email", () => {
    expect(assignSenderProfilePriority(true, "low")).toBe(30);
  });

  test("returns 40 for no-reply email regardless of priority", () => {
    expect(assignSenderProfilePriority(false, "high")).toBe(40);
    expect(assignSenderProfilePriority(false, "medium")).toBe(40);
    expect(assignSenderProfilePriority(false, "low")).toBe(40);
    expect(assignSenderProfilePriority(false)).toBe(40);
  });

  test("returns 40 for needs-reply with skip priority", () => {
    expect(assignSenderProfilePriority(true, "skip")).toBe(40);
  });

  test("returns 40 for needs-reply with undefined priority", () => {
    expect(assignSenderProfilePriority(true, undefined)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Tests: queueSenderProfiles priority sorting logic (re-implemented)
// ---------------------------------------------------------------------------

test.describe("queueSenderProfiles sorting", () => {
  type EmailWithAnalysis = {
    id: string;
    from: string;
    analysis?: { priority?: string };
  };

  function sortEmailsByPriority(emails: EmailWithAnalysis[]): EmailWithAnalysis[] {
    const priorityOrder: Record<string, number> = {
      high: 1,
      medium: 2,
      low: 3,
    };
    return [...emails].sort((a, b) => {
      const aPriority = priorityOrder[a.analysis?.priority || "low"] || 3;
      const bPriority = priorityOrder[b.analysis?.priority || "low"] || 3;
      return aPriority - bPriority;
    });
  }

  test("sorts high priority first, then medium, then low", () => {
    const emails: EmailWithAnalysis[] = [
      { id: "low", from: "a@example.com", analysis: { priority: "low" } },
      { id: "high", from: "b@example.com", analysis: { priority: "high" } },
      { id: "med", from: "c@example.com", analysis: { priority: "medium" } },
    ];

    const sorted = sortEmailsByPriority(emails);
    expect(sorted.map((e) => e.id)).toEqual(["high", "med", "low"]);
  });

  test("treats missing priority as low", () => {
    const emails: EmailWithAnalysis[] = [
      { id: "none", from: "a@example.com", analysis: {} },
      { id: "high", from: "b@example.com", analysis: { priority: "high" } },
    ];

    const sorted = sortEmailsByPriority(emails);
    expect(sorted[0].id).toBe("high");
    expect(sorted[1].id).toBe("none");
  });

  test("treats missing analysis as low priority", () => {
    const emails: EmailWithAnalysis[] = [
      { id: "no-analysis", from: "a@example.com" },
      { id: "high", from: "b@example.com", analysis: { priority: "high" } },
    ];

    const sorted = sortEmailsByPriority(emails);
    expect(sorted[0].id).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Tests: autoDraft priority filtering logic (re-implemented)
// ---------------------------------------------------------------------------

test.describe("autoDraft priority filtering", () => {
  function shouldAutoDraft(
    emailPriority: string | undefined,
    allowedPriorities: string[],
  ): boolean {
    return allowedPriorities.includes(emailPriority || "low");
  }

  test("allows high priority when configured for high+medium", () => {
    expect(shouldAutoDraft("high", ["high", "medium"])).toBe(true);
  });

  test("allows medium priority when configured for high+medium", () => {
    expect(shouldAutoDraft("medium", ["high", "medium"])).toBe(true);
  });

  test("rejects low priority when configured for high+medium only", () => {
    expect(shouldAutoDraft("low", ["high", "medium"])).toBe(false);
  });

  test("allows low priority when explicitly configured", () => {
    expect(shouldAutoDraft("low", ["high", "medium", "low"])).toBe(true);
  });

  test("treats undefined priority as 'low'", () => {
    expect(shouldAutoDraft(undefined, ["high", "medium"])).toBe(false);
    expect(shouldAutoDraft(undefined, ["high", "medium", "low"])).toBe(true);
  });

  test("rejects skip priority always", () => {
    expect(shouldAutoDraft("skip", ["high", "medium", "low"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: archive-ready deduplication key logic
// ---------------------------------------------------------------------------

test.describe("archive-ready composite key", () => {
  test("creates composite key from accountId and threadId", () => {
    const accountId = "acc-1";
    const threadId = "thread-1";
    const key = `${accountId}:${threadId}`;
    expect(key).toBe("acc-1:thread-1");
  });

  test("different accounts produce different keys for same thread", () => {
    const key1 = `acc-1:thread-1`;
    const key2 = `acc-2:thread-1`;
    expect(key1).not.toBe(key2);
  });

  test("Set correctly deduplicates composite keys", () => {
    const processed = new Set<string>();
    processed.add("acc-1:thread-1");
    processed.add("acc-1:thread-2");
    processed.add("acc-2:thread-1");

    expect(processed.has("acc-1:thread-1")).toBe(true);
    expect(processed.has("acc-2:thread-1")).toBe(true);
    expect(processed.has("acc-1:thread-3")).toBe(false);
    expect(processed.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent draft priority values
// ---------------------------------------------------------------------------

test.describe("agent draft priority values", () => {
  function getAgentDraftPriority(analysisPriority?: string): number {
    return analysisPriority === "high" ? 5 : analysisPriority === "medium" ? 15 : 25;
  }

  test("high priority emails get draft priority 5", () => {
    expect(getAgentDraftPriority("high")).toBe(5);
  });

  test("medium priority emails get draft priority 15", () => {
    expect(getAgentDraftPriority("medium")).toBe(15);
  });

  test("low priority emails get draft priority 25", () => {
    expect(getAgentDraftPriority("low")).toBe(25);
  });

  test("undefined priority defaults to 25", () => {
    expect(getAgentDraftPriority(undefined)).toBe(25);
  });

  test("agent drafts have higher priority (lower number) than sender profiles", () => {
    // Agent draft high (5) < sender profile high (10)
    expect(getAgentDraftPriority("high")).toBeLessThan(assignSenderProfilePriority(true, "high"));
  });

  test("analysis (0) has highest priority of all", () => {
    const analysisPriority = 0;
    expect(analysisPriority).toBeLessThan(getAgentDraftPriority("high"));
  });
});

// ---------------------------------------------------------------------------
// Tests: inbox email cache for startup optimization
// ---------------------------------------------------------------------------

test.describe("inbox email cache", () => {
  // Re-implement the cache logic from PrefetchService
  class InboxEmailCache {
    private cachedInboxEmails: Array<{ id: string; accountId: string }> | null = null;

    addCachedInboxEmails(emails: Array<{ id: string; accountId: string }>): void {
      if (!this.cachedInboxEmails) {
        this.cachedInboxEmails = [];
      }
      this.cachedInboxEmails.push(...emails);
    }

    consumeOrFallback(fallback: () => Array<{ id: string; accountId: string }>): {
      emails: Array<{ id: string; accountId: string }>;
      usedCache: boolean;
    } {
      const usedCache = this.cachedInboxEmails !== null;
      const emails = this.cachedInboxEmails ?? fallback();
      this.cachedInboxEmails = null;
      return { emails, usedCache };
    }

    get hasCachedEmails(): boolean {
      return this.cachedInboxEmails !== null;
    }
  }

  test("starts with no cache", () => {
    const cache = new InboxEmailCache();
    expect(cache.hasCachedEmails).toBe(false);
  });

  test("addCachedInboxEmails populates cache", () => {
    const cache = new InboxEmailCache();
    cache.addCachedInboxEmails([{ id: "e1", accountId: "acc1" }]);
    expect(cache.hasCachedEmails).toBe(true);
  });

  test("accumulates emails across multiple addCachedInboxEmails calls (multi-account)", () => {
    const cache = new InboxEmailCache();
    cache.addCachedInboxEmails([{ id: "e1", accountId: "acc1" }]);
    cache.addCachedInboxEmails([{ id: "e2", accountId: "acc2" }]);

    const { emails, usedCache } = cache.consumeOrFallback(() => []);
    expect(usedCache).toBe(true);
    expect(emails).toHaveLength(2);
    expect(emails.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  test("consumeOrFallback uses cache when available", () => {
    const cache = new InboxEmailCache();
    cache.addCachedInboxEmails([{ id: "e1", accountId: "acc1" }]);

    const fallbackCalled = { value: false };
    const { emails, usedCache } = cache.consumeOrFallback(() => {
      fallbackCalled.value = true;
      return [{ id: "fallback", accountId: "acc1" }];
    });

    expect(usedCache).toBe(true);
    expect(fallbackCalled.value).toBe(false);
    expect(emails[0].id).toBe("e1");
  });

  test("consumeOrFallback clears cache after use", () => {
    const cache = new InboxEmailCache();
    cache.addCachedInboxEmails([{ id: "e1", accountId: "acc1" }]);

    cache.consumeOrFallback(() => []);
    expect(cache.hasCachedEmails).toBe(false);
  });

  test("second consumeOrFallback uses fallback (cache cleared)", () => {
    const cache = new InboxEmailCache();
    cache.addCachedInboxEmails([{ id: "e1", accountId: "acc1" }]);

    cache.consumeOrFallback(() => []);

    const { emails, usedCache } = cache.consumeOrFallback(() => [
      { id: "db-email", accountId: "acc1" },
    ]);
    expect(usedCache).toBe(false);
    expect(emails[0].id).toBe("db-email");
  });

  test("consumeOrFallback uses fallback when cache was never populated", () => {
    const cache = new InboxEmailCache();

    const { emails, usedCache } = cache.consumeOrFallback(() => [
      { id: "db-email", accountId: "acc1" },
    ]);
    expect(usedCache).toBe(false);
    expect(emails[0].id).toBe("db-email");
  });
});
