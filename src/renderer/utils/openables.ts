import type { AttachmentMeta, DashboardEmail } from "../../shared/types";
import { type AttachmentWithId, formatFileSize, hasAttachmentId } from "./attachments";

export type OpenableLink = {
  kind: "link";
  id: string;
  label: string;
  metadata: string;
  url: string;
};

export type OpenableAttachment = {
  kind: "attachment";
  id: string;
  label: string;
  metadata: string;
  attachment: AttachmentWithId;
};

export type OpenableItem = OpenableLink | OpenableAttachment;

export const MAX_RENDERED_OPENABLE_ITEMS = 100;

export function displayUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  const suffix = url.search || url.hash ? `${url.search}${url.hash}` : "";
  return `${url.hostname}${path}${suffix}`;
}

function normalizeLabel(label: string, fallback: string): string {
  const cleaned = label.replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function trimUrlCandidate(candidate: string): string {
  let url = candidate;
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (",.;!?".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    // Keep a trailing ")" that closes a "(" inside the URL, e.g.
    // https://en.wikipedia.org/wiki/Rust_(programming_language); only trim
    // parens that are surrounding punctuation.
    if (last === ")") {
      const opens = url.split("(").length - 1;
      const closes = url.split(")").length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}

export function extractLinks(body: string): OpenableLink[] {
  if (!body.trim()) return [];

  const doc = new DOMParser().parseFromString(body, "text/html");
  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  const seen = new Set<string>();
  const links: OpenableLink[] = [];

  const addLink = (rawHref: string, labelText: string) => {
    if (!rawHref) return;

    const href = rawHref.trim();
    if (!href) return;

    const absoluteHref = href.startsWith("//") ? `https:${href}` : href;
    if (!/^https?:\/\//i.test(absoluteHref)) return;

    let url: URL;
    try {
      url = new URL(absoluteHref);
    } catch {
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (seen.has(url.href)) return;
    seen.add(url.href);

    links.push({
      kind: "link",
      id: `link:${url.href}`,
      label: normalizeLabel(labelText, displayUrl(url)),
      metadata: displayUrl(url),
      url: url.href,
    });
  };

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute("href");
    if (!rawHref) continue;

    const title = anchor.getAttribute("title") ?? "";
    const ariaLabel = anchor.getAttribute("aria-label") ?? "";
    const textLabel = normalizeLabel(anchor.textContent ?? "", "");
    addLink(rawHref, textLabel || title || ariaLabel);
  }

  const textNodes: string[] = [];
  if (doc.body) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent?.closest("a, script, style, template, noscript")) continue;
      textNodes.push(node.textContent ?? "");
    }
  } else {
    textNodes.push(body);
  }

  // Scan each visible text node independently. Flattening the whole body with
  // textContent erases <br> and block boundaries, which can join a URL to the
  // next label or link and turn the combined text into a bogus valid URL.
  for (const text of textNodes) {
    const urlMatches = text.matchAll(/https?:\/\/[^\s<>"']+/gi);
    for (const match of urlMatches) {
      const href = trimUrlCandidate(match[0]);
      addLink(href, href);
    }
  }

  return links;
}

export function attachmentMetadata(attachment: AttachmentMeta): string {
  const parts = [formatFileSize(attachment.size)];
  if (attachment.mimeType) parts.push(attachment.mimeType);
  return parts.join(" - ");
}

export function buildOpenables(email: DashboardEmail | null): OpenableItem[] {
  if (!email) return [];

  const links = extractLinks(email.body ?? "");
  const attachments: OpenableAttachment[] = (email.attachments ?? [])
    .filter(hasAttachmentId)
    .map((attachment) => ({
      kind: "attachment",
      id: `attachment:${attachment.id}`,
      label: attachment.filename,
      metadata: attachmentMetadata(attachment),
      attachment,
    }));

  return [...links, ...attachments];
}

export function itemMatches(item: OpenableItem, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystack = [item.label, item.metadata, item.kind === "link" ? item.url : ""]
    .join(" ")
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}
