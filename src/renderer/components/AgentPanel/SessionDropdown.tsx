import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore } from "../../store";
import type { AgentSessionSummary } from "../../../shared/agent-types";

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function statusDot(status: AgentSessionSummary["status"]): string {
  switch (status) {
    case "active":
      return "bg-green-500";
    case "completed":
      return "bg-gray-400";
    case "failed":
      return "bg-red-500";
    case "cancelled":
      return "bg-yellow-500";
  }
}

interface SessionDropdownProps {
  onNewChat: () => void;
}

export function SessionDropdown({ onNewChat }: SessionDropdownProps) {
  const [open, setOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const agentSessions = useAppStore((s) => s.agentSessions);
  const sessionList = useAppStore((s) => s.sessionList);
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  const currentSession = activeSessionId ? agentSessions[activeSessionId] : null;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (editingTitle && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTitle]);

  const handleRename = useCallback(async () => {
    if (!activeSessionId || !titleDraft.trim()) {
      setEditingTitle(false);
      return;
    }
    await window.api.agent.renameSession(activeSessionId, titleDraft.trim());
    useAppStore.getState().updateSessionInStore(activeSessionId, { title: titleDraft.trim() });
    setEditingTitle(false);
  }, [activeSessionId, titleDraft]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      setOpen(false);
    },
    [setActiveSessionId],
  );

  const activeSessions = sessionList.filter((s) => s.status === "active");
  const recentSessions = sessionList.filter((s) => s.status !== "active");

  return (
    <div ref={dropdownRef} className="relative border-b border-gray-200 dark:border-gray-700">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-400">▾</span>
          {editingTitle ? (
            <input
              ref={inputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleRename();
                if (e.key === "Escape") setEditingTitle(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="text-sm bg-transparent border-b border-blue-500 outline-none text-gray-900 dark:text-gray-100 w-full"
            />
          ) : (
            <span
              className="truncate text-gray-900 dark:text-gray-100"
              onDoubleClick={() => {
                if (currentSession) {
                  setTitleDraft(currentSession.title);
                  setEditingTitle(true);
                }
              }}
            >
              {currentSession?.title || "No active chat"}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-b-lg shadow-lg max-h-[300px] overflow-y-auto">
          <button
            onClick={() => {
              onNewChat();
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-sm text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-left font-medium"
          >
            + New Chat
          </button>

          {activeSessions.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium">
                Active
              </div>
              {activeSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleSelect(s.id)}
                  className={`w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 ${
                    s.id === activeSessionId ? "bg-gray-50 dark:bg-gray-800" : ""
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(s.status)}`}
                  />
                  <span className="truncate text-gray-900 dark:text-gray-100">{s.title}</span>
                  <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">
                    {formatRelativeTime(s.updatedAt)}
                  </span>
                </button>
              ))}
            </>
          )}

          {recentSessions.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium">
                Recent
              </div>
              {recentSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleSelect(s.id)}
                  className={`w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 ${
                    s.id === activeSessionId ? "bg-gray-50 dark:bg-gray-800" : ""
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(s.status)}`}
                  />
                  <span className="truncate text-gray-700 dark:text-gray-300">{s.title}</span>
                  <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">
                    {formatRelativeTime(s.updatedAt)}
                  </span>
                </button>
              ))}
            </>
          )}

          {sessionList.length === 0 && (
            <div className="px-3 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">
              No chat history
            </div>
          )}
        </div>
      )}
    </div>
  );
}
