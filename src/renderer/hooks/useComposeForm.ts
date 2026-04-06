import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "../store";
import { useSignature } from "./useSignature";
import type { ComposeAttachmentItem } from "../components/AttachmentList";
import type { ReplyInfo, IpcResponse, ContactSuggestion, ComposeMode } from "../../shared/types";

/** Extract bare email from a potentially formatted "Name <email>" address. */
function extractBareEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>$/);
  return match ? match[1] : addr;
}

/** Build a name map from an array of potentially formatted addresses. */
function buildNameMapFromAddresses(addresses: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const addr of addresses) {
    const match = addr.match(/^(.+?)\s*<([^>]+)>$/);
    if (match) {
      map.set(match[2].toLowerCase(), match[1].trim());
    }
  }
  return map;
}

// Shared send options shape (subset of the IPC API)
export interface ComposeSendOptions {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    path?: string;
    content?: string;
    size: number;
  }>;
  /** Map of lowercase email → display name, used to format MIME addresses as "Name <email>" */
  recipientNames?: Record<string, string>;
  /** True when this is a forward, so reply-specific side effects are skipped */
  isForward?: boolean;
}

export interface UseComposeFormOptions {
  accountId: string;
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
  initialBodyHtml?: string;
  initialBodyText?: string;
  /** For replies/forwards: provides subject, threading headers, quoted body */
  replyInfo?: ReplyInfo | null;
  /** Whether this is a forward (strips threading headers from send) */
  isForward?: boolean;
  /** Actual compose mode for undo-send context (defaults based on replyInfo/isForward) */
  composeMode?: ComposeMode;
  /** Email ID being replied to, for undo-send restore */
  replyToEmailId?: string;
  /** Source for auto-loading forwarded attachments */
  forwardAttachmentSource?: { emailId: string; accountId: string };
}

export interface ComposeFormState {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

export function useComposeForm({
  accountId,
  initialTo = [],
  initialCc = [],
  initialBcc = [],
  initialSubject = "",
  initialBodyHtml = "",
  initialBodyText = "",
  replyInfo,
  isForward = false,
  composeMode: explicitComposeMode,
  replyToEmailId,
  forwardAttachmentSource,
}: UseComposeFormOptions) {
  const composeMode = explicitComposeMode ?? (isForward ? "forward" : replyInfo ? "reply" : "new");
  // --- Address state ---
  // initialTo may contain formatted addresses ("Name <email>") from draft
  // restoration. Extract bare emails for form state and display names for nameMap.
  const [to, setTo] = useState<string[]>(() => initialTo.map(extractBareEmail));
  const [cc, setCc] = useState<string[]>(() => initialCc.map(extractBareEmail));
  const [bcc, setBcc] = useState<string[]>(() => initialBcc.map(extractBareEmail));
  const [showCcBcc, setShowCcBcc] = useState(initialCc.length > 0 || initialBcc.length > 0);

  // Auto-expand CC/BCC if they get populated (e.g., async draft restoration)
  useEffect(() => {
    if ((cc.length > 0 || bcc.length > 0) && !showCcBcc) {
      setShowCcBcc(true);
    }
  }, [cc.length, bcc.length]); // intentionally omit showCcBcc to avoid re-triggering after manual toggle

  // --- Content state ---
  // For replies, subject comes from replyInfo and is not editable.
  // For new compose, subject is mutable via setSubject.
  const [subject, setSubject] = useState(replyInfo?.subject ?? initialSubject);
  const [bodyHtml, setBodyHtml] = useState(initialBodyHtml);
  const [bodyText, setBodyText] = useState(initialBodyText);

  // --- Name mapping (email → display name from autocomplete selections) ---
  // Pre-populate from formatted addresses in initialTo/initialCc/initialBcc
  const [nameMap, setNameMap] = useState(() =>
    buildNameMapFromAddresses([...initialTo, ...initialCc, ...initialBcc]),
  );
  const handleSuggestionSelected = useCallback((suggestion: ContactSuggestion) => {
    if (suggestion.name) {
      setNameMap((prev) => new Map(prev).set(suggestion.email.toLowerCase(), suggestion.name));
    }
  }, []);

  // --- Send state ---
  const [isSending, setIsSending] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Attachments ---
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachmentItem[]>([]);
  const [loadingForwardAttachments, setLoadingForwardAttachments] = useState(false);

  // Auto-load forwarded attachments
  useEffect(() => {
    if (!forwardAttachmentSource) return;
    let cancelled = false;
    setLoadingForwardAttachments(true);
    window.api.attachments
      .getForForward(forwardAttachmentSource.emailId, forwardAttachmentSource.accountId)
      .then(
        (result: IpcResponse<Array<{ filename: string; mimeType: string; content: string }>>) => {
          if (cancelled || !result.success || !result.data) return;
          setComposeAttachments(
            result.data.map((att, i) => ({
              id: `fwd-${i}-${att.filename}`,
              filename: att.filename,
              mimeType: att.mimeType,
              size: Math.ceil((att.content.length * 3) / 4),
              content: att.content,
            })),
          );
        },
      )
      .catch((err: unknown) => console.error("Failed to load forwarded attachments:", err))
      .finally(() => {
        if (!cancelled) setLoadingForwardAttachments(false);
      });
    return () => {
      cancelled = true;
    };
  }, [forwardAttachmentSource?.emailId, forwardAttachmentSource?.accountId]);

  const handlePickFiles = useCallback(async () => {
    try {
      const result = await window.api.attachments.pickFiles();
      if (result.success && result.data?.length) {
        const newAttachments: ComposeAttachmentItem[] = result.data.map(
          (f: { filename: string; path: string; mimeType: string; size: number }) => ({
            id: `local-${Date.now()}-${f.filename}`,
            filename: f.filename,
            mimeType: f.mimeType,
            size: f.size,
            path: f.path,
          }),
        );
        setComposeAttachments((prev) => [...prev, ...newAttachments]);
      }
    } catch (err) {
      console.error("Failed to pick files:", err);
    }
  }, []);

  const handleRemoveAttachment = useCallback((id: string) => {
    setComposeAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // --- Signature ---
  const { activeSignatureId, setActiveSignatureId, availableSignatures, signatureHtml } =
    useSignature(accountId);

  // --- Drag-and-drop between address fields ---
  const handleRecipientDrop = useCallback(
    (targetField: string, email: string, sourceField: string) => {
      const setters: Record<string, React.Dispatch<React.SetStateAction<string[]>>> = {
        to: setTo,
        cc: setCc,
        bcc: setBcc,
      };
      setters[sourceField]?.((prev) => prev.filter((e) => e !== email));
      setters[targetField]?.((prev) => {
        if (prev.some((e) => e.toLowerCase() === email.toLowerCase())) return prev;
        return [...prev, email];
      });
    },
    [],
  );

  const handleRecipientDragStart = useCallback(() => {
    setShowCcBcc(true);
  }, []);

  // --- @mention → add to Cc ---
  const handleMentionAddToCc = useCallback((email: string) => {
    setCc((prev) => {
      if (prev.some((e) => e.toLowerCase() === email.toLowerCase())) return prev;
      return [...prev, email];
    });
    setShowCcBcc(true);
  }, []);

  // --- Editor onChange ---
  const handleEditorChange = useCallback((html: string, text: string) => {
    setBodyHtml(html);
    setBodyText(text);
  }, []);

  // --- Build send options ---
  const buildSendOptions = useCallback((): ComposeSendOptions => {
    const bodyWithSignature = signatureHtml ? `${bodyHtml}${signatureHtml}` : bodyHtml;
    const fullBodyHtml = replyInfo?.quotedBody
      ? `${bodyWithSignature}${replyInfo.quotedBody}`
      : bodyWithSignature;

    const sendAttachments =
      composeAttachments.length > 0
        ? composeAttachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            path: a.path,
            content: a.content,
            size: a.size,
          }))
        : undefined;

    // Convert nameMap to a plain object for IPC serialization
    const recipientNames = nameMap.size > 0 ? Object.fromEntries(nameMap) : undefined;

    return {
      accountId,
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      subject,
      bodyHtml: fullBodyHtml,
      bodyText,
      threadId: replyInfo?.threadId,
      inReplyTo: replyInfo?.inReplyTo,
      references: replyInfo?.references,
      attachments: sendAttachments,
      recipientNames,
      isForward: isForward || undefined,
    };
  }, [
    accountId,
    to,
    cc,
    bcc,
    subject,
    bodyHtml,
    bodyText,
    signatureHtml,
    replyInfo,
    isForward,
    composeAttachments,
    nameMap,
  ]);

  // --- Send ---
  const send = useCallback(async (): Promise<
    IpcResponse<{ id: string; threadId: string }> | "undo-queued" | null
  > => {
    const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    if (isSending || (!bodyText.trim() && !subject.trim()) || !hasAnyRecipient) return null;

    const sendOptions = buildSendOptions();

    // Check for undo send delay
    const { undoSendDelaySeconds, addUndoSend } = useAppStore.getState();
    if (undoSendDelaySeconds > 0) {
      addUndoSend({
        id: crypto.randomUUID(),
        sendOptions,
        recipients: to.join(", "),
        scheduledAt: Date.now(),
        delayMs: undoSendDelaySeconds * 1000,
        composeContext: {
          mode: composeMode,
          replyToEmailId,
          threadId: replyInfo?.threadId,
          bodyHtml,
          bodyText,
          to,
          cc: cc.length > 0 ? cc : undefined,
          bcc: bcc.length > 0 ? bcc : undefined,
          subject,
        },
      });
      return "undo-queued";
    }

    // No delay — send immediately
    setIsSending(true);
    setError(null);

    try {
      const response = await window.api.compose.send(sendOptions);
      if (!response.success) {
        setError(response.error || "Failed to send");
      }
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
      return null;
    } finally {
      setIsSending(false);
    }
  }, [
    isSending,
    bodyText,
    subject,
    to,
    cc,
    bcc,
    bodyHtml,
    buildSendOptions,
    isForward,
    replyInfo,
    composeMode,
    replyToEmailId,
  ]);

  // --- Schedule send ---
  const scheduleSend = useCallback(
    async (scheduledAt: number): Promise<boolean> => {
      const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
      if (isScheduling || (!bodyText.trim() && !subject.trim()) || !hasAnyRecipient) return false;

      setIsScheduling(true);
      setError(null);

      try {
        const sendOptions = buildSendOptions();
        const response = await window.api.scheduledSend.create({
          ...sendOptions,
          scheduledAt,
        });

        if (response.success) {
          return true;
        } else {
          setError(response.error || "Failed to schedule");
          return false;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to schedule");
        return false;
      } finally {
        setIsScheduling(false);
      }
    },
    [isScheduling, bodyText, subject, to, cc, bcc, buildSendOptions],
  );

  // --- Computed ---
  const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
  const hasContent = !!bodyText.trim() || !!subject.trim();
  const canSend = hasAnyRecipient && hasContent;

  // --- Form state snapshot ---
  const getFormState = useCallback(
    (): ComposeFormState => ({
      to,
      cc,
      bcc,
      subject,
      bodyHtml,
      bodyText,
    }),
    [to, cc, bcc, subject, bodyHtml, bodyText],
  );

  return {
    // Address state
    to,
    setTo,
    cc,
    setCc,
    bcc,
    setBcc,
    showCcBcc,
    setShowCcBcc,
    nameMap,
    handleSuggestionSelected,
    handleRecipientDrop,
    handleRecipientDragStart,
    handleMentionAddToCc,

    // Content state
    subject,
    setSubject,
    bodyHtml,
    bodyText,
    handleEditorChange,

    // Send state
    isSending,
    isScheduling,
    error,
    setError,
    send,
    scheduleSend,
    canSend,
    buildSendOptions,

    // Attachments
    composeAttachments,
    loadingForwardAttachments,
    handlePickFiles,
    handleRemoveAttachment,

    // Signature
    activeSignatureId,
    setActiveSignatureId,
    availableSignatures,

    // Utilities
    getFormState,
  };
}
