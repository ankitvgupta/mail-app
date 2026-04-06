import { EventEmitter } from "events";
import {
  getDueScheduledMessages,
  updateScheduledMessageStatus,
  getScheduledMessageStats,
  type ScheduledMessageRow,
} from "../db";
import type { GmailClient } from "./gmail-client";
import { createLogger } from "./logger";

const log = createLogger("scheduled-send");

// Check interval: 30 seconds
const CHECK_INTERVAL = 30_000;

type ScheduledSendEvent = "sending" | "sent" | "failed" | "statsChanged";

class ScheduledSendService extends EventEmitter {
  private clientResolver?: (accountId: string) => GmailClient | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  /**
   * Set the function to resolve GmailClient for an account ID.
   * Called from main/index.ts after sync service is initialized.
   */
  setClientResolver(resolver: (accountId: string) => GmailClient | null): void {
    this.clientResolver = resolver;
  }

  /**
   * Start the background timer that checks for due messages.
   */
  start(): void {
    if (this.timer) return;
    log.info("[ScheduledSend] Starting background check (30s interval)");
    this.timer = setInterval(() => this.processDueMessages(), CHECK_INTERVAL);
    // Also check immediately on start
    this.processDueMessages();
  }

  /**
   * Stop the background timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("[ScheduledSend] Stopped background check");
    }
  }

  /**
   * Get stats for scheduled messages.
   */
  getStats(accountId?: string) {
    return getScheduledMessageStats(accountId);
  }

  /**
   * Process all due messages (scheduled_at <= now).
   */
  async processDueMessages(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const due = getDueScheduledMessages(10);
      if (due.length === 0) return;

      log.info(`[ScheduledSend] ${due.length} message(s) due for sending`);

      for (const item of due) {
        await this.sendMessage(item);
      }
    } catch (error) {
      log.error({ err: error }, "[ScheduledSend] Error processing due messages");
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send a single scheduled message via Gmail API.
   */
  private async sendMessage(item: ScheduledMessageRow): Promise<void> {
    const client = this.clientResolver?.(item.accountId);
    if (!client) {
      log.error(`[ScheduledSend] No client for account ${item.accountId}`);
      updateScheduledMessageStatus(item.id, "failed", "Account not connected");
      this.emit("failed", { id: item.id, error: "Account not connected" });
      this.emit("statsChanged", this.getStats());
      return;
    }

    // Mark as sending
    updateScheduledMessageStatus(item.id, "sending");
    this.emit("sending", { id: item.id });

    try {
      const result = await client.sendMessage({
        to: item.to,
        cc: item.cc,
        bcc: item.bcc,
        subject: item.subject,
        bodyHtml: item.bodyHtml,
        bodyText: item.bodyText,
        threadId: item.threadId,
        inReplyTo: item.inReplyTo,
        references: item.references,
      });

      updateScheduledMessageStatus(item.id, "sent");
      log.info(`[ScheduledSend] Sent message ${item.id}, Gmail ID: ${result.id}`);
      this.emit("sent", { id: item.id, gmailId: result.id, threadId: result.threadId });
      this.emit("statsChanged", this.getStats());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Send failed";
      updateScheduledMessageStatus(item.id, "failed", errorMessage);
      log.error(`[ScheduledSend] Failed to send ${item.id}: ${errorMessage}`);
      this.emit("failed", { id: item.id, error: errorMessage });
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
