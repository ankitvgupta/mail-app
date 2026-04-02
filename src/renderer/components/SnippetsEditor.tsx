import { useState, useEffect } from "react";
import { useAppStore } from "../store";
import type { Snippet } from "../../shared/types";

type SuperhumanAccount = { email: string; snippetCount: number };
type ImportResult = { imported: number; warnings: string[] };

export function SnippetsEditor() {
  const { snippets: allSnippets, setSnippets, currentAccountId, accounts } = useAppStore();
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [crudError, setCrudError] = useState<string | null>(null);

  // Superhuman import state
  const [shAccounts, setShAccounts] = useState<SuperhumanAccount[] | null>(null);
  const [shDiscovering, setShDiscovering] = useState(false);
  const [shImporting, setShImporting] = useState(false);
  const [shResult, setShResult] = useState<ImportResult | null>(null);
  const [shError, setShError] = useState<string | null>(null);

  // Filter snippets for current account
  const snippets = allSnippets.filter((s) => s.accountId === currentAccountId);
  const currentAccount = accounts.find((a) => a.id === currentAccountId);

  // Load snippets on mount
  useEffect(() => {
    const loadSnippets = async () => {
      try {
        const result = await window.api.snippets.getAll();
        if ((result as { success: boolean }).success) {
          setSnippets((result as { data: Snippet[] }).data);
        }
      } finally {
        setIsLoading(false);
      }
    };
    loadSnippets();
  }, [setSnippets]);

  const handleCreate = async (name: string, body: string, shortcut?: string) => {
    if (!currentAccountId) return;
    setIsSaving(true);
    setCrudError(null);
    try {
      const result = (await window.api.snippets.create({
        accountId: currentAccountId,
        name,
        body,
        shortcut: shortcut || undefined,
      })) as { success: boolean; data?: Snippet; error?: string };
      if (result.success && result.data) {
        setSnippets([...allSnippets, result.data]);
        setIsCreating(false);
      } else {
        setCrudError(result.error ?? "Failed to create snippet");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdate = async (snippet: Snippet) => {
    setIsSaving(true);
    setCrudError(null);
    try {
      const { id, ...updates } = snippet;
      const result = (await window.api.snippets.update(id, updates)) as {
        success: boolean;
        data?: Snippet;
        error?: string;
      };
      if (result.success && result.data) {
        setSnippets(allSnippets.map((s) => (s.id === id ? result.data! : s)));
        setEditingSnippet(null);
      } else {
        setCrudError(result.error ?? "Failed to update snippet");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this snippet?")) return;
    setIsSaving(true);
    setCrudError(null);
    try {
      const result = (await window.api.snippets.delete(id)) as {
        success: boolean;
        error?: string;
      };
      if (result.success) {
        setSnippets(allSnippets.filter((s) => s.id !== id));
      } else {
        setCrudError(result.error ?? "Failed to delete snippet");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscoverSuperhuman = async () => {
    setShDiscovering(true);
    setShAccounts(null);
    setShResult(null);
    setShError(null);
    try {
      const result = (await window.api.snippets.discoverSuperhuman()) as {
        success: boolean;
        data?: { accounts: SuperhumanAccount[] };
        error?: string;
      };
      if (result.success && result.data) {
        setShAccounts(result.data.accounts);
        if (result.data.accounts.length === 0) {
          setShError("Superhuman not found on this machine");
        }
      } else {
        setShError(result.error ?? "Failed to discover accounts");
      }
    } finally {
      setShDiscovering(false);
    }
  };

  const handleImportSuperhuman = async (email: string) => {
    if (!currentAccountId) return;
    setShImporting(true);
    setShResult(null);
    try {
      const result = (await window.api.snippets.importFromSuperhuman(email, currentAccountId)) as {
        success: boolean;
        data?: ImportResult;
        error?: string;
      };
      if (result.success && result.data) {
        setShResult(result.data);
        // Refresh snippets
        const refreshed = (await window.api.snippets.getAll()) as {
          success: boolean;
          data?: Snippet[];
        };
        if (refreshed.success && refreshed.data) {
          setSnippets(refreshed.data);
        }
        setShAccounts(null);
      } else {
        setShError(result.error ?? "Import failed");
        setShAccounts(null);
      }
    } finally {
      setShImporting(false);
    }
  };

  if (isLoading) {
    return <div className="text-sm text-gray-500 dark:text-gray-400">Loading snippets...</div>;
  }

  if (!currentAccountId) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Select an account to manage snippets.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900 dark:text-gray-100">Snippets</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Reusable text blocks for <span className="font-medium">{currentAccount?.email}</span>.
            Insert them while composing emails.
          </p>
        </div>
        {!isCreating && !editingSnippet && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscoverSuperhuman}
              disabled={shDiscovering}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {shDiscovering ? "Checking..." : "Import from Superhuman"}
            </button>
            <button
              onClick={() => setIsCreating(true)}
              className="px-3 py-1.5 text-sm bg-blue-500 dark:bg-blue-400 text-white rounded hover:bg-blue-600 dark:hover:bg-blue-500"
            >
              + New Snippet
            </button>
          </div>
        )}
      </div>

      {/* Superhuman import inline dialog */}
      {shAccounts && shAccounts.length > 0 && !shResult && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Select Superhuman account to import snippets from:
            </span>
            <button
              onClick={() => setShAccounts(null)}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
          {shAccounts.map((acct) => (
            <button
              key={acct.email}
              onClick={() => handleImportSuperhuman(acct.email)}
              disabled={shImporting || acct.snippetCount === 0}
              className="w-full text-left px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="font-medium">{acct.email}</span>
              <span className="ml-2 text-gray-500 dark:text-gray-400">
                ({acct.snippetCount} snippet{acct.snippetCount !== 1 ? "s" : ""})
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Import result */}
      {shResult && (
        <div className="border rounded-lg p-4 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 space-y-1">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Imported {shResult.imported} snippet{shResult.imported !== 1 ? "s" : ""}
          </p>
          {shResult.warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400">
              {w}
            </p>
          ))}
          <button
            onClick={() => setShResult(null)}
            className="text-xs text-green-700 dark:text-green-400 hover:underline mt-1"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Import error */}
      {crudError && (
        <div className="border rounded-lg p-3 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800">
          <p className="text-sm text-red-700 dark:text-red-400">{crudError}</p>
          <button
            onClick={() => setCrudError(null)}
            className="text-xs text-red-600 dark:text-red-400 hover:underline mt-1"
          >
            Dismiss
          </button>
        </div>
      )}

      {shError && (
        <div className="border rounded-lg p-3 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800">
          <p className="text-sm text-red-700 dark:text-red-400">{shError}</p>
          <button
            onClick={() => setShError(null)}
            className="text-xs text-red-600 dark:text-red-400 hover:underline mt-1"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      {isCreating && (
        <SnippetForm
          onSave={handleCreate}
          onCancel={() => setIsCreating(false)}
          isSaving={isSaving}
        />
      )}

      {/* Edit form */}
      {editingSnippet && (
        <SnippetForm
          snippet={editingSnippet}
          onSave={(name, body, shortcut) =>
            handleUpdate({ ...editingSnippet, name, body, shortcut })
          }
          onCancel={() => setEditingSnippet(null)}
          isSaving={isSaving}
        />
      )}

      {/* Snippet list */}
      {!isCreating && !editingSnippet && (
        <div className="space-y-2">
          {snippets.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              No snippets yet. Create one or import from Superhuman.
            </div>
          ) : (
            snippets.map((snippet) => (
              <div
                key={snippet.id}
                className="flex items-start justify-between p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
                      {snippet.name}
                    </span>
                    {snippet.shortcut && (
                      <span className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded font-mono">
                        ;{snippet.shortcut}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                    {stripHtml(snippet.body)}
                  </p>
                </div>
                <div className="flex items-center gap-1 ml-2 shrink-0">
                  <button
                    onClick={() => setEditingSnippet(snippet)}
                    className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(snippet.id)}
                    disabled={isSaving}
                    className="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function SnippetForm({
  snippet,
  onSave,
  onCancel,
  isSaving,
}: {
  snippet?: Snippet;
  onSave: (name: string, body: string, shortcut?: string) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [shortcut, setShortcut] = useState(snippet?.shortcut ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !body.trim()) return;
    onSave(name.trim(), body.trim(), shortcut.trim() || undefined);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-white dark:bg-gray-800 space-y-3"
    >
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Meeting follow-up"
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Shortcut <span className="font-normal text-gray-500 dark:text-gray-400">(optional)</span>
        </label>
        <div className="flex items-center gap-1">
          <span className="text-sm text-gray-500 dark:text-gray-400 font-mono">;</span>
          <input
            type="text"
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value.replace(/\s/g, ""))}
            placeholder="e.g. thanks"
            className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Used to quickly find this snippet when searching in the snippet picker.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Content
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Type your snippet content here..."
          rows={6}
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Use {"{"}
          <code className="text-xs">first_name</code>
          {"}"} for the recipient&apos;s first name, {"{"}
          <code className="text-xs">my_name</code>
          {"}"} for your name, or any {"{"}
          <code className="text-xs">custom_placeholder</code>
          {"}"} that you&apos;ll fill in when inserting.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSaving || !name.trim() || !body.trim()}
          className="px-3 py-1.5 text-sm bg-blue-500 dark:bg-blue-400 text-white rounded hover:bg-blue-600 dark:hover:bg-blue-500 disabled:opacity-50"
        >
          {snippet ? "Save Changes" : "Create Snippet"}
        </button>
      </div>
    </form>
  );
}
