import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { networkMonitor } from "./network-monitor";
import {
  insertOutboxMessage,
  getOutboxStats,
  getPendingOutbox,
  getOutboxItems,
  getOutboxItem,
  updateOutboxStatus,
  deleteOutboxItem,
  type OutboxItem,
  type OutboxStats,
} from "../db";
import type { GmailClient } from "./gmail-client";
import { createLogger } from "./logger";

const log = createLogger("outbox");

// Type for the message payload to queue
export type OutboxMessage = {
  accountId: string;
  type: "send" | "reply";
  threadId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    path?: string;
    content?: string;
    size?: number;
  }>;
};

// Events emitted by the outbox service
type OutboxEvent = "queued" | "sending" | "sent" | "failed" | "authRequired" | "statsChanged";

// Interface for dedup cache entries
interface SentCacheEntry {
  subject: string;
  bodyPrefix: string;
  to: string;
}

// Max retries before marking as permanently failed
const MAX_RETRIES = 3;

// Batch size for processing
const BATCH_SIZE = 10;

class OutboxService extends EventEmitter {
  private clientResolver?: (accountId: string) => GmailClient | null;
  private processing: boolean = false;
  private recentSentCache: Map<string, SentCacheEntry> = new Map();

  /**
   * Set the function to resolve GmailClient for an account ID
   * Called from main/index.ts after sync service is initialized
   */
  setClientResolver(resolver: (accountId: string) => GmailClient | null): void {
    this.clientResolver = resolver;
  }

  /**
   * Queue a message to be sent
   * Returns the outbox item ID
   */
  queue(message: OutboxMessage): string {
    const id = randomUUID();
    const now = Date.now();

    insertOutboxMessage({
      id,
      accountId: message.accountId,
      type: message.type,
      threadId: message.threadId,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText,
      inReplyTo: message.inReplyTo,
      references: message.references,
      attachments: message.attachments,
      createdAt: now,
    });

    log.info(`[Outbox] Queued message ${id} to ${message.to.join(", ")}`);
    this.emit("queued", { id, message });
    this.emit("statsChanged", this.getStats());

    // If online, try to process immediately
    if (networkMonitor.isOnline) {
      // Small delay to batch rapid queues
      setTimeout(() => this.processQueue(), 100);
    }

    return id;
  }

  /**
   * Get outbox statistics
   */
  getStats(accountId?: string): OutboxStats {
    return getOutboxStats(accountId);
  }

  /**
   * Get all pending/failed outbox items
   */
  getItems(accountId?: string): OutboxItem[] {
    return getOutboxItems(accountId);
  }

  /**
   * Get a single outbox item
   */
  getItem(id: string): OutboxItem | null {
    return getOutboxItem(id);
  }

  /**
   * Retry a failed message
   */
  async retry(id: string): Promise<boolean> {
    const item = getOutboxItem(id);
    if (!item || item.status !== "failed") {
      return false;
    }

    // Reset status to pending
    updateOutboxStatus(id, "pending");
    this.emit("statsChanged", this.getStats());

    // Try to process
    if (networkMonitor.isOnline) {
      await this.processQueue();
    }

    return true;
  }

  /**
   * Remove/cancel a queued or failed message
   */
  remove(id: string): boolean {
    const item = getOutboxItem(id);
    if (!item) {
      return false;
    }

    // Don't remove if currently being sent
    if (item.status === "sending") {
      return false;
    }

    deleteOutboxItem(id);
    log.info(`[Outbox] Removed message ${id}`);
    this.emit("statsChanged", this.getStats());
    return true;
  }

  /**
   * Process pending messages in the outbox
   * Called when going online or after queueing
   */
  async processQueue(): Promise<void> {
    if (this.processing || !networkMonitor.isOnline) {
      return;
    }

    this.processing = true;
    log.info("[Outbox] Starting queue processing");

    try {
      // Get pending items (limited by batch size)
      const pending = getPendingOutbox(undefined, BATCH_SIZE);

      if (pending.length === 0) {
        log.info("[Outbox] No pending messages");
        return;
      }

      // Get unique account IDs from pending items
      const accountIds = [...new Set(pending.map((p) => p.accountId))];

      // Refresh sent cache for each account ONCE before processing
      for (const accountId of accountIds) {
        await this.refreshSentCache(accountId);
      }

      // Process items sequentially (Gmail rate limits)
      for (const item of pending) {
        if (!networkMonitor.isOnline) {
          log.info("[Outbox] Went offline during processing, stopping");
          break;
        }

        // Check for duplicate using local cache
        if (this.isDuplicateInCache(item)) {
          log.info(`[Outbox] Skipping ${item.id} - found in recent sent`);
          this.markAsSent(item.id);
          continue;
        }

        await this.sendMessage(item);
      }

      // Clear cache after processing
      this.recentSentCache.clear();

      // Check if more pending items exist
      const remaining = getOutboxStats();
      if (remaining.pending > 0 && networkMonitor.isOnline) {
        // Schedule next batch
        setTimeout(() => this.processQueue(), 1000);
      }
    } catch (error) {
      log.error({ err: error }, "[Outbox] Error processing queue");
    } finally {
      this.processing = false;
    }
  }

  /**
   * Refresh the sent cache for an account
   * Called once when going online, before processing outbox
   */
  private async refreshSentCache(accountId: string): Promise<void> {
    const client = this.clientResolver?.(accountId);
    if (!client) {
      log.warn(`[Outbox] No client for account ${accountId}, skipping sent cache`);
      return;
    }

    try {
      // Fetch emails sent in last 15 minutes (covers any race condition window)
      const fifteenMinAgo = Math.floor((Date.now() - 15 * 60 * 1000) / 1000);
      const query = `in:sent after:${fifteenMinAgo}`;
      const { results } = await client.searchEmails(query, 50);

      for (const result of results) {
        try {
          const email = await client.readEmail(result.id);
          if (!email) continue;

          // Strip HTML tags for comparison
          const bodyPrefix = email.body
            .replace(/<[^>]*>/g, "")
            .slice(0, 200)
            .trim()
            .toLowerCase();

          // Extract email address from "Name <email>" format
          const toMatch = email.to.match(/<([^>]+)>/) || [null, email.to];
          const to = (toMatch[1] || email.to).toLowerCase().trim();

          this.recentSentCache.set(result.id, {
            subject: email.subject.toLowerCase(),
            bodyPrefix,
            to,
          });
        } catch (error) {
          // Skip individual email errors
          log.warn({ err: error }, `[Outbox] Failed to read sent email ${result.id}`);
        }
      }

      log.info(`[Outbox] Loaded ${this.recentSentCache.size} recent sent emails for dedup`);
    } catch (error) {
      log.warn({ err: error }, "[Outbox] Failed to refresh sent cache");
      // Continue anyway - better to risk duplicate than block sends
    }
  }

  /**
   * Check if an outbox item already exists in recent sent emails
   */
  private isDuplicateInCache(item: OutboxItem): boolean {
    if (this.recentSentCache.size === 0) {
      return false;
    }

    // Normalize outbox item for comparison
    const rawTo = item.to[0]?.toLowerCase().trim() || "";
    const bracketMatch = rawTo.match(/<([^>]+)>/);
    const itemTo = bracketMatch ? bracketMatch[1].trim() : rawTo;
    const itemSubject = item.subject.toLowerCase();
    const itemBodyPrefix = item.bodyHtml
      .replace(/<[^>]*>/g, "")
      .slice(0, 200)
      .trim()
      .toLowerCase();

    for (const sent of this.recentSentCache.values()) {
      // Subject must match (with or without Re: prefix)
      const subjectMatch =
        sent.subject === itemSubject ||
        sent.subject === `re: ${itemSubject}` ||
        `re: ${sent.subject}` === itemSubject;

      const toMatch = sent.to === itemTo;
      const bodyMatch = sent.bodyPrefix === itemBodyPrefix;

      if (subjectMatch && toMatch && bodyMatch) {
        return true;
      }
    }

    return false;
  }

  /**
   * Mark an item as sent (used when dedup detects it was already sent)
   */
  private markAsSent(id: string): void {
    updateOutboxStatus(id, "sent");
    this.emit("sent", { id });
    this.emit("statsChanged", this.getStats());
  }

  /**
   * Send a single message from the outbox
   */
  private async sendMessage(item: OutboxItem): Promise<void> {
    const client = this.clientResolver?.(item.accountId);
    if (!client) {
      log.error(`[Outbox] No client for account ${item.accountId}`);
      this.handleFailure(item, "Account not connected — re-authenticate to send", true);
      this.emit("authRequired", { accountId: item.accountId, itemId: item.id });
      return;
    }

    // Mark as sending
    updateOutboxStatus(item.id, "sending");
    this.emit("sending", { id: item.id });
    this.emit("statsChanged", this.getStats());

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

      // Success!
      updateOutboxStatus(item.id, "sent");
      log.info(`[Outbox] Sent message ${item.id}, Gmail ID: ${result.id}`);
      this.emit("sent", { id: item.id, gmailId: result.id, threadId: result.threadId });
      this.emit("statsChanged", this.getStats());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Send failed";
      const isNetworkError = this.isNetworkError(error);

      if (isNetworkError) {
        // Network error - go offline and stop processing
        log.info(`[Outbox] Network error sending ${item.id}, going offline`);
        networkMonitor.setOffline();
        // Revert to pending so it's retried later
        updateOutboxStatus(item.id, "pending", errorMessage);
        this.emit("statsChanged", this.getStats());
      } else {
        // Non-network error (auth, invalid recipient, etc.)
        this.handleFailure(item, errorMessage, true);
      }
    }
  }

  /**
   * Handle a send failure
   */
  private handleFailure(item: OutboxItem, errorMessage: string, incrementRetry: boolean): void {
    const newRetryCount = incrementRetry ? item.retryCount + 1 : item.retryCount;

    if (newRetryCount >= MAX_RETRIES) {
      // Permanently failed
      updateOutboxStatus(item.id, "failed", errorMessage, incrementRetry);
      log.error(`[Outbox] Message ${item.id} permanently failed: ${errorMessage}`);
      this.emit("failed", { id: item.id, error: errorMessage, permanent: true });
    } else {
      // Temporarily failed, will be retried
      updateOutboxStatus(item.id, "pending", errorMessage, incrementRetry);
      log.warn(
        `[Outbox] Message ${item.id} failed (retry ${newRetryCount}/${MAX_RETRIES}): ${errorMessage}`,
      );
      this.emit("failed", {
        id: item.id,
        error: errorMessage,
        permanent: false,
        retryCount: newRetryCount,
      });
    }

    this.emit("statsChanged", this.getStats());
  }

  /**
   * Check if an error is a network error
   */
  private isNetworkError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      msg.includes("ENOTFOUND") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ECONNRESET") ||
      msg.includes("socket hang up") ||
      msg.includes("network") ||
      (error as NodeJS.ErrnoException)?.code === "ENOTFOUND" ||
      (error as NodeJS.ErrnoException)?.code === "ETIMEDOUT" ||
      (error as NodeJS.ErrnoException)?.code === "ECONNREFUSED" ||
      (error as NodeJS.ErrnoException)?.code === "ECONNRESET"
    );
  }

  // Type-safe event methods
  on(event: OutboxEvent, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  off(event: OutboxEvent, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  emit(event: OutboxEvent, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}

// Export singleton instance
export const outboxService = new OutboxService();
