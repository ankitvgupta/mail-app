import { ipcMain } from "electron";
import { getClient } from "./gmail.ipc";
import { updateEmailLabelIds, getEmailsByThread } from "../db";
import type { IpcResponse, LabelInfo } from "../../shared/types";
import { createLogger } from "../services/logger";

const log = createLogger("labels-ipc");

export function registerLabelsIpc(): void {
  // List all labels for an account
  ipcMain.handle(
    "labels:list",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<LabelInfo[]>> => {
      try {
        const client = await getClient(accountId);
        const labels = await client.listLabels();
        return { success: true, data: labels };
      } catch (error) {
        log.error({ err: error }, "Failed to list labels");
        return { success: false, error: String(error) };
      }
    },
  );

  // Create a new Gmail label
  ipcMain.handle(
    "labels:create",
    async (
      _,
      { accountId, name }: { accountId: string; name: string },
    ): Promise<IpcResponse<LabelInfo>> => {
      try {
        const client = await getClient(accountId);
        const label = await client.createLabel(name);
        return { success: true, data: label };
      } catch (error) {
        log.error({ err: error }, "[Labels] Failed to create label");
        return { success: false, error: String(error) };
      }
    },
  );

  // Modify labels on a single message
  ipcMain.handle(
    "labels:modify-message",
    async (
      _,
      {
        accountId,
        emailId,
        addLabelIds,
        removeLabelIds,
      }: {
        accountId: string;
        emailId: string;
        addLabelIds: string[];
        removeLabelIds: string[];
      },
    ): Promise<IpcResponse<{ labelIds: string[] }>> => {
      try {
        const client = await getClient(accountId);
        await client.modifyMessageLabels(emailId, addLabelIds, removeLabelIds);

        // Read back the updated message to get authoritative labelIds
        const msg = await client.readEmail(emailId);
        const newLabelIds = msg?.labelIds ?? [];

        // Update local DB
        updateEmailLabelIds(emailId, newLabelIds);

        return { success: true, data: { labelIds: newLabelIds } };
      } catch (error) {
        log.error({ err: error }, "Failed to modify message labels");
        return { success: false, error: String(error) };
      }
    },
  );

  // Modify labels on all messages in a thread
  ipcMain.handle(
    "labels:modify-thread",
    async (
      _,
      {
        accountId,
        threadId,
        addLabelIds,
        removeLabelIds,
      }: {
        accountId: string;
        threadId: string;
        addLabelIds: string[];
        removeLabelIds: string[];
      },
    ): Promise<IpcResponse<void>> => {
      try {
        const client = await getClient(accountId);
        await client.modifyThreadLabels(threadId, addLabelIds, removeLabelIds);

        // Read back authoritative labelIds from Gmail for each thread message (parallel)
        const threadEmails = getEmailsByThread(threadId, accountId);
        await Promise.all(
          threadEmails.map(async (email) => {
            const msg = await client.readEmail(email.id);
            updateEmailLabelIds(email.id, msg?.labelIds ?? []);
          }),
        );

        return { success: true, data: undefined };
      } catch (error) {
        log.error({ err: error }, "Failed to modify thread labels");
        return { success: false, error: String(error) };
      }
    },
  );
}
