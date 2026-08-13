/**
 * Pure HTML-to-text helpers used by the agent worker. Kept dependency-free
 * so importing from the utility process doesn't drag in electron/better-sqlite3
 * via the db module — @electron-toolkit/utils dereferences `electron.app` at
 * module load time, which is undefined in utility processes.
 */

/** Decode HTML entities including numeric (&#NNN; / &#xHH;) for agent-facing text. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "\uFFFD";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "\uFFFD";
    })
    .replace(/&[#\w]+;/gi, " ");
}

/**
 * Convert HTML to plain text for AI agent consumption.
 * Preserves paragraph breaks and decodes all HTML entities (including numeric).
 * Use this instead of stripHtmlForSearch when the text will be read by an LLM.
 */
export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // remove style blocks
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") // remove script blocks
      .replace(/<br\s*\/?>/gi, "\n") // <br> → newline
      .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)>/gi, "\n") // block-close → newline
      .replace(/<(?:hr)\s*\/?>/gi, "\n---\n") // <hr> → separator
      .replace(/<[^>]+>/g, ""), // strip remaining tags
  )
    .replace(/[ \t]+/g, " ") // collapse horizontal whitespace only
    .replace(/\n /g, "\n") // trim leading space after newlines
    .replace(/ \n/g, "\n") // trim trailing space before newlines
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ newlines to 2
    .trim();
}
