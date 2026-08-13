import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Memory, DraftMemory, MemoryScope, IpcResponse } from "../../shared/types";

declare global {
  interface Window {
    api: {
      memory: {
        list: (accountId: string) => Promise<IpcResponse<Memory[]>>;
        save: (params: {
          accountId: string;
          scope: string;
          scopeValue?: string | null;
          content: string;
          source?: string;
          sourceEmailId?: string;
        }) => Promise<IpcResponse<Memory>>;
        update: (
          id: string,
          updates: { content?: string; enabled?: boolean },
        ) => Promise<IpcResponse<Memory | null>>;
        delete: (id: string) => Promise<IpcResponse<void>>;
        categories: (accountId: string) => Promise<IpcResponse<string[]>>;
        draftMemories: {
          list: (accountId: string) => Promise<IpcResponse<DraftMemory[]>>;
          promote: (id: string, accountId: string) => Promise<IpcResponse<Memory>>;
          delete: (id: string) => Promise<IpcResponse<void>>;
        };
      };
    };
  }
}

const SCOPE_LABELS: Record<MemoryScope, string> = {
  global: "Global",
  person: "Person",
  domain: "Domain",
  category: "Category",
};

// Promotion thresholds by memory type — must match backend constants
const PROMOTION_THRESHOLDS: Record<string, number> = {
  drafting: 3,
  analysis: 2,
};
function getPromotionThreshold(memoryType?: string): number {
  return PROMOTION_THRESHOLDS[memoryType ?? "drafting"] ?? 3;
}

const SCOPE_DESCRIPTIONS: Record<MemoryScope, string> = {
  global: "Applies to all drafts",
  person: "Applies to a specific email address",
  domain: "Applies to everyone at a domain",
  category: "Applies when relevant (e.g. students, investors)",
};

export function MemoriesTab({
  accountId,
  highlightMemoryIds,
}: {
  accountId: string;
  highlightMemoryIds?: string[];
}) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add memory form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newScope, setNewScope] = useState<MemoryScope>("global");
  const [newScopeValue, setNewScopeValue] = useState("");
  const [newContent, setNewContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  // Categories for autocomplete
  const [existingCategories, setExistingCategories] = useState<string[]>([]);

  // Filter state
  const [filterScope, setFilterScope] = useState<MemoryScope | "all">("all");

  // Draft memories state
  const [draftMemories, setDraftMemories] = useState<DraftMemory[]>([]);
  const [showDraftMemories, setShowDraftMemories] = useState(false);

  // Highlight set for scroll-to behavior
  const promotedHighlightRef = useRef<HTMLDivElement>(null);
  const draftHighlightRef = useRef<HTMLDivElement>(null);
  const highlightSet = useMemo(() => new Set(highlightMemoryIds ?? []), [highlightMemoryIds]);
  const firstHighlightedDraftId = useMemo(
    () => draftMemories.find((dm) => highlightSet.has(dm.id))?.id ?? null,
    [draftMemories, highlightSet],
  );
  const promotedHighlightApplied = useRef(false);
  const draftHighlightApplied = useRef(false);
  const draftScrollApplied = useRef(false);

  // Reset when highlight targets change
  useEffect(() => {
    promotedHighlightApplied.current = false;
    draftHighlightApplied.current = false;
    draftScrollApplied.current = false;
  }, [highlightMemoryIds]);

  // Handle promoted memory highlights — enter edit mode and scroll
  useEffect(() => {
    if (promotedHighlightApplied.current) return;
    if (!highlightMemoryIds?.length || memories.length === 0) return;
    const firstId = highlightMemoryIds[0];
    const target = memories.find((m) => m.id === firstId);
    if (!target) return;

    promotedHighlightApplied.current = true;
    setEditingId(firstId);
    setEditContent(target.content);
    requestAnimationFrame(() => {
      promotedHighlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [highlightMemoryIds, memories]);

  // Handle draft memory highlights — expand section and scroll (runs independently)
  useEffect(() => {
    if (draftHighlightApplied.current) return;
    if (!highlightMemoryIds?.length || draftMemories.length === 0) return;
    if (!draftMemories.some((dm) => highlightSet.has(dm.id))) return;

    draftHighlightApplied.current = true;
    setShowDraftMemories(true);
  }, [highlightMemoryIds, draftMemories, highlightSet]);

  // Scroll to highlighted draft memory after the draft section is expanded and rendered
  useEffect(() => {
    if (draftScrollApplied.current) return;
    if (!showDraftMemories || !firstHighlightedDraftId) return;
    draftScrollApplied.current = true;
    // Only scroll to draft if there's no promoted highlight (promoted takes scroll priority)
    if (promotedHighlightApplied.current) return;
    requestAnimationFrame(() => {
      draftHighlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [showDraftMemories, firstHighlightedDraftId]);

  const loadMemories = useCallback(async () => {
    try {
      const raw = await window.api.memory.list(accountId);
      if (raw.success && Array.isArray(raw.data)) {
        setMemories(raw.data);
      }
    } catch {
      setError("Failed to load memories");
    } finally {
      setIsLoading(false);
    }
  }, [accountId]);

  const loadDraftMemories = useCallback(async () => {
    try {
      const raw = await window.api.memory.draftMemories.list(accountId);
      if (raw.success && Array.isArray(raw.data)) {
        setDraftMemories(raw.data);
      }
    } catch {
      // Non-critical
    }
  }, [accountId]);

  const loadCategories = useCallback(async () => {
    try {
      const raw = await window.api.memory.categories(accountId);
      if (raw.success && Array.isArray(raw.data)) {
        setExistingCategories(raw.data);
      }
    } catch {
      // Non-critical
    }
  }, [accountId]);

  useEffect(() => {
    loadMemories();
    loadCategories();
    loadDraftMemories();
  }, [loadMemories, loadCategories, loadDraftMemories]);

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    if (newScope !== "global" && !newScopeValue.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const raw = await window.api.memory.save({
        accountId,
        scope: newScope,
        scopeValue: newScope === "global" ? null : newScopeValue.trim(),
        content: newContent.trim(),
      });
      if (raw.success) {
        setNewContent("");
        setNewScopeValue("");
        setShowAddForm(false);
        loadMemories();
        if (newScope === "category") loadCategories();
      } else {
        setError(raw.error || "Failed to save memory");
      }
    } catch {
      setError("Failed to save memory");
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggle = async (memory: Memory) => {
    try {
      const raw = await window.api.memory.update(memory.id, { enabled: !memory.enabled });
      if (raw.success) {
        setMemories((prev) =>
          prev.map((m) => (m.id === memory.id ? { ...m, enabled: !m.enabled } : m)),
        );
      } else {
        setError(raw.error || "Failed to update memory");
      }
    } catch {
      setError("Failed to update memory");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const raw = await window.api.memory.delete(id);
      if (raw.success) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
      } else {
        setError(raw.error || "Failed to delete memory");
      }
    } catch {
      setError("Failed to delete memory");
    }
  };

  const handleSaveEdit = async (id: string) => {
    if (!editContent.trim()) return;
    try {
      const raw = await window.api.memory.update(id, { content: editContent.trim() });
      if (raw.success) {
        setMemories((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: editContent.trim() } : m)),
        );
        setEditingId(null);
      } else {
        setError(raw.error || "Failed to update memory");
      }
    } catch {
      setError("Failed to update memory");
    }
  };

  const filtered =
    filterScope === "all" ? memories : memories.filter((m) => m.scope === filterScope);

  // Group by scope for display
  const grouped = filtered.reduce<Record<string, Memory[]>>((acc, m) => {
    const key =
      m.scope === "global"
        ? "Global"
        : m.scope === "person"
          ? `Person: ${m.scopeValue}`
          : m.scope === "domain"
            ? `Domain: @${m.scopeValue}`
            : `Category: ${m.scopeValue ?? "(uncategorized)"}`;
    (acc[key] ??= []).push(m);
    return acc;
  }, {});

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto p-4 text-sm text-gray-500 dark:text-gray-400">
        Loading memories...
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">AI Memories</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Persistent preferences that influence how drafts are generated. Memories are
              automatically included in AI context when relevant.
            </p>
          </div>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-3 py-1.5 bg-blue-600 dark:bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors"
          >
            {showAddForm ? "Cancel" : "Add Memory"}
          </button>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}

        {/* Add memory form */}
        {showAddForm && (
          <div className="p-4 mb-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg space-y-3">
            <div className="flex gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Scope
                </label>
                <select
                  value={newScope}
                  onChange={(e) => {
                    setNewScope(e.target.value as MemoryScope);
                    setNewScopeValue("");
                  }}
                  aria-label="Memory scope"
                  className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded text-sm"
                >
                  {(Object.keys(SCOPE_LABELS) as MemoryScope[]).map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              {newScope !== "global" && (
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    {newScope === "person"
                      ? "Email address"
                      : newScope === "domain"
                        ? "Domain"
                        : "Category name"}
                  </label>
                  <input
                    type="text"
                    value={newScopeValue}
                    onChange={(e) => setNewScopeValue(e.target.value)}
                    placeholder={
                      newScope === "person"
                        ? "alice@example.com"
                        : newScope === "domain"
                          ? "example.com"
                          : "e.g. student, investor, recruiter"
                    }
                    list={newScope === "category" ? "memory-categories" : undefined}
                    className="w-full px-2 py-1.5 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded text-sm"
                  />
                  {newScope === "category" && existingCategories.length > 0 && (
                    <datalist id="memory-categories">
                      {existingCategories.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  )}
                </div>
              )}
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {SCOPE_DESCRIPTIONS[newScope]}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Memory
              </label>
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder='e.g. "Use a gentler tone" or "Look up their profile at university.edu/directory"'
                rows={2}
                className="w-full px-2 py-1.5 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded text-sm resize-none"
              />
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleAdd}
                disabled={
                  !newContent.trim() || (newScope !== "global" && !newScopeValue.trim()) || isSaving
                }
                className="px-3 py-1.5 bg-blue-600 dark:bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                {isSaving ? "Saving..." : "Save Memory"}
              </button>
            </div>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex gap-1 mb-3">
          {(["all", "global", "person", "domain", "category"] as const).map((scope) => (
            <button
              key={scope}
              onClick={() => setFilterScope(scope)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filterScope === scope
                  ? "bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              {scope === "all" ? "All" : SCOPE_LABELS[scope]}
              {scope !== "all" && (
                <span className="ml-1 text-gray-400 dark:text-gray-500">
                  {memories.filter((m) => m.scope === scope).length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Memory list */}
        {Object.keys(grouped).length === 0 ? (
          <div className="text-center py-8 text-sm text-gray-400 dark:text-gray-500">
            {memories.length === 0
              ? "No memories yet. Add one above, or save feedback as a memory after refining a draft."
              : "No memories match this filter."}
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(grouped).map(([groupLabel, groupMemories]) => (
              <div key={groupLabel}>
                <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                  {groupLabel}
                </h4>
                <div className="space-y-1">
                  {groupMemories.map((memory) => (
                    <div
                      key={memory.id}
                      ref={memory.id === highlightMemoryIds?.[0] ? promotedHighlightRef : undefined}
                      className={`flex items-start gap-2 p-2 rounded border transition-colors ${
                        highlightSet.has(memory.id)
                          ? "bg-purple-50 dark:bg-purple-900/30 border-purple-300 dark:border-purple-600 ring-2 ring-purple-400/50"
                          : memory.enabled
                            ? "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
                            : "bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-700/50 opacity-60"
                      }`}
                    >
                      <button
                        onClick={() => handleToggle(memory)}
                        className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                          memory.enabled
                            ? "bg-blue-600 dark:bg-blue-500 border-blue-600 dark:border-blue-500 text-white"
                            : "border-gray-300 dark:border-gray-600"
                        }`}
                        title={memory.enabled ? "Disable" : "Enable"}
                      >
                        {memory.enabled && (
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={3}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        {editingId === memory.id ? (
                          <div className="flex gap-1">
                            <input
                              type="text"
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveEdit(memory.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              className="flex-1 px-2 py-0.5 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded text-sm"
                              autoFocus
                            />
                            <button
                              onClick={() => handleSaveEdit(memory.id)}
                              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-800 dark:text-gray-200">
                            {memory.content}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {memory.source === "refinement"
                              ? "From refinement"
                              : memory.source === "draft-edit"
                                ? "From draft edit"
                                : memory.source === "priority-override"
                                  ? "From priority override"
                                  : "Manual"}
                          </span>
                          <span className="text-xs text-gray-300 dark:text-gray-600">·</span>
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {new Date(memory.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => {
                            setEditingId(memory.id);
                            setEditContent(memory.content);
                          }}
                          className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded transition-colors"
                          title="Edit"
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                            />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDelete(memory.id)}
                          className="p-1 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 rounded transition-colors"
                          title="Delete"
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Draft memories section */}
        {draftMemories.length > 0 && (
          <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setShowDraftMemories(!showDraftMemories)}
              className="flex items-center gap-2 text-sm font-semibold text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform ${showDraftMemories ? "rotate-90" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Draft Memories ({draftMemories.length})
            </button>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 ml-5">
              Observations from your edits and priority overrides — promoted to active memories
              after repeated confirmations
            </p>

            {showDraftMemories && (
              <div className="mt-3 space-y-1 ml-5">
                {draftMemories.map((dm) => (
                  <div
                    key={dm.id}
                    ref={dm.id === firstHighlightedDraftId ? draftHighlightRef : undefined}
                    className={`flex items-start gap-2 p-2 rounded border transition-colors ${
                      highlightSet.has(dm.id)
                        ? "bg-purple-50 dark:bg-purple-900/30 border-purple-300 dark:border-purple-600 ring-2 ring-purple-400/50"
                        : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 dark:text-gray-200">{dm.content}</p>
                      {dm.senderEmail && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          Observed in conversation with{" "}
                          <span className="font-medium text-gray-600 dark:text-gray-300">
                            {dm.senderEmail}
                          </span>
                          {dm.subject && (
                            <span className="text-gray-400 dark:text-gray-500">
                              {" "}
                              — {dm.subject}
                            </span>
                          )}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded-full ${
                            dm.scope === "global"
                              ? "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400"
                              : dm.scope === "person"
                                ? "bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
                                : dm.scope === "domain"
                                  ? "bg-green-50 dark:bg-green-900/40 text-green-600 dark:text-green-400"
                                  : "bg-amber-50 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400"
                          }`}
                        >
                          {SCOPE_LABELS[dm.scope]}
                          {dm.scopeValue ? `: ${dm.scopeValue}` : ""}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {dm.voteCount}/{getPromotionThreshold(dm.memoryType)} confirmations
                        </span>
                        {dm.emailContext && (
                          <>
                            <span className="text-xs text-gray-300 dark:text-gray-600">·</span>
                            <span className="text-xs text-gray-400 dark:text-gray-500">
                              {dm.emailContext}
                            </span>
                          </>
                        )}
                        <span className="text-xs text-gray-300 dark:text-gray-600">·</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          last seen {new Date(dm.lastVotedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={async () => {
                          try {
                            const raw = await window.api.memory.draftMemories.promote(
                              dm.id,
                              accountId,
                            );
                            if (raw.success) {
                              loadMemories();
                              loadDraftMemories();
                            } else {
                              setError(raw.error || "Failed to promote");
                            }
                          } catch {
                            setError("Failed to promote");
                          }
                        }}
                        className="px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/40 rounded transition-colors"
                        title="Promote to active memory"
                      >
                        Promote
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            const raw = await window.api.memory.draftMemories.delete(dm.id);
                            if (raw.success) {
                              setDraftMemories((prev) => prev.filter((d) => d.id !== dm.id));
                            } else {
                              setError(raw.error || "Failed to delete");
                            }
                          } catch {
                            setError("Failed to delete");
                          }
                        }}
                        className="p-1 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 rounded transition-colors"
                        title="Delete"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
