import { ipcMain, BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import {
  insertScheduledMessage,
  getScheduledMessages,
  getScheduledMessage,
  updateScheduledMessageStatus,
  updateScheduledMessageTime,
  deleteScheduledMessage,
  getScheduledMessageStats,
  getEmailsByThread,
  type ScheduledMessageRow,
} from "../db";
import { scheduledSendService } from "../services/scheduled-send-service";
import { getEmailSyncService } from "./sync.ipc";
import type {
  IpcResponse,
  ScheduledMessage,
  ScheduledMessageStats,
  SendMessageOptions,
} from "../../shared/types";
import { formatAddressesWithNames, extractThreadNames } from "../utils/address-formatting";
import { createLogger } from "../services/logger";

const log = createLogger("scheduled-send-ipc");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

function rowToScheduledMessage(row: ScheduledMessageRow): ScheduledMessage {
  return {
    id: row.id,
    accountId: row.accountId,
    type: row.type,
    threadId: row.threadId,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    inReplyTo: row.inReplyTo,
    references: row.references,
    scheduledAt: row.scheduledAt,
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt,
  };
}

export function registerScheduledSendIpc(): void {
  // Schedule a message for later sending
  ipcMain.handle(
    "scheduled-send:create",
    async (
      _,
      options: SendMessageOptions & { accountId: string; scheduledAt: number },
    ): Promise<IpcResponse<ScheduledMessage>> => {
      if (useFakeData) {
        log.info(
          { to: options.to, scheduledAt: new Date(options.scheduledAt).toISOString() },
          "[DEMO] Scheduling message",
        );
        const msg: ScheduledMessage = {
          id: `demo-scheduled-${Date.now()}`,
          accountId: options.accountId,
          type: options.threadId ? "reply" : "send",
          threadId: options.threadId,
          to: options.to,
          cc: options.cc,
          bcc: options.bcc,
          subject: options.subject,
          bodyHtml: options.bodyHtml || "",
          bodyText: options.bodyText,
          inReplyTo: options.inReplyTo,
          references: options.references,
          scheduledAt: options.scheduledAt,
          status: "scheduled",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return { success: true, data: msg };
      }

      try {
        // Augment recipientNames from thread context and format addresses
        let recipientNames = options.recipientNames;
        if (options.threadId) {
          const threadEmails = getEmailsByThread(options.threadId, options.accountId);
          const threadNames = extractThreadNames(threadEmails);
          recipientNames = { ...threadNames, ...recipientNames };
        }

        const id = randomUUID();
        const now = Date.now();

        insertScheduledMessage({
          id,
          accountId: options.accountId,
          type: options.threadId ? "reply" : "send",
          threadId: options.threadId,
          to: formatAddressesWithNames(options.to, recipientNames),
          cc: options.cc ? formatAddressesWithNames(options.cc, recipientNames) : undefined,
          bcc: options.bcc ? formatAddressesWithNames(options.bcc, recipientNames) : undefined,
          subject: options.subject,
          bodyHtml: options.bodyHtml || "",
          bodyText: options.bodyText,
          inReplyTo: options.inReplyTo,
          references: options.references,
          scheduledAt: options.scheduledAt,
          createdAt: now,
        });

        log.info(
          `[ScheduledSend] Scheduled message ${id} for ${new Date(options.scheduledAt).toISOString()}`,
        );

        const row = getScheduledMessage(id);
        if (!row) {
          return { success: false, error: "Failed to retrieve scheduled message" };
        }

        // Broadcast stats update
        broadcastStatsChanged();

        return { success: true, data: rowToScheduledMessage(row) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to schedule message",
        };
      }
    },
  );

  // List scheduled messages for an account
  ipcMain.handle(
    "scheduled-send:list",
    async (_, { accountId }: { accountId?: string }): Promise<IpcResponse<ScheduledMessage[]>> => {
      try {
        const rows = getScheduledMessages(accountId);
        return { success: true, data: rows.map(rowToScheduledMessage) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list scheduled messages",
        };
      }
    },
  );

  // Cancel a scheduled message (converts it to a Gmail draft so content isn't lost)
  ipcMain.handle(
    "scheduled-send:cancel",
    async (_, { id }: { id: string }): Promise<IpcResponse<{ draftId?: string }>> => {
      try {
        const row = getScheduledMessage(id);
        if (!row) {
          return { success: false, error: "Scheduled message not found" };
        }
        if (row.status !== "scheduled") {
          return { success: false, error: `Cannot cancel message in '${row.status}' state` };
        }

        // Try to save content as a Gmail draft so it's not lost
        let draftId: string | undefined;
        const syncService = getEmailSyncService();
        const client = syncService.getClientForAccount(row.accountId);
        if (client) {
          try {
            const draft = await client.createFullDraft({
              to: row.to,
              cc: row.cc,
              bcc: row.bcc,
              subject: row.subject,
              bodyHtml: row.bodyHtml || undefined,
              bodyText: row.bodyText || undefined,
              threadId: row.threadId || undefined,
              inReplyTo: row.inReplyTo || undefined,
              references: row.references || undefined,
            });
            draftId = draft.id;
            log.info(`[ScheduledSend] Created Gmail draft ${draftId} from cancelled message ${id}`);
          } catch (draftError) {
            // Draft creation is best-effort; still cancel the scheduled message
            log.warn(
              { err: draftError },
              `[ScheduledSend] Failed to create draft for cancelled message ${id}`,
            );
          }
        }

        updateScheduledMessageStatus(id, "cancelled");
        log.info(`[ScheduledSend] Cancelled message ${id}`);
        broadcastStatsChanged();
        return { success: true, data: { draftId } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to cancel scheduled message",
        };
      }
    },
  );

  // Reschedule a message (update time)
  ipcMain.handle(
    "scheduled-send:reschedule",
    async (
      _,
      { id, scheduledAt }: { id: string; scheduledAt: number },
    ): Promise<IpcResponse<ScheduledMessage>> => {
      try {
        const row = getScheduledMessage(id);
        if (!row) {
          return { success: false, error: "Scheduled message not found" };
        }
        if (row.status !== "scheduled") {
          return { success: false, error: `Cannot reschedule message in '${row.status}' state` };
        }

        updateScheduledMessageTime(id, scheduledAt);
        log.info(
          `[ScheduledSend] Rescheduled message ${id} to ${new Date(scheduledAt).toISOString()}`,
        );

        const updated = getScheduledMessage(id);
        if (!updated) {
          return { success: false, error: "Failed to retrieve updated message" };
        }

        broadcastStatsChanged();
        return { success: true, data: rowToScheduledMessage(updated) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to reschedule message",
        };
      }
    },
  );

  // Delete a scheduled message (remove entirely)
  ipcMain.handle(
    "scheduled-send:delete",
    async (_, { id }: { id: string }): Promise<IpcResponse<void>> => {
      try {
        deleteScheduledMessage(id);
        broadcastStatsChanged();
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to delete scheduled message",
        };
      }
    },
  );

  // Get stats
  ipcMain.handle(
    "scheduled-send:stats",
    async (
      _,
      { accountId }: { accountId?: string },
    ): Promise<IpcResponse<ScheduledMessageStats>> => {
      try {
        const stats = getScheduledMessageStats(accountId);
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get stats",
        };
      }
    },
  );

  // Wire up service events to broadcast to renderer
  scheduledSendService.on("sent", (data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("scheduled-send:sent", data);
    }
  });

  scheduledSendService.on("failed", (data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("scheduled-send:failed", data);
    }
  });

  scheduledSendService.on("statsChanged", (stats) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("scheduled-send:stats-changed", stats);
    }
  });
}

function broadcastStatsChanged(): void {
  const stats = getScheduledMessageStats();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("scheduled-send:stats-changed", stats);
  }
}
