import { useAppStore } from "../store";
import type {
  AgentProviderConfig,
  AgentTaskState,
  AgentTaskHistoryEntry,
} from "../../shared/agent-types";

function ProviderStatusDot({ status }: { status: AgentTaskState | "ready" | "unavailable" }) {
  const config: Record<string, { color: string; pulse: boolean; label: string }> = {
    ready: { color: "bg-green-500", pulse: false, label: "Ready" },
    running: { color: "bg-blue-500", pulse: true, label: "Running" },
    unavailable: { color: "bg-gray-400 dark:bg-gray-600", pulse: false, label: "Unavailable" },
    failed: { color: "bg-red-500", pulse: false, label: "Error" },
    completed: { color: "bg-green-500", pulse: false, label: "Ready" },
    cancelled: { color: "bg-green-500", pulse: false, label: "Ready" },
    pending_approval: { color: "bg-amber-500", pulse: true, label: "Awaiting Approval" },
    pending_async: { color: "bg-gray-400", pulse: true, label: "Waiting" },
  };

  const { color, pulse, label } = config[status] ?? config.ready;

  return (
    <span className="relative flex h-2 w-2" title={label}>
      {pulse && (
        <span
          className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-75`}
        />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
    </span>
  );
}

function ProviderRow({ provider }: { provider: AgentProviderConfig }) {
  const { selectedAgentIds, setSelectedAgentIds, agentTasks, selectedEmailId } = useAppStore();

  const isSelected = selectedAgentIds.includes(provider.id);

  // Determine run status for this provider from the current email's agent task
  const currentTask = selectedEmailId ? agentTasks[selectedEmailId] : undefined;
  const runStatus: AgentTaskState | "ready" = currentTask?.runs[provider.id]?.status ?? "ready";

  const handleToggle = () => {
    if (isSelected) {
      setSelectedAgentIds(selectedAgentIds.filter((id) => id !== provider.id));
    } else {
      setSelectedAgentIds([...selectedAgentIds, provider.id]);
    }
  };

  return (
    <button
      onClick={handleToggle}
      className={`w-full px-3 py-2 flex items-center gap-3 text-left text-sm transition-colors rounded-lg ${
        isSelected
          ? "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300"
          : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
      }`}
    >
      {/* Checkbox */}
      <div
        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
          isSelected ? "bg-purple-600 border-purple-600" : "border-gray-300 dark:border-gray-600"
        }`}
      >
        {isSelected && (
          <svg
            className="w-3 h-3 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={3}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* Provider info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {provider.icon && <span className="text-sm">{provider.icon}</span>}
          <span className="font-medium truncate">{provider.name}</span>
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
          {provider.description}
        </div>
      </div>

      {/* Status indicator */}
      <ProviderStatusDot status={runStatus} />
    </button>
  );
}

function TaskHistoryRow({ entry }: { entry: AgentTaskHistoryEntry }) {
  const statusIcon: Record<string, string> = {
    completed: "text-green-500",
    failed: "text-red-500",
    cancelled: "text-gray-400",
  };

  const relativeTime = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86400_000)}d ago`;
  };

  return (
    <div className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
      <div className="flex items-center gap-1.5">
        <svg
          className={`w-3 h-3 flex-shrink-0 ${statusIcon[entry.status] ?? "text-gray-400"}`}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          {entry.status === "completed" ? (
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          ) : entry.status === "failed" ? (
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
          ) : (
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm-1-5h2v2h-2zm0-8h2v6h-2z" />
          )}
        </svg>
        <span className="truncate flex-1">{entry.prompt}</span>
        <span className="text-gray-400 dark:text-gray-500 flex-shrink-0">
          {relativeTime(entry.timestamp)}
        </span>
      </div>
      {entry.summary && (
        <div className="ml-4.5 mt-0.5 text-gray-400 dark:text-gray-500 truncate">
          {entry.summary}
        </div>
      )}
    </div>
  );
}

export function AgentsSidebar() {
  const {
    isAgentsSidebarOpen,
    toggleAgentsSidebar,
    availableProviders,
    agentTaskHistory,
    setShowSettings,
  } = useAppStore();

  if (!isAgentsSidebarOpen) return null;

  // Show most recent tasks first, limit to 20
  const recentHistory = [...agentTaskHistory].reverse().slice(0, 20);

  return (
    <div className="w-56 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Agents</span>
        <button
          onClick={toggleAgentsSidebar}
          className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded transition-colors"
          title="Close sidebar"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Provider list */}
      <div className="p-2 space-y-1">
        {availableProviders.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-gray-400 dark:text-gray-500">
            No agents available.
          </div>
        ) : (
          availableProviders.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))
        )}
      </div>

      {/* Task History */}
      {recentHistory.length > 0 && (
        <>
          <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Recent Tasks
            </span>
          </div>
          <div className="flex-1 overflow-y-auto space-y-0.5">
            {recentHistory.map((entry) => (
              <TaskHistoryRow key={entry.taskId} entry={entry} />
            ))}
          </div>
        </>
      )}

      {/* Footer */}
      <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setShowSettings(true)}
          className="w-full px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors text-center"
        >
          Manage...
        </button>
      </div>
    </div>
  );
}

export default AgentsSidebar;
