import { ScheduleSendButton } from "./ScheduleSendButton";
import type { Signature } from "../../shared/types";

interface ComposeToolbarProps {
  onSend: () => void;
  onScheduleSend: (scheduledAt: number) => void;
  onPickFiles: () => void;
  isSending: boolean;
  isScheduling: boolean;
  canSend: boolean;
  activeSignatureId: string | null;
  onSignatureChange: (id: string | null) => void;
  availableSignatures: Signature[];
}

export function ComposeToolbar({
  onSend,
  onScheduleSend,
  onPickFiles,
  isSending,
  isScheduling,
  canSend,
  activeSignatureId,
  onSignatureChange,
  availableSignatures,
}: ComposeToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 pt-2 border-t border-gray-100 dark:border-gray-700/30">
      <button
        onClick={onSend}
        disabled={isSending || isScheduling || !canSend}
        className="px-3 py-1.5 bg-blue-600 dark:bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
        data-testid="inline-compose-send"
      >
        {isSending ? "Sending..." : "Send"}
      </button>
      <ScheduleSendButton
        onSchedule={onScheduleSend}
        disabled={isScheduling || isSending || !canSend}
      />
      <button
        onClick={onPickFiles}
        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
        title="Attach file"
        aria-label="Attach file"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"
          />
        </svg>
      </button>
      <span className="text-xs text-gray-500 dark:text-gray-400">Cmd+Enter to send</span>
      {availableSignatures.length > 0 && (
        <select
          value={activeSignatureId ?? ""}
          onChange={(e) => onSignatureChange(e.target.value || null)}
          aria-label="Signature"
          className="ml-auto text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
        >
          <option value="">No signature</option>
          {availableSignatures.map((sig) => (
            <option key={sig.id} value={sig.id}>
              {sig.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
