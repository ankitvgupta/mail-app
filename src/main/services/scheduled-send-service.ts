import { EventEmitter } from "events";
import {
  getDueScheduledMessages,
  getNextScheduledMessageTime,
  getScheduledMessages,
  claimScheduledMessage,
  updateScheduledMessageStatus,
  getScheduledMessageStats,
  type ScheduledMessageRow,
} from "../db";
import type { GmailClient } from "./gmail-client";
import { createLogger } from "./logger";
import { isNetworkError } from "./network-errors";
import { networkMonitor } from "./network-monitor";

const log = createLogger("scheduled-send");

// Upper bound on a single sleep. Long-horizon items (send-later days out) re-arm
// at least this often so clock changes and suspend/resume can't strand them.
const MAX_SLEEP = 30_000;

// Grace period for active sends during quit. Once it expires, their HTTP
// requests are aborted and the rows are put back into 'scheduled' before the DB
// is closed, so startup recovery can retry them safely.
const QUIT_FLUSH_TIMEOUT = 5_000;

// A connected account can briefly have no client while sync/re-authentication
// is rebuilding it. Keep the message pending without hot-looping the scheduler.
const CLIENT_RETRY_DELAY = 30_000;

type SendOutcome = "completed" | "deferred" | "offline";

export type ScheduledSendDependencies = {
  getDueScheduledMessages: typeof getDueScheduledMessages;
  getNextScheduledMessageTime: typeof getNextScheduledMessageTime;
  getScheduledMessages: typeof getScheduledMessages;
  claimScheduledMessage: typeof claimScheduledMessage;
  updateScheduledMessageStatus: typeof updateScheduledMessageStatus;
  getScheduledMessageStats: typeof getScheduledMessageStats;
  network: Pick<typeof networkMonitor, "isOnline" | "setOffline">;
  isNetworkError: typeof isNetworkError;
  now: () => number;
  quitFlushTimeout: number;
};

const defaultDependencies: ScheduledSendDependencies = {
  getDueScheduledMessages,
  getNextScheduledMessageTime,
  getScheduledMessages,
  claimScheduledMessage,
  updateScheduledMessageStatus,
  getScheduledMessageStats,
  network: networkMonitor,
  isNetworkError,
  now: Date.now,
  quitFlushTimeout: QUIT_FLUSH_TIMEOUT,
};

type ScheduledSendEvent = "sending" | "sent" | "failed" | "statsChanged";

export class ScheduledSendService extends EventEmitter {
  private clientResolver?: (accountId: string) => GmailClient | null;
  private threadArchiver?: (threadId: string, accountId: string) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private started = false;
  private drainingForQuit = false;
  private retryNotBefore = 0;
  private readonly activeSends = new Map<Promise<SendOutcome>, AbortController>();
  private readonly dependencies: ScheduledSendDependencies;

  constructor(dependencies: Partial<ScheduledSendDependencies> = {}) {
    super();
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  /**
   * Set the function to resolve GmailClient for an account ID.
   * Called from main/index.ts after sync service is initialized.
   */
  setClientResolver(resolver: (accountId: string) => GmailClient | null): void {
    this.clientResolver = resolver;
  }

  /**
   * Set the thread-archive implementation (used by send-and-archive).
   * Injected rather than called directly because archiving also updates local
   * label state and queues offline actions, which lives in the IPC layer.
   */
  setThreadArchiver(archiver: (threadId: string, accountId: string) => Promise<void>): void {
    this.threadArchiver = archiver;
  }

  /**
   * Start scheduling. Any row already past due fires immediately; the rest arm a
   * precise timer.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    log.info("[ScheduledSend] Starting scheduler");
    void this.processDueMessages();
  }

  /**
   * Recover after an unclean shutdown. Same work as start() — past-due rows fire
   * now, future rows re-arm — but named for the post-sync startup call so the
   * crash/force-kill recovery path is obvious at a glance.
   */
  recoverOnStartup(): void {
    this.retryNotBefore = 0;
    const pending = this.dependencies.getScheduledMessages();
    if (pending.length > 0) {
      const overdue = pending.filter((r) => r.scheduledAt <= Date.now()).length;
      log.info(
        `[ScheduledSend] Recovering ${pending.length} pending message(s), ${overdue} already due`,
      );
    }
    if (this.started) {
      void this.processDueMessages();
    } else {
      this.start();
    }
  }

  /**
   * Stop scheduling and clear the pending timer.
   */
  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      log.info("[ScheduledSend] Stopped scheduler");
    }
  }

  /**
   * Get stats for scheduled messages.
   */
  getStats(accountId?: string) {
    return this.dependencies.getScheduledMessageStats(accountId);
  }

  /**
   * Re-arm the timer. Called after any insert/cancel/reschedule so a newly queued
   * short delay (a 15s undo) isn't left waiting behind an existing longer sleep.
   */
  reschedule(): void {
    if (!this.started) return;
    this.retryNotBefore = 0;
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started || this.drainingForQuit || !this.dependencies.network.isOnline) return;

    const next = this.dependencies.getNextScheduledMessageTime();
    if (next === null) return;

    const wakeAt = Math.max(next, this.retryNotBefore);
    const delay = Math.min(Math.max(wakeAt - this.dependencies.now(), 0), MAX_SLEEP);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.processDueMessages();
    }, delay);
  }

  /**
   * Process all due messages (scheduled_at <= now), then re-arm for the next one.
   */
  async processDueMessages(): Promise<void> {
    if (this.processing || this.drainingForQuit || !this.dependencies.network.isOnline) return;
    this.processing = true;

    try {
      const due = this.dependencies.getDueScheduledMessages(10);
      if (due.length > 0) {
        log.info(`[ScheduledSend] ${due.length} message(s) due for sending`);
        for (const item of due) {
          if (this.drainingForQuit) break;
          const outcome = await this.sendTracked(item);
          if (outcome === "offline") break;
        }
      }
    } catch (error) {
      log.error({ err: error }, "[ScheduledSend] Error processing due messages");
    } finally {
      this.processing = false;
      this.armTimer();
    }
  }

  /**
   * Send every pending undo-send immediately regardless of remaining delay.
   * User-chosen send-later rows must retain their due time across app quits.
   */
  async flushPendingNow(): Promise<void> {
    this.drainingForQuit = true;
    this.stop();

    const pending = this.dependencies.getScheduledMessages(undefined, "undo");
    if (pending.length > 0) {
      log.info(`[ScheduledSend] Flushing ${pending.length} pending message(s) before quit`);
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (this.activeSends.size > 0) {
        log.warn(`[ScheduledSend] Aborting ${this.activeSends.size} in-flight send(s) before quit`);
      }
      for (const controller of this.activeSends.values()) controller.abort();
    }, this.dependencies.quitFlushTimeout);

    try {
      for (const item of pending) {
        if (timedOut) break;
        await this.sendTracked(item);
      }

      // processDueMessages() may already have claimed a row when quit begins.
      // Wait for every such request to finish or observe the abort before the
      // caller closes SQLite.
      while (this.activeSends.size > 0) {
        await Promise.allSettled([...this.activeSends.keys()]);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private sendTracked(item: ScheduledMessageRow): Promise<SendOutcome> {
    const controller = new AbortController();
    const send = this.sendMessage(item, controller.signal);
    this.activeSends.set(send, controller);
    void send.then(
      () => this.activeSends.delete(send),
      () => this.activeSends.delete(send),
    );
    return send;
  }

  /**
   * Send a single scheduled message via Gmail API.
   */
  private async sendMessage(item: ScheduledMessageRow, signal: AbortSignal): Promise<SendOutcome> {
    if (!this.dependencies.network.isOnline) return "offline";

    const client = this.clientResolver?.(item.accountId);
    if (!client) {
      log.warn(`[ScheduledSend] Client unavailable for account ${item.accountId}; will retry`);
      this.retryNotBefore = Math.max(
        this.retryNotBefore,
        this.dependencies.now() + CLIENT_RETRY_DELAY,
      );
      return "deferred";
    }

    // Claim before doing any work: this is what makes cancel-vs-fire safe. The
    // conditional UPDATE is indivisible, so if the user hit Undo first the row is
    // already 'cancelled', we get null here, and no message goes out.
    const claimed = this.dependencies.claimScheduledMessage(item.id, "sending");
    if (!claimed) return "completed";

    this.emit("sending", { id: item.id, kind: item.kind });

    try {
      const result = await client.sendMessage(
        {
          from: item.from,
          to: item.to,
          cc: item.cc,
          bcc: item.bcc,
          subject: item.subject,
          bodyHtml: item.bodyHtml,
          bodyText: item.bodyText,
          threadId: item.threadId,
          inReplyTo: item.inReplyTo,
          references: item.references,
          attachments: item.attachments,
        },
        { signal },
      );

      this.dependencies.updateScheduledMessageStatus(item.id, "sent");
      log.info(`[ScheduledSend] Sent message ${item.id}, Gmail ID: ${result.id}`);

      if (item.archiveThreadId && this.threadArchiver) {
        try {
          await this.threadArchiver(item.archiveThreadId, item.accountId);
        } catch (archiveError) {
          // Best-effort: the send already succeeded, so a failed archive must not
          // turn this into a failed send.
          log.warn(
            { err: archiveError },
            `[ScheduledSend] Failed to archive thread after sending ${item.id}`,
          );
        }
      }

      this.emit("sent", {
        id: item.id,
        kind: item.kind,
        accountId: item.accountId,
        gmailId: result.id,
        threadId: result.threadId,
        composeContext: item.composeContext,
        archiveThreadId: item.archiveThreadId,
      });
      this.emit("statsChanged", this.getStats());
      return "completed";
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Send failed";
      if (signal.aborted || this.dependencies.isNetworkError(error)) {
        this.dependencies.updateScheduledMessageStatus(item.id, "scheduled", errorMessage);
        if (!signal.aborted) {
          log.info(`[ScheduledSend] Network error sending ${item.id}; will retry when online`);
          this.dependencies.network.setOffline();
        } else {
          log.info(`[ScheduledSend] Send ${item.id} aborted during quit; left scheduled`);
        }
        this.emit("statsChanged", this.getStats());
        return signal.aborted ? "deferred" : "offline";
      }

      this.dependencies.updateScheduledMessageStatus(item.id, "failed", errorMessage);
      log.error(`[ScheduledSend] Failed to send ${item.id}: ${errorMessage}`);
      this.emit("failed", {
        id: item.id,
        kind: item.kind,
        accountId: item.accountId,
        composeContext: item.composeContext,
        error: errorMessage,
      });
      this.emit("statsChanged", this.getStats());
      return "completed";
    }
  }

  // Type-safe event methods
  on(event: ScheduledSendEvent, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  off(event: ScheduledSendEvent, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  emit(event: ScheduledSendEvent, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}

// Export singleton instance
export const scheduledSendService = new ScheduledSendService();
