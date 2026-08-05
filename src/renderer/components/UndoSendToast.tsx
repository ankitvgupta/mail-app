import { useEffect, useState, useCallback } from "react";
import { useAppStore, type UndoSendItem } from "../store";

// Map of item ID → cancel function, so the parent (or keyboard shortcut) can
// trigger a clean undo on any queued item without race conditions.
const cancelHandlers = new Map<string, () => void>();

type CancelResponse = {
  success: boolean;
  data?: { composeContext?: string; cancelled: boolean };
  error?: string;
};

function UndoSendToastItem({ item }: { item: UndoSendItem }) {
  const removeUndoSend = useAppStore((s) => s.removeUndoSend);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // The send itself is owned by the main process, so the only local state that
  // matters is whether the undo window has visually elapsed.
  const [elapsed, setElapsed] = useState(() => Date.now() >= item.scheduledAt + item.delayMs);

  const handleUndo = useCallback(async () => {
    const response = (await window.api.scheduledSend.cancel(item.id)) as CancelResponse;

    if (!response.success) {
      setCancelError(response.error || "Failed to undo");
      return;
    }

    // Lost the race — the message was already sent. Say so rather than
    // reopening compose, which would imply the send was recalled.
    if (!response.data?.cancelled) {
      setElapsed(true);
      return;
    }

    cancelHandlers.delete(item.id);

    // Reopen compose with the draft content so the user can edit and re-send
    const ctx = item.composeContext;
    if (ctx) {
      const store = useAppStore.getState();
      // Remove the optimistic "sent" email from the store. focusedThreadEmailId /
      // inlineReplyToEmailId may point at the optimistic ID; null them in the
      // same setState as the removal to avoid a render that observes a dangling
      // reference.
      if (ctx.optimisticEmailId) {
        const optimisticId = ctx.optimisticEmailId;
        useAppStore.setState((s) => ({
          emails: s.emails.filter((e) => e.id !== optimisticId),
          ...(s.focusedThreadEmailId === optimisticId ? { focusedThreadEmailId: null } : {}),
          ...(s.inlineReplyToEmailId === optimisticId ? { inlineReplyToEmailId: null } : {}),
        }));
      }
      if (ctx.threadId) {
        store.setSelectedThreadId(ctx.threadId);
      }
      if (ctx.replyToEmailId) {
        store.setSelectedEmailId(ctx.replyToEmailId);
      }
      store.setViewMode("full");
      store.openCompose(ctx.mode, ctx.replyToEmailId, {
        bodyHtml: ctx.bodyHtml,
        bodyText: ctx.bodyText,
        to: ctx.to,
        cc: ctx.cc,
        bcc: ctx.bcc,
        subject: ctx.subject,
      });
    }

    removeUndoSend(item.id);
  }, [item, removeUndoSend]);

  // Register cancel handler so parent / keyboard shortcut can trigger undo
  useEffect(() => {
    cancelHandlers.set(item.id, () => void handleUndo());
    return () => {
      cancelHandlers.delete(item.id);
    };
  }, [item.id, handleUndo]);

  // Hide the Undo affordance once the delay has passed. The send fires in main
  // regardless of this timer, so it only drives presentation.
  useEffect(() => {
    const remaining = item.scheduledAt + item.delayMs - Date.now();
    if (remaining <= 0) {
      setElapsed(true);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), remaining);
    return () => clearTimeout(timer);
  }, [item.scheduledAt, item.delayMs]);

  return (
    <div className="bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg flex items-center justify-between px-4 py-3 min-w-[280px]">
      <span className="text-sm">
        {cancelError ? <span className="text-red-400">{cancelError}</span> : "Message sent."}
      </span>
      {!elapsed && !cancelError && (
        <button
          onClick={() => void handleUndo()}
          className="ml-4 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
          title={navigator.platform.includes("Mac") ? "Cmd+Z" : "Ctrl+Z"}
        >
          Undo
        </button>
      )}
    </div>
  );
}

export function UndoSendToast() {
  const undoSendQueue = useAppStore((s) => s.undoSendQueue);

  // Cmd+Z / Ctrl+Z undoes the most recent pending send
  useEffect(() => {
    if (undoSendQueue.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        const queue = useAppStore.getState().undoSendQueue;
        if (queue.length === 0) return;

        const lastItem = queue[queue.length - 1];
        const cancel = cancelHandlers.get(lastItem.id);
        if (cancel) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancel();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undoSendQueue.length]);

  if (undoSendQueue.length === 0) return null;

  return (
    <>
      {undoSendQueue.map((item) => (
        <UndoSendToastItem key={item.id} item={item} />
      ))}
    </>
  );
}
