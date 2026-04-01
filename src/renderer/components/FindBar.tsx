import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../store";

export function FindBar() {
  const closeFindBar = useAppStore((s) => s.closeFindBar);
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    window.api.find.stop();
    closeFindBar();
  }, [closeFindBar]);

  // Auto-focus on mount — use requestAnimationFrame to ensure the DOM is ready
  // (plain autoFocus or a synchronous effect can lose to Electron's focus handling)
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // Listen for find results from main process
  useEffect(() => {
    window.api.find.onResult((result: { activeMatchOrdinal: number; matches: number }) => {
      setActiveMatch(result.activeMatchOrdinal);
      setTotalMatches(result.matches);
    });
    return () => {
      window.api.find.removeResultListener();
    };
  }, []);

  // Handle Escape — let modal overlays (CommandPalette, AgentPalette, SearchBar) take priority
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const state = useAppStore.getState();
        if (state.isCommandPaletteOpen || state.isAgentPaletteOpen || state.isSearchOpen) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [close]);

  // Stop find when component unmounts
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      window.api.find.stop();
    };
  }, []);

  const findText = useCallback((text: string, findNext?: boolean, forward?: boolean) => {
    if (!text) {
      window.api.find.stop();
      setActiveMatch(0);
      setTotalMatches(0);
      return;
    }
    window.api.find.find(text, { findNext: findNext ?? false, forward: forward ?? true });
  }, []);

  const handleInputChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      findText(value);
    }, 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (query) {
        findText(query, true, !e.shiftKey);
      }
    }
  };

  const goNext = () => {
    if (query) findText(query, true, true);
  };

  const goPrev = () => {
    if (query) findText(query, true, false);
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"
      data-testid="find-bar"
    >
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={query}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in page..."
        className="flex-1 min-w-0 px-2 py-1 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        data-testid="find-bar-input"
      />
      {query && (
        <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {totalMatches > 0 ? `${activeMatch} of ${totalMatches}` : "No matches"}
        </span>
      )}
      <button
        onClick={goPrev}
        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 dark:text-gray-400"
        title="Previous match (Shift+Enter)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>
      <button
        onClick={goNext}
        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 dark:text-gray-400"
        title="Next match (Enter)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <button
        onClick={close}
        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 dark:text-gray-400"
        title="Close (Escape)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
