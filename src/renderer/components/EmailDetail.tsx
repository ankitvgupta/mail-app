import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useAppStore, useSplitFilteredThreads } from "../store";
import DOMPurify from "dompurify";
import {
  emailBodyCache,
  isHtmlContent,
  hasRichBackground,
  stripLargeDataUris,
} from "../services/email-body-cache";
import { splitAddressList, extractFirstName } from "../utils/address-parsing";
import { splitQuotedContent } from "../services/quote-elision";
import { ComposeEditor } from "./ComposeEditor";
import { formatSnoozeTime } from "./SnoozeMenu";
import { AddressInput } from "./AddressInput";
import {
  EmailAttachmentList,
  ComposeAttachmentList,
  AttachmentPreviewModal,
} from "./AttachmentList";
import type {
  DashboardEmail,
  ReplyInfo,
  IpcResponse,
  ComposeMode,
  AttachmentMeta,
  LocalDraft,
  Memory,
  MemoryScope,
} from "../../shared/types";
import type { RestoredDraft } from "../store";
import { useComposeForm } from "../hooks/useComposeForm";
import { THREAD_NAV_EVENT } from "../hooks/useKeyboardShortcuts";
import type { ComposeFormState } from "../hooks/useComposeForm";
import { ComposeToolbar } from "./ComposeToolbar";
import { trackEvent } from "../services/posthog";
import { draftBodyToHtml } from "../../shared/draft-utils";
import { AnalysisPrioritySection } from "./AnalysisPrioritySection";

declare global {
  interface Window {
    api: {
      compose: {
        send: (options: {
          accountId: string;
          to: string[];
          cc?: string[];
          bcc?: string[];
          subject: string;
          bodyText?: string;
          bodyHtml?: string;
          threadId?: string;
          inReplyTo?: string;
          references?: string;
        }) => Promise<IpcResponse<{ id: string; threadId: string }>>;
        getReplyInfo: (
          emailId: string,
          mode: "reply" | "reply-all" | "forward" | "new",
          accountId: string,
        ) => Promise<IpcResponse<ReplyInfo | null>>;
      };
      contacts: {
        suggest: (
          query: string,
          limit?: number,
          // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        ) => Promise<IpcResponse<import("../../shared/types").ContactSuggestion[]>>;
      };
      sync: {
        now: (accountId: string) => Promise<void>;
      };
      memory: {
        save: (params: {
          accountId: string;
          scope: string;
          scopeValue?: string | null;
          content: string;
          source?: string;
          sourceEmailId?: string;
        }) => Promise<IpcResponse<Memory>>;
        classify: (params: {
          content: string;
          senderEmail: string;
          senderDomain: string;
        }) => Promise<
          IpcResponse<{ scope: MemoryScope; scopeValue: string | null; content: string }>
        >;
      };
      analysis: {
        overridePriority: (
          emailId: string,
          newNeedsReply: boolean,
          newPriority: string | null,
          reason?: string,
        ) => Promise<IpcResponse<{ analysisUpdated: boolean }>>;
      };
    };
  }
}

/**
 * Escape HTML entities for safe display in quoted content.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse a comma-separated address header into an array of bare email addresses.
 */
function parseAddressList(header: string): string[] {
  return header
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      const match = s.match(/<([^>]+)>/);
      return match ? match[1] : s;
    })
    .filter(Boolean);
}

/**
 * Compute ReplyInfo locally from a DashboardEmail without any IPC call.
 * This mirrors the logic from compose.ipc.ts extractReplyInfo but runs entirely
 * in the renderer process using data already in the store, so the reply pane
 * can open instantly. The inReplyTo/references fields use the email ID as a
 * placeholder — they get patched with proper Gmail Message-ID headers via
 * an async IPC call after the pane is already visible.
 */
function computeLocalReplyInfo(
  email: DashboardEmail,
  mode: ComposeMode,
  userEmail?: string,
): ReplyInfo {
  const fromMatch = email.from.match(/<([^>]+)>/) || [null, email.from];
  const fromEmail = fromMatch[1] || email.from;

  const toAddresses = parseAddressList(email.to);
  const ccAddresses = email.cc ? parseAddressList(email.cc) : [];

  const cc: string[] = [];
  if (mode === "reply-all") {
    const exclude = new Set([fromEmail.toLowerCase()]);
    if (userEmail) exclude.add(userEmail.toLowerCase());

    const seen = new Set<string>();
    for (const addr of [...toAddresses, ...ccAddresses]) {
      const lower = addr.toLowerCase();
      if (!exclude.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        cc.push(addr);
      }
    }
  }

  let subject = email.subject;
  if (mode === "forward") {
    if (!subject.toLowerCase().startsWith("fwd:")) {
      subject = `Fwd: ${subject}`;
    }
  } else {
    if (!subject.toLowerCase().startsWith("re:")) {
      subject = `Re: ${subject}`;
    }
  }

  const dateStr = new Date(email.date).toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const escapedFrom = escapeHtml(email.from);
  const escapedSubject = escapeHtml(email.subject);
  const escapedTo = escapeHtml(email.to);

  const originalBody = email.body ?? "";

  let quotedBody: string;
  let attribution: string;

  if (mode === "forward") {
    let attachmentLine = "";
    if (email.attachments?.length) {
      const names = email.attachments.map((a) => escapeHtml(a.filename)).join(", ");
      attachmentLine = `<br>Attachments: ${names}`;
    }
    attribution = `---------- Forwarded message ---------<br>From: <strong>${escapedFrom}</strong><br>Date: ${dateStr}<br>Subject: ${escapedSubject}<br>To: ${escapedTo}${attachmentLine}`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><br><br>${originalBody}</div>`;
  } else {
    attribution = `On ${dateStr}, ${escapedFrom} wrote:`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${originalBody}</blockquote></div>`;
  }

  return {
    to: mode === "forward" ? [] : [fromEmail],
    cc,
    subject,
    threadId: email.threadId,
    inReplyTo: email.id,
    references: email.id,
    quotedBody,
    originalBody,
    attribution,
    ...(mode === "forward" &&
      email.attachments?.length && {
        forwardedAttachments: email.attachments,
      }),
  };
}

// isHtmlContent and hasRichBackground are imported from email-body-cache.ts
// isPlainTextInHtml is internal to the cache (only needed for sanitization)

/**
 * Renders email body content - for expanded view, no max height.
 * useLightMode: when true, renders with dark text on transparent bg (for white card containers).
 * When false, renders with light text on dark bg (for dark card containers).
 */
function EmailBodyRenderer({
  emailId,
  body,
  useLightMode,
}: {
  emailId: string;
  body: string;
  useLightMode: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(200);

  // Use the LRU cache to avoid re-running DOMPurify on every email switch.
  // On cache hit this is a Map lookup; on miss it sanitizes and caches the result.
  const cached = useMemo(
    () => emailBodyCache.getOrCompute(emailId, body, useLightMode),
    [emailId, body, useLightMode],
  );
  const isHtml = cached.isHtml;
  const htmlContent = cached.isHtml ? cached.htmlContent : null;

  // Decode HTML entities for the plain text fallback. Also detects entity-encoded
  // HTML bodies (e.g. `&lt;html&gt;...`) that slipped past the initial isHtmlContent
  // check — the decoded result will contain real `<html>` tags.
  const decodedBody = useMemo(() => {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = body;
    return textarea.value;
  }, [body]);

  // Re-sanitize entity-decoded content that turns out to be HTML.
  // This handles the case where the body arrives entity-encoded (e.g. from
  // a Gmail API text/plain fallback that contains HTML source), so
  // isHtmlContent(body) returns false but isHtmlContent(decodedBody) is true.
  const recoveredHtml = useMemo(() => {
    if (isHtml || !decodedBody || !isHtmlContent(decodedBody)) return null;
    return emailBodyCache.getOrCompute(`${emailId}:recovered`, decodedBody, useLightMode);
  }, [isHtml, decodedBody, emailId, useLightMode]);

  const shouldRenderIframe =
    (isHtml && htmlContent) || (recoveredHtml?.isHtml && recoveredHtml.htmlContent);
  const iframeSrcDoc = isHtml ? htmlContent : recoveredHtml?.htmlContent;

  // Prefetch external images from the sanitized HTML so they're in the
  // browser HTTP cache by the time the iframe renders. Runs on the
  // DOMPurify output to avoid loading images from stripped contexts
  // (e.g. HTML comments containing tracking pixels).
  useEffect(() => {
    if (!iframeSrcDoc) return;
    const srcRegex = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
    let match;
    while ((match = srcRegex.exec(iframeSrcDoc)) !== null) {
      const img = new Image();
      img.src = match[1];
    }
  }, [iframeSrcDoc]);

  useEffect(() => {
    if (!iframeRef.current || !shouldRenderIframe || !iframeSrcDoc) return;

    const iframe = iframeRef.current;
    let attachedDoc: Document | null = null;

    const adjustHeight = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc && doc.body) {
          const height = doc.body.scrollHeight;
          setIframeHeight(height + 20);
        }
      } catch {
        // Cross-origin issues - use default height
      }
    };

    // Forward keyboard events from the iframe to the parent window.
    // When an iframe has focus, keydown events fire inside it and never reach
    // the parent — breaking shortcuts like Escape and Enter.  Since the iframe
    // uses srcdoc (same-origin), we can attach a listener to its document
    // directly and dispatch a synthetic KeyboardEvent on the parent window.
    const iframeKeydownHandler = (e: KeyboardEvent) => {
      // Let modifier combos (Cmd+C, Cmd+V, etc.) work natively in the iframe
      if (e.metaKey || e.ctrlKey) {
        // Only forward Cmd+K and Cmd+, which are app-level shortcuts
        if (e.key !== "k" && e.key !== ",") return;
      }
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: e.key,
          code: e.code,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    const attachKeyboardForwarding = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) return;
        // Remove previous listener if re-attaching (e.g. iframe reload)
        if (attachedDoc) {
          attachedDoc.removeEventListener("keydown", iframeKeydownHandler);
        }
        attachedDoc = doc;
        doc.addEventListener("keydown", iframeKeydownHandler);
      } catch {
        // Cross-origin iframe — can't attach listener, shortcuts won't work
      }
    };

    // srcDoc iframes can load synchronously before this effect runs,
    // so attach immediately if the iframe is already loaded.
    if (iframe.contentDocument?.readyState === "complete") {
      adjustHeight();
      attachKeyboardForwarding();
    }

    iframe.onload = () => {
      adjustHeight();
      attachKeyboardForwarding();
      setTimeout(adjustHeight, 300);
      setTimeout(adjustHeight, 1000);
    };

    return () => {
      if (attachedDoc) {
        attachedDoc.removeEventListener("keydown", iframeKeydownHandler);
      }
    };
  }, [iframeSrcDoc, shouldRenderIframe]);

  if (shouldRenderIframe && iframeSrcDoc) {
    return (
      <iframe
        ref={iframeRef}
        srcDoc={iframeSrcDoc}
        referrerPolicy="no-referrer"
        style={{
          width: "100%",
          height: `${iframeHeight}px`,
          border: "none",
          display: "block",
        }}
        title="Email content"
      />
    );
  }

  return (
    <div
      className={`whitespace-pre-wrap text-sm leading-relaxed ${useLightMode ? "text-gray-700" : "text-gray-300"}`}
    >
      {decodedBody}
    </div>
  );
}

// ===== Package Tracking Detection =====

interface TrackingInfo {
  carrier: string;
  trackingNumber: string;
  url: string;
}

function detectTrackingNumbers(bodies: string[]): TrackingInfo[] {
  const combined = bodies.map((b) => b.replace(/<[^>]*>/g, " ")).join(" ");
  const results: TrackingInfo[] = [];
  const seen = new Set<string>();

  const addMatch = (carrier: string, num: string, url: string) => {
    if (!seen.has(num)) {
      seen.add(num);
      results.push({ carrier, trackingNumber: num, url });
    }
  };

  // UPS: 1Z + 16 alphanumeric (very distinctive)
  for (const m of combined.matchAll(/\b1Z[A-Z0-9]{16}\b/gi)) {
    addMatch(
      "UPS",
      m[0].toUpperCase(),
      `https://www.ups.com/track?tracknum=${encodeURIComponent(m[0])}`,
    );
  }

  // USPS: distinctive prefixes + 18 digits
  for (const m of combined.matchAll(/\b(?:9400|9205|9270|9261|9202|9407|9303)\d{18}\b/g)) {
    addMatch("USPS", m[0], `https://tools.usps.com/go/TrackConfirmAction?tLabels=${m[0]}`);
  }

  // USPS international: 2 letters + 9 digits + US
  for (const m of combined.matchAll(/\b[A-Z]{2}\d{9}US\b/g)) {
    addMatch("USPS", m[0], `https://tools.usps.com/go/TrackConfirmAction?tLabels=${m[0]}`);
  }

  // FedEx: distinctive prefixes (96 + 20 digits, 61 + 18 digits)
  for (const m of combined.matchAll(/\b(?:96\d{20}|61\d{18})\b/g)) {
    addMatch("FedEx", m[0], `https://www.fedex.com/fedextrack/?trknbr=${m[0]}`);
  }

  // FedEx: 12 or 15 digit numbers only when "FedEx" appears in the email
  if (/fedex/i.test(combined)) {
    for (const m of combined.matchAll(/(?<!\d)\d{12}(?!\d)/g)) {
      addMatch("FedEx", m[0], `https://www.fedex.com/fedextrack/?trknbr=${m[0]}`);
    }
    for (const m of combined.matchAll(/(?<!\d)\d{15}(?!\d)/g)) {
      addMatch("FedEx", m[0], `https://www.fedex.com/fedextrack/?trknbr=${m[0]}`);
    }
  }

  // DHL: 10 digit numbers only when "DHL" appears in the email
  if (/\bDHL\b/i.test(combined)) {
    for (const m of combined.matchAll(/(?<!\d)\d{10}(?!\d)/g)) {
      addMatch(
        "DHL",
        m[0],
        `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${m[0]}`,
      );
    }
  }

  // Amazon Logistics: TBA + 12-15 digits
  for (const m of combined.matchAll(/\bTBA\d{12,15}\b/g)) {
    addMatch("Amazon", m[0], `https://www.amazon.com/progress-tracker/package?trackingId=${m[0]}`);
  }

  return results;
}

// ===== Unsubscribe Link Detection =====

function detectUnsubscribeUrl(bodies: string[]): string | null {
  // Search from latest email backwards (most recent unsubscribe link is most relevant)
  for (let i = bodies.length - 1; i >= 0; i--) {
    const body = bodies[i];

    // Match <a> tags where href or link text contains "unsubscribe"
    const linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(body)) !== null) {
      const href = match[1];
      const text = match[2].replace(/<[^>]*>/g, "");
      if (/unsubscribe/i.test(href) || /unsubscribe/i.test(text)) {
        if (href.startsWith("http://") || href.startsWith("https://")) {
          return href;
        }
      }
    }
  }
  return null;
}

/**
 * Renders an address list (From, To, Cc, Bcc) with Superhuman-style name display.
 * Default: shows just names. Double-click toggles to show full name + email.
 * If only a bare email is available, shows the email always.
 */
function AddressField({
  header,
  useWhiteCard,
  forceExpanded,
  nameMap,
}: {
  header: string;
  useWhiteCard: boolean;
  forceExpanded?: boolean;
  nameMap?: Map<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);

  const parsed = useMemo(() => {
    return splitAddressList(header).map((part) => {
      const trimmed = part.trim();
      const nameMatch = trimmed.match(/^([^<]+)<([^>]+)>/);
      if (nameMatch) {
        const name = nameMatch[1].trim().replace(/"/g, "");
        const email = nameMatch[2].trim();
        return { name: name || null, email, raw: trimmed };
      }
      // Bare email address — try to resolve name from thread context
      const bareEmail = trimmed;
      const resolvedName = nameMap?.get(bareEmail.toLowerCase()) ?? null;
      return { name: resolvedName, email: bareEmail, raw: trimmed };
    });
  }, [header, nameMap]);

  // All bare emails — no toggle needed
  const allBare = parsed.every((p) => !p.name);
  const showExpanded = forceExpanded || expanded;

  if (forceExpanded) {
    // Always show "Name <email>" with bold name, no toggle
    return (
      <span
        className={`select-all ${useWhiteCard ? "text-gray-700" : "text-gray-700 dark:text-gray-300"}`}
      >
        {parsed.map((p, i) => (
          <React.Fragment key={`${p.email}-${i}`}>
            {i > 0 && ", "}
            {p.name ? (
              <>
                <span className="font-medium">{p.name}</span> &lt;{p.email}&gt;
              </>
            ) : (
              p.email
            )}
          </React.Fragment>
        ))}
      </span>
    );
  }

  const display = parsed
    .map((p) => {
      if (!p.name) return p.email;
      return showExpanded ? `${p.name} <${p.email}>` : p.name;
    })
    .join(", ");

  const toggle = allBare ? undefined : () => setExpanded((v) => !v);

  return (
    <span
      className={`select-all ${!allBare ? "cursor-pointer" : ""} ${
        useWhiteCard ? "text-gray-700" : "text-gray-700 dark:text-gray-300"
      }`}
      role={allBare ? undefined : "button"}
      tabIndex={allBare ? undefined : 0}
      onDoubleClick={toggle}
      onKeyDown={
        allBare
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle!();
              }
            }
      }
      title={
        allBare
          ? undefined
          : showExpanded
            ? "Double-click to show names only"
            : "Double-click to show email addresses"
      }
    >
      {display}
      {!allBare && !showExpanded && (
        <svg
          className={`inline-block ml-1 w-3 h-3 opacity-0 group-hover/addr:opacity-60 transition-opacity ${
            useWhiteCard ? "text-gray-400" : "text-gray-400 dark:text-gray-500"
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      )}
    </span>
  );
}

/** Split an RFC 2822 address list, respecting commas inside quotes, angle brackets, and comments */
/** Build a map of email address → display name from all headers in a thread */
function buildNameMap(threadEmails: DashboardEmail[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of threadEmails) {
    // Extract from all address headers (from, to, cc, bcc)
    for (const header of [e.from, e.to, e.cc || "", e.bcc || ""]) {
      for (const part of splitAddressList(header)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const nameMatch = trimmed.match(/^([^<]+)<([^>]+)>/);
        if (nameMatch) {
          const name = nameMatch[1].trim().replace(/"/g, "");
          const addr = nameMatch[2].trim().toLowerCase();
          if (name && !map.has(addr)) map.set(addr, name);
        }
      }
    }
  }
  return map;
}

const firstName = extractFirstName;

function parseRecipientFirstNames(
  header: string,
  currentUserEmail?: string,
  nameMap?: Map<string, string>,
): string[] {
  if (!header) return [];
  return splitAddressList(header).map((r) => {
    const nameMatch = r.match(/^([^<]+)</);
    const emailMatch = r.match(/<([^>]+)>/)?.[1] || r.trim();
    if (currentUserEmail && emailMatch.toLowerCase() === currentUserEmail.toLowerCase())
      return "Me";
    if (nameMatch) {
      const extracted = firstName(nameMatch[1].trim().replace(/"/g, ""));
      if (!extracted.includes("@")) return extracted;
      // Name part is actually an email address — fall through to nameMap lookup
    }
    if (nameMap) {
      const resolved = nameMap.get(emailMatch.toLowerCase());
      if (resolved) return firstName(resolved);
    }
    return emailMatch;
  });
}

/** Join names with commas and & for the last one, with overflow */
function joinNames(names: string[], maxVisible = 6): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  if (names.length <= maxVisible)
    return names.slice(0, -1).join(", ") + ` & ${names[names.length - 1]}`;
  const remaining = names.length - maxVisible;
  return (
    names.slice(0, maxVisible).join(", ") +
    ` & ${remaining} ${remaining === 1 ? "other" : "others"}`
  );
}

/** Build full Superhuman-style header: "Sarah to Mike & Jake" or "Me to Sarah. Bcc: Me" */
function formatMessageHeader(
  email: DashboardEmail,
  currentUserEmail?: string,
  nameMap?: Map<string, string>,
): string {
  const senderMatch = email.from.match(/^([^<]+)/);
  const senderEmail = email.from.match(/<([^>]+)>/)?.[1] || email.from.trim();
  const isFromMe = currentUserEmail && senderEmail.toLowerCase() === currentUserEmail.toLowerCase();
  const senderFirst = isFromMe
    ? "Me"
    : senderMatch
      ? firstName(senderMatch[1].trim().replace(/"/g, ""))
      : email.from;

  const toNames = parseRecipientFirstNames(email.to, currentUserEmail, nameMap);
  const ccNames = email.cc ? parseRecipientFirstNames(email.cc, currentUserEmail, nameMap) : [];
  const all = [...toNames, ...ccNames];

  // Check if current user is in BCC
  const bccNames = email.bcc ? parseRecipientFirstNames(email.bcc, currentUserEmail, nameMap) : [];
  const meInBcc = bccNames.includes("Me");
  // Non-"Me" bcc recipients (you typically only see your own BCC)
  const otherBcc = bccNames.filter((n) => n !== "Me");

  let result = senderFirst;
  if (all.length > 0) result += ` to ${joinNames(all)}`;

  // Append Bcc segment
  const bccParts = [...otherBcc, ...(meInBcc ? ["Me"] : [])];
  if (bccParts.length > 0) result += `. Bcc: ${joinNames(bccParts)}`;

  return result;
}

// Superhuman-style thread message
function ThreadMessage({
  email,
  isExpanded,
  isFocused,
  onToggle,
  onReply,
  onReplyAll,
  onForward,
  currentUserEmail,
  accountId,
  threadEmails,
  onPreviewAttachment,
}: {
  email: DashboardEmail;
  isExpanded: boolean;
  isFocused: boolean;
  onToggle: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  currentUserEmail?: string;
  accountId?: string;
  threadEmails: DashboardEmail[];
  onPreviewAttachment?: (attachment: AttachmentMeta, data: string) => void;
}) {
  // Build name lookup from thread context (resolves bare emails to display names)
  const nameMap = useMemo(() => buildNameMap(threadEmails), [threadEmails]);

  // Extract sender info
  const senderMatch = email.from.match(/^([^<]+)/);
  const senderName = senderMatch ? senderMatch[1].trim().replace(/"/g, "") : email.from;
  const senderEmail = email.from.match(/<([^>]+)>/)?.[1] || email.from;

  // Check if this is from current user
  const isFromMe = currentUserEmail && senderEmail.toLowerCase() === currentUserEmail.toLowerCase();

  // Format date
  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        month: "numeric",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  const resolvedTheme = useAppStore((s) => s.resolvedTheme);
  const isDark = resolvedTheme === "dark";

  // Strip large inline data: URIs (multi-MB base64 images) ONCE so all
  // downstream processing (DOMParser, DOMPurify, iframe) operates on a
  // lightweight body. The original email.body stays intact in the store/DB.
  // null = body not yet loaded (prefetch pending); string = ready to render
  // null = body not yet loaded (list queries use '' as body placeholder);
  // '' or undefined both mean "not loaded yet — show loading indicator"
  const lightBody = useMemo(() => {
    if (!email.body) return null;
    return stripLargeDataUris(email.body, !isDark);
  }, [email.body, isDark]);

  // Get snippet for collapsed view (decode HTML entities from Gmail API)
  const decodeEntities = (text: string): string => {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  };
  const snippet = decodeEntities(
    email.snippet ||
      (lightBody ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .substring(0, 150),
  );

  const [showHeaderDetails, setShowHeaderDetails] = useState(false);
  const [showQuotedBody, setShowQuotedBody] = useState(false);

  // Strip trailing quoted/forwarded text so only new content shows by default.
  const { newContent, hasQuotedContent } = useMemo(
    () => splitQuotedContent(lightBody ?? ""),
    [lightBody],
  );

  const handleHeaderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowHeaderDetails(!showHeaderDetails);
  };
  // Rich HTML emails (with bgcolor/background-color) get a white card in dark mode.
  // Plain text and simple HTML get a dark card with light text.
  const isRich = lightBody !== null && isHtmlContent(lightBody) && hasRichBackground(lightBody);
  const useWhiteCard = isDark && isRich;
  // Iframe/text uses light-mode colors unless we're in dark mode with a non-rich email
  const useDarkContent = isDark && !isRich;

  if (!isExpanded) {
    // Collapsed row - single line like Superhuman
    return (
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-4 py-3 px-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left border-b border-gray-100 dark:border-gray-700/50"
      >
        {/* Sender */}
        <div className="w-28 flex-shrink-0">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate block">
            {isFromMe ? "Me" : senderName}
          </span>
        </div>

        {/* Preview */}
        <div className="flex-1 min-w-0">
          <span className="text-sm text-gray-500 dark:text-gray-400 truncate block">{snippet}</span>
        </div>

        {/* Date */}
        <div className="flex-shrink-0">
          <span className="text-sm text-gray-400 dark:text-gray-500">{formatDate(email.date)}</span>
        </div>
      </button>
    );
  }

  // Expanded view - full email content
  // White card for rich HTML emails in dark mode, dark card otherwise
  return (
    <div
      className={`group/msg ${
        useWhiteCard
          ? `bg-white rounded-lg${isFocused ? " ring-1 ring-blue-300 dark:ring-blue-500" : ""}`
          : `relative before:absolute before:left-[-6px] before:top-0 before:bottom-0 before:rounded-full bg-gray-50/50 dark:bg-gray-800/30 ${
              isFocused
                ? "before:w-1 before:bg-blue-600 before:dark:bg-blue-400"
                : "before:w-0.5 before:bg-blue-500 before:dark:bg-blue-400"
            }`
      }`}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-2 py-3 px-2 transition-colors text-left ${
          useWhiteCard ? "hover:bg-gray-100/50" : "hover:bg-gray-100/50 dark:hover:bg-gray-700/30"
        }`}
      >
        <span
          onClick={handleHeaderClick}
          className={`min-w-0 truncate text-sm font-medium cursor-pointer ${useWhiteCard ? "text-gray-900" : "text-gray-900 dark:text-gray-100"}`}
        >
          {formatMessageHeader(email, currentUserEmail, nameMap)}
        </span>
        <svg
          onClick={handleHeaderClick}
          className={`flex-shrink-0 w-3 h-3 transition-transform cursor-pointer ${showHeaderDetails ? "rotate-180" : ""} ${useWhiteCard ? "text-gray-400" : "text-gray-400 dark:text-gray-500"}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        <span
          className={`flex-shrink-0 ml-auto text-sm ${useWhiteCard ? "text-gray-400" : "text-gray-400 dark:text-gray-500"}`}
        >
          {formatDate(email.date)}
        </span>
        {/* Reply/Forward action buttons - top right, visible on hover */}
        {isExpanded && (
          <span className="flex-shrink-0 flex items-center gap-0.5 ml-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                onReply();
              }}
              className={`p-1 rounded transition-colors ${
                useWhiteCard
                  ? "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                  : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
              }`}
              title="Reply"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 10l6-6m0 0v12m0-12h12a2 2 0 012 2v8a2 2 0 01-2 2H9"
                />
              </svg>
            </span>
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                onReplyAll();
              }}
              className={`p-1 rounded transition-colors ${
                useWhiteCard
                  ? "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                  : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
              }`}
              title="Reply All"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 10h8a8 8 0 018 8v2M7 10l6 6m-6-6l6-6"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 14l4-4-4-4"
                />
              </svg>
            </span>
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                onForward();
              }}
              className={`p-1 rounded transition-colors ${
                useWhiteCard
                  ? "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                  : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
              }`}
              title="Forward"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </span>
          </span>
        )}
      </button>

      {/* Expandable sender details */}
      {showHeaderDetails && (
        <div
          className={`mx-2 mt-1 p-2 rounded border text-xs space-y-1 ${
            useWhiteCard
              ? "bg-gray-50 border-gray-200"
              : "bg-gray-100/50 dark:bg-gray-700/40 border-gray-200 dark:border-gray-600"
          }`}
        >
          <div className="flex group/addr">
            <span
              className={`w-12 flex-shrink-0 ${useWhiteCard ? "text-gray-500" : "text-gray-500 dark:text-gray-400"}`}
            >
              From:
            </span>
            <AddressField
              header={email.from}
              useWhiteCard={useWhiteCard}
              forceExpanded
              nameMap={nameMap}
            />
          </div>
          <div className="flex group/addr">
            <span
              className={`w-12 flex-shrink-0 ${useWhiteCard ? "text-gray-500" : "text-gray-500 dark:text-gray-400"}`}
            >
              To:
            </span>
            <AddressField
              header={email.to}
              useWhiteCard={useWhiteCard}
              forceExpanded
              nameMap={nameMap}
            />
          </div>
          {email.cc && (
            <div className="flex group/addr">
              <span
                className={`w-12 flex-shrink-0 ${useWhiteCard ? "text-gray-500" : "text-gray-500 dark:text-gray-400"}`}
              >
                Cc:
              </span>
              <AddressField
                header={email.cc}
                useWhiteCard={useWhiteCard}
                forceExpanded
                nameMap={nameMap}
              />
            </div>
          )}
          {email.bcc && (
            <div className="flex group/addr">
              <span
                className={`w-12 flex-shrink-0 ${useWhiteCard ? "text-gray-500" : "text-gray-500 dark:text-gray-400"}`}
              >
                Bcc:
              </span>
              <AddressField
                header={email.bcc}
                useWhiteCard={useWhiteCard}
                forceExpanded
                nameMap={nameMap}
              />
            </div>
          )}
          <div className="flex">
            <span
              className={`w-12 flex-shrink-0 ${useWhiteCard ? "text-gray-500" : "text-gray-500 dark:text-gray-400"}`}
            >
              Date:
            </span>
            <span
              className={`select-all ${useWhiteCard ? "text-gray-700" : "text-gray-700 dark:text-gray-300"}`}
            >
              {email.date}
            </span>
          </div>
        </div>
      )}

      {/* Email body - no inner scroll. Masked in session replays via global maskTextSelector:"*" in posthog.ts. */}
      <div className="px-2 pb-4" data-ph-no-capture>
        {lightBody === null ? (
          <div className="animate-pulse text-gray-400 dark:text-gray-500 text-sm py-4 px-2">
            Loading…
          </div>
        ) : (
          <>
            {/* Cache key uses `:trimmed` suffix so stripped and full body are cached separately.
                The LRU cache keys on emailId — since the same email has two body variants,
                the suffix prevents one from overwriting the other on toggle. */}
            <EmailBodyRenderer
              emailId={hasQuotedContent && !showQuotedBody ? `${email.id}:trimmed` : email.id}
              body={hasQuotedContent && !showQuotedBody ? newContent : lightBody}
              useLightMode={!useDarkContent}
            />
          </>
        )}
        {hasQuotedContent && (
          <button
            onClick={() => setShowQuotedBody(!showQuotedBody)}
            className="px-2 py-0.5 mt-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 rounded text-sm transition-colors"
            title={showQuotedBody ? "Hide quoted text" : "Show quoted text"}
          >
            ···
          </button>
        )}
        {/* Attachments */}
        {email.attachments && email.attachments.length > 0 && accountId && onPreviewAttachment && (
          <EmailAttachmentList
            attachments={email.attachments}
            emailId={email.id}
            accountId={accountId}
            onPreview={onPreviewAttachment}
          />
        )}
      </div>
    </div>
  );
}

// Sent message info for optimistic updates
interface SentMessageInfo {
  id: string;
  threadId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  snippet: string;
  attachments?: AttachmentMeta[];
}

// Inline reply/forward component
function InlineReply({
  replyInfo,
  accountId,
  accountEmail: _accountEmail,
  composeMode,
  replyToEmailId,
  onSend,
  onCancel,
  onContentChange,
  onToChange,
  onCcChange,
  onBccChange,
  restoredDraft,
  draftEmailId,
  onDiscardDraft,
  nameMap: externalNameMap,
}: {
  replyInfo: ReplyInfo;
  accountId: string;
  accountEmail: string;
  composeMode: "reply" | "reply-all" | "forward";
  replyToEmailId: string;
  onSend: (sentInfo: SentMessageInfo) => void;
  onCancel: () => void;
  onContentChange?: (content: { bodyHtml: string; bodyText: string }) => void;
  onToChange?: (to: string[]) => void;
  onCcChange?: (cc: string[]) => void;
  onBccChange?: (bcc: string[]) => void;
  restoredDraft?: RestoredDraft | null;
  /** Email ID that owns the AI-generated draft (for refine/revert). */
  draftEmailId?: string;
  /** Callback to discard the AI draft entirely. */
  onDiscardDraft?: () => void;
  /** Map of lowercase email → display name for rendering name chips */
  nameMap?: Map<string, string>;
}) {
  const isForward = composeMode === "forward";

  const form = useComposeForm({
    accountId,
    initialTo: restoredDraft?.to !== undefined ? restoredDraft.to : isForward ? [] : replyInfo.to,
    initialCc:
      restoredDraft?.cc !== undefined
        ? restoredDraft.cc
        : replyInfo.cc.length > 0
          ? replyInfo.cc
          : [],
    initialBcc: restoredDraft?.bcc !== undefined ? restoredDraft.bcc : [],
    initialBodyHtml: restoredDraft?.bodyHtml || "",
    initialBodyText: restoredDraft?.bodyText || "",
    replyInfo,
    isForward,
    composeMode,
    replyToEmailId,
    forwardAttachmentSource:
      isForward && replyInfo.forwardedAttachments?.length
        ? { emailId: replyToEmailId, accountId }
        : undefined,
  });

  // Merge external nameMap (from thread context) with autocomplete-derived nameMap
  const mergedNameMap = useMemo(() => {
    if (!externalNameMap) return form.nameMap;
    const merged = new Map(externalNameMap);
    for (const [k, v] of form.nameMap) merged.set(k, v);
    return merged;
  }, [externalNameMap, form.nameMap]);

  // Notify parent of To/Cc/Bcc changes so savePendingDraft can persist them.
  // Emit formatted "Name <email>" addresses so display names survive save/restore.
  useEffect(() => {
    const formatted = form.to.map((email) => {
      const name = mergedNameMap.get(email.toLowerCase());
      return name ? `${name} <${email}>` : email;
    });
    onToChange?.(formatted);
  }, [form.to, mergedNameMap, onToChange]);

  useEffect(() => {
    const formatted = form.cc.map((email) => {
      const name = mergedNameMap.get(email.toLowerCase());
      return name ? `${name} <${email}>` : email;
    });
    onCcChange?.(formatted);
  }, [form.cc, mergedNameMap, onCcChange]);

  useEffect(() => {
    const formatted = form.bcc.map((email) => {
      const name = mergedNameMap.get(email.toLowerCase());
      return name ? `${name} <${email}>` : email;
    });
    onBccChange?.(formatted);
  }, [form.bcc, mergedNameMap, onBccChange]);

  // Progressive disclosure: collapsed summary vs expanded address fields
  // Forward mode starts expanded since there are no initial recipients
  const [showAddressFields, setShowAddressFields] = useState(isForward);

  // When a chip drag starts, also reveal address fields
  const handleRecipientDragStart = useCallback(() => {
    form.handleRecipientDragStart();
    setShowAddressFields(true);
  }, [form.handleRecipientDragStart]);

  // When @mention adds to Cc, also reveal address fields
  const handleMentionAddToCc = useCallback(
    (email: string) => {
      form.handleMentionAddToCc(email);
      setShowAddressFields(true);
    },
    [form.handleMentionAddToCc],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // AI draft refinement state
  const [refineCritique, setRefineCritique] = useState("");
  const [isRefining, setIsRefining] = useState(false);
  const [preRefineContent, setPreRefineContent] = useState<{
    bodyHtml: string;
    bodyText: string;
  } | null>(null);

  // "Save as memory" state — shown after a successful refinement
  const [showSaveMemory, setShowSaveMemory] = useState(false);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryScope, setMemoryScope] = useState<MemoryScope>("person");
  const [memoryScopeValue, setMemoryScopeValue] = useState<string | null>(null);
  const [isClassifyingMemory, setIsClassifyingMemory] = useState(false);
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [memorySaved, setMemorySaved] = useState(false);

  // Derive sender email and domain from reply recipients (the person we're replying to)
  const senderEmail = replyInfo.to[0]
    ? (replyInfo.to[0].match(/<([^>]+)>/)?.[1] ?? replyInfo.to[0]).toLowerCase()
    : "";
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@")[1] : "";

  const memorySavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const classifyRequestRef = useRef(0);
  const memoryContentEditedRef = useRef(false);

  const handleSaveMemory = useCallback(async () => {
    if (!memoryContent.trim()) return;
    setIsSavingMemory(true);
    try {
      const scopeValue =
        memoryScopeValue ??
        (memoryScope === "person" ? senderEmail : memoryScope === "domain" ? senderDomain : null);
      const raw = await window.api.memory.save({
        accountId,
        scope: memoryScope,
        scopeValue,
        content: memoryContent.trim(),
        source: "refinement",
        sourceEmailId: draftEmailId ?? replyToEmailId,
      });
      if (raw.success) {
        if (memorySavedTimerRef.current) {
          clearTimeout(memorySavedTimerRef.current);
        }
        setMemorySaved(true);
        memorySavedTimerRef.current = setTimeout(() => {
          setShowSaveMemory(false);
          setMemorySaved(false);
        }, 1500);
      }
    } catch {
      // Silently fail — memory saving is non-critical
    } finally {
      setIsSavingMemory(false);
    }
  }, [
    memoryContent,
    memoryScope,
    memoryScopeValue,
    senderEmail,
    senderDomain,
    accountId,
    draftEmailId,
    replyToEmailId,
  ]);

  // Clean up memory-saved dismiss timer on unmount (InlineReply unmounts on thread switch)
  useEffect(() => {
    return () => {
      if (memorySavedTimerRef.current) {
        clearTimeout(memorySavedTimerRef.current);
      }
    };
  }, []);

  // Track the current editor content for refine (ComposeEditor's initialContent prop
  // is used to push new content into the editor, separate from bodyHtml which tracks
  // the latest editor value)
  const [editorInitialContent, setEditorInitialContent] = useState(restoredDraft?.bodyHtml || "");

  const handleRefine = useCallback(async () => {
    if (!refineCritique.trim() || !draftEmailId || isRefining) return;
    setIsRefining(true);
    form.setError(null);
    try {
      const raw = await window.api.drafts.refine(draftEmailId, form.bodyText, refineCritique);
      const result = raw as Record<string, unknown>;
      if (!result || typeof result !== "object" || !("success" in result)) {
        form.setError("Unexpected response from draft refinement");
        return;
      }
      if (!result.success) {
        form.setError(String(result.error || "Failed to refine draft"));
        return;
      }
      const refinedText = result.data as string;
      if (typeof refinedText !== "string") {
        form.setError("Invalid refinement result");
        return;
      }
      // Save current content so user can revert (only on success)
      setPreRefineContent({ bodyHtml: form.bodyHtml, bodyText: form.bodyText });
      const refinedHtml = draftBodyToHtml(refinedText);
      setEditorInitialContent(refinedHtml);
      // Push new content into the form via handleEditorChange
      form.handleEditorChange(refinedHtml, refinedText);
      onContentChange?.({ bodyHtml: refinedHtml, bodyText: refinedText });
      // Offer to save the critique as a memory for future drafts
      const critiqueText = refineCritique;
      memoryContentEditedRef.current = false;
      setMemoryContent(critiqueText);
      setMemoryScope("person");
      setMemoryScopeValue(senderEmail);
      setShowSaveMemory(true);

      setMemorySaved(false);
      setRefineCritique("");
      // Asynchronously classify the scope using AI.
      // Use a request counter to discard stale results if the user refines again quickly.
      const requestId = ++classifyRequestRef.current;
      setIsClassifyingMemory(true);
      window.api.memory
        .classify({
          content: critiqueText,
          senderEmail,
          senderDomain,
        })
        .then(
          (
            result: IpcResponse<{ scope: MemoryScope; scopeValue: string | null; content: string }>,
          ) => {
            if (requestId !== classifyRequestRef.current) return; // stale
            if (result.success && result.data) {
              setMemoryScope(result.data.scope);
              setMemoryScopeValue(result.data.scopeValue);
              // Only overwrite content if the user hasn't edited it while classify was in flight
              if (!memoryContentEditedRef.current) {
                setMemoryContent(result.data.content);
              }
            }
          },
        )
        .catch(() => {
          // Classification failed — keep defaults
        })
        .finally(() => {
          if (requestId === classifyRequestRef.current) {
            setIsClassifyingMemory(false);
          }
        });
    } catch (err) {
      form.setError(err instanceof Error ? err.message : "Failed to refine draft");
    } finally {
      setIsRefining(false);
    }
  }, [
    refineCritique,
    draftEmailId,
    isRefining,
    form.bodyHtml,
    form.bodyText,
    onContentChange,
    form.setError,
    form.handleEditorChange,
    senderEmail,
    senderDomain,
  ]);

  const handleRevertRefine = useCallback(() => {
    if (!preRefineContent) return;
    setEditorInitialContent(preRefineContent.bodyHtml);
    form.handleEditorChange(preRefineContent.bodyHtml, preRefineContent.bodyText);
    onContentChange?.(preRefineContent);
    setPreRefineContent(null);
  }, [preRefineContent, onContentChange, form.handleEditorChange]);

  // Wrap editor onChange to also notify parent
  const handleEditorChange = useCallback(
    (html: string, text: string) => {
      form.handleEditorChange(html, text);
      onContentChange?.({ bodyHtml: html, bodyText: text });
    },
    [form.handleEditorChange, onContentChange],
  );

  // Send with optimistic update support
  const handleSend = useCallback(async () => {
    const sendOptions = form.buildSendOptions();
    const { undoSendDelaySeconds, addUndoSend } = useAppStore.getState();

    if (!form.canSend || form.isSending) return;

    if (undoSendDelaySeconds > 0) {
      const optimisticId = `pending-${Date.now()}`;
      addUndoSend({
        id: crypto.randomUUID(),
        sendOptions,
        recipients: form.to.join(", "),
        scheduledAt: Date.now(),
        delayMs: undoSendDelaySeconds * 1000,
        composeContext: {
          mode: composeMode,
          replyToEmailId,
          threadId: replyInfo.threadId,
          bodyHtml: form.bodyHtml,
          bodyText: form.bodyText,
          to: form.to,
          cc: form.cc.length > 0 ? form.cc : undefined,
          bcc: form.bcc.length > 0 ? form.bcc : undefined,
          subject: replyInfo.subject,
          optimisticEmailId: optimisticId,
        },
      });
      onSend({
        id: optimisticId,
        threadId: replyInfo.threadId,
        to: form.to,
        cc: form.cc.length > 0 ? form.cc : undefined,
        bcc: form.bcc.length > 0 ? form.bcc : undefined,
        subject: replyInfo.subject,
        body: sendOptions.bodyHtml,
        snippet: form.bodyText.substring(0, 150),
        attachments:
          form.composeAttachments.length > 0
            ? form.composeAttachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
              }))
            : undefined,
      });
      return;
    }

    const response = await form.send();
    if (response && response !== "undo-queued" && response.success && response.data) {
      onSend({
        id: response.data.id,
        threadId: isForward ? replyInfo.threadId : response.data.threadId,
        to: form.to,
        cc: form.cc.length > 0 ? form.cc : undefined,
        bcc: form.bcc.length > 0 ? form.bcc : undefined,
        subject: replyInfo.subject,
        body: sendOptions.bodyHtml,
        snippet: form.bodyText.substring(0, 150),
        attachments:
          form.composeAttachments.length > 0
            ? form.composeAttachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
              }))
            : undefined,
      });
    }
  }, [form, composeMode, replyToEmailId, replyInfo, isForward, onSend]);

  const handleScheduleSend = useCallback(
    async (scheduledAt: number) => {
      const success = await form.scheduleSend(scheduledAt);
      if (success) onCancel();
    },
    [form.scheduleSend, onCancel],
  );

  const [showQuotedContent, setShowQuotedContent] = useState(false);

  // Handle Cmd+Enter to send (capture phase to beat ProseMirror's Enter handler)
  useEffect(() => {
    const handleCmdEnter = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSend();
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("keydown", handleCmdEnter, { capture: true });
      return () => container.removeEventListener("keydown", handleCmdEnter, { capture: true });
    }
  }, [handleSend]);

  // Handle Escape to blur (bubble phase so ProseMirror processes Escape first)
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        containerRef.current?.querySelectorAll("iframe").forEach((iframe) => {
          iframe.blur();
        });
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("keydown", handleEscape);
      return () => container.removeEventListener("keydown", handleEscape);
    }
  }, []);

  // Build summary text: "Draft to Thomas, Kelley & Jon"
  const summaryText = useMemo(() => {
    const allRecipients = [...form.to, ...form.cc];
    const names = allRecipients.map((email) => {
      if (mergedNameMap) {
        const name = mergedNameMap.get(email.toLowerCase());
        if (name) return firstName(name);
      }
      return email;
    });
    if (names.length === 0) return isForward ? "Forward" : "Reply";
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  }, [form.to, form.cc, mergedNameMap, isForward]);

  return (
    <div
      ref={containerRef}
      className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      data-testid="inline-compose"
    >
      <div className="px-4 pt-2">
        <div className="flex items-center justify-between mb-1">
          {/* Level 1: Collapsed summary / Level 2: Header with controls */}
          {!showAddressFields ? (
            <button
              onClick={() => setShowAddressFields(true)}
              className="text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700/30 rounded px-1 py-0.5 -mx-1 transition-colors"
              data-testid="inline-reply-summary"
            >
              <span className="text-green-600 dark:text-green-400 font-medium">
                {isForward ? "Forward" : "Reply"}
              </span>
              {(form.to.length > 0 || form.cc.length > 0) && (
                <span className="text-gray-700 dark:text-gray-300">
                  {" to "}
                  {summaryText}
                </span>
              )}
            </button>
          ) : (
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {isForward ? "Forward" : "Reply"}
            </span>
          )}
          <div className="flex items-center gap-1">
            {showAddressFields && (
              <>
                {!isForward && (
                  <button
                    onClick={() => setShowAddressFields(false)}
                    className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1"
                    title="Collapse address fields"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 15l7-7 7 7"
                      />
                    </svg>
                  </button>
                )}
                {!form.showCcBcc && (
                  <button
                    onClick={() => form.setShowCcBcc(true)}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 px-1"
                    data-testid="inline-reply-cc-bcc-toggle"
                  >
                    Cc / Bcc
                  </button>
                )}
              </>
            )}
            <button
              onClick={onDiscardDraft ?? onCancel}
              className="text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 p-1"
              data-testid="inline-compose-close"
              title="Discard draft"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          </div>
        </div>
        {showAddressFields && (
          <>
            <AddressInput
              label="To"
              value={form.to}
              onChange={form.setTo}
              placeholder="recipient@example.com"
              autoFocus={isForward}
              nameMap={mergedNameMap}
              onSuggestionSelected={form.handleSuggestionSelected}
              fieldId="to"
              onChipDrop={(email, sourceField) =>
                form.handleRecipientDrop("to", email, sourceField)
              }
              onChipDragStart={handleRecipientDragStart}
            />
            {form.showCcBcc && (
              <div>
                <AddressInput
                  label="Cc"
                  value={form.cc}
                  onChange={form.setCc}
                  placeholder="cc@example.com"
                  nameMap={mergedNameMap}
                  onSuggestionSelected={form.handleSuggestionSelected}
                  fieldId="cc"
                  onChipDrop={(email, sourceField) =>
                    form.handleRecipientDrop("cc", email, sourceField)
                  }
                  onChipDragStart={handleRecipientDragStart}
                />
                <AddressInput
                  label="Bcc"
                  value={form.bcc}
                  onChange={form.setBcc}
                  placeholder="bcc@example.com"
                  nameMap={mergedNameMap}
                  onSuggestionSelected={form.handleSuggestionSelected}
                  fieldId="bcc"
                  onChipDrop={(email, sourceField) =>
                    form.handleRecipientDrop("bcc", email, sourceField)
                  }
                  onChipDragStart={handleRecipientDragStart}
                />
              </div>
            )}
          </>
        )}
      </div>
      <div className="px-4 py-2">
        <ComposeEditor
          initialContent={editorInitialContent}
          onChange={handleEditorChange}
          placeholder={isForward ? "Add a message..." : "Write your reply..."}
          autoFocus={!isForward && !restoredDraft?.skipAutoFocus}
          onAddToCc={handleMentionAddToCc}
        />
        {/* Attachments */}
        {form.loadingForwardAttachments && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Loading forwarded attachments...
          </p>
        )}
        <ComposeAttachmentList
          attachments={form.composeAttachments}
          onRemove={form.handleRemoveAttachment}
        />
        {form.error && <p className="text-sm text-red-600 dark:text-red-400 mt-2">{form.error}</p>}
        {/* Quoted original email — expandable via "..." button */}
        {replyInfo.quotedBody && (
          <div className="mt-1">
            <button
              onClick={() => setShowQuotedContent(!showQuotedContent)}
              className="px-2 py-0.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 rounded text-sm transition-colors"
              title={showQuotedContent ? "Hide original" : "Show original"}
            >
              ···
            </button>
            {showQuotedContent && (
              <div
                className="mt-1 pl-3 border-l-2 border-gray-200 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400 overflow-auto max-h-80"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(replyInfo.quotedBody) }}
              />
            )}
          </div>
        )}
        {/* AI Refine section */}
        {draftEmailId && (
          <div className="flex items-center gap-2 mt-2">
            <input
              type="text"
              value={refineCritique}
              onChange={(e) => setRefineCritique(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  refineCritique.trim()
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  handleRefine();
                }
              }}
              placeholder="Refine with AI... e.g. 'make it shorter' or 'more formal'"
              className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={isRefining}
            />
            <button
              onClick={handleRefine}
              disabled={isRefining || !refineCritique.trim()}
              className="px-3 py-1.5 bg-purple-600 dark:bg-purple-500 text-white text-sm font-medium rounded hover:bg-purple-700 dark:hover:bg-purple-600 transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {isRefining ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Refining...
                </>
              ) : (
                "Refine"
              )}
            </button>
            {preRefineContent && (
              <button
                onClick={handleRevertRefine}
                className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Revert
              </button>
            )}
          </div>
        )}
        {/* Save as Memory prompt — shown after a successful refinement */}
        {showSaveMemory && (
          <div className="mt-2 p-2.5 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800/40 rounded text-sm">
            {memorySaved ? (
              <span className="text-purple-700 dark:text-purple-300 font-medium">Memory saved</span>
            ) : (
              <>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-purple-700 dark:text-purple-300 font-medium">
                    Save as memory?
                  </span>
                  <button
                    onClick={() => {
                      if (memorySavedTimerRef.current) {
                        clearTimeout(memorySavedTimerRef.current);
                      }
                      setShowSaveMemory(false);
                    }}
                    className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
                  >
                    dismiss
                  </button>
                </div>
                <input
                  type="text"
                  value={memoryContent}
                  onChange={(e) => {
                    memoryContentEditedRef.current = true;
                    setMemoryContent(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      memoryContent.trim() &&
                      !isClassifyingMemory &&
                      !isSavingMemory
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSaveMemory();
                    }
                  }}
                  className="w-full px-2 py-1 mb-1.5 border border-purple-200 dark:border-purple-700 dark:bg-gray-700 dark:text-gray-100 rounded text-sm focus:ring-1 focus:ring-purple-400"
                  placeholder="Describe the preference to remember..."
                />
                <div className="flex items-center gap-2 flex-wrap">
                  {isClassifyingMemory ? (
                    <span className="text-xs text-purple-500 dark:text-purple-400 italic">
                      Classifying scope...
                    </span>
                  ) : (
                    <>
                      <span className="text-xs text-gray-500 dark:text-gray-400">Apply to:</span>
                      {senderEmail && (
                        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                          <input
                            type="radio"
                            name="memory-scope"
                            checked={memoryScope === "person"}
                            onChange={() => {
                              setMemoryScope("person");
                              setMemoryScopeValue(senderEmail);
                            }}
                            className="w-3 h-3"
                          />
                          {senderEmail}
                        </label>
                      )}
                      {senderDomain && (
                        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                          <input
                            type="radio"
                            name="memory-scope"
                            checked={memoryScope === "domain"}
                            onChange={() => {
                              setMemoryScope("domain");
                              setMemoryScopeValue(senderDomain);
                            }}
                            className="w-3 h-3"
                          />
                          @{senderDomain}
                        </label>
                      )}
                      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                        <input
                          type="radio"
                          name="memory-scope"
                          checked={memoryScope === "category"}
                          onChange={() => {
                            setMemoryScope("category");
                            setMemoryScopeValue(null);
                          }}
                          className="w-3 h-3"
                        />
                        Category
                        {memoryScope === "category" && memoryScopeValue
                          ? `: ${memoryScopeValue}`
                          : ""}
                      </label>
                      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                        <input
                          type="radio"
                          name="memory-scope"
                          checked={memoryScope === "global"}
                          onChange={() => {
                            setMemoryScope("global");
                            setMemoryScopeValue(null);
                          }}
                          className="w-3 h-3"
                        />
                        Everyone
                      </label>
                    </>
                  )}
                  <button
                    onClick={handleSaveMemory}
                    disabled={!memoryContent.trim() || isSavingMemory || isClassifyingMemory}
                    className="ml-auto px-2 py-0.5 bg-purple-600 dark:bg-purple-500 text-white text-xs font-medium rounded hover:bg-purple-700 dark:hover:bg-purple-600 disabled:opacity-50 transition-colors"
                  >
                    {isSavingMemory ? "Saving..." : "Save"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <div className="mt-2">
          <ComposeToolbar
            onSend={handleSend}
            onScheduleSend={handleScheduleSend}
            onPickFiles={form.handlePickFiles}
            isSending={form.isSending}
            isScheduling={form.isScheduling}
            canSend={form.canSend}
            activeSignatureId={form.activeSignatureId}
            onSignatureChange={form.setActiveSignatureId}
            availableSignatures={form.availableSignatures}
          />
        </div>
      </div>
    </div>
  );
}

// New email compose component (for starting a new thread)
function NewEmailCompose({
  accountId,
  onSend,
  onCancel,
  onDiscard,
  initialDraft,
}: {
  accountId: string;
  onSend: () => void;
  onCancel: (formState: ComposeFormState) => void;
  onDiscard?: () => void;
  initialDraft?: RestoredDraft | null;
}) {
  const form = useComposeForm({
    accountId,
    initialTo: initialDraft?.to ?? [],
    initialCc: initialDraft?.cc ?? [],
    initialBcc: initialDraft?.bcc ?? [],
    initialSubject: initialDraft?.subject || "",
    initialBodyHtml: initialDraft?.bodyHtml || "",
    initialBodyText: initialDraft?.bodyText || "",
  });

  // Watch for external updates to this draft (e.g. from the agent's update_draft tool).
  // When the store's copy changes, push new content into the editor.
  const localDraftId = initialDraft?.localDraftId;
  const storeDraft = useAppStore((s) =>
    localDraftId ? s.localDrafts.find((d) => d.id === localDraftId) : undefined,
  );
  const storeDraftUpdatedAt = storeDraft?.updatedAt;
  const [lastAgentUpdateAt, setLastAgentUpdateAt] = useState(storeDraftUpdatedAt);
  // Derive content: use agent-updated content when available, otherwise initial
  const editorContent = storeDraft?.bodyHtml ?? initialDraft?.bodyHtml ?? "";
  useEffect(() => {
    if (!storeDraft || storeDraftUpdatedAt === lastAgentUpdateAt) return;
    setLastAgentUpdateAt(storeDraftUpdatedAt);
    if (storeDraft.bodyHtml) {
      // setContent causes ProseMirror to lose focus — restore it so Escape still works
      setTimeout(() => {
        containerRef.current?.querySelector<HTMLElement>(".ProseMirror")?.focus();
      }, 0);
    }
    if (storeDraft.subject && storeDraft.subject !== form.subject) {
      form.setSubject(storeDraft.subject);
    }
    if (storeDraft.to && JSON.stringify(storeDraft.to) !== JSON.stringify(form.to)) {
      form.setTo(storeDraft.to);
    }
    if (storeDraft.cc && JSON.stringify(storeDraft.cc) !== JSON.stringify(form.cc)) {
      form.setCc(storeDraft.cc);
    }
    if (storeDraft.bcc && JSON.stringify(storeDraft.bcc) !== JSON.stringify(form.bcc)) {
      form.setBcc(storeDraft.bcc);
    }
  }, [storeDraftUpdatedAt]);

  const containerRef = useRef<HTMLDivElement>(null);
  const ccInputRef = useRef<HTMLInputElement>(null);
  const bccInputRef = useRef<HTMLInputElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);

  const focusEditor = useCallback(() => {
    const editor = containerRef.current?.querySelector<HTMLElement>(".ProseMirror");
    editor?.focus();
  }, []);

  // Send handler — uses the hook but needs custom subject and simpler callback
  const handleSend = useCallback(async () => {
    if (!form.canSend || form.isSending) return;

    const hasAttachments = form.composeAttachments.length > 0;
    const result = await form.send();
    if (result === "undo-queued") {
      // Track on undo-queued: user may still undo, but intent to send is confirmed
      trackEvent("email_sent", { type: "new", has_attachments: hasAttachments });
      onSend();
    } else if (result && result.success) {
      trackEvent("email_sent", { type: "new", has_attachments: hasAttachments });
      onSend();
    }
  }, [form, onSend]);

  const handleScheduleSend = useCallback(
    async (scheduledAt: number) => {
      const success = await form.scheduleSend(scheduledAt);
      if (success) onSend();
    },
    [form.scheduleSend, onSend],
  );

  const getFormState = useCallback(
    (): ComposeFormState => form.getFormState(),
    [form.getFormState],
  );

  // Handle Cmd+Enter to send (capture phase to beat ProseMirror's Enter handler)
  useEffect(() => {
    const handleCmdEnter = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSend();
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("keydown", handleCmdEnter, { capture: true });
      return () => container.removeEventListener("keydown", handleCmdEnter, { capture: true });
    }
  }, [handleSend]);

  // Handle Escape to cancel (bubble phase so ProseMirror processes Escape first)
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel(getFormState());
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("keydown", handleEscape);
      return () => container.removeEventListener("keydown", handleEscape);
    }
  }, [onCancel, getFormState]);

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col bg-white dark:bg-gray-800 overflow-hidden"
    >
      {/* Header */}
      <div className="h-9 px-4 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700/50 flex items-center flex-shrink-0">
        <span className="text-gray-900 dark:text-gray-100 font-medium text-sm">New Message</span>
        <button
          onClick={onDiscard ?? (() => onCancel(getFormState()))}
          className="ml-auto p-1.5 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 rounded transition-colors"
          title="Discard draft"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>

      {/* Compose form */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4">
          {/* To field with Cc/Bcc toggle */}
          <div className="flex items-center">
            <div className="flex-1 min-w-0">
              <AddressInput
                label="To"
                value={form.to}
                onChange={form.setTo}
                placeholder="recipient@example.com"
                autoFocus
                nameMap={form.nameMap}
                onSuggestionSelected={form.handleSuggestionSelected}
                onTab={() => {
                  if (form.showCcBcc) ccInputRef.current?.focus();
                  else subjectInputRef.current?.focus();
                }}
                fieldId="to"
                onChipDrop={(email, sourceField) =>
                  form.handleRecipientDrop("to", email, sourceField)
                }
                onChipDragStart={form.handleRecipientDragStart}
              />
            </div>
            {!form.showCcBcc && (
              <button
                onClick={() => form.setShowCcBcc(true)}
                className="ml-2 flex-shrink-0 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                data-testid="compose-cc-bcc-toggle"
              >
                Cc/Bcc
              </button>
            )}
          </div>

          {/* Collapsible Cc/Bcc fields */}
          {form.showCcBcc && (
            <>
              <AddressInput
                label="Cc"
                value={form.cc}
                onChange={form.setCc}
                placeholder="cc@example.com"
                nameMap={form.nameMap}
                onSuggestionSelected={form.handleSuggestionSelected}
                inputRef={ccInputRef}
                onTab={() => bccInputRef.current?.focus()}
                fieldId="cc"
                onChipDrop={(email, sourceField) =>
                  form.handleRecipientDrop("cc", email, sourceField)
                }
                onChipDragStart={form.handleRecipientDragStart}
              />
              <AddressInput
                label="Bcc"
                value={form.bcc}
                onChange={form.setBcc}
                placeholder="bcc@example.com"
                nameMap={form.nameMap}
                onSuggestionSelected={form.handleSuggestionSelected}
                inputRef={bccInputRef}
                onTab={() => subjectInputRef.current?.focus()}
                fieldId="bcc"
                onChipDrop={(email, sourceField) =>
                  form.handleRecipientDrop("bcc", email, sourceField)
                }
                onChipDragStart={form.handleRecipientDragStart}
              />
            </>
          )}

          <div className="flex items-baseline gap-2 py-1.5 border-b border-gray-200 dark:border-gray-700/50">
            <label className="w-10 text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">
              Subject
            </label>
            <input
              ref={subjectInputRef}
              type="text"
              value={form.subject}
              onChange={(e) => form.setSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  focusEditor();
                }
              }}
              placeholder="Subject"
              className="flex-1 outline-none border-none text-sm dark:text-gray-100 dark:placeholder-gray-400 bg-transparent"
              style={{ outline: "none", boxShadow: "none" }}
            />
          </div>

          {/* Body editor */}
          <div className="pt-3">
            <ComposeEditor
              initialContent={editorContent}
              onChange={form.handleEditorChange}
              placeholder="Write your message..."
              onAddToCc={form.handleMentionAddToCc}
            />
          </div>

          {/* Attachments */}
          <ComposeAttachmentList
            attachments={form.composeAttachments}
            onRemove={form.handleRemoveAttachment}
          />

          {form.error && <p className="text-sm text-red-600 dark:text-red-400">{form.error}</p>}

          {/* Action bar */}
          <div className="py-2 mt-2">
            <ComposeToolbar
              onSend={handleSend}
              onScheduleSend={handleScheduleSend}
              onPickFiles={form.handlePickFiles}
              isSending={form.isSending}
              isScheduling={form.isScheduling}
              canSend={form.canSend}
              activeSignatureId={form.activeSignatureId}
              onSignatureChange={form.setActiveSignatureId}
              availableSignatures={form.availableSignatures}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

interface EmailDetailProps {
  isFullView?: boolean;
}

export function EmailDetail({ isFullView = false }: EmailDetailProps) {
  const {
    emails,
    selectedEmailId,
    selectedThreadId,
    setSelectedEmailId,
    setSelectedThreadId: _setSelectedThreadId,
    updateEmail,
    addEmails,
    removeEmailsAndAdvance,
    markThreadAsRead,
    setViewMode,
    accounts,
    currentAccountId,
    composeState,
    closeCompose,
    openCompose,
    removeLocalDraft,
    addLocalDraft,
  } = useAppStore();

  const addRecentlyRepliedThread = useAppStore((s) => s.addRecentlyRepliedThread);
  const addUndoAction = useAppStore((s) => s.addUndoAction);
  const snoozedThreads = useAppStore((s) => s.snoozedThreads);
  const removeSnoozedThread = useAppStore((s) => s.removeSnoozedThread);
  const showSnoozeMenu = useAppStore((s) => s.showSnoozeMenu);
  const setShowSnoozeMenu = useAppStore((s) => s.setShowSnoozeMenu);
  const isInlineReplyOpen = useAppStore((s) => s.isInlineReplyOpen);
  const setInlineReplyOpen = useAppStore((s) => s.setInlineReplyOpen);
  const focusedThreadEmailId = useAppStore((s) => s.focusedThreadEmailId);
  const setFocusedThreadEmailId = useAppStore((s) => s.setFocusedThreadEmailId);

  const { threads: currentThreads } = useSplitFilteredThreads();

  // Use a ref so thread-switch expansion updates are synchronous (no re-render).
  // The counter state is only bumped by user-driven toggles.
  const expandedMessagesRef = useRef<Set<string>>(new Set());
  const prevExpandedThreadIdRef = useRef<string | undefined>(undefined);
  const [, setExpandedVersion] = useState(0);
  const [inlineReplyInfo, setInlineReplyInfo] = useState<ReplyInfo | null>(null);
  const [inlineComposeMode, setInlineComposeMode] = useState<
    "reply" | "reply-all" | "forward" | null
  >(null);
  const inlineReplyToEmailId = useAppStore((s) => s.inlineReplyToEmailId);
  const setInlineReplyToEmailId = useAppStore((s) => s.setInlineReplyToEmailId);
  const [isLoadingReplyInfo, setIsLoadingReplyInfo] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<RestoredDraft | null>(null);
  // Track inline reply content so we can save as draft on close
  const inlineReplyContentRef = useRef<{
    bodyHtml: string;
    bodyText: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
  } | null>(null);
  // Ref to the latest email so cleanup effects can save drafts for the correct email
  const latestEmailRef = useRef<ReturnType<typeof threadEmails.at> | null>(null);
  // Ref to current compose mode so savePendingDraft can persist it without re-creating
  const inlineComposeModeRef = useRef<"reply" | "reply-all" | "forward" | null>(null);

  // Attachment preview modal state
  const [previewAttachment, setPreviewAttachment] = useState<{
    attachment: AttachmentMeta;
    data: string;
  } | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollTargetRef = useRef<string | null>(null);
  const postSendScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Anchor ref: tracks the expanded email's position in scrollable content so we can
  // compensate when new messages are inserted above (e.g. fullThreadEmails loading).
  const scrollAnchorRef = useRef<{ emailId: string; scrollOffset: number } | null>(null);

  // Clear post-send scroll timeout on unmount
  useEffect(() => {
    return () => {
      if (postSendScrollTimeoutRef.current) {
        clearTimeout(postSendScrollTimeoutRef.current);
      }
    };
  }, []);

  const storeEmail = emails.find((e) => e.id === selectedEmailId);

  // Fallback: fetch from DB when email isn't in the store (e.g. search result from archived/sent mail)
  const [fetchedEmail, setFetchedEmail] = useState<DashboardEmail | null>(null);
  const isFetchingFallbackEmailRef = useRef(false);
  useEffect(() => {
    if (storeEmail || !selectedEmailId) {
      isFetchingFallbackEmailRef.current = false;
      setFetchedEmail(null);
      return;
    }
    isFetchingFallbackEmailRef.current = true;
    let cancelled = false;
    (
      window as {
        api: {
          gmail: { getEmail: (id: string) => Promise<{ success: boolean; data?: DashboardEmail }> };
        };
      }
    ).api.gmail
      .getEmail(selectedEmailId)
      .then((result) => {
        if (!cancelled && result.success && result.data) {
          setFetchedEmail(result.data as DashboardEmail);
          // Also add to store so thread view and other features work
          addEmails([result.data as DashboardEmail]);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error("Failed to fetch email for detail view:", err);
      })
      .finally(() => {
        if (!cancelled) isFetchingFallbackEmailRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEmailId, storeEmail, addEmails]);

  const selectedEmail = storeEmail ?? fetchedEmail;

  // Get current user email for "Me" detection
  const currentAccount = accounts.find((a) => a.id === currentAccountId);
  const currentUserEmail = currentAccount?.email;

  // State to hold full thread emails fetched from Gmail (includes sent replies)
  const [fullThreadEmails, setFullThreadEmails] = useState<DashboardEmail[]>([]);
  const [_isLoadingThread, setIsLoadingThread] = useState(false);

  // Fetch full thread when thread changes
  useEffect(() => {
    if (!selectedEmail || !currentAccountId) {
      setFullThreadEmails([]);
      return;
    }

    const fetchThread = async () => {
      setIsLoadingThread(true);
      try {
        const response = await window.api.emails.getThread(
          selectedEmail.threadId,
          currentAccountId,
        );
        if (response.success && response.data) {
          setFullThreadEmails(response.data);
          // Push into the store so the sidebar can also resolve these emails
          // (e.g. when focusedThreadEmailId points to one not yet in the store)
          addEmails(response.data);
        }
      } catch (error) {
        console.error("Failed to fetch thread:", error);
      } finally {
        setIsLoadingThread(false);
      }
    };

    fetchThread();
  }, [selectedEmail?.threadId, currentAccountId]);

  // Mark-as-read is handled imperatively in the Enter/click handlers
  // (store.markThreadAsRead) — not here — so it fires instantly before render.

  // Get all emails in the same thread, sorted chronologically (oldest first)
  // Merge store emails with full thread emails from Gmail
  const threadEmails = useMemo(() => {
    if (!selectedEmail) return [];

    // Start with emails from the store
    const storeEmails = emails.filter((e) => e.threadId === selectedEmail.threadId);

    // Merge with full thread emails. Store versions have analysis/draft info,
    // but may have empty bodies (bulk queries exclude body for performance).
    // Backfill body from fullThreadEmails when the store version lacks it.
    const storeEmailIds = new Set(storeEmails.map((e) => e.id));
    const fullThreadMap = new Map(fullThreadEmails.map((e) => [e.id, e]));
    const mergedEmails = storeEmails.map((e) => {
      const full = fullThreadMap.get(e.id);
      return full && !e.body ? { ...e, body: full.body } : e;
    });

    // Add any emails from fullThreadEmails that aren't in the store.
    // Filter by threadId to prevent stale emails from a previous thread
    // leaking in during the render before the fetch effect fires.
    for (const email of fullThreadEmails) {
      if (!storeEmailIds.has(email.id) && email.threadId === selectedEmail.threadId) {
        mergedEmails.push(email);
      }
    }

    return mergedEmails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [emails, selectedEmail, fullThreadEmails]);

  // Name map for resolving emails → display names across the thread
  const nameMap = useMemo(() => buildNameMap(threadEmails), [threadEmails]);

  // The latest email is the one we're typically replying to
  const latestEmail = threadEmails.length > 0 ? threadEmails[threadEmails.length - 1] : null;

  // The latest RECEIVED email (not sent by user) — used for analysis display
  // so that the user's own sent reply doesn't override the thread's analysis.
  const latestReceivedEmail = useMemo(() => {
    if (!currentUserEmail) return latestEmail;
    const received = threadEmails.filter((e) => {
      const sender = e.from.match(/<(.+?)>/)?.[1] ?? e.from;
      return sender.toLowerCase() !== currentUserEmail.toLowerCase();
    });
    return received.length > 0 ? received[received.length - 1] : latestEmail;
  }, [threadEmails, currentUserEmail, latestEmail]);

  // The email that has an AI-generated draft attached — may differ from latestEmail
  // when the agent drafted on an earlier received email and a sent reply is now the latest.
  const draftEmail = useMemo(() => threadEmails.find((e) => e.draft) ?? null, [threadEmails]);

  // Synchronously update the expansion ref when the thread changes — no setState,
  // no re-render, no discarded render. The ref is already correct for THIS render.
  if (latestEmail?.threadId !== prevExpandedThreadIdRef.current) {
    prevExpandedThreadIdRef.current = latestEmail?.threadId;
    if (threadEmails.length > 0) {
      const firstUnreadIdx = threadEmails.findIndex((e) => e.labelIds?.includes("UNREAD"));
      const isContiguousUnreadToEnd =
        firstUnreadIdx !== -1 &&
        threadEmails.slice(firstUnreadIdx).every((e) => e.labelIds?.includes("UNREAD"));
      const target = isContiguousUnreadToEnd
        ? threadEmails[firstUnreadIdx]
        : threadEmails[threadEmails.length - 1];
      expandedMessagesRef.current = new Set([target.id]);
    } else {
      expandedMessagesRef.current = new Set();
    }
  }

  // Ensure focusedThreadEmailId is always expanded. When UndoSendToast replaces
  // a pending email ID with the real Gmail ID, it updates focusedThreadEmailId
  // in the store but can't update expandedMessagesRef (a local ref). This
  // synchronous render-phase check patches the ref so the email doesn't collapse.
  if (
    focusedThreadEmailId &&
    !expandedMessagesRef.current.has(focusedThreadEmailId) &&
    threadEmails.some((e) => e.id === focusedThreadEmailId)
  ) {
    const newSet = new Set(expandedMessagesRef.current);
    // Remove stale IDs no longer in the thread (e.g. the old pending-* ID)
    for (const id of newSet) {
      if (!threadEmails.some((e) => e.id === id)) {
        newSet.delete(id);
      }
    }
    newSet.add(focusedThreadEmailId);
    expandedMessagesRef.current = newSet;
  }

  useEffect(() => {
    latestEmailRef.current = latestEmail;
  }, [latestEmail]);

  // Listen for n/p keyboard navigation within the thread (dispatched by useKeyboardShortcuts)
  useEffect(() => {
    const handler = (e: Event) => {
      const direction = (e as CustomEvent<string>).detail;
      if (threadEmails.length <= 1) return;

      const currentIdx = focusedThreadEmailId
        ? threadEmails.findIndex((em) => em.id === focusedThreadEmailId)
        : -1;

      let nextIdx: number;
      if (direction === "next") {
        nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, threadEmails.length - 1);
      } else {
        nextIdx = currentIdx < 0 ? threadEmails.length - 1 : Math.max(currentIdx - 1, 0);
      }

      const targetEmail = threadEmails[nextIdx];
      if (!targetEmail) return;

      // Expand the target message and update focus
      const newSet = new Set(expandedMessagesRef.current);
      newSet.add(targetEmail.id);
      expandedMessagesRef.current = newSet;
      setFocusedThreadEmailId(targetEmail.id);
      setExpandedVersion((v) => v + 1);

      // Scroll the message into view
      setTimeout(() => {
        const el = document.querySelector(`[data-email-id="${targetEmail.id}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    };

    window.addEventListener(THREAD_NAV_EVENT, handler);
    return () => window.removeEventListener(THREAD_NAV_EVENT, handler);
  }, [threadEmails, focusedThreadEmailId, setFocusedThreadEmailId]);

  useEffect(() => {
    inlineComposeModeRef.current = inlineComposeMode;
  }, [inlineComposeMode]);

  // The reply target is the latest RECEIVED email (not sent by us).
  // After sending a reply, latestEmail becomes the sent message, but
  // Reply/Forward buttons should still target the last received email
  // so that getReplyInfo can find it in the DB.
  const replyTargetEmailId = useMemo(() => {
    if (!latestEmail) return null;
    const received = threadEmails.filter((e) => !e.labelIds?.includes("SENT"));
    return received.length > 0 ? received[received.length - 1].id : latestEmail.id;
  }, [threadEmails, latestEmail]);

  // Detect tracking numbers and unsubscribe links across thread emails
  const trackingNumbers = useMemo(() => {
    return detectTrackingNumbers(threadEmails.map((e) => e.body ?? "").filter(Boolean));
  }, [threadEmails]);

  const unsubscribeUrl = useMemo(() => {
    return detectUnsubscribeUrl(threadEmails.map((e) => e.body ?? "").filter(Boolean));
  }, [threadEmails]);

  // Save any in-progress reply content as a draft for the current thread.
  // Called when switching threads or when the component unmounts.
  const savePendingDraft = useCallback(() => {
    const content = inlineReplyContentRef.current;
    const email = latestEmailRef.current;
    const mode = inlineComposeModeRef.current;
    if (content?.bodyText.trim() && email) {
      updateEmail(email.id, {
        draft: {
          ...email.draft,
          body: content.bodyText,
          status: "edited",
          createdAt: email.draft?.createdAt ?? Date.now(),
          composeMode: mode ?? undefined,
          ...(content.to !== undefined ? { to: content.to.length ? content.to : undefined } : {}),
          ...(content.cc !== undefined ? { cc: content.cc.length ? content.cc : undefined } : {}),
          ...(content.bcc !== undefined
            ? { bcc: content.bcc.length ? content.bcc : undefined }
            : {}),
        },
      });
      window.api.drafts.save(
        email.id,
        content.bodyText,
        mode ?? undefined,
        content.to,
        content.cc,
        content.bcc,
      );
    }
    inlineReplyContentRef.current = null;
  }, [updateEmail]);

  // Track whether auto-open has fired for the current thread visit
  const autoOpenedThreadRef = useRef<string | null>(null);

  // Reset scroll and inline reply state when switching threads.
  // Expansion is handled synchronously during render (above) to avoid flicker.
  // This layout effect handles scroll position and reply state cleanup.
  useLayoutEffect(() => {
    // Clear stale focus from previous thread immediately
    setFocusedThreadEmailId(null);
    // Cancel any pending post-send scroll from the previous thread
    if (postSendScrollTimeoutRef.current) {
      clearTimeout(postSendScrollTimeoutRef.current);
      postSendScrollTimeoutRef.current = null;
    }
    if (!threadEmails.length) return;

    // Reset scroll position before paint so the previous thread's scroll offset
    // doesn't briefly show content at the wrong position.
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }

    // Set scroll target to the expanded email (same logic as the render-phase expansion above).
    const firstUnreadIdx = threadEmails.findIndex((e) => e.labelIds?.includes("UNREAD"));
    const isContiguousUnreadToEnd =
      firstUnreadIdx !== -1 &&
      threadEmails.slice(firstUnreadIdx).every((e) => e.labelIds?.includes("UNREAD"));
    const target = isContiguousUnreadToEnd
      ? threadEmails[firstUnreadIdx]
      : threadEmails[threadEmails.length - 1];
    setFocusedThreadEmailId(target.id);
    pendingScrollTargetRef.current = target.id;

    // Clear inline reply and errors when switching threads
    setInlineReplyInfo(null);
    setInlineComposeMode(null);
    setInlineReplyToEmailId(null);
    setRestoredDraft(null);
    setInlineReplyOpen(false);
    // Allow auto-open to fire again when returning to this thread
    autoOpenedThreadRef.current = null;
  }, [latestEmail?.threadId, setInlineReplyOpen]);

  // Precompute sanitized HTML for the next few threads so archive-and-advance
  // is instant. Uses requestIdleCallback to avoid blocking the current render.
  useEffect(() => {
    if (!selectedThreadId || currentThreads.length === 0) return;

    const currentIndex = currentThreads.findIndex((t) => t.threadId === selectedThreadId);
    if (currentIndex === -1) return;

    const isDark = useAppStore.getState().resolvedTheme === "dark";
    const cancels: Array<() => void> = [];

    for (let i = 1; i <= 3; i++) {
      const nextThread = currentThreads[currentIndex + i];
      if (!nextThread) break;

      const targetEmail = nextThread.latestEmail;
      const strippedBody = targetEmail.body ? stripLargeDataUris(targetEmail.body, !isDark) : "";
      const isRich = isHtmlContent(strippedBody) && hasRichBackground(strippedBody);
      const useLightMode = !isDark || isRich;

      cancels.push(emailBodyCache.precompute(targetEmail.id, strippedBody, useLightMode));
    }

    return () => {
      cancels.forEach((fn) => fn());
    };
    // Only re-run when the selected thread changes, not on every currentThreads
    // recalculation. currentThreads is intentionally omitted: if the list changes
    // without a thread switch (e.g. new email arrives), the worst case is a cache
    // miss on the next advance — the correct HTML is computed synchronously then.
  }, [selectedThreadId]);

  // Save draft when leaving a thread (thread switch or unmount/deselect)
  useEffect(() => {
    return () => {
      savePendingDraft();
    };
  }, [latestEmail?.threadId, savePendingDraft]);

  // Auto-open the inline reply editor when the selected thread has a draft.
  // This makes viewing a draft feel identical to having composed it yourself —
  // no intermediate preview, just the editor pre-filled with draft content.
  // Uses a ref to ensure we only auto-open once per thread visit (so closing
  // the editor manually doesn't cause it to re-open).
  useEffect(() => {
    if (!draftEmail?.draft?.body || !replyTargetEmailId) return;
    // Don't re-open if already auto-opened for this thread
    if (autoOpenedThreadRef.current === draftEmail.threadId) return;
    // Don't re-open if the editor is already active for this thread
    if (inlineReplyInfo || composeState?.isOpen) return;
    autoOpenedThreadRef.current = draftEmail.threadId ?? null;
    const bodyHtml = draftBodyToHtml(draftEmail.draft.body);
    // Restore the compose mode that was active when the draft was saved
    const mode = draftEmail.draft.composeMode ?? "reply-all";
    openCompose(mode, replyTargetEmailId, {
      bodyHtml,
      bodyText: draftEmail.draft.body,
      to: draftEmail.draft.to,
      cc: draftEmail.draft.cc,
      bcc: draftEmail.draft.bcc,
      skipAutoFocus: true,
    });
  }, [
    draftEmail?.threadId,
    draftEmail?.draft?.body,
    replyTargetEmailId,
    inlineReplyInfo,
    composeState?.isOpen,
    openCompose,
  ]);

  // Scroll to the target email before the browser paints.
  // Runs after the expansion layout effect triggers a sync re-render with the expanded content in the DOM.
  useLayoutEffect(() => {
    const targetId = pendingScrollTargetRef.current;
    if (!targetId) return;
    if (!expandedMessagesRef.current.has(targetId)) return; // wait for expansion re-render

    pendingScrollTargetRef.current = null;
    const container = scrollContainerRef.current;
    const el = container?.querySelector(`[data-email-id="${targetId}"]`);
    if (el && container) {
      el.scrollIntoView({ behavior: "instant", block: "start" });
      // Record anchor so we can preserve position when the full thread loads
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      scrollAnchorRef.current = {
        emailId: targetId,
        scrollOffset: elRect.top - containerRect.top + container.scrollTop,
      };
    }
  }, [latestEmail?.threadId]);

  // Preserve scroll position when threadEmails changes (e.g. fullThreadEmails loads and inserts
  // new messages above the email being read). Adjusts scrollTop so the anchored email doesn't move.
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container) return;

    const el = container.querySelector(`[data-email-id="${anchor.emailId}"]`);
    if (!el) return;

    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const currentOffset = elRect.top - containerRect.top + container.scrollTop;
    const diff = currentOffset - anchor.scrollOffset;
    if (diff !== 0) {
      container.scrollTop += diff;
    }
    scrollAnchorRef.current = { emailId: anchor.emailId, scrollOffset: currentOffset };
  }, [threadEmails]);

  // Handle inline reply/forward in full view mode.
  // Computes reply info locally from the email data already in the store so the
  // reply pane opens instantly. The Gmail Message-ID/References headers (needed
  // for proper email threading) are fetched asynchronously and patched in before
  // send time — they don't affect the visible UI.
  const composeRequestIdRef = useRef(0);
  useEffect(() => {
    if (isFullView && composeState?.isOpen && composeState.replyToEmailId && currentAccountId) {
      const mode = composeState.mode;
      if (mode === "reply" || mode === "reply-all" || mode === "forward") {
        const requestId = ++composeRequestIdRef.current;
        // Read fresh values from the store snapshot rather than closures so they
        // don't need to be in the dependency array (this effect is event-driven
        // by composeState, not reactive to email/account changes).
        const storeState = useAppStore.getState();
        const storeEmails = storeState.emails;
        const acct = storeState.accounts.find((a) => a.id === currentAccountId);
        const userEmail = acct?.email;
        // Find the email in the thread that has a draft (may not be the latest)
        const threadId = storeEmails.find((e) => e.id === composeState.replyToEmailId)?.threadId;
        const threadDraftEmail = threadId
          ? storeEmails.find((e) => e.threadId === threadId && e.draft?.body)
          : undefined;

        // Capture restored draft before closeCompose clears composeState.
        // If no explicit restoredDraft, check if the email already has a saved draft to restore.
        let restored = composeState.restoredDraft ?? null;
        if (!restored && threadDraftEmail?.draft?.body) {
          restored = {
            bodyHtml: draftBodyToHtml(threadDraftEmail.draft.body),
            bodyText: threadDraftEmail.draft.body,
            to: threadDraftEmail.draft.to,
            cc: threadDraftEmail.draft.cc,
            bcc: threadDraftEmail.draft.bcc,
          };
        }
        setRestoredDraft(restored);
        setInlineComposeMode(mode);
        setInlineReplyToEmailId(composeState.replyToEmailId);

        // Compute reply info locally from the email already in the store —
        // no IPC round-trip needed. The reply pane opens instantly.
        const replyEmail = storeEmails.find((e) => e.id === composeState.replyToEmailId);
        if (replyEmail && replyEmail.body) {
          const localReplyInfo = computeLocalReplyInfo(replyEmail, mode, userEmail);
          setInlineReplyInfo(localReplyInfo);
          setInlineReplyOpen(true);
          setIsLoadingReplyInfo(false);
          closeCompose();

          // Fetch proper Message-ID/References headers in the background.
          // These only matter at send time for Gmail threading — the UI is
          // already fully interactive without them.
          window.api.compose
            .getReplyInfo(composeState.replyToEmailId, mode, currentAccountId)
            .then((response: IpcResponse<ReplyInfo | null>) => {
              if (requestId !== composeRequestIdRef.current) return;
              if (response.success && response.data) {
                setInlineReplyInfo((prev) =>
                  prev
                    ? {
                        ...prev,
                        inReplyTo: response.data!.inReplyTo,
                        references: response.data!.references,
                      }
                    : prev,
                );
              }
            })
            .catch(() => {
              // Non-critical — the email ID fallback for inReplyTo/references
              // still works for threading, just less reliably.
            });
        } else {
          // Email not in store (edge case: search result or archived email).
          // Fall back to the IPC call.
          setIsLoadingReplyInfo(true);
          window.api.compose
            .getReplyInfo(composeState.replyToEmailId, mode, currentAccountId)
            .then((response: IpcResponse<ReplyInfo | null>) => {
              if (requestId !== composeRequestIdRef.current) return;
              if (!response.success || !response.data) {
                setInlineComposeMode(null);
                setInlineReplyToEmailId(null);
                return;
              }
              setInlineReplyInfo(response.data);
              setInlineReplyOpen(true);
            })
            .finally(() => {
              if (requestId !== composeRequestIdRef.current) return;
              setIsLoadingReplyInfo(false);
              closeCompose();
            });
        }
      }
    }
  }, [isFullView, composeState, currentAccountId, closeCompose, setInlineReplyOpen]);

  // Safety net: if we're in full view with no valid email and no compose open,
  // fall back to split view so the email list becomes visible. This catches edge
  // cases like background sync removing the viewed email, or race conditions
  // between archive/trash and viewMode updates. Deferred via rAF to avoid
  // false positives from transient state during multi-step store updates
  // (e.g. undo-send calls removeEmails + setViewMode + openCompose separately).
  const composeIsOpen = composeState?.isOpen ?? false;
  useEffect(() => {
    if (isFullView && !selectedEmail && !composeIsOpen) {
      const id = requestAnimationFrame(() => {
        // Don't reset while a DB fallback fetch is in progress — the email
        // may not be in the store yet but will arrive shortly (e.g. navigating
        // to a search result or archived email).
        if (isFetchingFallbackEmailRef.current) return;
        const s = useAppStore.getState();
        if (s.viewMode === "full" && !s.composeState?.isOpen) {
          // Check both: selectedEmailId is null, OR the email no longer
          // exists in the store. The latter catches cases where an email was
          // removed (by sync, setEmails, removeEmails, etc.) but
          // selectedEmailId wasn't cleared.
          const emailGone = !s.selectedEmailId || !s.emails.some((e) => e.id === s.selectedEmailId);
          if (emailGone) {
            useAppStore.setState({
              viewMode: "split",
              selectedEmailId: null,
              selectedThreadId: null,
            });
          }
        }
      });
      return () => cancelAnimationFrame(id);
    }
  }, [isFullView, selectedEmail, composeIsOpen]);

  const handleInlineReplySent = (sentInfo: SentMessageInfo) => {
    trackEvent("email_sent", {
      type: inlineComposeMode ?? "unknown",
      has_attachments: (sentInfo.attachments?.length ?? 0) > 0,
    });
    // Add the sent email to the store optimistically.
    // Always use the current thread's threadId so forwards appear in the
    // thread view alongside the original email, just like replies do.
    if (currentAccountId && currentUserEmail) {
      const sentEmail: DashboardEmail = {
        id: sentInfo.id,
        threadId: selectedEmail?.threadId ?? sentInfo.threadId,
        accountId: currentAccountId,
        from: currentUserEmail,
        to: sentInfo.to.join(", "),
        cc: sentInfo.cc?.join(", "),
        bcc: sentInfo.bcc?.join(", "),
        subject: sentInfo.subject,
        snippet: sentInfo.snippet,
        body: sentInfo.body,
        date: new Date().toISOString(),
        isUnread: false,
        labelIds: ["SENT"],
        ...(sentInfo.attachments?.length ? { attachments: sentInfo.attachments } : {}),
      };
      addEmails([sentEmail]);
      // Keep this thread in its current position for a grace period so the user
      // can naturally move to the next email without the list jumping.
      addRecentlyRepliedThread(sentEmail.threadId);

      // Focus, expand, and scroll to the just-sent email so the user sees it immediately
      expandedMessagesRef.current = new Set([...expandedMessagesRef.current, sentInfo.id]);
      setExpandedVersion((v) => v + 1);
      setFocusedThreadEmailId(sentInfo.id);
      // Scroll after React commits the re-render with the new email in the DOM.
      // We can't use pendingScrollTargetRef here because the scroll useLayoutEffect's
      // dependency (latestEmail?.threadId) doesn't change within the same thread.
      const scrollToId = sentInfo.id;
      if (postSendScrollTimeoutRef.current) clearTimeout(postSendScrollTimeoutRef.current);
      postSendScrollTimeoutRef.current = setTimeout(() => {
        postSendScrollTimeoutRef.current = null;
        const el = scrollContainerRef.current?.querySelector(`[data-email-id="${scrollToId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 0);
    }

    // Clear the saved draft since the reply has been sent
    if (draftEmail) {
      updateEmail(draftEmail.id, { draft: undefined });
    }

    inlineReplyContentRef.current = null;
    setInlineReplyInfo(null);
    setInlineComposeMode(null);
    setInlineReplyToEmailId(null);
    setRestoredDraft(null);
    setInlineReplyOpen(false);
    // Also trigger sync to ensure we have the canonical version
    if (currentAccountId) {
      window.api.sync.now(currentAccountId);
    }
  };

  const handleInlineReplyCancel = useCallback(() => {
    savePendingDraft();
    setInlineReplyInfo(null);
    setInlineComposeMode(null);
    setInlineReplyToEmailId(null);
    setRestoredDraft(null);
    setInlineReplyOpen(false);
  }, [savePendingDraft, setInlineReplyOpen]);

  // React to external close of inline reply (e.g. keyboard shortcut sets isInlineReplyOpen to false)
  useEffect(() => {
    if (!isInlineReplyOpen && inlineReplyInfo) {
      handleInlineReplyCancel();
    }
  }, [isInlineReplyOpen, inlineReplyInfo, handleInlineReplyCancel]);

  const handleDiscardDraft = useCallback(() => {
    if (draftEmail) {
      updateEmail(draftEmail.id, { draft: undefined });
      window.api.drafts.save(draftEmail.id, "");
    }
    // Clear inline reply content ref so cancel handler won't re-save the draft
    inlineReplyContentRef.current = null;
    // Close the inline reply if it's open
    setInlineReplyInfo(null);
    setInlineComposeMode(null);
    setInlineReplyToEmailId(null);
    setRestoredDraft(null);
    setInlineReplyOpen(false);
  }, [draftEmail, updateEmail, setInlineReplyOpen]);

  const handleNewEmailSent = () => {
    // If this was a local draft, remove it now that it's been sent
    const localDraftId = composeState?.restoredDraft?.localDraftId;
    if (localDraftId) {
      removeLocalDraft(localDraftId);
      window.api.compose.deleteLocalDraft(localDraftId);
    }
    closeCompose();
    setViewMode("split");
    // Trigger sync to get the sent message
    if (currentAccountId) {
      window.api.sync.now(currentAccountId);
    }
  };

  const handleNewEmailCancel = async (formState: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    bodyHtml: string;
    bodyText: string;
  }) => {
    const hasContent =
      formState.to.length > 0 ||
      formState.subject.trim() ||
      formState.bodyText.trim() ||
      formState.bodyHtml.replace(/<[^>]*>/g, "").trim();
    const existingDraftId = composeState?.restoredDraft?.localDraftId;

    if (hasContent && currentAccountId) {
      if (existingDraftId) {
        // Update existing draft with current form state
        await window.api.compose.updateLocalDraft(existingDraftId, {
          to: formState.to,
          cc: formState.cc.length > 0 ? formState.cc : undefined,
          bcc: formState.bcc.length > 0 ? formState.bcc : undefined,
          subject: formState.subject,
          bodyHtml: formState.bodyHtml,
          bodyText: formState.bodyText,
        } as Record<string, unknown>);
        // Update in store too
        useAppStore.getState().updateLocalDraft(existingDraftId, {
          to: formState.to,
          cc: formState.cc.length > 0 ? formState.cc : undefined,
          bcc: formState.bcc.length > 0 ? formState.bcc : undefined,
          subject: formState.subject,
          bodyHtml: formState.bodyHtml,
          bodyText: formState.bodyText,
          updatedAt: Date.now(),
        });
      } else {
        // Save new draft
        const result = (await window.api.compose.saveLocalDraft({
          accountId: currentAccountId,
          to: formState.to,
          cc: formState.cc.length > 0 ? formState.cc : undefined,
          bcc: formState.bcc.length > 0 ? formState.bcc : undefined,
          subject: formState.subject,
          bodyHtml: formState.bodyHtml,
          bodyText: formState.bodyText,
        })) as IpcResponse<LocalDraft>;
        if (result.success && result.data) {
          addLocalDraft(result.data);
        }
      }
    }

    closeCompose();
    setViewMode("split");
  };

  const handleNewEmailDiscard = () => {
    const localDraftId = composeState?.restoredDraft?.localDraftId;
    if (localDraftId) {
      removeLocalDraft(localDraftId);
      window.api.compose.deleteLocalDraft(localDraftId);
    }
    closeCompose();
    setViewMode("split");
  };

  // Show new email compose view when in "new" compose mode
  if (composeState?.isOpen && composeState.mode === "new" && currentAccountId) {
    return (
      <NewEmailCompose
        accountId={currentAccountId}
        onSend={handleNewEmailSent}
        onCancel={handleNewEmailCancel}
        onDiscard={handleNewEmailDiscard}
        initialDraft={composeState.restoredDraft}
      />
    );
  }

  if (!selectedEmail || !latestEmail) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-800/50">
        <p className="text-gray-400 dark:text-gray-500">Select an email to view</p>
      </div>
    );
  }

  const toggleMessage = (emailId: string) => {
    const set = expandedMessagesRef.current;
    const wasExpanded = set.has(emailId);
    const newSet = new Set(set);
    if (newSet.has(emailId)) {
      newSet.delete(emailId);
    } else {
      newSet.add(emailId);
    }
    expandedMessagesRef.current = newSet;
    setExpandedVersion((v) => v + 1);
    if (!wasExpanded) {
      setFocusedThreadEmailId(emailId);
    } else if (focusedThreadEmailId === emailId) {
      setFocusedThreadEmailId(null);
    }
  };

  // Decode HTML entities (Gmail API returns subjects with entities like &#39;)
  const decodeHtmlEntities = (text: string): string => {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  };
  const oldestEmail = threadEmails[0] || latestEmail;
  // Strip Re: if the oldest email is a reply (has inReplyTo, or subject starts
  // with Re: for pre-backfill data). Fwd: is never stripped — a forward IS
  // the original from the recipient's perspective.
  const cleanSubject = decodeHtmlEntities(
    oldestEmail.inReplyTo || /^Re:\s/i.test(oldestEmail.subject)
      ? oldestEmail.subject.replace(/^(Re:\s*)+/i, "")
      : oldestEmail.subject,
  );

  const handleBackToSplit = () => {
    setViewMode("split");
  };

  const isStarred = threadEmails.some((e) => e.labelIds?.includes("STARRED"));

  const handleArchive = () => {
    if (!currentAccountId || !selectedThreadId) return;
    const emailIds = threadEmails.map((e) => e.id);

    // Find next thread before removing
    const currentIndex = currentThreads.findIndex((t) => t.threadId === selectedThreadId);
    const remainingThreads = currentThreads.filter((t) => t.threadId !== selectedThreadId);

    // Atomically remove from UI and advance to next thread in one render
    if (remainingThreads.length > 0) {
      const nextIndex = Math.min(Math.max(currentIndex, 0), remainingThreads.length - 1);
      const nextThread = remainingThreads[nextIndex];
      if (nextThread) markThreadAsRead(nextThread.threadId);
      removeEmailsAndAdvance(
        emailIds,
        nextThread?.threadId ?? null,
        nextThread?.latestEmail.id ?? null,
      );
    } else {
      removeEmailsAndAdvance(emailIds, null, null);
      if (isFullView) setViewMode("split");
    }

    // Queue the action with undo support (actual IPC call happens after delay)
    addUndoAction({
      id: `archive-${selectedThreadId}-${Date.now()}`,
      type: "archive",
      threadCount: 1,
      accountId: currentAccountId,
      emails: [...threadEmails],
      scheduledAt: Date.now(),
      delayMs: 5000,
    });
  };

  const handleTrash = () => {
    if (!currentAccountId || !selectedThreadId) return;
    const emailIds = threadEmails.map((e) => e.id);

    // Find next thread before removing (same auto-advance as archive)
    const currentIndex = currentThreads.findIndex((t) => t.threadId === selectedThreadId);
    const remainingThreads = currentThreads.filter((t) => t.threadId !== selectedThreadId);

    // Atomically remove from UI and advance to next thread in one render
    if (remainingThreads.length > 0) {
      const nextIndex = Math.min(Math.max(currentIndex, 0), remainingThreads.length - 1);
      const nextThread = remainingThreads[nextIndex];
      if (nextThread) markThreadAsRead(nextThread.threadId);
      removeEmailsAndAdvance(
        emailIds,
        nextThread?.threadId ?? null,
        nextThread?.latestEmail.id ?? null,
      );
    } else {
      removeEmailsAndAdvance(emailIds, null, null);
      if (isFullView) setViewMode("split");
    }

    // Queue the action with undo support
    addUndoAction({
      id: `trash-${selectedThreadId}-${Date.now()}`,
      type: "trash",
      threadCount: 1,
      accountId: currentAccountId,
      emails: [...threadEmails],
      scheduledAt: Date.now(),
      delayMs: 5000,
    });
  };

  const handleMarkUnread = () => {
    if (!currentAccountId || !latestEmail) return;
    const currentLabels = latestEmail.labelIds || ["INBOX"];

    // Optimistic update + undo — only if email was actually modified
    if (!currentLabels.includes("UNREAD")) {
      const previousLabels: Record<string, string[]> = { [latestEmail.id]: [...currentLabels] };
      updateEmail(latestEmail.id, { labelIds: [...currentLabels, "UNREAD"] });
      addUndoAction({
        id: `mark-unread-${selectedThreadId}-${Date.now()}`,
        type: "mark-unread",
        threadCount: 1,
        accountId: currentAccountId,
        emails: [latestEmail],
        scheduledAt: Date.now(),
        delayMs: 5000,
        previousLabels,
      });
    }
    setSelectedEmailId(null);
    if (isFullView) setViewMode("split");
  };

  const handleToggleStar = () => {
    if (!currentAccountId || !latestEmail) return;
    const newStarred = !isStarred;
    const changedEmails: typeof threadEmails = [];
    const previousLabels: Record<string, string[]> = {};

    if (newStarred) {
      // Star the latest email
      const currentLabels = latestEmail.labelIds || ["INBOX"];
      if (!currentLabels.includes("STARRED")) {
        previousLabels[latestEmail.id] = [...currentLabels];
        updateEmail(latestEmail.id, { labelIds: [...currentLabels, "STARRED"] });
        changedEmails.push(latestEmail);
      }
    } else {
      // Unstar all starred emails in the thread
      const starredEmails = threadEmails.filter((e) => e.labelIds?.includes("STARRED"));
      for (const email of starredEmails) {
        const currentLabels = email.labelIds || [];
        previousLabels[email.id] = [...currentLabels];
        const newLabels = currentLabels.filter((l: string) => l !== "STARRED");
        updateEmail(email.id, { labelIds: newLabels });
        changedEmails.push(email);
      }
    }

    if (changedEmails.length > 0) {
      addUndoAction({
        id: `${newStarred ? "star" : "unstar"}-${selectedThreadId}-${Date.now()}`,
        type: newStarred ? "star" : "unstar",
        threadCount: 1,
        accountId: currentAccountId,
        emails: changedEmails,
        scheduledAt: Date.now(),
        delayMs: 5000,
        previousLabels,
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-gray-800 overflow-hidden">
      {/* Back button for full view */}
      {isFullView && (
        <div className="h-10 px-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center flex-shrink-0">
          <button
            onClick={handleBackToSplit}
            className="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back
          </button>
        </div>
      )}

      {/* Single scroll container for entire thread */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {/* Thread header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 dark:border-gray-700/50">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                {cleanSubject}
              </h1>
              {threadEmails.length > 1 && (
                <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
                  {threadEmails.length} messages
                </p>
              )}
            </div>
            <div className="flex items-center ml-4 flex-shrink-0">
              <div className="flex items-center">
                <button
                  onClick={handleArchive}
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                  title="Archive"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M5 8h14M5 8a2 2 0 01-2-2V4a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                    />
                  </svg>
                </button>
                <button
                  onClick={handleTrash}
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                  title="Delete"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
                <button
                  onClick={handleMarkUnread}
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                  title="Mark as unread"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
                    />
                  </svg>
                </button>
                <button
                  onClick={handleToggleStar}
                  className={`p-1.5 rounded transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${
                    isStarred
                      ? "text-yellow-400 hover:text-yellow-500"
                      : "text-gray-400 dark:text-gray-500 hover:text-yellow-400"
                  }`}
                  title={isStarred ? "Unstar" : "Star"}
                >
                  <svg
                    className="w-4 h-4"
                    fill={isStarred ? "currentColor" : "none"}
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
                    />
                  </svg>
                </button>
                {/* Snooze button */}
                <button
                  onClick={() => setShowSnoozeMenu(!showSnoozeMenu)}
                  className={`p-1.5 rounded transition-colors ${
                    snoozedThreads.has(latestEmail.threadId)
                      ? "text-amber-500 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                      : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                  title={snoozedThreads.has(latestEmail.threadId) ? "Snoozed" : "Snooze (h)"}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </button>
              </div>
              <div className="w-px h-4 bg-gray-200 dark:bg-gray-600 mx-1" />
              <div className="flex items-center">
                <button
                  onClick={() =>
                    openCompose(
                      "reply-all",
                      focusedThreadEmailId ?? replyTargetEmailId ?? latestEmail.id,
                    )
                  }
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                  title="Reply All"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M7 10h8a8 8 0 018 8v2M7 10l6 6m-6-6l6-6"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M3 14l4-4-4-4"
                    />
                  </svg>
                </button>
                <button
                  onClick={() =>
                    openCompose(
                      "forward",
                      focusedThreadEmailId ?? replyTargetEmailId ?? latestEmail.id,
                    )
                  }
                  className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                  title="Forward"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M14 5l7 7m0 0l-7 7m7-7H3"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Snooze banner */}
        {snoozedThreads.has(latestEmail.threadId) &&
          currentAccountId &&
          (() => {
            const snoozeInfo = snoozedThreads.get(latestEmail.threadId);
            return snoozeInfo ? (
              <div className="px-6 py-2.5 border-b border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <svg
                    className="w-4 h-4 text-amber-500 dark:text-amber-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span className="text-sm text-amber-700 dark:text-amber-300">
                    Snoozed until {formatSnoozeTime(snoozeInfo.snoozeUntil)}
                  </span>
                </div>
                <button
                  onClick={async () => {
                    await window.api.snooze.unsnooze(latestEmail.threadId, currentAccountId);
                    removeSnoozedThread(latestEmail.threadId);
                  }}
                  className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 font-medium"
                >
                  Unsnooze
                </button>
              </div>
            ) : null;
          })()}

        {/* Action buttons (Track Package, Unsubscribe) */}
        {(trackingNumbers.length > 0 || unsubscribeUrl) && (
          <div className="px-6 py-2.5 border-b border-gray-100 flex items-center gap-2 flex-wrap">
            {trackingNumbers.map((t, i) => (
              <button
                key={i}
                onClick={() => window.open(t.url, "_blank")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-full transition-colors"
                title={`Track ${t.carrier} package ${t.trackingNumber}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                  />
                </svg>
                Track {t.carrier} Package
              </button>
            ))}
            {unsubscribeUrl && (
              <button
                onClick={() => window.open(unsubscribeUrl!, "_blank")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors"
                title="Unsubscribe from this mailing list"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                  />
                </svg>
                Unsubscribe
              </button>
            )}
          </div>
        )}

        {/* Thread messages - single scroll, no nested scrolls */}
        <div className="px-6">
          {threadEmails.map((email) => (
            <div key={email.id} data-email-id={email.id}>
              <ThreadMessage
                email={email}
                isExpanded={expandedMessagesRef.current.has(email.id)}
                isFocused={focusedThreadEmailId === email.id}
                onToggle={() => toggleMessage(email.id)}
                onReply={() => openCompose("reply", email.id)}
                onReplyAll={() => openCompose("reply-all", email.id)}
                onForward={() => openCompose("forward", email.id)}
                currentUserEmail={currentUserEmail}
                accountId={currentAccountId ?? undefined}
                threadEmails={threadEmails}
                onPreviewAttachment={(attachment, data) =>
                  setPreviewAttachment({ attachment, data })
                }
              />
              {/* Loading indicator for inline reply — stays inside map for positioning */}
              {inlineReplyToEmailId === email.id && isLoadingReplyInfo && (
                <div className="py-4 text-sm text-gray-500 dark:text-gray-400">Loading...</div>
              )}
              {/* Inline reply/forward — rendered inside the map right below the email being replied to.
                  When undo-send replaces an optimistic email ID, UndoSendToast atomically updates
                  inlineReplyToEmailId in the store so this condition keeps matching. */}
              {inlineReplyToEmailId === email.id &&
                inlineReplyInfo &&
                currentAccountId &&
                currentUserEmail &&
                inlineComposeMode && (
                  <InlineReply
                    key={`${inlineComposeMode}-${inlineReplyToEmailId}`}
                    replyInfo={inlineReplyInfo}
                    accountId={currentAccountId}
                    accountEmail={currentUserEmail}
                    composeMode={inlineComposeMode}
                    replyToEmailId={inlineReplyToEmailId}
                    onSend={handleInlineReplySent}
                    onCancel={handleInlineReplyCancel}
                    onContentChange={(content) => {
                      inlineReplyContentRef.current = {
                        ...inlineReplyContentRef.current,
                        ...content,
                      };
                    }}
                    onToChange={(to) => {
                      if (inlineReplyContentRef.current) {
                        inlineReplyContentRef.current.to = to;
                      } else {
                        inlineReplyContentRef.current = { bodyHtml: "", bodyText: "", to };
                      }
                    }}
                    onCcChange={(cc) => {
                      if (inlineReplyContentRef.current) {
                        inlineReplyContentRef.current.cc = cc;
                      } else {
                        inlineReplyContentRef.current = { bodyHtml: "", bodyText: "", cc };
                      }
                    }}
                    onBccChange={(bcc) => {
                      if (inlineReplyContentRef.current) {
                        inlineReplyContentRef.current.bcc = bcc;
                      } else {
                        inlineReplyContentRef.current = { bodyHtml: "", bodyText: "", bcc };
                      }
                    }}
                    restoredDraft={restoredDraft}
                    draftEmailId={
                      draftEmail?.draft && draftEmail.draft.status !== "edited"
                        ? draftEmail.id
                        : undefined
                    }
                    onDiscardDraft={handleDiscardDraft}
                    nameMap={nameMap}
                  />
                )}
            </div>
          ))}
        </div>

        {/* Analysis section with priority override — uses latestReceivedEmail
             so the user's own sent reply doesn't override the thread's analysis */}
        {latestReceivedEmail?.analysis && (
          <AnalysisPrioritySection
            email={latestReceivedEmail}
            onAnalysisUpdated={(newNeedsReply, newPriority) => {
              updateEmail(latestReceivedEmail.id, {
                analysis: {
                  ...latestReceivedEmail.analysis!,
                  needsReply: newNeedsReply,
                  priority: (newPriority as "high" | "medium" | "low" | "skip" | null) ?? undefined,
                },
              });
            }}
          />
        )}
      </div>

      {/* Attachment preview modal */}
      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment.attachment}
          data={previewAttachment.data}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </div>
  );
}
