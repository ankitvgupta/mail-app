import type { SendAsAlias } from "../../shared/types";

interface FromSelectorProps {
  aliases: SendAsAlias[];
  selected: string | undefined;
  onChange: (email: string) => void;
}

/**
 * Compact dropdown for selecting which send-as address to use.
 * Only renders when the account has 2+ aliases.
 */
export function FromSelector({ aliases, selected, onChange }: FromSelectorProps) {
  if (aliases.length < 2) return null;

  // Determine what's shown — default to the default alias
  const current = selected || aliases.find((a) => a.isDefault)?.email || aliases[0].email;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-500 dark:text-gray-400 shrink-0">From</span>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-transparent border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-gray-900 dark:text-gray-100 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
      >
        {aliases.map((alias) => (
          <option key={alias.email} value={alias.email}>
            {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
          </option>
        ))}
      </select>
    </div>
  );
}
