import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AttachmentMeta, DashboardEmail, IpcResponse } from "../../shared/types";
import { useAppStore } from "../store";
import { isPreviewable } from "../utils/attachments";
import {
  buildOpenables,
  itemMatches,
  MAX_RENDERED_OPENABLE_ITEMS,
  type OpenableAttachment,
  type OpenableItem,
  type OpenableLink,
} from "../utils/openables";
import { formatPlatformShortcut } from "../utils/platform";
import { AttachmentPreviewModal } from "./AttachmentList";
import {
  PaletteFooter,
  PaletteHeader,
  PaletteResults,
  PaletteShell,
  usePaletteSelection,
} from "./PaletteShell";

const OPEN_SHORTCUT = formatPlatformShortcut("O");

const ICONS = {
  command: "M13 10V3L4 14h7v7l9-11h-7z",
  link: "M13.19 8.688a4.5 4.5 0 016.364 6.364l-1.768 1.768a4.5 4.5 0 01-6.364 0M10.81 15.312a4.5 4.5 0 01-6.364-6.364L6.214 7.18a4.5 4.5 0 016.364 0",
  file: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5A3.375 3.375 0 0010.125 2.25H6.75A2.25 2.25 0 004.5 4.5v15A2.25 2.25 0 006.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-5.25z",
};

function PaletteIcon({
  path,
  className = "w-5 h-5 text-gray-400 dark:text-gray-500 flex-shrink-0",
  strokeWidth = 1.5,
}: {
  path: string;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

function RowIcon({ item, isSelected }: { item: OpenableItem; isSelected: boolean }) {
  return (
    <PaletteIcon
      path={item.kind === "link" ? ICONS.link : ICONS.file}
      className={`w-5 h-5 flex-shrink-0 ${
        isSelected ? "text-blue-600 dark:text-blue-300" : "text-gray-400 dark:text-gray-500"
      }`}
    />
  );
}

export function OpenLinksAttachmentsPalette({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [loadedEmailState, setLoadedEmailState] = useState<{
    id: string;
    email: DashboardEmail;
  } | null>(null);
  const [loadingEmailId, setLoadingEmailId] = useState<string | null>(null);
  const [openingAttachmentId, setOpeningAttachmentId] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<{
    attachment: AttachmentMeta;
    data: string;
  } | null>(null);

  const emails = useAppStore((s) => s.emails);
  const selectedEmailId = useAppStore((s) => s.selectedEmailId);
  const focusedThreadEmailId = useAppStore((s) => s.focusedThreadEmailId);
  const viewMode = useAppStore((s) => s.viewMode);
  const currentAccountId = useAppStore((s) => s.currentAccountId);

  const sourceEmailId =
    viewMode === "full" ? (focusedThreadEmailId ?? selectedEmailId) : selectedEmailId;
  const storeEmail = useMemo(
    () => emails.find((email) => email.id === sourceEmailId) ?? null,
    [emails, sourceEmailId],
  );
  const email = loadedEmailState?.id === sourceEmailId ? loadedEmailState.email : storeEmail;
  const accountId = email?.accountId ?? currentAccountId;
  const isLoadingEmail = loadingEmailId === sourceEmailId;

  useEffect(() => {
    if (isOpen) {
      setQuery("");
    } else {
      setLoadedEmailState(null);
      setLoadingEmailId(null);
      setOpeningAttachmentId(null);
      setPreviewAttachment(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!previewAttachment) return;

    const handlePreviewEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setPreviewAttachment(null);
    };

    window.addEventListener("keydown", handlePreviewEscape, true);
    return () => window.removeEventListener("keydown", handlePreviewEscape, true);
  }, [previewAttachment]);

  useEffect(() => {
    if (!isOpen || !sourceEmailId) {
      setLoadingEmailId(null);
      return;
    }

    if (storeEmail?.body) {
      setLoadedEmailState(null);
      setLoadingEmailId(null);
      return;
    }

    let cancelled = false;
    setLoadingEmailId(sourceEmailId);

    window.api.gmail
      .getEmail(sourceEmailId)
      .then((response: unknown) => {
        if (cancelled) return;

        const emailResponse = response as IpcResponse<DashboardEmail>;
        if (emailResponse.success && emailResponse.data.id === sourceEmailId) {
          setLoadedEmailState({ id: sourceEmailId, email: emailResponse.data });
        } else if (!emailResponse.success) {
          console.error("Failed to load email for openables:", emailResponse.error);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Failed to load email for openables:", error);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingEmailId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sourceEmailId, storeEmail?.body]);

  const openableItems = useMemo(() => buildOpenables(email), [email]);

  const filteredItems = useMemo(
    () => openableItems.filter((item) => itemMatches(item, query)),
    [openableItems, query],
  );

  // buildOpenables returns links before attachments, so the visible slice is
  // already in rendered (grouped) order — it doubles as the flat list that
  // data-index/selection/Enter operate on.
  const visibleItems = useMemo(
    () => filteredItems.slice(0, MAX_RENDERED_OPENABLE_ITEMS),
    [filteredItems],
  );

  const groupedItems = useMemo(() => {
    return {
      links: visibleItems.filter((item): item is OpenableLink => item.kind === "link"),
      attachments: visibleItems.filter(
        (item): item is OpenableAttachment => item.kind === "attachment",
      ),
    };
  }, [visibleItems]);

  const hiddenMatchCount = Math.max(filteredItems.length - visibleItems.length, 0);

  const { selectedIndex, setSelectedIndex, inputRef, listRef, moveSelection } = usePaletteSelection(
    { isOpen, query, itemCount: visibleItems.length },
  );

  // Reset selection when the palette switches to a different email
  useEffect(() => {
    setSelectedIndex(0);
  }, [sourceEmailId, setSelectedIndex]);

  const openAttachment = useCallback(
    async (attachment: OpenableAttachment["attachment"]) => {
      if (!email || !accountId || openingAttachmentId) return;

      setOpeningAttachmentId(attachment.id);
      try {
        if (isPreviewable(attachment.mimeType)) {
          const result = await window.api.attachments.preview(
            email.id,
            attachment.attachmentId,
            accountId,
          );
          if (result.success && result.data) {
            setPreviewAttachment({ attachment, data: result.data.data });
            return;
          }
        }

        await window.api.attachments.download(
          email.id,
          attachment.attachmentId,
          attachment.filename,
          accountId,
        );
      } catch (error) {
        console.error("Failed to open attachment:", error);
      } finally {
        setOpeningAttachmentId(null);
      }
    },
    [accountId, email, openingAttachmentId],
  );

  const executeItem = useCallback(
    (item: OpenableItem) => {
      if (item.kind === "link") {
        onClose();
        requestAnimationFrame(() => {
          window.open(item.url, "_blank", "noopener,noreferrer");
        });
        return;
      }

      void openAttachment(item.attachment);
    },
    [onClose, openAttachment],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const index = Number(event.key) - 1;
        const item = visibleItems[index];
        if (item) {
          executeItem(item);
        }
        return;
      }

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          if (previewAttachment) {
            setPreviewAttachment(null);
            return;
          }
          onClose();
          break;
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1);
          break;
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          if (visibleItems[selectedIndex]) {
            executeItem(visibleItems[selectedIndex]);
          }
          break;
      }
    },
    [executeItem, moveSelection, onClose, previewAttachment, selectedIndex, visibleItems],
  );

  if (!isOpen) return null;

  let flatIndex = 0;
  const hasItems = visibleItems.length > 0;

  const renderRows = (title: string, items: OpenableItem[]) => {
    if (items.length === 0) return null;

    return (
      <div key={title}>
        <div className="px-4 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
          {title}
        </div>
        {items.map((item) => {
          const index = flatIndex++;
          const isSelected = index === selectedIndex;
          const isOpening =
            item.kind === "attachment" && openingAttachmentId === item.attachment.id;
          const isDisabled = item.kind === "attachment" && openingAttachmentId !== null;

          return (
            <button
              key={item.id}
              data-index={index}
              type="button"
              disabled={isDisabled}
              aria-busy={isOpening || undefined}
              title={item.kind === "link" ? item.url : item.metadata}
              onClick={() => executeItem(item)}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`w-full px-4 py-2 flex items-center gap-3 text-left text-sm transition-colors ${
                isSelected
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                  : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              } ${isDisabled ? "cursor-wait opacity-70" : ""}`}
            >
              <RowIcon item={item} isSelected={isSelected} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium truncate">{item.label}</span>
                <span
                  className={`block text-xs truncate ${
                    isSelected
                      ? "text-blue-600 dark:text-blue-300"
                      : "text-gray-400 dark:text-gray-500"
                  }`}
                >
                  {item.metadata}
                </span>
              </span>
              {isOpening ? (
                <svg
                  className="w-4 h-4 animate-spin text-gray-400 dark:text-gray-500"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="2"
                    opacity="0.25"
                  />
                  <path
                    d="M4 12a8 8 0 018-8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              ) : index < 9 ? (
                <kbd className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded font-mono text-gray-500 dark:text-gray-400">
                  {formatPlatformShortcut(index + 1)}
                </kbd>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <>
      <PaletteShell label="Open Links & Attachments" onClose={onClose}>
        <PaletteHeader
          icon={
            <PaletteIcon
              path={ICONS.command}
              className="w-5 h-5 text-gray-400 flex-shrink-0"
              strokeWidth={2}
            />
          }
          inputRef={inputRef}
          query={query}
          onQueryChange={setQuery}
          onKeyDown={handleKeyDown}
          placeholder="Open Links & Attachments..."
          trailing={
            <kbd className="px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
              {OPEN_SHORTCUT}
            </kbd>
          }
        />

        <PaletteResults listRef={listRef}>
          {!hasItems ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {isLoadingEmail
                ? "Loading links and attachments..."
                : query
                  ? "No matching links or attachments"
                  : "No links or attachments"}
            </div>
          ) : (
            <>
              {renderRows("Links", groupedItems.links)}
              {renderRows("Attachments", groupedItems.attachments)}
              {hiddenMatchCount > 0 && (
                <div className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500">
                  {hiddenMatchCount} more {hiddenMatchCount === 1 ? "item" : "items"} match. Keep
                  typing to narrow.
                </div>
              )}
            </>
          )}
        </PaletteResults>

        <PaletteFooter enterLabel="open" />
      </PaletteShell>

      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment.attachment}
          data={previewAttachment.data}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </>
  );
}
