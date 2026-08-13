import { ipcMain } from "electron";
import Store from "electron-store";
import { randomUUID } from "crypto";
import { type InboxSplit, type IpcResponse, InboxSplitSchema } from "../../shared/types";
import { getDataDir } from "../data-dir";
import {
  discoverSuperhumanAccounts,
  readSuperhumanSplits,
  convertSuperhumanSplits,
} from "../services/superhuman-import";
import { createLogger } from "../services/logger";

const log = createLogger("splits-ipc");

// Cache discovered Superhuman account paths to avoid double filesystem scan
const discoveredPaths = new Map<string, string>();

type SplitsStore = {
  splits: InboxSplit[];
};

let _store: Store<SplitsStore> | null = null;
function getStore(): Store<SplitsStore> {
  if (!_store) {
    _store = new Store<SplitsStore>({
      name: "exo-splits",
      cwd: getDataDir(),
      defaults: {
        splits: [],
      },
    });
  }
  return _store;
}

function getSplits(): InboxSplit[] {
  return getStore().get("splits");
}

function saveSplits(splits: InboxSplit[]): void {
  getStore().set("splits", splits);
}

export function registerSplitsIpc(): void {
  // Get all splits
  ipcMain.handle("splits:get-all", async (): Promise<IpcResponse<InboxSplit[]>> => {
    try {
      const splits = getSplits();
      return { success: true, data: splits };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Save all splits (replaces existing)
  ipcMain.handle("splits:save", async (_, splits: InboxSplit[]): Promise<IpcResponse<void>> => {
    try {
      // Validate each split
      for (const split of splits) {
        InboxSplitSchema.parse(split);
      }
      saveSplits(splits);
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Create a new split
  ipcMain.handle(
    "splits:create",
    async (_, split: Omit<InboxSplit, "id">): Promise<IpcResponse<InboxSplit>> => {
      try {
        const newSplit: InboxSplit = {
          ...split,
          id: randomUUID(),
        };
        InboxSplitSchema.parse(newSplit);

        const splits = getSplits();
        splits.push(newSplit);
        saveSplits(splits);

        return { success: true, data: newSplit };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update an existing split
  ipcMain.handle(
    "splits:update",
    async (
      _,
      { id, updates }: { id: string; updates: Partial<Omit<InboxSplit, "id">> },
    ): Promise<IpcResponse<InboxSplit>> => {
      try {
        const splits = getSplits();
        const index = splits.findIndex((s) => s.id === id);

        if (index === -1) {
          return { success: false, error: `Split with id ${id} not found` };
        }

        const updatedSplit: InboxSplit = {
          ...splits[index],
          ...updates,
        };
        InboxSplitSchema.parse(updatedSplit);

        splits[index] = updatedSplit;
        saveSplits(splits);

        return { success: true, data: updatedSplit };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Delete a split
  ipcMain.handle("splits:delete", async (_, { id }: { id: string }): Promise<IpcResponse<void>> => {
    try {
      const splits = getSplits();
      const newSplits = splits.filter((s) => s.id !== id);

      if (newSplits.length === splits.length) {
        return { success: false, error: `Split with id ${id} not found` };
      }

      saveSplits(newSplits);
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Discover Superhuman accounts available for import
  ipcMain.handle(
    "splits:discover-superhuman",
    async (): Promise<IpcResponse<{ accounts: Array<{ email: string; splitCount: number }> }>> => {
      try {
        const rawAccounts = await discoverSuperhumanAccounts();
        discoveredPaths.clear();
        const accounts: Array<{ email: string; splitCount: number }> = [];

        for (const { email, filePath } of rawAccounts) {
          discoveredPaths.set(email, filePath);
          try {
            const shSplits = await readSuperhumanSplits(filePath);
            // Run conversion to get the actual importable count (skips disabled/shared)
            const { splits: converted } = convertSuperhumanSplits(shSplits, "", 0);
            log.info(
              `[SuperhumanImport] ${email}: ${converted.length} importable of ${shSplits.length} total`,
            );
            accounts.push({ email, splitCount: converted.length });
          } catch (e) {
            log.error({ err: e }, `[SuperhumanImport] Failed to read splits for ${email}`);
            accounts.push({ email, splitCount: 0 });
          }
        }

        return { success: true, data: { accounts } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Import splits from Superhuman for a given email
  ipcMain.handle(
    "splits:import-superhuman",
    async (
      _,
      { superhumanEmail, targetAccountId }: { superhumanEmail: string; targetAccountId: string },
    ): Promise<IpcResponse<{ imported: number; warnings: string[] }>> => {
      try {
        // Use cached path from discovery to avoid a second filesystem scan
        let filePath = discoveredPaths.get(superhumanEmail);
        if (!filePath) {
          // Fallback: re-discover if cache was cleared (e.g. app restart between steps)
          const rawAccounts = await discoverSuperhumanAccounts();
          const account = rawAccounts.find((a) => a.email === superhumanEmail);
          if (!account) {
            return {
              success: false,
              error: `Superhuman account ${superhumanEmail} not found`,
            };
          }
          filePath = account.filePath;
        }

        const shSplits = await readSuperhumanSplits(filePath);
        const existingSplits = getSplits();
        const startingOrder = existingSplits.filter((s) => s.accountId === targetAccountId).length;

        const { splits: newSplits, warnings } = convertSuperhumanSplits(
          shSplits,
          targetAccountId,
          startingOrder,
        );

        // Deduplicate against existing splits by name (for the same account)
        const existingNames = new Set(
          existingSplits.filter((s) => s.accountId === targetAccountId).map((s) => s.name),
        );
        const uniqueNewSplits = newSplits.filter((s) => !existingNames.has(s.name));
        const skippedCount = newSplits.length - uniqueNewSplits.length;
        if (skippedCount > 0) {
          warnings.push(`Skipped ${skippedCount} split(s) that already exist.`);
        }

        // Validate each split against our schema before saving
        const validSplits: InboxSplit[] = [];
        for (const split of uniqueNewSplits) {
          try {
            validSplits.push(InboxSplitSchema.parse(split));
          } catch {
            warnings.push(`Skipped "${split.name}": failed schema validation`);
          }
        }

        // Append to existing splits
        saveSplits([...existingSplits, ...validSplits]);

        return {
          success: true,
          data: { imported: validSplits.length, warnings },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
