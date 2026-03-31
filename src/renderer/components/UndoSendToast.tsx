import { useEffect, useRef, useState, useCallback } from "react";
import { useAppStore, type UndoSendItem } from "../store";

// Map of item ID → cancel function, so the parent (or keyboard shortcut) can
// trigger a clean undo on any queued item without race conditions.
const cancelHandlers = new Map<string, () => void>();

function UndoSendToastItem({ item }: { item: UndoSendItem }) {
  const removeUndoSend = useAppStore((s) => s.removeUndoSend);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentRef = useRef(false);

  const doSend = useCallback(async () => {
    if (sentRef.current) return;
    sentRef.current = true;

    try {
      const response = await window.api.compose.send(item.sendOptions);
      if (!response.success) {
        setSendError(response.error);
        sentRef.current = false;
        return;
      }

      // Replace the optimistic "pending-*" email with the real Gmail ID so
      // background sync won't add a duplicate when it discovers the same message.
      // Done as a single atomic setState to prevent intermediate states where the
      // email is removed but not yet re-added (which would unmount any inline
      // reply editor attached to it).
      const ctx = item.composeContext;
      if (ctx?.optimisticEmailId && response.data?.id && !response.data.queued) {
        const state = useAppStore.getState();
        const optimistic = state.emails.find(e => e.id === ctx.optimisticEmailId);
        if (optimistic) {
          useAppStore.setState((s) => ({
            emails: [
              ...s.emails.filter(e => e.id !== ctx.optimisticEmailId),
              { ...optimistic, id: response.data!.id },
            ],
            // Update focusedThreadEmailId so subsequent Reply All clicks
            // don't target the now-removed optimistic email
            ...(s.focusedThreadEmailId === ctx.optimisticEmailId
              ? { focusedThreadEmailId: response.data!.id }
              : {}),
            // Update inlineReplyToEmailId so the InlineReply component doesn't
            // unmount when the optimistic email it's targeting gets replaced
            ...(s.inlineReplyToEmailId === ctx.optimisticEmailId
              ? { inlineReplyToEmailId: response.data!.id }
              : {}),
          }));
        }
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send");
      sentRef.current = false;
      return;
    }
    cancelHandlers.delete(item.id);
    removeUndoSend(item.id);
  }, [item, removeUndoSend]);

  const handleUndo = useCallback(() => {
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sentRef.current = true; // prevent race
    cancelHandlers.delete(item.id);

    // Reopen compose with the draft content so the user can edit and re-send
    const ctx = item.composeContext;
    if (ctx) {
      const store = useAppStore.getState();
      // Remove the optimistic "sent" email from the store
      if (ctx.optimisticEmailId) {
        store.removeEmails([ctx.optimisticEmailId]);
      }
      if (ctx.threadId) {
        store.setSelectedThreadId(ctx.threadId);
      }
      if (ctx.replyToEmailId) {
        store.setSelectedEmailId(ctx.replyToEmailId);
      }
      store.setViewMode("full");
      store.openCompose(ctx.mode, ctx.replyToEmailId, {
        from: ctx.from,
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
    cancelHandlers.set(item.id, handleUndo);
    return () => { cancelHandlers.delete(item.id); };
  }, [item.id, handleUndo]);

  useEffect(() => {
    const endTime = item.scheduledAt + item.delayMs;
    const remaining = Math.max(0, endTime - Date.now());

    sendTimerRef.current = setTimeout(() => {
      doSend();
    }, remaining);

    return () => {
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    };
  }, [item, doSend]);

  return (
    <div className="bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg flex items-center justify-between px-4 py-3 min-w-[280px]">
      <span className="text-sm">
        {sendError ? (
          <span className="text-red-400">{sendError}</span>
        ) : (
          "Message sent."
        )}
      </span>
      {!sentRef.current && !sendError && (
        <button
          onClick={handleUndo}
          className="ml-4 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
          title={navigator.platform.includes("Mac") ? "Cmd+Z" : "Ctrl+Z"}
        >
          Undo
        </button>
      )}
      {sendError && (
        <button
          onClick={() => {
            setSendError(null);
            sentRef.current = false;
            doSend();
          }}
          className="ml-4 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
        >
          Retry
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
