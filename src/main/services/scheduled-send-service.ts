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

const log = createLogger("scheduled-send");

// Upper bound on a single sleep. Long-horizon items (send-later days out) re-arm
// at least this often so clock changes and suspend/resume can't strand them.
const MAX_SLEEP = 30_000;

// Cap on how long a quit may be delayed while flushing pending sends. Anything
// unsent stays 'scheduled' and is recovered by recoverOnStartup() next launch.
const QUIT_FLUSH_TIMEOUT = 5_000;

type ScheduledSendEvent = "sending" | "sent" | "failed" | "statsChanged";

class ScheduledSendService extends EventEmitter {
  private clientResolver?: (accountId: string) => GmailClient | null;
  private threadArchiver?: (threadId: string, accountId: string) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private started = false;

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
    const pending = getScheduledMessages();
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
    return getScheduledMessageStats(accountId);
  }

  /**
   * Re-arm the timer. Called after any insert/cancel/reschedule so a newly queued
   * short delay (a 15s undo) isn't left waiting behind an existing longer sleep.
   */
  reschedule(): void {
    if (!this.started) return;
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started) return;

    const next = getNextScheduledMessageTime();
    if (next === null) return;

    const delay = Math.min(Math.max(next - Date.now(), 0), MAX_SLEEP);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.processDueMessages();
    }, delay);
  }

  /**
   * Process all due messages (scheduled_at <= now), then re-arm for the next one.
   */
  async processDueMessages(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const due = getDueScheduledMessages(10);
      if (due.length > 0) {
        log.info(`[ScheduledSend] ${due.length} message(s) due for sending`);
        for (const item of due) {
          await this.sendMessage(item);
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
    const pending = getScheduledMessages(undefined, "undo");
    if (pending.length === 0) return;

    log.info(`[ScheduledSend] Flushing ${pending.length} pending message(s) before quit`);
    const flush = (async () => {
      for (const item of pending) {
        await this.sendMessage(item);
      }
    })();

    // Never block quit indefinitely — survivors are recovered on next launch.
    await Promise.race([
      flush,
      new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT)),
    ]);
  }

  /**
   * Send a single scheduled message via Gmail API.
   */
  private async sendMessage(item: ScheduledMessageRow): Promise<void> {
    // Claim before doing any work: this is what makes cancel-vs-fire safe. The
    // conditional UPDATE is indivisible, so if the user hit Undo first the row is
    // already 'cancelled', we get null here, and no message goes out.
    const claimed = claimScheduledMessage(item.id, "sending");
    if (!claimed) return;

    const client = this.clientResolver?.(item.accountId);
    if (!client) {
      log.error(`[ScheduledSend] No client for account ${item.accountId}`);
      updateScheduledMessageStatus(item.id, "failed", "Account not connected");
      this.emit("failed", {
        id: item.id,
        kind: item.kind,
        accountId: item.accountId,
        composeContext: item.composeContext,
        error: "Account not connected",
      });
      this.emit("statsChanged", this.getStats());
      return;
    }

    this.emit("sending", { id: item.id, kind: item.kind });

    try {
      const result = await client.sendMessage({
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
      });

      updateScheduledMessageStatus(item.id, "sent");
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Send failed";
      updateScheduledMessageStatus(item.id, "failed", errorMessage);
      log.error(`[ScheduledSend] Failed to send ${item.id}: ${errorMessage}`);
      this.emit("failed", {
        id: item.id,
        kind: item.kind,
        accountId: item.accountId,
        composeContext: item.composeContext,
        error: errorMessage,
      });
      this.emit("statsChanged", this.getStats());
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
