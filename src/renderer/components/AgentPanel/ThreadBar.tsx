import { useAppStore } from "../../store";

export function ThreadBar() {
  const selectedEmailId = useAppStore((s) => s.selectedEmailId);
  const emails = useAppStore((s) => s.emails);

  const selectedEmail = selectedEmailId ? emails.find((e) => e.id === selectedEmailId) : null;

  if (!selectedEmail) {
    return (
      <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 dark:text-gray-500">
        No thread selected
      </div>
    );
  }

  return (
    <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 truncate">
      <span className="mr-1">📎</span>
      {selectedEmail.subject || "(no subject)"}
    </div>
  );
}
