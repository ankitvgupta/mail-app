import { useState, memo } from "react";
import type { ScopedAgentEvent } from "../../../shared/agent-types";

interface CollapsedToolCallsProps {
  events: ScopedAgentEvent[];
}

export const CollapsedToolCalls = memo(function CollapsedToolCalls({
  events,
}: CollapsedToolCallsProps) {
  const [expanded, setExpanded] = useState(false);

  const toolNames = events
    .filter((e) => e.type === "tool_call_start")
    .map((e) => (e.type === "tool_call_start" ? e.toolName : ""));

  const uniqueTools = [...new Set(toolNames)];
  const summary =
    uniqueTools.length <= 2
      ? uniqueTools.join(", ")
      : `${uniqueTools.slice(0, 2).join(", ")} +${uniqueTools.length - 2}`;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      >
        <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
        <span className="font-mono">
          Used {toolNames.length} tool{toolNames.length !== 1 ? "s" : ""}
          {summary ? ` (${summary})` : ""}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-3 space-y-1 border-l-2 border-gray-200 dark:border-gray-700 pl-2">
          {events.map((event, i) => {
            if (event.type === "tool_call_start") {
              return (
                <div key={i} className="text-xs text-gray-500 dark:text-gray-400">
                  <span className="font-mono font-medium">{event.toolName}</span>
                  <pre className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 overflow-x-auto max-h-20 overflow-y-auto">
                    {typeof event.input === "string"
                      ? event.input.slice(0, 200)
                      : JSON.stringify(event.input, null, 2).slice(0, 200)}
                  </pre>
                </div>
              );
            }
            if (event.type === "tool_call_end") {
              return (
                <div
                  key={i}
                  className="text-[10px] text-gray-400 dark:text-gray-500 font-mono overflow-x-auto max-h-16 overflow-y-auto"
                >
                  →{" "}
                  {typeof event.result === "string"
                    ? event.result.slice(0, 150)
                    : JSON.stringify(event.result).slice(0, 150)}
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
});
