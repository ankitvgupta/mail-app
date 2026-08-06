/**
 * Strip oversized inline `data:` URIs from email HTML bodies.
 *
 * Prod forensics (July 2026) found 1.54GB of the 1.6GB emails table was
 * base64 image payloads inlined into body HTML (avg 106KB/row, max 29MB) —
 * content the renderer replaces with a placeholder before display anyway, so
 * storing it only bloats every synchronous main-process query into a beach
 * ball. Bodies are stripped once at the write boundary (saveEmail + migration
 * 8) and again on read as a backstop for rows written by older builds.
 *
 * Lives in `shared/` (not `main/`) so the main process, the DB migration
 * runner, and the renderer all import the SAME threshold, regex, and matcher —
 * a drift between them would mean the two processes disagree about which images
 * get stripped. This module must stay dependency-free (no electron, no
 * data-dir): it is imported by db/migrations.ts, which runs in non-Electron
 * test contexts, and by the renderer bundle.
 */

/** Data URIs at or above this length (chars) are replaced with a placeholder. */
export const DATA_URI_STRIP_THRESHOLD = 50_000;

/**
 * Matches a `src="data:..."` attribute value (any quote style, any element).
 *
 * Anchored on `src` rather than on `<img ...>` so the scan is LINEAR: a lazy
 * `<img\b[^>]*?` prefix restarts at every `<img` token and, on a body full of
 * `<img` with no closing `>`, degrades to O(n²) — a sender-triggerable freeze
 * of the synchronous main process (the exact beach ball this code prevents).
 * `\bsrc\s*=\s*` only engages where "src=" actually appears, and `[^"']+` scans
 * each value once with no nested quantifier, so total work is O(body length).
 *
 * Anchoring on `src` also broadens coverage beyond `<img>` to `<video>`,
 * `<source>`, `<input type=image>`, etc. `href`/`data=`/CSS `url()` data URIs
 * are still not covered — forensics showed the payload is overwhelmingly
 * `<img src>`, and stripping is a storage optimization, not a security control.
 */
const SRC_DATA_URI_RE = /(\bsrc\s*=\s*["'])(data:[^"']+)(["'])/gi;

/** Colors for the placeholder SVG. Defaults are theme-neutral mid-grays legible
 *  on both light and dark backgrounds (the main process doesn't know the theme). */
export interface PlaceholderColors {
  fill: string;
  textFill: string;
}

const DEFAULT_PLACEHOLDER_COLORS: PlaceholderColors = { fill: "#d1d5db", textFill: "#4b5563" };

/** A small SVG data URI shown in place of a stripped inline image. */
export function inlineImagePlaceholder(
  mime: string,
  dataUriLength: number,
  colors: PlaceholderColors = DEFAULT_PLACEHOLDER_COLORS,
): string {
  // The mime comes from attacker-controlled email HTML. It's rendered as an
  // image (no script execution) and re-sanitized downstream, but validate it
  // so arbitrary markup can't be injected into the placeholder SVG regardless
  // of the consuming context. Anything unexpected falls back to "image".
  const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : "image";
  const sizeKB = Math.round((dataUriLength * 3) / 4 / 1024);
  const sizeLabel = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60">` +
    `<rect width="400" height="60" rx="8" fill="${colors.fill}"/>` +
    `<text x="200" y="35" text-anchor="middle" fill="${colors.textFill}" font-family="system-ui" font-size="13">` +
    `Inline ${safeMime} (${sizeLabel}) — too large to display inline` +
    `</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Replace inline `src="data:..."` URIs larger than DATA_URI_STRIP_THRESHOLD
 * with a placeholder SVG. Smaller data URIs (signatures, logos) are preserved.
 */
export function stripLargeDataUris(body: string, colors?: PlaceholderColors): string {
  // Case-insensitive: URI schemes are case-insensitive per RFC 2397, so a
  // sender using `DATA:` must not bypass the strip. Regex test avoids
  // allocating a lowercased copy of a multi-MB body.
  if (!body || !/data:/i.test(body)) return body;
  // If the whole body is under the threshold, no single data URI can exceed it.
  if (body.length < DATA_URI_STRIP_THRESHOLD) return body;

  return body.replace(SRC_DATA_URI_RE, (match, before: string, dataUri: string, after: string) => {
    if (dataUri.length < DATA_URI_STRIP_THRESHOLD) return match;
    const mimeMatch = dataUri.match(/^data:([^;,]+)/i);
    const mime = mimeMatch?.[1] ?? "image";
    return `${before}${inlineImagePlaceholder(mime, dataUri.length, colors)}${after}`;
  });
}
