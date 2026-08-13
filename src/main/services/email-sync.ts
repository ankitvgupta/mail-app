import { type GmailClient, isAuthError } from "./gmail-client";
import {
  saveEmail,
  deleteEmail,
  getHistoryId,
  setHistoryId,
  hasEmailsForAccount,
  getEmailIds,
  getInboxThreadIds,
  getEmail,
  updateEmailLabelIds,
  deleteArchiveReadyForThreads,
  getArchiveReadyForThread,
  batchInsertOnboardingSkips,
} from "../db";
import { cleanupStaleDraftsForThread, deleteGmailDraftById } from "./gmail-draft-sync";
import { prefetchService } from "./prefetch-service";
import { snoozeService } from "./snooze-service";
import { networkMonitor } from "./network-monitor";
// Background sync disabled - was causing memory issues
// import { backgroundSyncService } from "./background-sync";
import type { Email, DashboardEmail } from "../../shared/types";
import { createLogger } from "./logger";

const log = createLogger("sync");

const DEFAULT_SYNC_INTERVAL = 30000; // 30 seconds

export type SyncStatus = "idle" | "syncing" | "error";
export type AccountInfo = {
  accountId: string;
  email: string;
  displayName?: string;
  isConnected: boolean;
};

type SyncAccount = {
  client: GmailClient;
  email: string;
  intervalId: NodeJS.Timeout | null;
  status: SyncStatus;
  lastError?: string;
  // Set at registration when account has no stored emails — consumed by
  // the first fullSync to run triage. Prevents race conditions where emails
  // arrive between registration and the fullSync check.
  needsFirstSyncTriage?: boolean;
};

const HEALTH_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes

class EmailSyncService {
  private accounts: Map<string, SyncAccount> = new Map();
  private syncInterval: number = DEFAULT_SYNC_INTERVAL;
  private healthCheckIntervalId: NodeJS.Timeout | null = null;
  // Tracks whether we've done the one-time sent backfill per account
  private sentBackfillDone: Set<string> = new Set();
  private onNewEmails?: (accountId: string, emails: DashboardEmail[]) => void;
  private onNewSentEmails?: (accountId: string, emails: DashboardEmail[]) => void;
  private onSyncStatusChange?: (accountId: string, status: SyncStatus) => void;
  private onEmailsRemoved?: (accountId: string, emailIds: string[]) => void;
  private onEmailsUpdated?: (
    accountId: string,
    updates: { emailId: string; labelIds: string[] }[],
  ) => void;
  private onAuthErrorCallback?: (accountId: string, email: string) => void;
  private onDraftsRemoved?: (accountId: string, emailIds: string[]) => void;
  private onSyncProgress?: (
    accountId: string,
    progress: { fetched: number; total: number },
  ) => void;
  private networkListenersSetup: boolean = false;

  /**
   * Set up network monitor listeners for pause/resume
   * Called once during initialization
   */
  setupNetworkListeners(): void {
    if (this.networkListenersSetup) return;

    networkMonitor.on("offline", () => {
      log.info("[Sync] Went offline, pausing sync");
      this.pauseAllSync();
    });

    networkMonitor.on("online", () => {
      log.info("[Sync] Back online, resuming sync");
      this.resumeAllSync();
    });

    this.networkListenersSetup = true;
  }

  /**
   * Pause syncing for all accounts (when offline)
   */
  private pauseAllSync(): void {
    for (const [accountId, account] of this.accounts) {
      if (account.intervalId) {
        clearInterval(account.intervalId);
        account.intervalId = null;
      }
      this.onSyncStatusChange?.(accountId, "idle");
    }
  }

  /**
   * Resume syncing for all accounts (when back online)
   */
  private resumeAllSync(): void {
    for (const accountId of this.accounts.keys()) {
      this.startSync(accountId);
    }
  }

  /**
   * Get client for an account (exposed for outbox service)
   */
  getClientForAccount(accountId: string): GmailClient | null {
    return this.accounts.get(accountId)?.client || null;
  }

  /**
   * Register a Gmail client for a specific account
   */
  async registerAccount(client: GmailClient): Promise<AccountInfo> {
    const accountId = client.getAccountId();

    // Get profile to retrieve email address, and display name for account setup
    const [profile, displayName] = await Promise.all([
      client.getProfile(),
      client.fetchDisplayName(),
    ]);

    // Only use stored history ID if we have existing emails for this account
    // This ensures new accounts do a full sync first
    const storedHistoryId = getHistoryId(accountId);
    const hasExistingEmails = hasEmailsForAccount(accountId);

    // A full sync has completed before only if we have BOTH a history ID and emails.
    // No history ID means first-time sync is needed, even if some emails exist
    // (e.g. from a partial sync interrupted by HMR restart).
    const hasCompletedFullSync = !!(storedHistoryId && hasExistingEmails);

    if (hasCompletedFullSync) {
      // We have emails, use incremental sync from stored history
      client.setLastHistoryId(storedHistoryId);
      log.info(`[Sync] Using stored history for ${profile.emailAddress}: ${storedHistoryId}`);
    } else {
      // New account or no emails - clear history ID so full sync happens
      // Note: getProfile() sets lastHistoryId, so we must explicitly clear it
      client.setLastHistoryId(null);
      log.info(
        `[Sync] No stored emails for ${profile.emailAddress}, will do full sync (historyId=${storedHistoryId}, hasEmails=${hasExistingEmails})`,
      );
    }

    this.accounts.set(accountId, {
      client,
      email: profile.emailAddress,
      intervalId: null,
      status: "idle",
      // Mark for first-sync triage when no full sync has completed before.
      // This is captured at registration to avoid race conditions.
      needsFirstSyncTriage: !hasCompletedFullSync,
    });

    log.info(
      `[Sync] Registered account: ${profile.emailAddress} (${accountId}, needsFirstSyncTriage=${!hasCompletedFullSync})`,
    );

    return {
      accountId,
      email: profile.emailAddress,
      displayName: displayName ?? undefined,
      isConnected: true,
    };
  }

  /**
   * Unregister an account and stop syncing
   */
  unregisterAccount(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (account) {
      if (account.intervalId) {
        clearInterval(account.intervalId);
      }
      this.accounts.delete(accountId);
      log.info(`[Sync] Unregistered account: ${accountId}`);
    }
  }

  /**
   * Get all registered accounts
   */
  getAccounts(): AccountInfo[] {
    return Array.from(this.accounts.entries()).map(([accountId, account]) => ({
      accountId,
      email: account.email,
      isConnected: account.status !== "error",
    }));
  }

  /**
   * Start automatic syncing for an account
   */
  startSync(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) {
      log.error(`[Sync] Account not found: ${accountId}`);
      return;
    }

    // Stop any existing sync
    if (account.intervalId) {
      clearInterval(account.intervalId);
    }

    // Do initial sync
    this.syncAccount(accountId);

    // Start interval
    account.intervalId = setInterval(() => {
      this.syncAccount(accountId);
    }, this.syncInterval);

    log.info(`[Sync] Started sync for ${account.email} (every ${this.syncInterval / 1000}s)`);
  }

  /**
   * Stop automatic syncing for an account
   */
  stopSync(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (account?.intervalId) {
      clearInterval(account.intervalId);
      account.intervalId = null;
      account.status = "idle";
      log.info(`[Sync] Stopped sync for ${account.email}`);
    }
  }

  /**
   * Start syncing for all accounts
   */
  startAllSync(): void {
    for (const accountId of this.accounts.keys()) {
      this.startSync(accountId);
    }
    this.startHealthCheck();
  }

  /**
   * Stop syncing for all accounts
   */
  stopAllSync(): void {
    for (const accountId of this.accounts.keys()) {
      this.stopSync(accountId);
    }
    this.stopHealthCheck();
  }

  /**
   * Trigger immediate sync for an account
   */
  async syncNow(accountId: string): Promise<void> {
    await this.syncAccount(accountId);
  }

  /**
   * Set the sync interval (in milliseconds)
   */
  setSyncInterval(interval: number): void {
    this.syncInterval = Math.max(10000, interval); // Minimum 10 seconds

    // Restart all active syncs with new interval
    for (const [accountId, account] of this.accounts) {
      if (account.intervalId) {
        this.stopSync(accountId);
        this.startSync(accountId);
      }
    }
  }

  /**
   * Set callback for new emails
   */
  onNewEmailsReceived(callback: (accountId: string, emails: DashboardEmail[]) => void): void {
    this.onNewEmails = callback;
  }

  /**
   * Set callback for new sent emails (sent-view only, not added to inbox)
   */
  onNewSentEmailsReceived(callback: (accountId: string, emails: DashboardEmail[]) => void): void {
    this.onNewSentEmails = callback;
  }

  /**
   * Set callback for sync status changes
   */
  onStatusChange(callback: (accountId: string, status: SyncStatus) => void): void {
    this.onSyncStatusChange = callback;
  }

  /**
   * Set callback for removed emails
   */
  onEmailsRemovedCallback(callback: (accountId: string, emailIds: string[]) => void): void {
    this.onEmailsRemoved = callback;
  }

  /**
   * Set callback for email label updates (e.g. read/unread changes from external clients)
   */
  onEmailsUpdatedCallback(
    callback: (accountId: string, updates: { emailId: string; labelIds: string[] }[]) => void,
  ): void {
    this.onEmailsUpdated = callback;
  }

  /**
   * Set callback for auth errors (expired/revoked tokens).
   * Fired when sync detects an auth failure — distinct from generic sync errors.
   */
  onAuthError(callback: (accountId: string, email: string) => void): void {
    this.onAuthErrorCallback = callback;
  }

  /**
   * Set callback for when drafts are removed during sync (user replied elsewhere
   * or someone else replied, making old drafts stale).
   */
  onDraftsRemovedCallback(callback: (accountId: string, emailIds: string[]) => void): void {
    this.onDraftsRemoved = callback;
  }

  /**
   * Set callback for sync progress updates (fetched/total during full sync)
   */
  onProgressChange(
    callback: (accountId: string, progress: { fetched: number; total: number }) => void,
  ): void {
    this.onSyncProgress = callback;
  }

  /**
   * Fetch recent sent emails that belong to inbox threads and save them to the DB.
   * Runs once per account per app session to backfill sent replies the incremental
   * history sync may have missed (e.g. replies sent before SENT was added to history).
   */
  private async syncSentForInboxThreads(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    const { client } = account;
    const inboxThreadIds = getInboxThreadIds(accountId);
    if (inboxThreadIds.size === 0) return;

    // Get recent sent message stubs (id + threadId only, lightweight)
    const sentResults = await client.getEmailsByLabel("SENT", 200);

    // Filter to only sent emails whose thread has an inbox email
    const existingIds = getEmailIds(accountId);
    const toFetch = sentResults.filter(
      (r) => inboxThreadIds.has(r.threadId) && !existingIds.has(r.id),
    );

    if (toFetch.length === 0) return;

    log.info(
      `[Sync] Backfilling ${toFetch.length} sent emails for inbox threads (${account.email})`,
    );
    const newEmails: DashboardEmail[] = [];

    for (let i = 0; i < toFetch.length; i++) {
      try {
        const email = await client.readEmail(toFetch[i].id);
        if (email) {
          saveEmail(email, accountId);
          newEmails.push({
            ...email,
            accountId,
            labelIds: email.labelIds,
            analysis: undefined,
            draft: undefined,
          });
        }
      } catch (err) {
        log.error({ err: err }, `[Sync] Failed to fetch sent email ${toFetch[i].id}`);
      }
      // Yield every 10 fetches to avoid starving the event loop
      if ((i + 1) % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (newEmails.length > 0) {
      this.onNewEmails?.(accountId, newEmails);

      // Sent emails change thread completeness — re-evaluate archive-readiness.
      // Skip threads that already have a delayed reanalysis from compose (user
      // just replied through the app — the timer in compose.ipc.ts handles it).
      // Lazy import to avoid circular dependency (compose.ipc → sync.ipc → email-sync → compose.ipc).
      const sentEmails = newEmails.filter((e) => e.labelIds?.includes("SENT"));
      if (sentEmails.length > 0) {
        const { hasPendingReanalysis } = await import("../ipc/compose.ipc");
        const sentThreadIds = [...new Set(sentEmails.map((e) => e.threadId))].filter(
          (tid) => !hasPendingReanalysis(tid),
        );
        if (sentThreadIds.length > 0) {
          prefetchService.requeueArchiveReadyForThreads(sentThreadIds, accountId);
        }
      }
    }
  }

  /**
   * Fetch all recent sent emails and save to DB (for the Sent mail view).
   * Unlike syncSentForInboxThreads which only saves sent emails in inbox threads,
   * this saves ALL sent emails so they appear in the dedicated Sent view.
   */
  private async syncAllSentEmails(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    const { client } = account;
    const existingIds = getEmailIds(accountId);

    // Fetch recent sent emails (up to 500)
    const sentResults = await client.getEmailsByLabel("SENT", 500);
    const toFetch = sentResults.filter((r) => !existingIds.has(r.id));

    if (toFetch.length === 0) return;

    log.info(`[Sync] Syncing ${toFetch.length} sent emails for Sent view (${account.email})`);
    const newEmails: DashboardEmail[] = [];

    for (let i = 0; i < toFetch.length; i++) {
      try {
        const email = await client.readEmail(toFetch[i].id);
        if (email) {
          saveEmail(email, accountId);
          newEmails.push({
            ...email,
            accountId,
            labelIds: email.labelIds,
            analysis: undefined,
            draft: undefined,
          });
        }
      } catch (err) {
        log.error({ err: err }, `[Sync] Failed to fetch sent email ${toFetch[i].id}`);
      }
      // Yield every 10 fetches to avoid starving the event loop
      if ((i + 1) % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (newEmails.length > 0) {
      this.onNewSentEmails?.(accountId, newEmails);
    }
  }

  /**
   * Perform incremental sync for an account using History API
   */
  private async syncAccount(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    const { client } = account;
    const historyId = client.getLastHistoryId();

    log.info(`[Sync] syncAccount called for ${account.email}, historyId=${historyId}`);

    account.status = "syncing";
    this.onSyncStatusChange?.(accountId, "syncing");

    try {
      if (!historyId) {
        // No history ID - do full sync
        // Use the flag captured at registration time to avoid race conditions.
        // Don't consume the flag yet — fullSync takes minutes and we need
        // hasFirstSyncPending() to return true the entire time to suppress
        // premature processAllPending() calls.
        const runTriage = account.needsFirstSyncTriage ?? false;
        log.info(`[Sync] FULL SYNC for ${account.email} (no history ID, runTriage=${runTriage})`);
        await this.fullSync(accountId, { runTriage });
        if (runTriage) {
          account.needsFirstSyncTriage = false; // consume after triage completes
        }
      } else {
        // Incremental sync using History API
        log.info(`[Sync] INCREMENTAL sync for ${account.email} from history ${historyId}`);
        await this.incrementalSync(accountId, historyId);
      }

      account.status = "idle";
      account.lastError = undefined;
      this.onSyncStatusChange?.(accountId, "idle");
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ err: errMsg }, `[Sync] Error syncing ${account.email}`);

      if (isAuthError(error)) {
        // Auth failure — stop sync for this account, notify caller
        log.error(`[Sync] Auth error for ${account.email}, stopping sync`);
        this.stopSync(accountId);
        account.status = "error";
        account.lastError = "Authentication expired";
        this.onSyncStatusChange?.(accountId, "error");
        this.onAuthErrorCallback?.(accountId, account.email);
      } else if (errMsg === "HISTORY_EXPIRED") {
        // History ID expired, do full sync
        log.info(`[Sync] History expired, doing full sync for ${account.email}`);
        try {
          await this.fullSync(accountId);
          account.status = "idle";
          this.onSyncStatusChange?.(accountId, "idle");
        } catch (fullSyncError: unknown) {
          if (isAuthError(fullSyncError)) {
            log.error(`[Sync] Auth error during full sync for ${account.email}`);
            this.stopSync(accountId);
            account.status = "error";
            account.lastError = "Authentication expired";
            this.onSyncStatusChange?.(accountId, "error");
            this.onAuthErrorCallback?.(accountId, account.email);
          } else {
            account.status = "error";
            account.lastError =
              fullSyncError instanceof Error ? fullSyncError.message : String(fullSyncError);
            this.onSyncStatusChange?.(accountId, "error");
          }
        }
      } else {
        account.status = "error";
        account.lastError = errMsg;
        this.onSyncStatusChange?.(accountId, "error");
      }
    }
  }

  /**
   * Full sync - fetch all inbox emails
   */
  static readonly MAX_SYNC_EMAILS = 2500;

  private async fullSync(
    accountId: string,
    options?: { skipPrefetch?: boolean; suppressNotification?: boolean; runTriage?: boolean },
  ): Promise<DashboardEmail[]> {
    const account = this.accounts.get(accountId);
    if (!account) return [];

    const { client } = account;
    log.info(`[Sync] fullSync starting for ${account.email}`);

    // Get profile to update history ID
    const profile = await client.getProfile();
    setHistoryId(accountId, profile.historyId);
    log.info(`[Sync] fullSync got profile, historyId=${profile.historyId}`);

    // Get emails with INBOX label (the actual inbox, not all mail)
    const searchResults = await client.getEmailsByLabel("INBOX", EmailSyncService.MAX_SYNC_EMAILS);
    log.info(`[Sync] fullSync found ${searchResults.length} inbox emails`);

    const existingIds = getEmailIds(accountId);
    log.info(`[Sync] fullSync existing emails: ${existingIds.size}`);

    // Filter to only new emails, then fetch full content concurrently
    const newIds = searchResults.filter((r) => !existingIds.has(r.id)).map((r) => r.id);
    log.info(`[Sync] fullSync fetching ${newIds.length} new emails (concurrent, batch size 10)`);

    // Emit initial progress
    this.onSyncProgress?.(accountId, { fetched: 0, total: newIds.length });

    const allFetchedEmails: Email[] = [];
    // Accumulate emails and emit in larger batches to reduce renderer re-renders.
    // During full sync with 500+ emails, emitting every 10 causes 50+ store
    // flushes each triggering full groupByThread recomputation → CPU spike.
    const EMIT_BATCH_SIZE = 50;
    let pendingEmit: DashboardEmail[] = [];
    let lastEmitTime = Date.now();

    // Process in chunks of 10, emitting each batch progressively
    for (let i = 0; i < newIds.length; i += 10) {
      const chunk = newIds.slice(i, i + 10);
      const results = await Promise.allSettled(chunk.map((id) => client.readEmail(id)));

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          const email = result.value;
          allFetchedEmails.push(email);
          saveEmail(email, accountId);
          pendingEmit.push({
            ...email,
            accountId,
            labelIds: email.labelIds,
            analysis: undefined,
            draft: undefined,
          });
        }
      }

      // Emit accumulated emails every EMIT_BATCH_SIZE or every 2 seconds,
      // whichever comes first. This gives the renderer progressive updates
      // without overwhelming it with tiny batches.
      const now = Date.now();
      if (
        pendingEmit.length >= EMIT_BATCH_SIZE ||
        (pendingEmit.length > 0 && now - lastEmitTime >= 2000)
      ) {
        if (!options?.suppressNotification) {
          this.onNewEmails?.(accountId, pendingEmit);
        }
        pendingEmit = [];
        // Always reset timer when draining — even when suppressed — so the
        // 2-second window slides correctly and batching isn't degraded.
        lastEmitTime = now;
      }

      // Emit progress (always, even when suppressNotification is true)
      this.onSyncProgress?.(accountId, {
        fetched: Math.min(i + 10, newIds.length),
        total: newIds.length,
      });

      // Yield to the event loop between API batches so IPC handlers, UI
      // updates and other async work can run. Without this, fetching 500+
      // emails monopolizes the main thread and causes beach-ball on macOS.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Flush any remaining emails that didn't hit the batch threshold
    if (pendingEmit.length > 0 && !options?.suppressNotification) {
      this.onNewEmails?.(accountId, pendingEmit);
    }

    // Build the full newEmails array from all fetched emails
    const newEmails: DashboardEmail[] = allFetchedEmails.map((email) => ({
      ...email,
      accountId,
      labelIds: email.labelIds,
      analysis: undefined,
      draft: undefined,
    }));

    if (newEmails.length > 0) {
      log.info(`[Sync] Fetched ${newEmails.length} new emails for ${account.email}`);
    }

    // When runTriage is set, do first-time triage as a post-sync step
    const effectiveSkipPrefetch = options?.skipPrefetch || options?.runTriage;
    if (options?.runTriage && newEmails.length > 0) {
      // Sort by date descending (newest first) to partition by position
      const sorted = [...newEmails].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );

      // Top 500 newest get analyzed, the rest are skipped
      const analysisWindow = sorted.slice(0, EmailSyncService.MAX_ANALYSIS_EMAILS);
      const overflow = sorted.slice(EmailSyncService.MAX_ANALYSIS_EMAILS);

      if (overflow.length > 0) {
        const skipIds = overflow.map((e) => e.id);
        const analysisThreadIds = new Set(analysisWindow.map((e) => e.threadId));
        const skipThreadIds = [...new Set(overflow.map((e) => e.threadId))].filter(
          (tid) => !analysisThreadIds.has(tid),
        );
        batchInsertOnboardingSkips(skipIds, skipThreadIds, accountId);
        log.info(
          `[Sync] First-time triage for ${accountId}: ` +
            `${analysisWindow.length} to analyze, ${overflow.length} overflow skipped`,
        );

        // Update in-memory email objects with skip analysis for triaged emails
        const skipIdSet = new Set(overflow.map((e) => e.id));
        const skipAnalysis = {
          needsReply: false,
          reason: "Pre-existing email before app setup",
          analyzedAt: Date.now(),
        };
        for (const email of newEmails) {
          if (skipIdSet.has(email.id)) {
            email.analysis = skipAnalysis;
          }
        }

        // Emit the triaged updates so renderer reflects skip/archive-ready state
        if (!options?.suppressNotification) {
          this.onNewEmails?.(
            accountId,
            overflow.map((e) => {
              const updated = newEmails.find((ne) => ne.id === e.id);
              return updated || e;
            }),
          );
        }
      }

      // Queue analysis window for prefetch
      if (analysisWindow.length > 0) {
        prefetchService
          .queueEmails(analysisWindow.map((e) => e.id))
          .catch((err) => log.error({ err }, "Unhandled error"));
      }
    } else if (!effectiveSkipPrefetch && newEmails.length > 0) {
      // Queue new emails for prefetching (analysis, sender profiles, drafts)
      prefetchService
        .queueEmails(newEmails.map((e) => e.id))
        .catch((err) => log.error({ err }, "Unhandled error"));
    }

    // Backfill sent emails for inbox threads
    await this.syncSentForInboxThreads(accountId);
    this.sentBackfillDone.add(accountId);

    // Sync all sent emails (for the Sent view)
    await this.syncAllSentEmails(accountId);

    return newEmails;
  }

  /**
   * How many of the synced emails will go through the analysis pipeline.
   * The rest (501–5000) are synced but marked skip + archive-ready.
   */
  static readonly MAX_ANALYSIS_EMAILS = 500;

  /**
   * Run the initial sync for a new account during onboarding.
   *
   * Syncs up to MAX_SYNC_EMAILS (2500) from Gmail. Of those:
   *  - The newest MAX_ANALYSIS_EMAILS (500) are candidates for analysis,
   *    except any older than 3 months which are also skipped.
   *  - Everything beyond that is marked skip + archive-ready.
   *
   * Does NOT start the sync loop or trigger prefetch — caller must do
   * that after the triage screen is shown.
   */
  async runOnboardingSync(accountId: string): Promise<{
    totalSynced: number;
    totalInboxCount: number;
    oldMarked: number;
    recentCount: number;
    oldEmailIds: string[];
    recentEmailIds: string[];
  }> {
    const account = this.accounts.get(accountId);
    const client = account?.client;

    // Get total inbox count for UI messaging (separate from the sync limit)
    let totalInboxCount = 0;
    if (client) {
      try {
        totalInboxCount = await client.getLabelCount("INBOX");
      } catch {
        // Non-critical — just won't show the "X more not loaded" message
      }
    }

    // Suppress onNewEmails notification during fullSync — we fire it after
    // triage so the renderer only sees already-triaged emails, avoiding a
    // flash of untriaged emails in the inbox.
    const newEmails = await this.fullSync(accountId, {
      skipPrefetch: true,
      suppressNotification: true,
    });

    // Sort by date descending (newest first) to partition by position
    const sorted = [...newEmails].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    // Build cutoff at 3 months ago, clamped to the last day of the target
    // month. Both Date.UTC and setUTCMonth overflow (e.g. May 31 → Feb 31 →
    // Mar 3), so we normalize to day 1 first, then use day=0 of the next
    // month to get the last day of the target month.
    const cutoff = new Date();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 3 + 1, 0);
    const cutoffMs = cutoff.getTime();

    // The newest MAX_ANALYSIS_EMAILS are candidates for analysis,
    // but within those, anything older than 3 months is also skipped.
    const analysisWindow = sorted.slice(0, EmailSyncService.MAX_ANALYSIS_EMAILS);
    const overflow = sorted.slice(EmailSyncService.MAX_ANALYSIS_EMAILS);

    const recentEmails = analysisWindow.filter((e) => new Date(e.date).getTime() >= cutoffMs);
    const oldInWindow = analysisWindow.filter((e) => new Date(e.date).getTime() < cutoffMs);

    // Everything beyond 500 + old emails within the 500 → skip + archive-ready
    const toSkip = [...overflow, ...oldInWindow];

    if (toSkip.length > 0) {
      const skipIds = toSkip.map((e) => e.id);
      // Don't mark threads as archive-ready if they also contain recent emails
      const recentThreadIds = new Set(recentEmails.map((e) => e.threadId));
      const skipThreadIds = [...new Set(toSkip.map((e) => e.threadId))].filter(
        (tid) => !recentThreadIds.has(tid),
      );
      batchInsertOnboardingSkips(skipIds, skipThreadIds, accountId);
      log.info(
        `[Sync] Onboarding triage for ${accountId}: ` +
          `${recentEmails.length} to analyze, ${oldInWindow.length} old in window, ` +
          `${overflow.length} overflow, ${toSkip.length} total skipped`,
      );
    }

    // Update in-memory email objects with analysis data for skipped emails
    // so the renderer receives them with their Other classification, preventing
    // them from appearing as "unanalyzed" at the top of the inbox.
    if (toSkip.length > 0) {
      const skipIdSet = new Set(toSkip.map((e) => e.id));
      const skipAnalysis = {
        needsReply: false,
        reason: "Pre-existing email before app setup",
        analyzedAt: Date.now(),
      };
      for (const email of newEmails) {
        if (skipIdSet.has(email.id)) {
          email.analysis = skipAnalysis;
        }
      }
    }

    if (newEmails.length > 0) {
      this.onNewEmails?.(accountId, newEmails);
    }

    return {
      totalSynced: newEmails.length,
      totalInboxCount,
      oldMarked: toSkip.length,
      recentCount: recentEmails.length,
      oldEmailIds: toSkip.map((e) => e.id),
      recentEmailIds: recentEmails.map((e) => e.id),
    };
  }

  /**
   * Start prefetch processing for specific emails and begin the sync loop.
   * Called after onboarding triage is complete.
   */
  async startAfterOnboarding(accountId: string, emailIdsToProcess: string[]): Promise<void> {
    if (emailIdsToProcess.length > 0) {
      await prefetchService.queueEmails(emailIdsToProcess);
    }
    this.startSync(accountId);
  }

  /**
   * Check if an account is already registered in the sync service.
   */
  isAccountRegistered(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  /**
   * Check if any account is doing a first-time sync (triage pending).
   * Used to suppress premature prefetch scanning during initial load.
   */
  hasFirstSyncPending(): boolean {
    for (const account of this.accounts.values()) {
      if (account.needsFirstSyncTriage) return true;
    }
    return false;
  }

  /**
   * Incremental sync using History API
   */
  private async incrementalSync(accountId: string, startHistoryId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    const { client } = account;

    const changes = await client.getHistoryChanges(startHistoryId);

    // Save new history ID
    setHistoryId(accountId, changes.historyId);

    // Snapshot threads that have drafts on emails about to be deleted.
    // Must happen BEFORE deleteEmail() removes the draft rows from DB,
    // otherwise the later cleanup pass can't detect that a draft existed.
    const threadsWithDeletedDrafts = new Set<string>();

    // CRITICAL: Remove message IDs that appear in BOTH deleted AND new lists.
    // This happens when a draft is sent: INBOX label removed (→ deleted) + SENT label added (→ new).
    // Processing both would delete the email then immediately re-add it, causing data loss.
    const newSet = new Set(changes.newMessageIds);
    const filteredDeleted = changes.deletedMessageIds.filter((id) => !newSet.has(id));

    // Handle deleted/archived emails
    if (filteredDeleted.length > 0) {
      log.info(`[Sync] ${filteredDeleted.length} emails removed for ${account.email}`);

      // Clean up Gmail drafts BEFORE deleting email records — deleteEmail
      // removes the local draft row but doesn't touch Gmail, and once the
      // email row is gone the getThreadDrafts JOIN can't find it.
      for (const id of filteredDeleted) {
        const email = getEmail(id);
        if (email?.draft?.gmailDraftId) {
          deleteGmailDraftById(accountId, email.draft.gmailDraftId).catch(() => {});
        }
        if (email?.draft) {
          threadsWithDeletedDrafts.add(email.threadId);
        }
      }

      for (const id of filteredDeleted) {
        deleteEmail(id, accountId);
      }
      this.onEmailsRemoved?.(accountId, filteredDeleted);
    }

    // Fetch new emails
    if (changes.newMessageIds.length > 0) {
      log.info(`[Sync] ${changes.newMessageIds.length} new emails for ${account.email}`);

      const newEmails: DashboardEmail[] = [];

      for (const id of changes.newMessageIds) {
        try {
          const email = await client.readEmail(id);
          if (email) {
            saveEmail(email, accountId);
            newEmails.push({
              ...email,
              accountId,
              labelIds: email.labelIds,
              analysis: undefined,
              draft: undefined,
            });
          }
        } catch (err) {
          log.error({ err: err }, `[Sync] Failed to fetch email ${id}`);
        }
      }

      if (newEmails.length > 0) {
        this.onNewEmails?.(accountId, newEmails);

        // Unsnooze any threads that received replies
        const threadIds = [...new Set(newEmails.map((e) => e.threadId))];
        snoozeService.unsnoozeForReplies(threadIds, accountId);

        // Queue new emails for prefetching (analysis, sender profiles, drafts)
        prefetchService
          .queueEmails(newEmails.map((e) => e.id))
          .catch((err) => log.error({ err }, "Unhandled error"));

        // New received emails invalidate archive-ready status for their threads —
        // remove immediately so the thread goes back to the prioritized inbox.
        const receivedEmails = newEmails.filter((e) => !e.labelIds?.includes("SENT"));
        if (receivedEmails.length > 0) {
          const receivedThreadIds = [...new Set(receivedEmails.map((e) => e.threadId))];
          this.clearArchiveReadyForThreads(receivedThreadIds, accountId);
          // Re-queue archive-ready analysis with the new email context
          prefetchService.requeueArchiveReadyForThreads(receivedThreadIds, accountId);
        }

        // Sent emails change thread completeness — re-evaluate archive-readiness.
        // Skip threads with a pending delayed reanalysis from compose (the user
        // just replied through the app and the grace-period timer handles it).
        // Lazy import to avoid circular dependency (compose.ipc → sync.ipc → email-sync → compose.ipc).
        const sentEmails = newEmails.filter((e) => e.labelIds?.includes("SENT"));
        if (sentEmails.length > 0) {
          const sentThreadIds = [...new Set(sentEmails.map((e) => e.threadId))];
          this.clearArchiveReadyForThreads(sentThreadIds, accountId);
          const { hasPendingReanalysis } = await import("../ipc/compose.ipc");
          const threadIdsToRequeue = sentThreadIds.filter((tid) => !hasPendingReanalysis(tid));
          if (threadIdsToRequeue.length > 0) {
            prefetchService.requeueArchiveReadyForThreads(threadIdsToRequeue, accountId);
          }
        }

        // --- Draft cleanup: remove stale drafts when new activity supersedes them ---
        // Any new email in a thread with existing drafts invalidates those drafts:
        //   - User replied from another client (SENT) → draft is superseded
        //   - Someone else replied (received) → context changed, draft is stale
        //
        // Two-pass approach decouples cleanup from force-queueing to avoid a bug
        // where a SENT email processed first would prevent force-queueing for a
        // received email in the same thread (processedThreads dedup).
        const removedDraftEmailIds: string[] = [];
        const threadsWithRemovedDrafts = new Set<string>();
        const processedThreads = new Set<string>();
        const newEmailIds = new Set(newEmails.map((e) => e.id));

        // Pass 1: clean up stale drafts (one pass per thread, order doesn't matter)
        for (const email of newEmails) {
          if (processedThreads.has(email.threadId)) continue;
          processedThreads.add(email.threadId);

          const hasSent = newEmails.some(
            (e) => e.threadId === email.threadId && e.labelIds?.includes("SENT"),
          );
          const reason = hasSent ? "user replied from another client" : "new reply in thread";
          const removed = cleanupStaleDraftsForThread(
            email.threadId,
            accountId,
            newEmailIds,
            reason,
            hasSent,
          );

          if (removed.length > 0) {
            removedDraftEmailIds.push(...removed);
            threadsWithRemovedDrafts.add(email.threadId);
          }
        }

        // Pass 2: force-queue agent drafts for received (non-SENT) emails in
        // threads that lost drafts — either via cleanup above or via the deletion
        // handler (which removes email rows before cleanup can find them).
        // Skip threads where the user themselves sent a reply (draft was superseded).
        const forceQueuedThreads = new Set<string>();
        for (const email of newEmails) {
          if (email.labelIds?.includes("SENT")) continue;
          const tid = email.threadId;
          if (forceQueuedThreads.has(tid)) continue;
          if (!threadsWithRemovedDrafts.has(tid) && !threadsWithDeletedDrafts.has(tid)) continue;
          // Don't re-draft if the user also replied in this thread
          const userAlsoReplied = newEmails.some(
            (e) => e.threadId === tid && e.labelIds?.includes("SENT"),
          );
          if (userAlsoReplied) continue;

          log.info(
            `[Sync] Force-queueing agent draft for ${email.id} — thread ${tid} had a draft removed by new activity`,
          );
          prefetchService.forceQueueAgentDraft(email.id);
          forceQueuedThreads.add(tid);
        }

        if (removedDraftEmailIds.length > 0) {
          this.onDraftsRemoved?.(accountId, removedDraftEmailIds);
        }
      }
    }

    // Handle read/unread label changes from external clients (Gmail web, mobile, etc.)
    const labelUpdates: { emailId: string; labelIds: string[] }[] = [];

    for (const messageId of changes.readMessageIds) {
      const email = getEmail(messageId);
      if (email) {
        // Default to ["INBOX"] for legacy emails with no labels stored
        const currentLabels = email.labelIds || ["INBOX"];
        if (currentLabels.includes("UNREAD")) {
          const newLabels = currentLabels.filter((l) => l !== "UNREAD");
          log.info(
            `[Sync] Marking ${messageId} as read: ${JSON.stringify(currentLabels)} → ${JSON.stringify(newLabels)}`,
          );
          updateEmailLabelIds(messageId, newLabels);
          labelUpdates.push({ emailId: messageId, labelIds: newLabels });
        }
      }
    }

    for (const messageId of changes.unreadMessageIds) {
      const email = getEmail(messageId);
      if (email) {
        // Default to ["INBOX"] for legacy emails with no labels stored
        const currentLabels = email.labelIds || ["INBOX"];
        if (!currentLabels.includes("UNREAD")) {
          const newLabels = [...currentLabels, "UNREAD"];
          log.info(
            `[Sync] Marking ${messageId} as unread: ${JSON.stringify(currentLabels)} → ${JSON.stringify(newLabels)}`,
          );
          updateEmailLabelIds(messageId, newLabels);
          labelUpdates.push({ emailId: messageId, labelIds: newLabels });
        }
      }
    }

    if (labelUpdates.length > 0) {
      log.info(`[Sync] ${labelUpdates.length} label updates for ${account.email}`);
      this.onEmailsUpdated?.(accountId, labelUpdates);
    }

    // One-time backfill of sent emails for inbox threads (once per app session)
    if (!this.sentBackfillDone.has(accountId)) {
      this.sentBackfillDone.add(accountId);
      await this.syncSentForInboxThreads(accountId);
    }
  }

  /**
   * Start periodic token health checks for all accounts.
   * Catches expired tokens proactively (before a sync attempt fails).
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckIntervalId = setInterval(() => {
      this.runHealthChecks();
    }, HEALTH_CHECK_INTERVAL);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    for (const [accountId, account] of this.accounts) {
      // Skip accounts that are already in error state (already reported)
      if (account.status === "error" && account.lastError === "Authentication expired") {
        continue;
      }
      try {
        const healthy = await account.client.checkTokenHealth();
        if (!healthy) {
          log.error(`[Sync] Health check failed for ${account.email}, token expired`);
          this.stopSync(accountId);
          account.status = "error";
          account.lastError = "Authentication expired";
          this.onSyncStatusChange?.(accountId, "error");
          this.onAuthErrorCallback?.(accountId, account.email);
        }
      } catch {
        // Non-auth error (network) — ignore, regular sync will handle it
      }
    }
  }

  /**
   * Clear archive-ready status for threads and notify the renderer.
   * Called when new emails arrive (received or sent) that invalidate prior analysis.
   */
  private clearArchiveReadyForThreads(threadIds: string[], accountId: string): void {
    // Check which threads actually had archive-ready status
    const affectedThreadIds = threadIds.filter((tid) => {
      const result = getArchiveReadyForThread(tid, accountId);
      return result?.isReady;
    });

    if (affectedThreadIds.length === 0) return;

    log.info(
      `[Sync] Clearing archive-ready for ${affectedThreadIds.length} threads (new activity detected)`,
    );
    deleteArchiveReadyForThreads(affectedThreadIds, accountId);

    // Notify renderer to remove from archive-ready set
    // Use lazy import to avoid circular dependency
    import("../ipc/prefetch.ipc")
      .then(({ notifyArchiveReady }) => {
        for (const threadId of affectedThreadIds) {
          notifyArchiveReady(threadId, accountId, false, "");
        }
      })
      .catch((err) => log.error({ err }, "Unhandled error"));
  }

  /**
   * Get sync status for an account
   */
  getSyncStatus(accountId: string): SyncStatus {
    return this.accounts.get(accountId)?.status || "idle";
  }
}

// Export singleton
export const emailSyncService = new EmailSyncService();
