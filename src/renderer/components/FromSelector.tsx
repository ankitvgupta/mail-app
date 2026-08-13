import { useState, useRef, useEffect } from "react";
import type { SendAsAlias } from "../../shared/types";
import { formatAlias } from "../utils/alias-formatting";

/** Extract bare email from a potentially formatted "Name <email>" address. */
function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>$/);
  return match ? match[1] : addr;
}

interface FromSelectorProps {
  aliases: SendAsAlias[];
  selected: string | undefined;
  onChange: (formatted: string) => void;
  /** Used as the display-name fallback when an alias has none of its own. */
  fallbackDisplayName?: string;
  /**
   * Account email to fall back to when there are no aliases (or only one).
   * Required when alwaysShow is true.
   */
  accountEmail?: string;
  /**
   * Force the From line to render even when the account has fewer than 2
   * aliases — shows as a non-interactive label so the user can see at a
   * glance which account a reply is going from. Used in unified inbox view.
   */
  alwaysShow?: boolean;
}

/**
 * Custom dropdown for selecting which send-as address to use.
 * Only renders when the account has 2+ aliases, unless `alwaysShow` is true
 * (in which case it renders as a static "From: <email>" label for accounts
 * with one or zero aliases).
 * Uses a custom popover instead of native <select> to avoid OS chrome.
 */
export function FromSelector({
  aliases,
  selected,
  onChange,
  fallbackDisplayName,
  accountEmail,
  alwaysShow = false,
}: FromSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  if (aliases.length < 2) {
    if (!alwaysShow) return null;
    // Static display — confirms which account this is sending from.
    const display = aliases[0]?.email ?? accountEmail;
    if (!display) return null;
    return (
      <div className="flex items-center gap-2 py-1.5 border-b border-gray-200 dark:border-gray-700/50">
        <label className="w-10 text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">From</label>
        <span className="min-w-0 text-sm text-gray-900 dark:text-gray-100 truncate pl-1.5">
          {display}
        </span>
      </div>
    );
  }

  const selectedBare = selected ? extractEmail(selected).toLowerCase() : "";
  const currentAlias =
    aliases.find((a) => a.email.toLowerCase() === selectedBare) ||
    aliases.find((a) => a.isDefault) ||
    aliases[0];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative flex items-center gap-2 py-1.5 border-b border-gray-200 dark:border-gray-700/50"
    >
      <label className="w-10 text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">From</label>
      <div className="flex-1 flex flex-wrap items-center">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="min-w-0 text-left text-sm text-gray-900 dark:text-gray-100 truncate cursor-pointer pl-1.5"
        >
          {currentAlias.email}
        </button>
      </div>
      {open && (
        <div className="absolute left-10 top-full mt-1 z-50 min-w-[280px] max-w-[400px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1">
          {aliases.map((alias) => (
            <button
              key={alias.email}
              type="button"
              onClick={() => {
                onChange(formatAlias(alias, fallbackDisplayName));
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-sm truncate transition-colors ${
                alias.email.toLowerCase() === currentAlias.email.toLowerCase()
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                  : "text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700/50"
              }`}
            >
              {formatAlias(alias, fallbackDisplayName)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
