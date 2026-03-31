import { ipcMain } from "electron";
import { getClient } from "./gmail.ipc";
import type { IpcResponse } from "../../shared/types";

interface LabelInfo {
  id: string;
  name: string;
  type: string;
  color?: { textColor: string; backgroundColor: string };
}

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
        console.error("[Labels] Failed to list labels:", error);
        return { success: false, error: String(error) };
      }
    }
  );
}
