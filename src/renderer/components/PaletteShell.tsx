import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Shared selection plumbing for the command-style palettes (CommandPalette,
 * AgentCommandPalette, OpenLinksAttachmentsPalette): selected-index state,
 * input focus on open, selection reset on query change, clamping when the
 * list shrinks, [data-index] scroll-into-view, and arrow-key movement.
 *
 * The caller owns the query state (the filtered items — and therefore
 * itemCount — derive from it).
 */
export function usePaletteSelection({
  isOpen,
  query,
  itemCount,
}: {
  isOpen: boolean;
  query: string;
  itemCount: number;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset selection and focus the input when opened
  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keep selection in range when the list shrinks
  useEffect(() => {
    if (selectedIndex >= itemCount) {
      setSelectedIndex(Math.max(itemCount - 1, 0));
    }
  }, [itemCount, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (itemCount === 0) return;
      setSelectedIndex((i) => Math.min(Math.max(i + delta, 0), itemCount - 1));
    },
    [itemCount],
  );

  return { selectedIndex, setSelectedIndex, inputRef, listRef, moveSelection };
}

/** Full-screen backdrop plus the centered palette panel. */
export function PaletteShell({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Palette panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl dark:shadow-black/40 overflow-hidden border border-gray-200 dark:border-gray-700"
      >
        {children}
      </div>
    </div>
  );
}

/** Icon + search input + optional trailing kbd hints ("esc" is always shown). */
export function PaletteHeader({
  icon,
  inputRef,
  query,
  onQueryChange,
  onKeyDown,
  placeholder,
  trailing,
}: {
  icon: ReactNode;
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQueryChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  placeholder: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
      {icon}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="flex-1 text-base outline-none placeholder-gray-400 dark:text-gray-100 dark:placeholder-gray-500 bg-transparent"
      />
      {trailing}
      <kbd className="px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
        esc
      </kbd>
    </div>
  );
}

/** Scrollable results container; items must carry data-index attributes. */
export function PaletteResults({
  listRef,
  children,
}: {
  listRef: RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
      {children}
    </div>
  );
}

/** The ↑↓ / Enter / Esc hint bar. */
export function PaletteFooter({ enterLabel }: { enterLabel: string }) {
  return (
    <div className="flex items-center gap-4 px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
      <span>
        <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">&uarr;&darr;</kbd>{" "}
        navigate
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Enter</kbd> {enterLabel}
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Esc</kbd> close
      </span>
    </div>
  );
}
