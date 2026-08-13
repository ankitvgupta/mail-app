import { useState, useEffect } from "react";
import { useAppStore } from "../store";
import type { InboxSplit, SplitCondition } from "../../shared/types";

const CONDITION_TYPES = [
  { value: "from", label: "From", placeholder: "e.g., *@company.com or john@" },
  { value: "to", label: "To", placeholder: "e.g., *@mycompany.com" },
  { value: "subject", label: "Subject", placeholder: "e.g., *urgent* or [JIRA]*" },
  { value: "label", label: "Label", placeholder: "e.g., STARRED, IMPORTANT" },
  { value: "has_attachment", label: "Attachment", placeholder: "e.g., *.ics, *.pdf" },
] as const;

interface ConditionEditorProps {
  condition: SplitCondition;
  onChange: (condition: SplitCondition) => void;
  onRemove: () => void;
}

function ConditionEditor({ condition, onChange, onRemove }: ConditionEditorProps) {
  const typeInfo = CONDITION_TYPES.find((t) => t.value === condition.type) || CONDITION_TYPES[0];

  return (
    <div className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800/50 rounded">
      <select
        value={condition.type}
        onChange={(e) => onChange({ ...condition, type: e.target.value as SplitCondition["type"] })}
        aria-label="Condition type"
        className="text-sm border rounded px-2 py-1 w-24 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600"
      >
        {CONDITION_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      <label className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 shrink-0">
        <input
          type="checkbox"
          checked={condition.negate ?? false}
          onChange={(e) => onChange({ ...condition, negate: e.target.checked })}
          className="rounded"
        />
        NOT
      </label>

      <input
        type="text"
        value={condition.value}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
        placeholder={typeInfo.placeholder}
        className="flex-1 text-sm border rounded px-2 py-1 font-mono dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600"
      />

      <button
        onClick={onRemove}
        className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-400 p-1 shrink-0"
        title="Remove condition"
        aria-label="Remove condition"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

interface SplitEditorProps {
  split: InboxSplit | null;
  onSave: (split: Omit<InboxSplit, "id" | "accountId"> | InboxSplit) => void;
  onCancel: () => void;
  existingCount: number;
}

function SplitEditor({ split, onSave, onCancel, existingCount }: SplitEditorProps) {
  const [name, setName] = useState(split?.name ?? "");
  const [icon, setIcon] = useState(split?.icon ?? "");
  const [conditions, setConditions] = useState<SplitCondition[]>(
    split?.conditions ?? [{ type: "from", value: "" }],
  );
  const [conditionLogic, setConditionLogic] = useState<"and" | "or">(split?.conditionLogic ?? "or");
  const [exclusive, setExclusive] = useState(split?.exclusive ?? false);

  const handleAddCondition = () => {
    setConditions([...conditions, { type: "from", value: "" }]);
  };

  const handleUpdateCondition = (index: number, updated: SplitCondition) => {
    const newConditions = [...conditions];
    newConditions[index] = updated;
    setConditions(newConditions);
  };

  const handleRemoveCondition = (index: number) => {
    setConditions(conditions.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!name.trim()) return;
    if (conditions.length === 0) return;
    if (conditions.some((c) => !c.value.trim())) return;

    const splitData = {
      name: name.trim(),
      icon: icon.trim() || undefined,
      conditions,
      conditionLogic,
      exclusive,
      order: split?.order ?? existingCount,
    };

    if (split) {
      onSave({ ...splitData, id: split.id });
    } else {
      onSave(splitData);
    }
  };

  const isValid = name.trim() && conditions.length > 0 && conditions.every((c) => c.value.trim());

  return (
    <div className="border rounded-lg p-4 bg-white dark:bg-gray-800">
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Work"
              className="w-full text-sm border rounded px-3 py-2 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600"
            />
          </div>
          <div className="w-20">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Icon
            </label>
            <input
              type="text"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="emoji"
              maxLength={2}
              className="w-full text-sm border rounded px-3 py-2 text-center dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Conditions
            </label>
            <select
              value={conditionLogic}
              onChange={(e) => setConditionLogic(e.target.value as "and" | "or")}
              aria-label="Condition match logic"
              className="text-xs border rounded px-2 py-1 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600"
            >
              <option value="or">Match ANY</option>
              <option value="and">Match ALL</option>
            </select>
          </div>
          <div className="space-y-2">
            {conditions.map((condition, index) => (
              <ConditionEditor
                key={index}
                condition={condition}
                onChange={(c) => handleUpdateCondition(index, c)}
                onRemove={() => handleRemoveCondition(index)}
              />
            ))}
          </div>
          <button
            onClick={handleAddCondition}
            className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
          >
            + Add condition
          </button>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Use <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">*</code> as wildcard.
            Examples:{" "}
            <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">*@company.com</code>,
            <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded ml-1">john*</code>,
            <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded ml-1">*newsletter*</code>
          </p>
        </div>

        <div className="border-t pt-4">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={exclusive}
              onChange={(e) => setExclusive(e.target.checked)}
              className="rounded"
            />
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Exclusive
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Hide matching emails from "All" inbox and "Archive Ready"
              </p>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid}
            className="px-3 py-1.5 text-sm bg-blue-500 dark:bg-blue-400 text-white rounded hover:bg-blue-600 dark:hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {split ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

type SuperhumanAccount = { email: string; splitCount: number };
type ImportResult = { imported: number; warnings: string[] };

export function SplitConfigEditor() {
  const { splits: allSplits, setSplits, currentAccountId, accounts } = useAppStore();
  const [editingSplit, setEditingSplit] = useState<InboxSplit | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Superhuman import state
  const [shAccounts, setShAccounts] = useState<SuperhumanAccount[] | null>(null);
  const [shDiscovering, setShDiscovering] = useState(false);
  const [shImporting, setShImporting] = useState(false);
  const [shResult, setShResult] = useState<ImportResult | null>(null);
  const [shError, setShError] = useState<string | null>(null);

  // Filter splits for current account
  const splits = allSplits.filter((s) => s.accountId === currentAccountId);
  const currentAccount = accounts.find((a) => a.id === currentAccountId);

  // Load splits on mount
  useEffect(() => {
    const loadSplits = async () => {
      try {
        const result = await window.api.splits.getAll();
        if (result.success) {
          setSplits(result.data as InboxSplit[]);
        }
      } finally {
        setIsLoading(false);
      }
    };
    loadSplits();
  }, [setSplits]);

  const handleCreate = async (split: Omit<InboxSplit, "id" | "accountId">) => {
    if (!currentAccountId) return;

    setIsSaving(true);
    try {
      const splitWithAccount = { ...split, accountId: currentAccountId };
      const result = await window.api.splits.create(splitWithAccount);
      if (result.success) {
        const newSplit = result.data as InboxSplit;
        setSplits([...allSplits, newSplit]);
        setIsCreating(false);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdate = async (split: InboxSplit) => {
    setIsSaving(true);
    try {
      const { id, ...updates } = split;
      const result = await window.api.splits.update(id, updates);
      if (result.success) {
        // Use server response which has the full merged split (including accountId)
        const updated = result.data as InboxSplit;
        setSplits(allSplits.map((s) => (s.id === id ? updated : s)));
        setEditingSplit(null);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this split?")) return;

    setIsSaving(true);
    try {
      const result = await window.api.splits.delete(id);
      if (result.success) {
        setSplits(allSplits.filter((s) => s.id !== id));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const newSplits = [...splits];
    const temp = newSplits[index].order;
    newSplits[index].order = newSplits[index - 1].order;
    newSplits[index - 1].order = temp;
    [newSplits[index], newSplits[index - 1]] = [newSplits[index - 1], newSplits[index]];

    // Update allSplits with the modified account splits
    const otherSplits = allSplits.filter((s) => s.accountId !== currentAccountId);
    setSplits([...otherSplits, ...newSplits]);
    await window.api.splits.save([...otherSplits, ...newSplits]);
  };

  const handleMoveDown = async (index: number) => {
    if (index === splits.length - 1) return;
    const newSplits = [...splits];
    const temp = newSplits[index].order;
    newSplits[index].order = newSplits[index + 1].order;
    newSplits[index + 1].order = temp;
    [newSplits[index], newSplits[index + 1]] = [newSplits[index + 1], newSplits[index]];

    // Update allSplits with the modified account splits
    const otherSplits = allSplits.filter((s) => s.accountId !== currentAccountId);
    setSplits([...otherSplits, ...newSplits]);
    await window.api.splits.save([...otherSplits, ...newSplits]);
  };

  const handleDiscoverSuperhuman = async () => {
    setShDiscovering(true);
    setShAccounts(null);
    setShResult(null);
    setShError(null);
    try {
      const result = (await window.api.splits.discoverSuperhuman()) as {
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
      const result = (await window.api.splits.importFromSuperhuman(email, currentAccountId)) as {
        success: boolean;
        data?: ImportResult;
        error?: string;
      };
      if (result.success && result.data) {
        setShResult(result.data);
        // Refresh splits
        const refreshed = (await window.api.splits.getAll()) as {
          success: boolean;
          data?: InboxSplit[];
        };
        if (refreshed.success && refreshed.data) {
          setSplits(refreshed.data);
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

  const sortedSplits = [...splits].sort((a, b) => a.order - b.order);

  if (isLoading) {
    return <div className="text-sm text-gray-500 dark:text-gray-400">Loading splits...</div>;
  }

  if (!currentAccountId) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Switch from <span className="font-medium">All Inboxes</span> to a single account in the
        title bar to manage that account's splits.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900 dark:text-gray-100">Inbox Splits</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Splits for <span className="font-medium">{currentAccount?.email}</span>. Use wildcards
            (*) in patterns.
          </p>
        </div>
        {!isCreating && !editingSplit && (
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
              + New Split
            </button>
          </div>
        )}
      </div>

      {/* Superhuman import inline dialog */}
      {shAccounts && shAccounts.length > 0 && !shResult && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Select Superhuman account to import from:
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
              disabled={shImporting || acct.splitCount === 0}
              className="w-full text-left px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="font-medium">{acct.email}</span>
              <span className="ml-2 text-gray-500 dark:text-gray-400">
                ({acct.splitCount} split{acct.splitCount !== 1 ? "s" : ""})
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Import result */}
      {shResult && (
        <div className="border rounded-lg p-4 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 space-y-1">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Imported {shResult.imported} split{shResult.imported !== 1 ? "s" : ""}
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

      {isCreating && (
        <SplitEditor
          split={null}
          onSave={(s) => handleCreate(s as Omit<InboxSplit, "id">)}
          onCancel={() => setIsCreating(false)}
          existingCount={splits.length}
        />
      )}

      {editingSplit && (
        <SplitEditor
          split={editingSplit}
          onSave={(s) => handleUpdate(s as InboxSplit)}
          onCancel={() => setEditingSplit(null)}
          existingCount={splits.length}
        />
      )}

      {sortedSplits.length === 0 && !isCreating ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          <p className="text-sm">No splits configured yet.</p>
          <p className="text-xs mt-1">Create a split to filter your inbox.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedSplits.map((split, index) => (
            <div
              key={split.id}
              className={`flex items-center justify-between p-3 border rounded-lg border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 ${
                editingSplit?.id === split.id ? "opacity-50" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                {split.icon && <span className="text-lg">{split.icon}</span>}
                <div>
                  <div className="font-medium text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                    {split.name}
                    {split.exclusive && (
                      <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">
                        exclusive
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {split.conditions.length} condition{split.conditions.length !== 1 ? "s" : ""} (
                    {split.conditionLogic})
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleMoveUp(index)}
                  disabled={index === 0 || isSaving}
                  className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30"
                  title="Move up"
                  aria-label={`Move "${split.name}" up`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => handleMoveDown(index)}
                  disabled={index === sortedSplits.length - 1 || isSaving}
                  className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30"
                  title="Move down"
                  aria-label={`Move "${split.name}" down`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => setEditingSplit(split)}
                  disabled={isSaving || !!editingSplit}
                  className="p-1 text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-30"
                  title="Edit"
                  aria-label={`Edit split "${split.name}"`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => handleDelete(split.id)}
                  disabled={isSaving}
                  className="p-1 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-30"
                  title="Delete"
                  aria-label={`Delete split "${split.name}"`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
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
  );
}
