import type { SendAsAlias } from "../../shared/types";

interface FromSelectorProps {
  aliases: SendAsAlias[];
  selected: string | undefined;
  onChange: (email: string) => void;
}

/**
 * Compact "From" address dropdown, shown above the To field.
 * Only renders when the account has more than one send-as alias.
 */
export function FromSelector({ aliases, selected, onChange }: FromSelectorProps) {
  if (aliases.length <= 1) return null;

  const selectedAlias = aliases.find(a => a.email.toLowerCase() === selected?.toLowerCase());
  const displayValue = selectedAlias
    ? (selectedAlias.displayName ? `${selectedAlias.displayName} <${selectedAlias.email}>` : selectedAlias.email)
    : selected || aliases.find(a => a.isPrimary)?.email || aliases[0].email;

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-gray-200 dark:border-gray-700/50">
      <label className="w-10 text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">
        From
      </label>
      <select
        value={selected?.toLowerCase() || aliases.find(a => a.isPrimary)?.email.toLowerCase() || aliases[0].email.toLowerCase()}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-sm bg-transparent border-none outline-none text-gray-900 dark:text-gray-100 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded py-0.5 -ml-1"
        title={displayValue}
      >
        {aliases.map(alias => (
          <option key={alias.email} value={alias.email.toLowerCase()}>
            {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
            {alias.isPrimary ? " (primary)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
