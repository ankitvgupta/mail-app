import DOMPurify from "dompurify";
import { stripLargeDataUris as stripLargeDataUrisShared } from "../../shared/body-sanitizer";

/**
 * Checks if content appears to be HTML.
 * Re-exported so EmailDetail.tsx can use the same check for theme decisions
 * without duplicating the implementation.
 */
export function isHtmlContent(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
}

/**
 * Detects HTML that is essentially plain text in a minimal wrapper — the actual
 * line breaks are \n characters rather than <br>, <p>, or block-level elements.
 */
function isPlainTextInHtml(html: string): boolean {
  if (/<(?:br|p|blockquote|table|pre|h[1-6])[\s/>]/i.test(html)) return false;
  const divCount = (html.match(/<div[\s>]/gi) || []).length;
  if (divCount > 3) return false;
  const textContent = html.replace(/<[^>]*>/g, "");
  return (textContent.match(/\n/g) || []).length >= 2;
}

/**
 * Detect whether HTML email has its own background colors (rich marketing emails).
 * Re-exported so EmailDetail.tsx can use it for theme decisions.
 *
 * White/transparent backgrounds are excluded — many email clients set an explicit
 * `background-color: white` or `bgcolor="#ffffff"` which is just the default, not
 * an indicator of rich styling.
 */
export function hasRichBackground(html: string): boolean {
  const isDefaultBg = (value: string): boolean => {
    const v = value.trim().toLowerCase();
    return (
      v === "white" ||
      v === "#fff" ||
      v === "#ffffff" ||
      v === "transparent" ||
      v === "none" ||
      v === "inherit" ||
      v === "initial" ||
      v === "unset" ||
      /^rgba?\s*\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*[\d.]+)?\s*\)$/.test(v)
    );
  };

  // Check bgcolor HTML attributes for non-white colors
  for (const m of html.matchAll(/bgcolor\s*=\s*["']?([^"'>;]+)["']?/gi)) {
    if (!isDefaultBg(m[1])) return true;
  }
  // Check background-color CSS declarations for non-white colors
  for (const m of html.matchAll(/background-color\s*:\s*([^;}"'!]+)/gi)) {
    if (!isDefaultBg(m[1])) return true;
  }
  // Check background shorthand CSS declarations for non-white colors.
  // Skip url() values — background images (e.g. tracking pixels) aren't "rich" backgrounds.
  for (const m of html.matchAll(/background\s*:\s*([^;}"'!]+)/gi)) {
    const val = m[1].trim().toLowerCase();
    if (/^url\(/.test(val)) continue;
    if (!isDefaultBg(m[1])) return true;
  }

  return false;
}

/**
 * Replace inline data: URIs larger than ~50KB with a lightweight SVG placeholder.
 * Emails can contain multi-MB base64 images/videos that make DOMParser,
 * DOMPurify, and iframe rendering extremely slow. Call this before any heavy
 * processing (quote splitting, sanitization, rendering).
 *
 * Exported so EmailDetail can strip once and pass the light body to both
 * splitQuotedContent and EmailBodyRenderer.
 */
export function stripLargeDataUris(body: string, useLightMode = true): string {
  // Delegates to the shared (linear, case-insensitive) matcher — see
  // shared/body-sanitizer.ts — passing theme-aware placeholder colors so the
  // display placeholder matches the current light/dark mode.
  return stripLargeDataUrisShared(
    body,
    useLightMode
      ? { fill: "#f3f4f6", textFill: "#6b7280" }
      : { fill: "#374151", textFill: "#9ca3af" },
  );
}

const SANITIZE_CONFIG = {
  WHOLE_DOCUMENT: false,
  ALLOWED_TAGS: [
    "p",
    "br",
    "div",
    "span",
    "a",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "table",
    "tr",
    "td",
    "th",
    "thead",
    "tbody",
    "tfoot",
    "img",
    "blockquote",
    "pre",
    "code",
    "hr",
    "center",
    "font",
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "aside",
    "style",
  ],
  ALLOWED_ATTR: [
    "href",
    "src",
    "alt",
    "title",
    "style",
    "class",
    "id",
    "target",
    "width",
    "height",
    "border",
    "cellpadding",
    "cellspacing",
    "align",
    "valign",
    "bgcolor",
    "color",
    "face",
    "size",
    "type",
  ],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|data|cid):)/i,
};

function buildIframeHtml(
  sanitizedBody: string,
  useLightMode: boolean,
  needsPreLine: boolean,
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <base target="_blank">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: ${useLightMode ? "#374151" : "#e5e7eb"};
      background: ${useLightMode ? "transparent" : "#1f2937"};
      margin: 0;
      padding: 0;
      word-break: break-word;${needsPreLine ? "\n      white-space: pre-line;" : ""}
    }
    img { max-width: 100%; height: auto; display: block; }
    a { color: ${useLightMode ? "#3b82f6" : "#60a5fa"}; }
    table { max-width: 100%; border-collapse: collapse; }
    td, th { vertical-align: top; }
    blockquote { margin: 0; padding-left: 12px; border-left: 2px solid ${useLightMode ? "#e5e7eb" : "#4b5563"}; color: ${useLightMode ? "#6b7280" : "#9ca3af"}; }
    ${
      !useLightMode
        ? `
    /* Override inline styles that assume a white background.
       Only applied in dark-content mode (non-rich HTML emails). */
    body, div, p, span, td, th, li, font, h1, h2, h3, h4, h5, h6 {
      color: #e5e7eb !important;
    }
    div, p, span, td, th, li, font, h1, h2, h3, h4, h5, h6,
    table, tr, thead, tbody, tfoot, center, blockquote, pre {
      background-color: transparent !important;
    }
    blockquote, blockquote * { color: #9ca3af !important; background-color: transparent !important; }
    a { color: #60a5fa !important; }
    `
        : ""
    }
  </style>
</head>
<body>${sanitizedBody}</body>
</html>`;
}

export type SanitizedResult =
  | {
      isHtml: true;
      htmlContent: string;
    }
  | {
      isHtml: false;
      htmlContent: null;
    };

/**
 * LRU cache for pre-sanitized email body HTML. Stores the complete iframe HTML
 * document (DOMPurify output + CSS) so switching between emails doesn't
 * re-sanitize each time.
 *
 * Cache key: `${emailId}:${lightMode}` — different themes produce different CSS,
 * so each theme variant is cached separately.
 */
class EmailBodyCache {
  private cache = new Map<string, SanitizedResult>();
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  private makeKey(emailId: string, useLightMode: boolean): string {
    return `${emailId}:${useLightMode ? "l" : "d"}`;
  }

  /**
   * Get cached sanitized HTML, or compute + cache it synchronously.
   *
   * The cache key is `emailId:lightMode` — `body` is only used on cache miss
   * to compute the result. This is correct because Gmail message bodies are
   * immutable: the body for a given emailId never changes.
   */
  getOrCompute(emailId: string, body: string, useLightMode: boolean): SanitizedResult {
    const key = this.makeKey(emailId, useLightMode);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Move to end for LRU freshness
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const result = this.compute(body, useLightMode);
    this.set(key, result);
    return result;
  }

  /**
   * Check if a result is already cached.
   */
  has(emailId: string, useLightMode: boolean): boolean {
    return this.cache.has(this.makeKey(emailId, useLightMode));
  }

  /**
   * Precompute sanitized HTML in the background without blocking the current render.
   * Uses requestIdleCallback where available, falls back to setTimeout(0).
   * Returns a cancel function so callers can clean up stale precompute requests
   * (e.g., in a useEffect cleanup when the user rapidly switches threads).
   */
  precompute(emailId: string, body: string, useLightMode: boolean): () => void {
    const key = this.makeKey(emailId, useLightMode);
    if (this.cache.has(key)) return () => {};

    const useIdleCallback = typeof requestIdleCallback === "function";

    const handle: number = useIdleCallback
      ? requestIdleCallback(() => {
          if (this.cache.has(key)) return;
          const result = this.compute(body, useLightMode);
          this.set(key, result);
        })
      : window.setTimeout(() => {
          if (this.cache.has(key)) return;
          const result = this.compute(body, useLightMode);
          this.set(key, result);
        }, 0);

    return () => {
      if (useIdleCallback) {
        cancelIdleCallback(handle);
      } else {
        clearTimeout(handle);
      }
    };
  }

  /**
   * Invalidate cached entries for an email.
   */
  invalidate(emailId: string): void {
    const toDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${emailId}:`)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private set(key: string, value: SanitizedResult): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first in Map iteration order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  private compute(body: string, useLightMode: boolean): SanitizedResult {
    if (!isHtmlContent(body)) {
      return { isHtml: false, htmlContent: null };
    }

    const stripped = stripLargeDataUris(body, useLightMode);

    const needsPreLine = isPlainTextInHtml(stripped);
    const clean = DOMPurify.sanitize(stripped, SANITIZE_CONFIG);
    const htmlContent = buildIframeHtml(clean, useLightMode, needsPreLine);

    return { isHtml: true, htmlContent };
  }
}

/** Singleton cache instance shared across all EmailBodyRenderer components */
export const emailBodyCache = new EmailBodyCache();
