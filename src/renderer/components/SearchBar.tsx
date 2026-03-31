import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../store";
import type { IpcResponse, DashboardEmail } from "../../shared/types";
import { trackEvent } from "../services/posthog";

type SearchResult = {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  rank: number;
};

declare global {
  interface Window {
    api: {
      search: {
        query: (query: string, options?: { accountId?: string; limit?: number }) => Promise<IpcResponse<SearchResult[]>>;
        suggestions: (query: string, limit?: number) => Promise<IpcResponse<string[]>>;
      };
      emails: {
        search: (query: string, accountId: string, maxResults?: number) => Promise<IpcResponse<DashboardEmail[]>>;
        searchRemote: (query: string, accountId: string, maxResults?: number, pageToken?: string) => Promise<IpcResponse<{ emails: DashboardEmail[]; nextPageToken?: string }>>;
      };
    };
  }
}

function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

interface SearchBarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SearchBar({ isOpen, onClose }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1); // -1 means no selection
  const [hasNavigated, setHasNavigated] = useState(false); // Track if user used arrow keys
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    setSelectedEmailId,
    currentAccountId,
    accounts,
    setActiveSearch,
    setViewMode,
    isOnline,
    setRemoteSearchResults,
    setRemoteSearchError,
    setCurrentSplitId,
  } = useAppStore();

  // The "search all mail" affordance is at index === results.length
  const searchAllMailIndex = results.length;

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setResults([]);
      setSelectedIndex(-1);
      setHasNavigated(false);
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSelectedIndex(-1);
      setHasNavigated(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await window.api.search.query(query, {
          accountId: currentAccountId || undefined,
          limit: 20,
        });
        if (response.success) {
          setResults(response.data);
          // Don't auto-select, keep selection at -1 unless user navigates
        }
      } catch (error) {
        console.error("Search failed:", error);
      } finally {
        setIsSearching(false);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [query, currentAccountId]);

  // Perform full Gmail search and show results (local + remote in parallel)
  const performFullSearch = useCallback(() => {
    const accountIds = currentAccountId ? [currentAccountId] : accounts.map(a => a.id);
    if (!query.trim() || accountIds.length === 0) return;

    // Special handling for "in:draft" / "in:drafts" — switch to drafts view instead of searching
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "in:draft" || trimmed === "in:drafts") {
      setCurrentSplitId("__drafts__");
      onClose();
      return;
    }

    trackEvent("search_performed");

    setActiveSearch(query, []);

    // Fire local search for each account and merge results
    for (const accountId of accountIds) {
      window.api.emails.search(query, accountId, 500)
        .then((localResponse: IpcResponse<DashboardEmail[]>) => {
          if (useAppStore.getState().activeSearchQuery !== query) return;
          if (localResponse.success && localResponse.data) {
            const existing = useAppStore.getState().activeSearchResults ?? [];
            const existingIds = new Set(existing.map(e => e.id));
            const newEmails = localResponse.data.filter(e => !existingIds.has(e.id));
            if (newEmails.length > 0) {
              useAppStore.getState().setActiveSearchResults([...existing, ...newEmails]);
            }
          }
        })
        .catch((error: unknown) => {
          console.error("Local search failed:", error);
        });
    }

    // Fire remote search for each account and merge results.
    // Use Promise.all to ensure remoteSearchStatus transitions to "complete"
    // even when all accounts return empty or fully-deduplicated results.
    if (isOnline) {
      const remotePromises = accountIds.map((accountId) =>
        window.api.emails.searchRemote(query, accountId, 500)
          .then((response: { success: boolean; data?: { emails: DashboardEmail[]; nextPageToken?: string }; error?: string }) => {
            if (useAppStore.getState().activeSearchQuery !== query) return;
            if (response.success && response.data) {
              const existing = useAppStore.getState().remoteSearchResults ?? [];
              const existingIds = new Set(existing.map(e => e.id));
              const newEmails = response.data.emails.filter(e => !existingIds.has(e.id));
              if (newEmails.length > 0) {
                setRemoteSearchResults([...existing, ...newEmails]);
              }
              // Only store nextPageToken for single-account searches — in All
              // accounts mode the token is ambiguous and "load more" is disabled.
              if (response.data.nextPageToken && currentAccountId) {
                useAppStore.getState().setRemoteSearchNextPageToken(response.data.nextPageToken);
              }
            } else {
              setRemoteSearchError(response.error || "Gmail search failed");
            }
          })
          .catch((err: unknown) => {
            if (useAppStore.getState().activeSearchQuery !== query) return;
            setRemoteSearchError(err instanceof Error ? err.message : "Gmail search failed");
          })
      );
      Promise.all(remotePromises).then(() => {
        // If no individual response called setRemoteSearchResults (e.g. all
        // results were empty or duplicates), the status is still "searching".
        // Force it to "complete" so the spinner stops.
        const s = useAppStore.getState();
        if (s.activeSearchQuery === query && s.remoteSearchStatus === "searching") {
          setRemoteSearchResults(s.remoteSearchResults ?? []);
        }
      });
    } else {
      setRemoteSearchResults([]);
    }
  }, [query, currentAccountId, accounts, isOnline, setActiveSearch, setRemoteSearchResults, setRemoteSearchError, setCurrentSplitId, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setHasNavigated(true);
          // Allow navigating to the "search all mail" row at the end
          setSelectedIndex((i) => Math.min(i + 1, searchAllMailIndex));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHasNavigated(true);
          setSelectedIndex((i) => Math.max(i - 1, i === -1 ? -1 : 0));
          break;
        case "Enter":
          e.preventDefault();
          if (hasNavigated && selectedIndex >= 0 && selectedIndex < results.length && results[selectedIndex]) {
            // User explicitly navigated to a result, select it
            setSelectedEmailId(results[selectedIndex].id);
            setViewMode("full");
            onClose();
          } else {
            // Either: no navigation, or selected "search all mail" row, or just pressed Enter
            if (query.trim()) {
              performFullSearch();
            }
          }
          break;
      }
    },
    [results, selectedIndex, hasNavigated, searchAllMailIndex, setSelectedEmailId, setViewMode, onClose, query, performFullSearch]
  );

  const handleResultClick = (result: SearchResult) => {
    setSelectedEmailId(result.id);
    setViewMode("full");
    onClose();
  };

  // Format date for display
  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      } else if (diffDays === 1) {
        return "Yesterday";
      } else if (diffDays < 7) {
        return date.toLocaleDateString([], { weekday: "short" });
      } else {
        return date.toLocaleDateString([], { month: "short", day: "numeric" });
      }
    } catch {
      return "";
    }
  };

  // Extract sender name from email
  const getSenderName = (from: string) => {
    const match = from.match(/^([^<]+)/);
    return match ? match[1].trim() : from;
  };

  // Determine footer hint text
  const footerHint = hasNavigated && selectedIndex >= 0 && selectedIndex < results.length
    ? "Enter to open"
    : "Enter to search all mail";

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Search panel */}
      <div className="relative w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl dark:shadow-black/40 overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <svg
            className="w-5 h-5 text-gray-400 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search emails... (try from:, to:, subject:)"
            className="flex-1 text-lg outline-none placeholder-gray-400 dark:text-gray-100 dark:placeholder-gray-500 bg-transparent"
          />
          {isSearching && (
            <svg className="w-5 h-5 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          <kbd className="px-2 py-1 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-96 overflow-y-auto">
          {results.length > 0 ? (
            <div className="py-2">
              {results.map((result, index) => (
                <button
                  key={result.id}
                  onClick={() => handleResultClick(result)}
                  className={`w-full px-4 py-3 text-left transition-colors ${
                    index === selectedIndex && selectedIndex >= 0 ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                          {getSenderName(result.from)}
                        </span>
                        <span className="text-sm text-gray-400 dark:text-gray-500">{formatDate(result.date)}</span>
                      </div>
                      <div className="text-sm text-gray-700 dark:text-gray-300 truncate mt-0.5">{result.subject}</div>
                      {result.snippet && (
                        <div className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">{decodeHtmlEntities(result.snippet)}</div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
              {/* "Search all mail" affordance row */}
              {query.trim() && (
                <button
                  onClick={performFullSearch}
                  className={`w-full px-4 py-3 text-left transition-colors border-t border-gray-100 dark:border-gray-700/50 ${
                    selectedIndex === searchAllMailIndex ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  }`}
                >
                  <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <span className="text-sm font-medium">
                      Search all mail for &quot;{query}&quot;
                    </span>
                  </div>
                </button>
              )}
            </div>
          ) : query.trim() && !isSearching ? (
            <div className="py-2">
              <div className="px-4 py-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                No local results for &quot;{query}&quot;
              </div>
              {/* "Search all mail" affordance when no local results */}
              <button
                onClick={performFullSearch}
                className={`w-full px-4 py-3 text-left transition-colors border-t border-gray-100 dark:border-gray-700/50 ${
                  selectedIndex === searchAllMailIndex ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
                }`}
              >
                <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span className="text-sm font-medium">
                    Search all mail for &quot;{query}&quot;
                  </span>
                </div>
              </button>
            </div>
          ) : !query.trim() ? (
            <div className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">
              <div className="font-medium mb-2">Search operators:</div>
              <ul className="space-y-1">
                <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">from:email@example.com</code> - Search by sender</li>
                <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">to:email@example.com</code> - Search by recipient</li>
                <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">subject:keyword</code> - Search in subject</li>
                <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">"exact phrase"</code> - Search exact phrase</li>
                <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">in:draft</code> - View drafts</li>
              </ul>
            </div>
          ) : null}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <span><kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">↑↓</kbd> to navigate</span>
          <span><kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Enter</kbd> {footerHint}</span>
          <span><kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Esc</kbd> to close</span>
        </div>
      </div>
    </div>
  );
}

export default SearchBar;
