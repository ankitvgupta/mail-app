import { useState, useEffect } from "react";
import type { DashboardEmail } from "../../shared/types";

// Binary classification options: Priority (needs reply) vs Other.
const OPTIONS = [
  { value: "priority" as const, label: "Priority", needsReply: true },
  { value: "other" as const, label: "Other", needsReply: false },
];

type OptionValue = (typeof OPTIONS)[number]["value"];

function currentValue(analysis: { needsReply: boolean }): OptionValue {
  return analysis.needsReply ? "priority" : "other";
}

/** Interactive analysis section with Priority/Other override and optional memory reason. */
export function AnalysisPrioritySection({
  email,
  onAnalysisUpdated,
}: {
  email: DashboardEmail;
  onAnalysisUpdated: (newNeedsReply: boolean) => void;
}) {
  const analysis = email.analysis!;
  const current = currentValue(analysis);

  const [isEditing, setIsEditing] = useState(false);
  const [selectedValue, setSelectedValue] = useState<OptionValue>(current);
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Reset state when email changes
  useEffect(() => {
    setIsEditing(false);
    setSelectedValue(currentValue(analysis));
    setReason("");
  }, [email.id]);

  const handleSave = async () => {
    const option = OPTIONS.find((o) => o.value === selectedValue);
    if (!option || selectedValue === current) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await window.api.analysis.overridePriority(
        email.id,
        option.needsReply,
        reason.trim() || undefined,
      );
      onAnalysisUpdated(option.needsReply);
      setIsEditing(false);
      setReason("");
    } catch (err) {
      console.error("Failed to override classification:", err);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isEditing) {
    return (
      <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700/50 bg-gray-50 dark:bg-gray-800/50">
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`font-medium ${
              analysis.needsReply
                ? "text-blue-600 dark:text-blue-400"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {analysis.needsReply ? "Priority" : "Other"}
          </span>
          <span className="text-gray-300 dark:text-gray-600">·</span>
          <span className="text-gray-400 dark:text-gray-500 flex-1">{analysis.reason}</span>
          <button
            onClick={() => setIsEditing(true)}
            className="text-xs text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700/50 bg-gray-50 dark:bg-gray-800/50">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400 text-xs font-medium">
            Classification:
          </span>
          <div className="flex gap-1">
            {OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSelectedValue(opt.value)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  selectedValue === opt.value
                    ? opt.value === "priority"
                      ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                      : "bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {selectedValue !== current && (
          <>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") {
                  setIsEditing(false);
                  setSelectedValue(current);
                  setReason("");
                }
              }}
              placeholder="Reason (optional) — helps improve future classification"
              className="w-full px-3 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-400"
              autoFocus
            />
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => {
                  setIsEditing(false);
                  setSelectedValue(current);
                  setReason("");
                }}
                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-3 py-1 text-xs font-medium rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </>
        )}
        {selectedValue === current && (
          <div className="flex justify-end">
            <button
              onClick={() => setIsEditing(false)}
              className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
