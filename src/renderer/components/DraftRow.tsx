import React from "react";
import type { InboxDensity, LocalDraft } from "../../shared/types";

interface DraftRowProps {
  draft: LocalDraft;
  isSelected: boolean;
  density: InboxDensity;
  onClick: () => void;
}

// Density-specific style maps (matches EmailRow)
const densityStyles = {
  default: {
    row: "h-10 px-4 gap-2 text-sm",
    recipientWidth: "w-32",
    badge: "text-[10px] px-1.5 py-0.5",
    time: "w-10 text-xs",
  },
  compact: {
    row: "h-8 px-3 gap-1.5 text-xs",
    recipientWidth: "w-28",
    badge: "text-[9px] px-1 py-px",
    time: "w-9 text-[10px]",
  },
} as const;

function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Lightweight regex strip — avoids DOMParser overhead in the hot render path
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

export const DraftRow = React.memo(
  function DraftRow({ draft, isSelected, density, onClick }: DraftRowProps) {
    const ds = densityStyles[density] ?? densityStyles.default;
    const recipients = draft.to.join(", ");
    const snippet = draft.bodyText || stripHtmlTags(draft.bodyHtml);
    const time = formatRelativeDate(draft.updatedAt);

    return (
      <button
        onClick={onClick}
        className={`
        w-full ${ds.row} flex items-center text-left
        border-b border-gray-100 dark:border-gray-700/50 transition-colors group
        ${
          isSelected
            ? "bg-blue-600 text-white"
            : "hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-900 dark:text-gray-100"
        }
      `}
      >
        {/* Draft indicator dot area */}
        <div className="w-5 flex-shrink-0 flex items-center justify-center">
          <div
            className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-white" : "bg-orange-400"}`}
          />
        </div>

        {/* Recipients */}
        <div
          className={`${ds.recipientWidth} truncate font-medium flex-shrink-0 ${
            isSelected ? "text-white" : "text-gray-600 dark:text-gray-400"
          }`}
        >
          {recipients || "(no recipients)"}
        </div>

        {/* Draft badge */}
        <span
          className={`
        ${ds.badge} rounded flex-shrink-0 uppercase font-medium
        ${
          isSelected
            ? "bg-white/20 text-white"
            : "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
        }
      `}
        >
          Draft
        </span>

        {/* Subject + Snippet */}
        <div
          className={`flex-1 min-w-0 flex items-center ${density === "compact" ? "gap-1.5" : "gap-2"}`}
        >
          <span
            className={`font-medium truncate ${
              isSelected ? "text-white" : "text-gray-700 dark:text-gray-300"
            }`}
          >
            {draft.subject || "(no subject)"}
          </span>
          {snippet && (
            <>
              <span
                className={`flex-shrink-0 ${isSelected ? "text-white/40" : "text-gray-300 dark:text-gray-600"}`}
              >
                —
              </span>
              <span
                className={`truncate ${isSelected ? "text-white/60" : "text-gray-400 dark:text-gray-500"}`}
              >
                {snippet}
              </span>
            </>
          )}
        </div>

        {/* Time */}
        <span
          className={`${ds.time} text-right flex-shrink-0 tabular-nums ${
            isSelected ? "text-white/60" : "text-gray-400 dark:text-gray-500"
          }`}
        >
          {time}
        </span>
      </button>
    );
  },
  (prev, next) =>
    // Skip re-render if visible props are unchanged (onClick is stable from parent)
    prev.draft.id === next.draft.id &&
    prev.draft.updatedAt === next.draft.updatedAt &&
    prev.isSelected === next.isSelected &&
    prev.density === next.density,
);
