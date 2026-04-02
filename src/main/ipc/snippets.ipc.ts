import { ipcMain } from "electron";
import Store from "electron-store";
import { randomUUID } from "crypto";
import { type Snippet, type IpcResponse, SnippetSchema } from "../../shared/types";
import { getDataDir } from "../data-dir";
import {
  discoverSuperhumanAccounts,
  readSuperhumanSnippets,
  convertSuperhumanSnippets,
} from "../services/superhuman-import";
import { createLogger } from "../services/logger";

const log = createLogger("snippets-ipc");

// Cache discovered Superhuman account paths to avoid double filesystem scan
const discoveredPaths = new Map<string, string>();

type SnippetsStore = {
  snippets: Snippet[];
};

// Lazy-initialized to avoid running before initDevData()
let _store: Store<SnippetsStore> | null = null;
function getStore(): Store<SnippetsStore> {
  if (!_store) {
    _store = new Store<SnippetsStore>({
      name: "exo-snippets",
      cwd: getDataDir(),
      defaults: {
        snippets: [],
      },
    });
  }
  return _store;
}

function getSnippets(): Snippet[] {
  return getStore().get("snippets");
}

function saveSnippets(snippets: Snippet[]): void {
  getStore().set("snippets", snippets);
}

export function registerSnippetsIpc(): void {
  // Get all snippets
  ipcMain.handle("snippets:get-all", async (): Promise<IpcResponse<Snippet[]>> => {
    try {
      const snippets = getSnippets();
      return { success: true, data: snippets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Save all snippets (replaces existing)
  ipcMain.handle("snippets:save", async (_, snippets: Snippet[]): Promise<IpcResponse<void>> => {
    try {
      for (const snippet of snippets) {
        SnippetSchema.parse(snippet);
      }
      saveSnippets(snippets);
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Create a new snippet
  ipcMain.handle(
    "snippets:create",
    async (_, snippet: Omit<Snippet, "id">): Promise<IpcResponse<Snippet>> => {
      try {
        const now = Date.now();
        const newSnippet: Snippet = {
          ...snippet,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
        SnippetSchema.parse(newSnippet);

        const snippets = getSnippets();
        snippets.push(newSnippet);
        saveSnippets(snippets);

        return { success: true, data: newSnippet };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update an existing snippet
  ipcMain.handle(
    "snippets:update",
    async (
      _,
      { id, updates }: { id: string; updates: Partial<Omit<Snippet, "id">> },
    ): Promise<IpcResponse<Snippet>> => {
      try {
        const snippets = getSnippets();
        const index = snippets.findIndex((s) => s.id === id);

        if (index === -1) {
          return { success: false, error: `Snippet with id ${id} not found` };
        }

        const updatedSnippet: Snippet = {
          ...snippets[index],
          ...updates,
          updatedAt: Date.now(),
        };
        SnippetSchema.parse(updatedSnippet);

        snippets[index] = updatedSnippet;
        saveSnippets(snippets);

        return { success: true, data: updatedSnippet };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Delete a snippet
  ipcMain.handle(
    "snippets:delete",
    async (_, { id }: { id: string }): Promise<IpcResponse<void>> => {
      try {
        const snippets = getSnippets();
        const newSnippets = snippets.filter((s) => s.id !== id);

        if (newSnippets.length === snippets.length) {
          return { success: false, error: `Snippet with id ${id} not found` };
        }

        saveSnippets(newSnippets);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Discover Superhuman accounts for snippet import
  ipcMain.handle(
    "snippets:discover-superhuman",
    async (): Promise<
      IpcResponse<{ accounts: Array<{ email: string; snippetCount: number }> }>
    > => {
      try {
        const rawAccounts = await discoverSuperhumanAccounts();
        discoveredPaths.clear();
        const accounts: Array<{ email: string; snippetCount: number }> = [];

        for (const { email, filePath } of rawAccounts) {
          discoveredPaths.set(email, filePath);
          try {
            const shSnippets = await readSuperhumanSnippets(filePath);
            log.info(
              `[SuperhumanImport] ${email}: ${shSnippets.length} snippets found`,
            );
            accounts.push({ email, snippetCount: shSnippets.length });
          } catch (e) {
            log.error({ err: e }, `[SuperhumanImport] Failed to read snippets for ${email}`);
            accounts.push({ email, snippetCount: 0 });
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

  // Import snippets from Superhuman for a given email
  ipcMain.handle(
    "snippets:import-superhuman",
    async (
      _,
      { superhumanEmail, targetAccountId }: { superhumanEmail: string; targetAccountId: string },
    ): Promise<IpcResponse<{ imported: number; warnings: string[] }>> => {
      try {
        // Use cached path from discovery to avoid a second filesystem scan
        let filePath = discoveredPaths.get(superhumanEmail);
        if (!filePath) {
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

        const shSnippets = await readSuperhumanSnippets(filePath);
        const warnings: string[] = [];

        const newSnippets = convertSuperhumanSnippets(shSnippets, targetAccountId);

        // Deduplicate against existing snippets by name (for the same account)
        const existingSnippets = getSnippets();
        const existingNames = new Set(
          existingSnippets
            .filter((s) => s.accountId === targetAccountId)
            .map((s) => s.name),
        );
        const uniqueNewSnippets = newSnippets.filter((s) => !existingNames.has(s.name));
        const skippedCount = newSnippets.length - uniqueNewSnippets.length;
        if (skippedCount > 0) {
          warnings.push(`Skipped ${skippedCount} snippet(s) that already exist.`);
        }

        // Validate each snippet against our schema before saving
        const validSnippets: Snippet[] = [];
        for (const snippet of uniqueNewSnippets) {
          try {
            validSnippets.push(SnippetSchema.parse(snippet));
          } catch {
            warnings.push(`Skipped "${snippet.name}": failed schema validation`);
          }
        }

        // Append to existing snippets
        saveSnippets([...existingSnippets, ...validSnippets]);

        return {
          success: true,
          data: { imported: validSnippets.length, warnings },
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
