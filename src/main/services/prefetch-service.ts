import { EmailAnalyzer } from "./email-analyzer";
import { ArchiveReadyAnalyzer } from "./archive-ready-analyzer";
import {
  getEmail,
  getEmailsByThread,
  getFirstEmailIdForThread,
  isThreadFullyAnalyzed,
  getInboxEmails,
  saveAnalysis,
  saveArchiveReady,
  getAnalyzedArchiveThreadIds,
  getAccounts,
  updateDraftAgentTaskId,
} from "../db";
import { getConfig, getModelIdForFeature } from "../ipc/settings.ipc";
import { getExtensionHost } from "../extensions";
import { agentCoordinator } from "../agents/agent-coordinator";
import type { AgentContext } from "../agents/types";
import { DEFAULT_AGENT_DRAFTER_PROMPT } from "../../shared/types";
import type { Email, DashboardEmail } from "../../shared/types";
import { createLogger } from "./logger";

const log = createLogger("prefetch");

// Lazy import to avoid circular dependency
let notifyEmailAnalyzed: ((emailId: string) => void) | null = null;
async function getNotifyFn(): Promise<(emailId: string) => void> {
  if (!notifyEmailAnalyzed) {
    const { notifyEmailAnalyzed: notify } = await import("../ipc/prefetch.ipc");
    notifyEmailAnalyzed = notify;
  }
  return notifyEmailAnalyzed;
}

let notifyArchiveReady:
  | ((threadId: string, accountId: string, isReady: boolean, reason: string) => void)
  | null = null;
async function getNotifyArchiveReadyFn(): Promise<
  (threadId: string, accountId: string, isReady: boolean, reason: string) => void
> {
  if (!notifyArchiveReady) {
    const { notifyArchiveReady: notify } = await import("../ipc/prefetch.ipc");
    notifyArchiveReady = notify;
  }
  return notifyArchiveReady;
}

type _PrefetchPriority = "high" | "medium" | "low";
type PrefetchStatus = "idle" | "running" | "error";

interface PrefetchTask {
  emailId: string;
  type: "analysis" | "sender-profile" | "agent-draft" | "archive-ready";
  threadId?: string; // Used for archive-ready tasks
  accountId?: string; // Used for archive-ready deduplication
  priority: number; // Lower = higher priority
}

export interface AgentDraftItem {
  emailId: string;
  subject: string;
  from: string;
  priority: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
}

export interface PrefetchProgress {
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
  agentDrafts?: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    items: AgentDraftItem[];
  };
}

/**
 * Background service for pre-fetching sender profiles and auto-generating drafts
 * Prioritizes high priority emails, then medium, then low
 */
class PrefetchService {
  private isRunning = false;
  private queue: PrefetchTask[] = [];
  private status: PrefetchStatus = "idle";
  private currentTask?: PrefetchTask;
  private analyzer: EmailAnalyzer | null = null;
  private archiveReadyAnalyzer: ArchiveReadyAnalyzer | null = null;

  // Track what's been processed to avoid duplicate work
  private processedAnalysis = new Set<string>();
  private processedSenderProfiles = new Set<string>();
  private processedDrafts = new Set<string>();
  private processedExtensionEnrichments = new Set<string>();
  private processedArchiveReady = new Set<string>();

  // Track pending sender lookups to deduplicate (senderEmail -> [emailIds])
  private pendingSenderLookups = new Map<string, string[]>();

  // Agent draft pool: rate-limited to avoid memory blowup from too many concurrent agents
  private static readonly MAX_CONCURRENT_AGENT_DRAFTS = 3;
  private agentDraftBacklog: PrefetchTask[] = [];
  private activeAgentDraftCount = 0;
  private agentDraftItems = new Map<string, AgentDraftItem>(); // emailId -> status
  private activeAgentTaskIds = new Map<string, string>(); // emailId -> taskId (to detect superseded tasks)
  private forceQueuedDrafts = new Set<string>(); // emailIds that bypass analysis.needsReply check
  private completedAgentDraftLog: AgentDraftItem[] = []; // ring buffer, last 50
  private processedDraftThreads = new Set<string>(); // threadIds with queued/processed agent drafts

  // Startup cache: populated by sync:get-emails to avoid duplicate getInboxEmails() call
  // at startup. Consumed once by processAllPending(), then closed to prevent non-startup
  // sync:get-emails calls (account switch, manual refresh) from re-populating with partial data.
  private cachedInboxEmails: DashboardEmail[] | null = null;
  private startupCacheOpen = true;

  // Progress tracking
  private processedCounts = {
    analysis: 0,
    senderProfile: 0,
    draft: 0,
    extensionEnrichment: 0,
    archiveReady: 0,
  };
  private progressListeners: Array<(progress: PrefetchProgress) => void> = [];

  // Throttle progress updates to avoid flooding renderer with IPC
  private lastProgressEmit = 0;
  private progressEmitPending = false;
  private static readonly PROGRESS_THROTTLE_MS = 1000; // At most once per second

  private buildEAPromptSuffix(eaConfig: {
    enabled: boolean;
    email?: string;
    name?: string;
  }): string {
    if (!eaConfig.enabled || !eaConfig.email) return "";
    const eaName = eaConfig.name || "the executive assistant";
    return `\n\nExecutive Assistant Context:
The user has an executive assistant${eaConfig.name ? ` named ${eaConfig.name}` : ""} (${eaConfig.email}) who handles scheduling on their behalf.

When you see emails in a thread where ${eaName} is coordinating scheduling with a third party, assess from the email content whether ${eaName} is handling the conversation. If ${eaName} is actively managing the back-and-forth (e.g., proposing times, confirming details) and the email does not require the user's personal input beyond scheduling, do NOT generate a draft. Only draft a reply if the email content directly addresses the user or requires their personal decision or expertise.`;
  }

  private getAnalyzer(): EmailAnalyzer {
    if (!this.analyzer) {
      const config = getConfig();
      this.analyzer = new EmailAnalyzer(getModelIdForFeature("analysis"), config.analysisPrompt);
    }
    return this.analyzer;
  }

  private getArchiveReadyAnalyzer(): ArchiveReadyAnalyzer {
    if (!this.archiveReadyAnalyzer) {
      const config = getConfig();
      this.archiveReadyAnalyzer = new ArchiveReadyAnalyzer(
        getModelIdForFeature("archiveReady"),
        config.archiveReadyPrompt,
      );
    }
    return this.archiveReadyAnalyzer;
  }

  /**
   * Cache inbox emails from sync:get-emails to avoid duplicate getInboxEmails() call
   * at startup. Called per-account; results are accumulated across accounts.
   */
  addCachedInboxEmails(emails: DashboardEmail[]): void {
    if (!this.startupCacheOpen) return;
    if (!this.cachedInboxEmails) {
      this.cachedInboxEmails = [];
    }
    // Use concat instead of push(...spread) to avoid stack overflow on large inboxes
    this.cachedInboxEmails = this.cachedInboxEmails.concat(emails);
  }

  /** Close the startup cache window without consuming. Called when processAllPending is skipped. */
  closeStartupCache(): void {
    this.cachedInboxEmails = null;
    this.startupCacheOpen = false;
  }

  /**
   * Queue emails for prefetching
   * This is the main entry point - call this when new emails arrive
   */
  async queueEmails(emailIds: string[]): Promise<void> {
    log.info(`[Prefetch] Queueing ${emailIds.length} emails for prefetch`);

    for (const emailId of emailIds) {
      // First, queue analysis if not already analyzed
      const email = getEmail(emailId);
      if (!email) continue;

      // Skip sent emails - they don't need reply analysis
      if (email.labelIds?.includes("SENT")) continue;

      if (!email.analysis && !this.processedAnalysis.has(emailId)) {
        this.queue.push({
          emailId,
          type: "analysis",
          priority: 0, // Analysis first
        });
      }
    }

    // Start processing if not already running
    this.processQueue();
  }

  /**
   * Queue sender profile prefetch for specific emails
   */
  queueSenderProfiles(emails: DashboardEmail[]): void {
    // Sort by priority: high first, then medium
    const priorityOrder: Record<string, number> = { high: 1, medium: 2, low: 3 };

    const sortedEmails = [...emails].sort((a, b) => {
      const aPriority = priorityOrder[a.analysis?.priority || "low"] || 3;
      const bPriority = priorityOrder[b.analysis?.priority || "low"] || 3;
      return aPriority - bPriority;
    });

    for (const email of sortedEmails) {
      const senderEmail = this.extractSenderEmail(email.from);
      if (this.processedSenderProfiles.has(senderEmail)) continue;

      // Only prefetch for high and medium priority
      const priority = email.analysis?.priority;
      if (priority !== "high" && priority !== "medium") continue;

      this.queue.push({
        emailId: email.id,
        type: "sender-profile",
        priority: priority === "high" ? 10 : 20,
      });
    }

    this.processQueue();
  }

  /**
   * Process all pending emails - analyze, then prefetch profiles and drafts
   * Only processes INBOX emails to save compute - archived/sent emails don't need AI processing.
   * Sender profiles and drafts are only generated based on config settings.
   */
  async processAllPending(): Promise<void> {
    const _t0 = performance.now();
    log.info(`[PERF] processAllPending START`);

    const tConfig = performance.now();
    const config = getConfig();
    log.info(
      `[PERF] processAllPending getConfig took ${(performance.now() - tConfig).toFixed(1)}ms`,
    );

    // Use cached inbox emails from sync:get-emails if available (startup path),
    // otherwise fall back to DB query (non-startup callers like prompt change, rerun drafts).
    const tGetEmails = performance.now();
    const usedCache = this.cachedInboxEmails !== null;
    const inboxEmails = this.cachedInboxEmails ?? getInboxEmails();
    this.cachedInboxEmails = null;
    this.startupCacheOpen = false; // close window so non-startup sync:get-emails won't re-populate
    log.info(
      `[PERF] processAllPending getInboxEmails took ${(performance.now() - tGetEmails).toFixed(1)}ms, returned ${inboxEmails.length} emails (cache=${usedCache})`,
    );

    const unanalyzed = inboxEmails.filter((e) => !e.analysis);

    // Queue analysis for unanalyzed emails
    if (unanalyzed.length > 0) {
      log.info(`[Prefetch] Processing ${unanalyzed.length} unanalyzed inbox emails`);
      await this.queueEmails(unanalyzed.map((e) => e.id));
    } else {
      log.info("[Prefetch] No unanalyzed inbox emails to process");
    }

    // Queue sender-profiles for ALL analyzed inbox emails in priority order
    // Priority: high(10) > medium(20) > low(30) > no-reply(40)
    // Deduplicate by sender email to avoid redundant API calls
    if (config.enableSenderLookup ?? true) {
      const needsSenderProfile = inboxEmails.filter((e) => {
        if (!e.analysis) return false; // Not analyzed yet
        // Onboarding-skipped emails have priority="skip" — bulk-marked old emails
        // that don't need any prefetching.
        if (e.analysis.priority === "skip") return false;
        const senderEmail = this.extractSenderEmail(e.from);
        if (this.processedSenderProfiles.has(senderEmail)) return false;
        return true;
      });

      if (needsSenderProfile.length > 0) {
        let queuedCount = 0;
        let deduplicatedCount = 0;

        for (const email of needsSenderProfile) {
          const senderEmail = this.extractSenderEmail(email.from);

          // Assign priority based on analysis result
          let priority = 40; // Default: no reply needed
          if (email.analysis?.needsReply) {
            switch (email.analysis.priority) {
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

          // Check if already queued for this sender
          if (this.pendingSenderLookups.has(senderEmail)) {
            // Already queued - just add this email to the waiting list
            this.pendingSenderLookups.get(senderEmail)!.push(email.id);
            deduplicatedCount++;
            continue;
          }

          // New sender - queue it and track which emails are waiting
          this.pendingSenderLookups.set(senderEmail, [email.id]);
          this.queue.push({
            emailId: email.id,
            type: "sender-profile",
            priority,
          });
          queuedCount++;
        }

        log.info(
          `[Prefetch] Queueing ${queuedCount} unique sender-profile lookups (deduplicated ${deduplicatedCount} from ${needsSenderProfile.length} emails)`,
        );
        this.processQueue();
      }
    }

    // Queue agent-mode drafts for analyzed emails that need reply and don't have drafts.
    // Respects autoDraft config: skip entirely if disabled, filter by priority if configured.
    // Deduplicate by thread — only draft for the newest email per thread, since one
    // draft reply per thread is all that's needed.
    const autoDraft = config.autoDraft;
    const isTestMode = process.env.EXO_TEST_MODE === "true";
    const isDemoMode = process.env.EXO_DEMO_MODE === "true";
    const skipAgentDrafts = autoDraft?.enabled === false || isTestMode || isDemoMode;
    if (skipAgentDrafts) {
      if (autoDraft?.enabled === false)
        log.info("[Prefetch] Auto-drafting disabled in config — skipping agent drafts");
      if (isTestMode || isDemoMode) log.info("[Prefetch] Test/demo mode — skipping agent drafts");
    }
    const allowedPriorities = autoDraft?.priorities ?? ["high", "medium", "low"];
    const candidateEmails = skipAgentDrafts
      ? []
      : inboxEmails.filter(
          (e) =>
            e.analysis?.needsReply &&
            e.analysis?.priority !== "skip" &&
            allowedPriorities.includes(e.analysis?.priority || "low") &&
            !e.draft &&
            !this.processedDrafts.has(e.id) &&
            !this.queue.some((t) => t.type === "agent-draft" && t.emailId === e.id) &&
            !this.agentDraftItems.has(e.id) &&
            !this.agentDraftBacklog.some((t) => t.emailId === e.id),
        );
    // Also skip threads that already have a draft on any email (completed or in-progress)
    const threadsWithDrafts = new Set(inboxEmails.filter((e) => e.draft).map((e) => e.threadId));
    // Include threads with in-progress agent drafts
    for (const emailId of this.agentDraftItems.keys()) {
      const e = getEmail(emailId);
      if (e?.threadId) threadsWithDrafts.add(e.threadId);
    }
    for (const task of this.agentDraftBacklog) {
      const e = getEmail(task.emailId);
      if (e?.threadId) threadsWithDrafts.add(e.threadId);
    }
    // Include threads already queued from a previous processAllPending() call
    // whose items may still be in this.queue (not yet moved to agentDraftBacklog)
    for (const threadId of this.processedDraftThreads) {
      threadsWithDrafts.add(threadId);
    }
    // Also scan the main queue for agent-draft items — covers the window between
    // being queued and being moved to agentDraftBacklog by processQueue()
    for (const task of this.queue) {
      if (task.type === "agent-draft") {
        const e = getEmail(task.emailId);
        if (e?.threadId) threadsWithDrafts.add(e.threadId);
      }
    }
    const newestPerThread = new Map<string, (typeof candidateEmails)[0]>();
    for (const email of candidateEmails) {
      if (threadsWithDrafts.has(email.threadId)) continue;
      const existing = newestPerThread.get(email.threadId);
      if (!existing || new Date(email.date).getTime() > new Date(existing.date).getTime()) {
        newestPerThread.set(email.threadId, email);
      }
    }
    const needsDraft = Array.from(newestPerThread.values());
    if (needsDraft.length > 0) {
      for (const email of needsDraft) {
        const priority =
          email.analysis?.priority === "high" ? 5 : email.analysis?.priority === "medium" ? 15 : 25;
        this.queue.push({
          emailId: email.id,
          type: "agent-draft",
          priority,
        });
        this.processedDraftThreads.add(email.threadId);
      }
      log.info(
        `[Prefetch] Queueing ${needsDraft.length} agent drafts (${candidateEmails.length} candidates deduplicated to ${needsDraft.length} threads)`,
      );
      this.processQueue();
    }

    // Queue archive-ready analysis for fully-analyzed threads
    this.queueArchiveReadyTasks(inboxEmails);
  }

  /**
   * Queue archive-ready analysis for inbox threads that are fully analyzed.
   * Runs at low priority so it happens after analysis, sender profiles, and drafts.
   */
  private queueArchiveReadyTasks(inboxEmails: DashboardEmail[]): void {
    // Group by thread
    const threadMap = new Map<string, DashboardEmail[]>();
    for (const email of inboxEmails) {
      const existing = threadMap.get(email.threadId) || [];
      existing.push(email);
      threadMap.set(email.threadId, existing);
    }

    // Find threads already analyzed for archive-readiness, keyed by (accountId, threadId)
    // to avoid cross-account collisions
    const accountIds = new Set(inboxEmails.map((e) => e.accountId).filter(Boolean));
    const alreadyAnalyzed = new Set<string>();
    for (const accountId of accountIds) {
      if (accountId) {
        for (const threadId of getAnalyzedArchiveThreadIds(accountId)) {
          alreadyAnalyzed.add(`${accountId}:${threadId}`);
        }
      }
    }

    let queued = 0;
    for (const [threadId, emails] of threadMap) {
      // Skip if already analyzed for archive-readiness or in this session
      const accountId = emails[0]?.accountId || "";
      if (
        alreadyAnalyzed.has(`${accountId}:${threadId}`) ||
        this.processedArchiveReady.has(`${accountId}:${threadId}`)
      )
        continue;

      // Skip if any received email in thread is unanalyzed
      // Sent emails don't need reply analysis, so exclude them from this check
      const allAnalyzed = emails.every((e) => e.analysis || e.labelIds?.includes("SENT"));
      if (!allAnalyzed) continue;

      this.queue.push({
        emailId: emails[0].id,
        threadId,
        accountId,
        type: "archive-ready",
        priority: 90, // Run after everything else
      });
      queued++;
    }

    if (queued > 0) {
      log.info(`[Prefetch] Queueing ${queued} threads for archive-ready analysis`);
      this.processQueue();
    }
  }

  /**
   * Re-queue threads for archive-ready analysis when new sent emails arrive.
   * Clears prior results so the thread gets a fresh evaluation that includes
   * the user's reply.
   */
  requeueArchiveReadyForThreads(threadIds: string[], accountId?: string): void {
    let queued = 0;
    for (const threadId of threadIds) {
      // Clear from processed set so it gets re-analyzed
      if (accountId) {
        this.processedArchiveReady.delete(`${accountId}:${threadId}`);
      }

      // Lightweight lookup — only need a single email ID for the task, not full thread
      const firstEmailId = getFirstEmailIdForThread(threadId, accountId);
      if (!firstEmailId) continue;

      // Skip if already in queue for this account
      const alreadyQueued = this.queue.some(
        (t) => t.type === "archive-ready" && t.threadId === threadId && t.accountId === accountId,
      );
      if (alreadyQueued) continue;

      this.queue.push({
        emailId: firstEmailId,
        threadId,
        accountId,
        type: "archive-ready",
        priority: 90,
      });
      queued++;
    }

    if (queued > 0) {
      log.info(
        `[Prefetch] Re-queueing ${queued} threads for archive-ready re-analysis (sent emails synced)`,
      );
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isRunning) {
      log.info(`[PERF] processQueue SKIPPED (already running)`);
      return;
    }

    const t0 = performance.now();
    log.info(`[PERF] processQueue START, queue length=${this.queue.length}`);

    this.isRunning = true;
    this.status = "running";
    this.emitProgress();

    // agent-draft tasks are drained via scheduleAgentDraft (which has its own
    // concurrency control) before reaching the CONCURRENCY lookup below, so the
    // "agent-draft" entry here is never used at runtime — it exists only to
    // satisfy the Record<PrefetchTask["type"], number> type requirement.
    const CONCURRENCY: Record<PrefetchTask["type"], number> = {
      analysis: 10,
      "archive-ready": 5,
      // Sender-profile tasks make Claude API calls then do synchronous DB
      // reads/writes on resolution. With 10 concurrent tasks resolving near-
      // simultaneously, the sync DB bursts pile up and block the main thread
      // for seconds (observed 7.8s event-loop lag). Cap at 3 so at most 3
      // bursts of sync work can land back-to-back.
      "sender-profile": 3,
      "agent-draft": 1,
    };

    try {
      let taskCount = 0;

      // Sort once up front instead of every iteration. Re-sorting 500+ items
      // on each loop pass (O(n log n) × iterations) was a major CPU hotspot
      // during initial sync. We re-sort only when new items arrive mid-run
      // (tracked via lastSortedLength) to avoid priority inversion.
      let lastSortedLength = this.queue.length;
      this.queue.sort((a, b) => a.priority - b.priority);

      while (this.queue.length > 0) {
        // Yield to event loop before each batch to let IPC handlers run
        await new Promise((resolve) => setImmediate(resolve));

        // Re-sort if new items were enqueued since last sort
        if (this.queue.length > lastSortedLength) {
          this.queue.sort((a, b) => a.priority - b.priority);
        }

        // Agent-draft tasks get moved to a separate rate-limited pool
        // so they don't block the main queue or blow up memory
        if (this.queue[0]?.type === "agent-draft") {
          const agentDraftTasks = this.queue.filter((t) => t.type === "agent-draft");
          this.queue = this.queue.filter((t) => t.type !== "agent-draft");
          for (const task of agentDraftTasks) {
            this.scheduleAgentDraft(task);
          }
          lastSortedLength = this.queue.length;
          continue;
        }

        // Take up to MAX_CONCURRENT tasks of the same type
        const batch: PrefetchTask[] = [];
        const firstTask = this.queue[0];
        const batchType = firstTask.type;

        // Collect up to the type-specific concurrency limit
        const maxForType = CONCURRENCY[batchType];
        let i = 0;
        while (i < this.queue.length && batch.length < maxForType) {
          if (this.queue[i].type === batchType) {
            batch.push(this.queue.splice(i, 1)[0]);
          } else {
            i++;
          }
        }

        // Update baseline AFTER extraction so additions during the next
        // async batch are detectable for re-sort
        lastSortedLength = this.queue.length;

        this.currentTask = batch[0]; // Show first task as current
        this.emitProgress();

        // Process batch in parallel, yielding after each task's DB write
        // to prevent synchronous write bursts from blocking the main thread
        const tBatch = performance.now();
        await Promise.all(
          batch.map(async (task) => {
            try {
              const tTask = performance.now();
              await this.processTask(task);
              // Yield after each task so DB writes don't pile up back-to-back
              await new Promise((resolve) => setImmediate(resolve));
              const taskTime = performance.now() - tTask;
              if (taskTime > 100) {
                log.info(
                  `[PERF] processTask ${task.type}:${task.emailId.slice(0, 8)} took ${taskTime.toFixed(1)}ms`,
                );
              }
            } catch (error) {
              log.error({ err: error }, `[Prefetch] Error processing task`);
            }
          }),
        );

        const batchTime = performance.now() - tBatch;
        if (batch.length > 1) {
          log.info(`[PERF] Parallel batch of ${batch.length} tasks took ${batchTime.toFixed(1)}ms`);
        }

        this.currentTask = undefined;
        this.emitProgress();

        taskCount += batch.length;
        if (taskCount % 10 === 0 || taskCount === batch.length) {
          log.info(
            `[PERF] processQueue progress: ${taskCount} tasks done, ${this.queue.length} remaining, elapsed ${(performance.now() - t0).toFixed(0)}ms`,
          );
        }

        // Brief delay between batches to avoid rate limiting and CPU spikes.
        // Always delay when there's more work, not just for multi-item batches —
        // single-item analysis tasks in a tight loop can still saturate the CPU.
        if (this.queue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } finally {
      this.isRunning = false;
      this.status = "idle";
      this.currentTask = undefined;
      this.emitProgress();
      log.info(`[PERF] processQueue END total ${(performance.now() - t0).toFixed(1)}ms`);

      // If items were added while we were finishing (e.g., clear() + processAllPending()
      // happened during our run), restart to pick them up.
      // Only check this.queue — agentDraftBacklog is drained independently by
      // drainAgentDraftBacklog() and would cause infinite recursion here.
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }

  private async processTask(task: PrefetchTask): Promise<void> {
    switch (task.type) {
      case "analysis":
        await this.processAnalysis(task.emailId);
        break;
      case "sender-profile":
        await this.processSenderProfile(task.emailId);
        break;
      case "agent-draft":
        await this.processAgentDraft(task.emailId);
        break;
      case "archive-ready":
        await this.processArchiveReady(task.threadId || task.emailId, task.emailId);
        break;
    }
  }

  private async processAnalysis(emailId: string): Promise<void> {
    if (this.processedAnalysis.has(emailId)) return;

    const email = getEmail(emailId);
    if (!email) {
      this.processedAnalysis.add(emailId);
      return;
    }

    // If already analyzed (e.g. by autoAnalyzeEmails), still queue sender-profile
    if (email.analysis) {
      this.processedAnalysis.add(emailId);
      const config = getConfig();
      if (config.enableSenderLookup ?? true) {
        let priority = 40;
        if (email.analysis.needsReply) {
          switch (email.analysis.priority) {
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
        log.info(
          `[Prefetch] Email ${emailId} already analyzed, queueing sender-profile (priority=${priority})`,
        );
        this.queue.push({
          emailId,
          type: "sender-profile",
          priority,
        });
      }
      return;
    }

    log.info(`[Prefetch] Analyzing email ${emailId}`);

    try {
      const analyzer = this.getAnalyzer();
      const emailForAnalysis: Email = {
        id: email.id,
        threadId: email.threadId,
        subject: email.subject,
        from: email.from,
        to: email.to,
        date: email.date,
        body: email.body ?? "",
        snippet: email.snippet,
      };

      // Look up user email for the account so the analyzer knows who "the user" is
      const accounts = getAccounts();
      const account = email.accountId
        ? accounts.find((a) => a.id === email.accountId)
        : (accounts.find((a) => a.isPrimary) ?? accounts[0]);
      const userEmail = account?.email;

      const result = await analyzer.analyze(emailForAnalysis, userEmail, email.accountId);
      saveAnalysis(emailId, result.needs_reply, result.reason, result.priority);
      this.processedAnalysis.add(emailId);
      this.processedCounts.analysis++;

      log.info(
        `[Prefetch] Analyzed ${emailId}: ${result.priority} priority, needs_reply=${result.needs_reply}`,
      );

      // Notify renderer that this email was analyzed
      const notify = await getNotifyFn();
      notify(emailId);

      // Queue follow-up tasks based on analysis result
      const config = getConfig();

      // Queue sender profile for ALL emails (priority order: high > medium > low > no-reply)
      // Deduplicate by sender email to avoid redundant API calls
      if (config.enableSenderLookup ?? true) {
        const senderEmail = this.extractSenderEmail(email.from);

        // Skip if already processed
        if (!this.processedSenderProfiles.has(senderEmail)) {
          let priority = 40; // Default: no reply needed
          if (result.needs_reply) {
            switch (result.priority) {
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

          // Check if already queued for this sender
          if (this.pendingSenderLookups.has(senderEmail)) {
            // Already queued - just add this email to the waiting list
            this.pendingSenderLookups.get(senderEmail)!.push(emailId);
            log.info(
              `[Prefetch] Email ${emailId} added to pending lookup for sender ${senderEmail}`,
            );
          } else {
            // New sender - queue it
            this.pendingSenderLookups.set(senderEmail, [emailId]);
            log.info(
              `[Prefetch] Queueing sender-profile for ${emailId} (sender=${senderEmail}, priority=${priority})`,
            );
            this.queue.push({
              emailId,
              type: "sender-profile",
              priority,
            });
          }
        }
      }

      if (result.needs_reply && (!email.labelIds || email.labelIds.includes("INBOX"))) {
        // Queue agent-mode draft only for inbox emails (skip archived/trashed)
        // Treat NULL labelIds as inbox (demo mode emails have no labels)
        // Respect autoDraft config: skip if disabled, filter by priority
        // Deduplicate by thread: only queue the most recent email per thread,
        // since the agent drafting system operates on the whole thread.
        const autoDraftConfig = config.autoDraft;
        const autoDraftAllowed = autoDraftConfig?.enabled !== false;
        const autoDraftPriorities = autoDraftConfig?.priorities ?? ["high", "medium", "low"];
        const isTest = process.env.EXO_TEST_MODE === "true";
        const isDemo = process.env.EXO_DEMO_MODE === "true";
        if (
          autoDraftAllowed &&
          !isTest &&
          !isDemo &&
          result.priority !== "skip" &&
          autoDraftPriorities.includes(result.priority || "low") &&
          !this.processedDrafts.has(emailId) &&
          !this.isThreadAlreadyQueuedForDraft(email.threadId)
        ) {
          const draftPriority =
            result.priority === "high" ? 5 : result.priority === "medium" ? 15 : 25;
          this.queue.push({
            emailId,
            type: "agent-draft",
            priority: draftPriority,
          });
          this.processedDraftThreads.add(email.threadId);
        }
      }

      // Check if the entire thread is now fully analyzed -> queue archive-ready
      // Sent emails don't need reply analysis, so exclude them from this check
      // Uses lightweight SQL check instead of loading full thread to avoid BFS overhead.
      const archiveReadyKey = `${email.accountId}:${email.threadId}`;
      if (!this.processedArchiveReady.has(archiveReadyKey)) {
        const allAnalyzed = isThreadFullyAnalyzed(email.threadId, email.accountId);
        if (allAnalyzed) {
          this.queue.push({
            emailId,
            threadId: email.threadId,
            accountId: email.accountId,
            type: "archive-ready",
            priority: 90,
          });
        }
      }
    } catch (error) {
      log.error({ err: error }, `[Prefetch] Failed to analyze ${emailId}`);

      // Still queue sender-profile even when analysis fails.
      // Extension enrichments (e.g. third-party services) don't depend on
      // the Anthropic API, so they can run independently of analysis.
      const config = getConfig();
      if (config.enableSenderLookup ?? true) {
        const senderEmail = this.extractSenderEmail(email.from);
        if (!this.processedSenderProfiles.has(senderEmail)) {
          if (this.pendingSenderLookups.has(senderEmail)) {
            this.pendingSenderLookups.get(senderEmail)!.push(emailId);
          } else {
            this.pendingSenderLookups.set(senderEmail, [emailId]);
            this.queue.push({
              emailId,
              type: "sender-profile",
              priority: 50, // Lower priority than analyzed emails
            });
          }
        }
      }
    }
  }

  private async processSenderProfile(emailId: string): Promise<void> {
    // All sender lookups are now handled by the extension system
    // This just triggers the extension enrichment which does the actual lookup
    await this.processExtensionEnrichment(emailId);
    this.processedCounts.senderProfile++;
  }

  /**
   * Process extension enrichment for an email
   * This populates the extension_enrichments table used by the sidebar panels
   * Called from background queue - this is where new lookups are triggered
   *
   * Architecture:
   * 1. Queue deduplicates by sender (one task per unique sender)
   * 2. First email triggers actual API lookups via extensionHost
   * 3. After lookup, we call extensionHost for all other waiting emails
   * 4. Those calls are cache hits - each extension handles its own caching
   */
  private async processExtensionEnrichment(emailId: string): Promise<void> {
    if (this.processedExtensionEnrichments.has(emailId)) return;

    const email = getEmail(emailId);
    if (!email) return;

    const senderEmail = this.extractSenderEmail(email.from);

    // Skip if we already processed this sender (another concurrent task handled it)
    if (this.processedSenderProfiles.has(senderEmail)) {
      log.info(`[Prefetch] Skipping ${senderEmail} - already processed by another task`);
      this.processedExtensionEnrichments.add(emailId);
      return;
    }

    log.info(
      `[Prefetch] Running extension enrichment for sender ${senderEmail} (email ${emailId})`,
    );

    try {
      const extensionHost = getExtensionHost();
      // Get thread emails from DB - only the specific thread, scoped to account
      const threadEmails = getEmailsByThread(email.threadId, email.accountId);

      // Background mode: allow new lookups (this is the only place that should trigger API calls)
      await extensionHost.enrichEmail(email, threadEmails, { allowNewLookups: true });

      this.processedSenderProfiles.add(senderEmail);
      this.processedExtensionEnrichments.add(emailId);
      this.processedCounts.extensionEnrichment++;

      // Now trigger enrichment for all other emails waiting for this sender
      // These will be cache hits - each extension handles its own caching.
      // Yield between each to avoid blocking the event loop with back-to-back
      // sync DB reads (getEmail + getEmailsByThread + enrichment cache checks).
      const waitingEmails = this.pendingSenderLookups.get(senderEmail) || [];
      if (waitingEmails.length > 1) {
        let cachedCount = 0;
        for (const waitingEmailId of waitingEmails) {
          if (
            waitingEmailId !== emailId &&
            !this.processedExtensionEnrichments.has(waitingEmailId)
          ) {
            // Yield with a brief delay so IPC handlers, UI updates, and
            // incremental GC can run. setImmediate alone isn't enough — the
            // rapid object allocation from cache-hit processing causes major
            // GC pauses (~1s) when V8 defers collection too long.
            await new Promise((resolve) => setTimeout(resolve, 5));
            const waitingEmail = getEmail(waitingEmailId);
            if (waitingEmail) {
              // allowNewLookups: false means these are cache hits — threadEmails
              // are only used by provider.enrich() which won't be called.
              // Pass empty array to avoid loading full email bodies into memory.
              await extensionHost.enrichEmail(waitingEmail, [], {
                allowNewLookups: false,
              });
              this.processedExtensionEnrichments.add(waitingEmailId);
              cachedCount++;
            }
          }
        }
        log.info(
          `[Prefetch] Enrichment complete for ${senderEmail} (1 lookup + ${cachedCount} cache hits)`,
        );
      } else {
        log.info(`[Prefetch] Enrichment complete for ${senderEmail}`);
      }

      // Clean up pending lookups for this sender
      this.pendingSenderLookups.delete(senderEmail);
    } catch (error) {
      log.error({ err: error }, `[Prefetch] Failed to run extension enrichment for ${senderEmail}`);
      // Clean up pending lookups even on failure
      this.pendingSenderLookups.delete(senderEmail);
    }
  }

  /**
   * Schedule an agent-draft task through the rate-limited pool.
   * Unlike other task types, agent drafts hold conversation state in the worker
   * for the entire duration of the agent run, so we cap concurrency to avoid
   * memory exhaustion.
   */
  private scheduleAgentDraft(task: PrefetchTask): void {
    const email = getEmail(task.emailId);
    if (!email) return;

    // Track in visible queue
    this.agentDraftItems.set(task.emailId, {
      emailId: task.emailId,
      subject: email.subject || "(no subject)",
      from: email.from || "",
      priority: email.analysis?.priority || "low",
      status: "queued",
    });

    this.agentDraftBacklog.push(task);
    this.drainAgentDraftBacklog();
    this.emitProgress();
  }

  /**
   * Start queued agent drafts up to the concurrency limit.
   * Called after scheduling new tasks and after a running task finishes.
   */
  private drainAgentDraftBacklog(): void {
    // Sort backlog by priority
    this.agentDraftBacklog.sort((a, b) => a.priority - b.priority);

    while (
      this.agentDraftBacklog.length > 0 &&
      this.activeAgentDraftCount < PrefetchService.MAX_CONCURRENT_AGENT_DRAFTS
    ) {
      const task = this.agentDraftBacklog.shift()!;
      this.activeAgentDraftCount++;

      // Update status
      const item = this.agentDraftItems.get(task.emailId);
      if (item) {
        item.status = "running";
        item.startedAt = Date.now();
      }
      this.emitProgress();

      this.processAgentDraft(task.emailId)
        .catch((error) => {
          log.error({ err: error }, `[Prefetch] Agent draft pool error for ${task.emailId}`);
        })
        .finally(() => {
          this.activeAgentDraftCount--;
          this.emitProgress();
          this.drainAgentDraftBacklog();
        });
    }
  }

  /**
   * Run an agent-mode draft for an email and await its completion.
   * The agent has access to tools like searchEmails, getSenderProfile, and generateDraft,
   * so it can research context before drafting.
   */
  private async processAgentDraft(emailId: string): Promise<void> {
    if (this.processedDrafts.has(emailId)) return;

    // Skip in test/demo mode — agent worker may not be available or we shouldn't make real API calls
    const isTestMode = process.env.EXO_TEST_MODE === "true";
    const isDemoMode = process.env.EXO_DEMO_MODE === "true";
    if (isTestMode || isDemoMode) {
      this.processedDrafts.add(emailId);
      this.markAgentDraftDone(emailId, "completed");
      return;
    }

    const email = getEmail(emailId);
    if (!email || email.draft) {
      this.processedDrafts.add(emailId);
      this.markAgentDraftDone(emailId, "completed");
      return;
    }

    // Skip emails no longer in the inbox (archived/trashed between queue and processing)
    // Treat emails with no labelIds (NULL in DB) as inbox — matches getInboxEmails query
    if (email.labelIds && !email.labelIds.includes("INBOX")) {
      this.processedDrafts.add(emailId);
      this.markAgentDraftDone(emailId, "completed");
      return;
    }

    // Skip if analysis says no reply needed — unless this was force-queued
    // (e.g., stale draft cleaned up due to third-party reply in the thread).
    const isForceQueued = this.forceQueuedDrafts.has(emailId);
    if (!isForceQueued && !email.analysis?.needsReply) {
      this.processedDrafts.add(emailId);
      this.markAgentDraftDone(emailId, "completed");
      return;
    }
    if (isForceQueued) {
      this.forceQueuedDrafts.delete(emailId);
    }

    log.info(
      `[Prefetch] Starting agent draft for email ${emailId} (priority=${email.analysis?.priority ?? "unknown"})`,
    );

    const taskId = `auto-draft-${emailId}-${Date.now()}`;

    try {
      const config = getConfig();
      let prompt = config.agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT;
      if (config.ea) {
        prompt += this.buildEAPromptSuffix(config.ea);
      }

      const accounts = getAccounts();
      if (accounts.length === 0) {
        log.warn(`[Prefetch] No accounts configured — skipping agent draft for ${emailId}`);
        this.processedDrafts.add(emailId);
        this.markAgentDraftDone(emailId, "failed");
        return;
      }
      const account = email.accountId
        ? accounts.find((a) => a.id === email.accountId)
        : (accounts.find((a) => a.isPrimary) ?? accounts[0]);
      const context: AgentContext = {
        accountId: account?.id || "",
        currentEmailId: emailId,
        currentThreadId: email.threadId,
        userEmail: account?.email || "",
        userName: account?.displayName,
        emailSubject: email.subject,
        emailFrom: email.from,
        emailBody: email.body ?? "",
      };

      // Track which taskId is active for this email so we can detect superseded tasks
      this.activeAgentTaskIds.set(emailId, taskId);

      // Launch the agent and await its actual completion (not just startup)
      await agentCoordinator.runAgent(taskId, ["claude"], prompt, context);
      await agentCoordinator.waitForCompletion(taskId);

      // Link the draft record to the agent task so the trace can be loaded later
      try {
        updateDraftAgentTaskId(emailId, taskId);
      } catch (err) {
        log.warn(
          { err: err },
          `[Prefetch] Failed to link agent task ${taskId} to draft for ${emailId}`,
        );
      }

      this.processedDrafts.add(emailId);
      this.processedCounts.draft++;
      this.markAgentDraftDone(emailId, "completed");
      this.activeAgentTaskIds.delete(emailId);

      log.info(`[Prefetch] Agent draft completed for ${emailId} (taskId=${taskId})`);
    } catch (error) {
      log.error({ err: error }, `[Prefetch] Failed agent draft for ${emailId}`);
      // Only mark as processed if this task hasn't been superseded by a rerun.
      // When drafts:rerun-agent cancels the old task, its catch block runs asynchronously
      // after removeFromProcessedDrafts() has already cleared the email for re-queuing.
      const superseded = this.activeAgentTaskIds.get(emailId) !== taskId;
      if (!superseded) {
        this.processedDrafts.add(emailId);
        this.activeAgentTaskIds.delete(emailId);
        this.markAgentDraftDone(emailId, "failed");
      }
    }
  }

  markAgentDraftDone(emailId: string, status: "completed" | "failed"): void {
    const item = this.agentDraftItems.get(emailId);
    if (item) {
      item.status = status;
      item.completedAt = Date.now();
      // Move to completed log (ring buffer, keep last 50)
      this.completedAgentDraftLog.push({ ...item });
      if (this.completedAgentDraftLog.length > 50) {
        this.completedAgentDraftLog.shift();
      }
      this.agentDraftItems.delete(emailId);
    }
  }

  private async processArchiveReady(threadId: string, emailId: string): Promise<void> {
    // Derive accountId from the queued email rather than the first thread result
    const sourceEmail = getEmail(emailId);
    const accountId = sourceEmail?.accountId;
    const compositeKey = `${accountId}:${threadId}`;

    if (this.processedArchiveReady.has(compositeKey)) return;

    if (!accountId) {
      this.processedArchiveReady.add(compositeKey);
      return;
    }

    const threadEmails = getEmailsByThread(threadId, accountId);
    if (threadEmails.length === 0) {
      this.processedArchiveReady.add(compositeKey);
      return;
    }

    log.info(`[Prefetch] Analyzing archive-readiness for thread ${threadId}`);

    try {
      const archiveAnalyzer = this.getArchiveReadyAnalyzer();

      // Get user email for context
      const accounts = getAccounts();
      const account = accounts.find((a) => a.id === accountId);
      const userEmail = account?.email;

      const result = await archiveAnalyzer.analyzeThread(threadEmails, userEmail);
      saveArchiveReady(threadId, accountId, result.archive_ready, result.reason);

      this.processedArchiveReady.add(compositeKey);
      this.processedCounts.archiveReady++;

      log.info(
        `[Prefetch] Thread ${threadId}: archive_ready=${result.archive_ready}, reason=${result.reason}`,
      );

      // Notify renderer of new archive-ready result
      const notify = await getNotifyArchiveReadyFn();
      notify(threadId, accountId, result.archive_ready, result.reason);
    } catch (error) {
      log.error({ err: error }, `[Prefetch] Failed archive-ready analysis for thread ${threadId}`);
    }
  }

  private extractSenderEmail(from: string): string {
    const match = from.match(/<([^>]+)>/);
    return (match ? match[1] : from).toLowerCase();
  }

  /**
   * Add a progress listener
   */
  onProgress(callback: (progress: PrefetchProgress) => void): () => void {
    this.progressListeners.push(callback);
    // Return unsubscribe function
    return () => {
      const index = this.progressListeners.indexOf(callback);
      if (index >= 0) {
        this.progressListeners.splice(index, 1);
      }
    };
  }

  /**
   * Emit progress to all listeners (throttled to avoid flooding renderer)
   */
  private emitProgress(): void {
    const now = Date.now();

    // If we recently emitted, schedule a delayed emit instead
    if (now - this.lastProgressEmit < PrefetchService.PROGRESS_THROTTLE_MS) {
      if (!this.progressEmitPending) {
        this.progressEmitPending = true;
        const delay = PrefetchService.PROGRESS_THROTTLE_MS - (now - this.lastProgressEmit);
        setTimeout(() => {
          this.progressEmitPending = false;
          this.lastProgressEmit = Date.now();
          this.doEmitProgress();
        }, delay);
      }
      return;
    }

    this.lastProgressEmit = now;
    this.doEmitProgress();
  }

  /**
   * Actually emit progress to listeners
   */
  private doEmitProgress(): void {
    const progress = this.getProgress();
    for (const listener of this.progressListeners) {
      try {
        listener(progress);
      } catch (e) {
        log.error({ err: e }, "[Prefetch] Error in progress listener");
      }
    }
  }

  /**
   * Get current progress
   */
  getProgress(): PrefetchProgress {
    // Build agent draft queue items: active (running/queued) + recent completed
    const activeItems = [...this.agentDraftItems.values()];
    const backlogItems: AgentDraftItem[] = this.agentDraftBacklog
      .filter((t) => !this.agentDraftItems.has(t.emailId))
      .map((t) => {
        const email = getEmail(t.emailId);
        return {
          emailId: t.emailId,
          subject: email?.subject || "(no subject)",
          from: email?.from || "",
          priority: email?.analysis?.priority || "low",
          status: "queued" as const,
        };
      });

    const queuedCount = this.agentDraftBacklog.length;
    const runningCount = this.activeAgentDraftCount;
    const completedCount = this.completedAgentDraftLog.filter(
      (i) => i.status === "completed",
    ).length;
    const failedCount = this.completedAgentDraftLog.filter((i) => i.status === "failed").length;

    return {
      status: this.status,
      queueLength: this.queue.length,
      currentTask: this.currentTask
        ? {
            emailId: this.currentTask.emailId,
            type: this.currentTask.type,
          }
        : undefined,
      processed: { ...this.processedCounts },
      agentDrafts: {
        queued: queuedCount,
        running: runningCount,
        completed: completedCount,
        failed: failedCount,
        items: [
          ...activeItems,
          ...backlogItems,
          ...this.completedAgentDraftLog.slice(-10).reverse(),
        ],
      },
    };
  }

  /**
   * Reset caches - call when config changes
   */
  reset(): void {
    this.analyzer = null;
    this.archiveReadyAnalyzer = null;
    // Don't reset processed sets - those track what's been done this session
  }

  /**
   * Reset extension enrichment tracking so emails can be re-queued.
   * Call this after an extension completes authentication to re-process
   * all emails that were skipped due to missing credentials.
   */
  resetExtensionEnrichments(): void {
    log.info(
      `[Prefetch] Resetting extension enrichment tracking (was: ${this.processedExtensionEnrichments.size} emails, ${this.processedSenderProfiles.size} senders)`,
    );
    this.processedExtensionEnrichments.clear();
    this.processedSenderProfiles.clear();
    this.pendingSenderLookups.clear();
  }

  /**
   * Remove a single email from the processed-drafts set so it can be re-queued.
   */
  removeFromProcessedDrafts(emailId: string): void {
    this.processedDrafts.delete(emailId);
    // Also clear thread-level tracking so the thread can be re-queued
    const email = getEmail(emailId);
    if (email?.threadId) this.processedDraftThreads.delete(email.threadId);
    // Clear active task tracking so the old task's catch block detects it was superseded
    this.activeAgentTaskIds.delete(emailId);
  }

  addToProcessedDrafts(emailId: string): void {
    this.processedDrafts.add(emailId);
    // Also restore thread-level tracking to prevent duplicate drafts
    const email = getEmail(emailId);
    if (email?.threadId) this.processedDraftThreads.add(email.threadId);
  }

  /**
   * Check if any email from this thread already has an agent draft queued, running,
   * in backlog, or processed. The agent drafting system operates on the whole thread,
   * so we only need one draft per thread.
   */
  private isThreadAlreadyQueuedForDraft(threadId: string): boolean {
    if (this.processedDraftThreads.has(threadId)) return true;
    // Check active/queued items
    for (const [, item] of this.agentDraftItems) {
      const e = getEmail(item.emailId);
      if (e?.threadId === threadId) return true;
    }
    // Check backlog
    for (const task of this.agentDraftBacklog) {
      const e = getEmail(task.emailId);
      if (e?.threadId === threadId) return true;
    }
    // Check main queue
    for (const task of this.queue) {
      if (task.type === "agent-draft") {
        const e = getEmail(task.emailId);
        if (e?.threadId === threadId) return true;
      }
    }
    return false;
  }

  /**
   * Force-queue an agent draft for an email, bypassing the analysis needsReply gate.
   * Used when a stale draft is cleaned up due to a third-party reply — the user
   * clearly cares about this thread (they had a draft), so we should always re-draft.
   */
  forceQueueAgentDraft(emailId: string): void {
    // Clear processedDrafts since this is an explicit re-queue after draft cleanup.
    // Without this, a previously-processed email would be silently skipped.
    this.processedDrafts.delete(emailId);
    // Skip if already queued/running — don't touch processedDraftThreads in this case,
    // because the existing queue/running item still provides thread-level dedup via
    // isThreadAlreadyQueuedForDraft's scan of agentDraftItems/backlog/queue.
    if (this.agentDraftItems.has(emailId)) return;
    if (this.queue.some((t) => t.type === "agent-draft" && t.emailId === emailId)) return;
    if (this.agentDraftBacklog.some((t) => t.emailId === emailId)) return;

    const isTest = process.env.EXO_TEST_MODE === "true";
    const isDemo = process.env.EXO_DEMO_MODE === "true";
    if (isTest || isDemo) return;

    // Clear and re-set thread tracking only when we actually queue
    const email = getEmail(emailId);
    if (email?.threadId) this.processedDraftThreads.delete(email.threadId);
    log.info(`[Prefetch] Force-queueing agent draft for ${emailId} (thread received new reply)`);
    this.forceQueuedDrafts.add(emailId);
    this.queue.push({
      emailId,
      type: "agent-draft",
      priority: 5, // High priority — user cares about this thread
    });
    if (email?.threadId) this.processedDraftThreads.add(email.threadId);
    this.processQueue();
  }

  /** Get the active agent taskId for an email (if one is currently running). */
  getActiveAgentTaskId(emailId: string): string | undefined {
    return this.activeAgentTaskIds.get(emailId);
  }

  /** Register a manually-triggered agent draft for dedup tracking. */
  trackManualAgentDraft(emailId: string, taskId: string): void {
    this.activeAgentTaskIds.set(emailId, taskId);
    this.agentDraftItems.set(emailId, {
      emailId,
      subject: "",
      from: "",
      priority: "",
      status: "running",
      startedAt: Date.now(),
    });
  }

  /**
   * Build the agent context for drafting a reply to a specific email.
   * Extracted from processAgentDraft so it can be reused by the rerun IPC handler.
   */
  buildAgentDraftContext(
    emailId: string,
  ): { prompt: string; context: AgentContext; taskId: string } | null {
    const email = getEmail(emailId);
    if (!email) return null;

    const config = getConfig();
    let prompt = config.agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT;
    if (config.ea) {
      prompt += this.buildEAPromptSuffix(config.ea);
    }

    const accounts = getAccounts();
    if (accounts.length === 0) return null;
    const account = email.accountId
      ? accounts.find((a) => a.id === email.accountId)
      : (accounts.find((a) => a.isPrimary) ?? accounts[0]);

    const taskId = `auto-draft-${emailId}-${Date.now()}`;
    const context: AgentContext = {
      accountId: account?.id || "",
      currentEmailId: emailId,
      currentThreadId: email.threadId,
      userEmail: account?.email || "",
      userName: account?.displayName,
      emailSubject: email.subject,
      emailFrom: email.from,
      emailBody: email.body,
    };

    return { prompt, context, taskId };
  }

  /**
   * Clear all state - call on logout or account switch
   */
  clear(): void {
    this.reset();
    this.queue = [];
    this.cachedInboxEmails = null;
    this.startupCacheOpen = false;
    this.processedAnalysis.clear();
    this.processedSenderProfiles.clear();
    this.processedDrafts.clear();
    this.processedDraftThreads.clear();
    this.processedExtensionEnrichments.clear();
    this.processedArchiveReady.clear();
    this.pendingSenderLookups.clear();
    this.agentDraftBacklog = [];
    this.agentDraftItems.clear();
    this.activeAgentTaskIds.clear();
    this.forceQueuedDrafts.clear();
    this.completedAgentDraftLog = [];
    // Note: activeAgentDraftCount is not reset — running agents finish naturally
    // and their finally() handlers correctly decrement the count
    this.processedCounts = {
      analysis: 0,
      senderProfile: 0,
      draft: 0,
      extensionEnrichment: 0,
      archiveReady: 0,
    };
    this.emitProgress();
  }

  getStatus(): PrefetchStatus {
    return this.status;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

// Singleton instance
export const prefetchService = new PrefetchService();
