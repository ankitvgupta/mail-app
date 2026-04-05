import { readdir, open, mkdtemp, rm } from "fs/promises";
import { createWriteStream } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { randomUUID } from "crypto";
import type { InboxSplit, Snippet, SplitCondition } from "../../shared/types";

// Use createRequire to load native module at runtime (same pattern as db/index.ts)
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// ============================================
// Superhuman data types
// ============================================

type SuperhumanLabel = {
  id: string;
  name: string;
  slug: string;
  type: string;
  color: string;
};

type SuperhumanSplit = {
  id: string;
  matcher: {
    name: string;
    query: string;
    gmailQuery: string;
  };
  isDisabled: boolean;
  type?: string; // "vip" | "team" | "shared" | "calendar" | "news"
  leaveThreadsInImportantOther: boolean;
  labels: SuperhumanLabel[];
};

// ============================================
// Query parser
// ============================================

type ParsedQuery = {
  conditions: SplitCondition[];
  conditionLogic: "and" | "or";
  skippedClauses: string[];
};

/**
 * Parse Superhuman's matcher.query DSL into our SplitCondition format.
 *
 * Observed syntax:
 *   from:user@example.com
 *   from:{a@x.com, b@y.com}
 *   from:domain.com (no @, means *@domain.com)
 *   subject:"Weekly Updates"
 *   filename:ics
 *   autolabel:autoLabel_xxx (skip — Superhuman AI-only)
 *   is:shared (skip — Superhuman-specific)
 *   Clauses joined by ` OR ` → conditionLogic: "or"
 */
export function parseSuperhumanQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  if (!trimmed) {
    return { conditions: [], conditionLogic: "and", skippedClauses: [] };
  }

  // Split on ` OR ` — presence of OR means "or" logic
  const rawClauses = trimmed.split(/\s+OR\s+/);

  const conditions: SplitCondition[] = [];
  const skippedClauses: string[] = [];

  for (const raw of rawClauses) {
    // Strip surrounding parens
    const clause = raw.replace(/^\(+/, "").replace(/\)+$/, "").trim();
    if (!clause) continue;

    const parsed = parseSingleClause(clause);
    if (parsed === null) {
      // Intentionally skipped (Superhuman-specific, e.g. autolabel:, is:)
      continue;
    } else if (parsed.length > 0) {
      conditions.push(...parsed);
    } else {
      skippedClauses.push(clause);
    }
  }

  // Use "or" when:
  // - Multiple top-level clauses joined by OR (even if some were skipped)
  // - A single clause expanded into multiple conditions (e.g. from:{a, b})
  const conditionLogic: "and" | "or" =
    rawClauses.length > 1 || conditions.length > 1 ? "or" : "and";

  return { conditions, conditionLogic, skippedClauses };
}

/** Returns conditions, null for intentionally-skipped clauses, or [] for unknown */
function parseSingleClause(clause: string): SplitCondition[] | null {
  // from:{a, b, c} — brace-grouped addresses
  const fromBraceMatch = clause.match(/^from:\{([^}]+)\}$/);
  if (fromBraceMatch) {
    return fromBraceMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((addr) => ({ type: "from" as const, value: normalizeAddress(addr) }));
  }

  // from:value
  const fromMatch = clause.match(/^from:(.+)$/);
  if (fromMatch) {
    return [{ type: "from", value: normalizeAddress(fromMatch[1]) }];
  }

  // to:value
  const toMatch = clause.match(/^to:(.+)$/);
  if (toMatch) {
    return [{ type: "to", value: normalizeAddress(toMatch[1]) }];
  }

  // subject:"quoted" or subject:unquoted
  const subjectMatch = clause.match(/^subject:(.+)$/);
  if (subjectMatch) {
    const raw = subjectMatch[1];
    // Strip quotes and wrap in wildcards for substring matching
    const unquoted = raw.replace(/^"/, "").replace(/"$/, "");
    return [{ type: "subject", value: `*${unquoted}*` }];
  }

  // filename:ext → has_attachment: *.ext
  const filenameMatch = clause.match(/^filename:(\S+)$/);
  if (filenameMatch) {
    // Strip leading *. or . to handle "filename:ics", "filename:.ics", "filename:*.ics" uniformly
    const raw = filenameMatch[1].replace(/^\*?\.?/, "");
    return [{ type: "has_attachment", value: `*.${raw}` }];
  }

  // Intentionally skip Superhuman-specific types (not a warning)
  if (/^autolabel:/.test(clause) || /^is:/.test(clause)) {
    return null;
  }

  // Unknown clause — skip
  return [];
}

/** Normalize an email address for wildcard matching */
function normalizeAddress(addr: string): string {
  const cleaned = addr.trim();
  // If it contains @, use as-is (exact match)
  if (cleaned.includes("@")) {
    return cleaned;
  }
  // Domain only (e.g. "docs.google.com") → wildcard match
  return `*@${cleaned}`;
}

// ============================================
// Database reader
// ============================================

// Superhuman's Electron app data directory (platform-aware)
const SUPERHUMAN_APP_DIR = join(
  homedir(),
  process.platform === "win32"
    ? "AppData/Roaming/Superhuman"
    : process.platform === "linux"
      ? ".config/Superhuman"
      : "Library/Application Support/Superhuman",
);

const HEADER_SIZE = 4096;

/**
 * Recursively find all regular files under a directory.
 * Skips directories that can't be read.
 */
async function findFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Scan a flat directory for files with a Superhuman OPFS header.
 * Returns accounts found (email + filePath).
 */
async function scanDirForAccounts(
  dir: string,
  seen: Set<string>,
): Promise<Array<{ email: string; filePath: string }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const accounts: Array<{ email: string; filePath: string }> = [];
  for (const entry of entries) {
    const filePath = join(dir, entry);
    let fh;
    try {
      fh = await open(filePath, "r");
      const header = Buffer.alloc(HEADER_SIZE);
      await fh.read(header, 0, HEADER_SIZE, 0);

      const headerStr = header.toString("utf-8");
      const emailMatch = headerStr.match(/^\/([^/\0]+)\.sqlite3/);
      if (!emailMatch) continue;

      const email = emailMatch[1];
      if (email === "demo@superhuman.com") continue;
      if (seen.has(email)) continue;
      seen.add(email);

      accounts.push({ email, filePath });
    } catch {
      continue;
    } finally {
      await fh?.close();
    }
  }
  return accounts;
}

/**
 * Discover Superhuman accounts. Checks the known OPFS path first,
 * then falls back to a recursive search if that path doesn't exist
 * or yields no results (in case the Chromium OPFS layout changes).
 */
export async function discoverSuperhumanAccounts(): Promise<
  Array<{ email: string; filePath: string }>
> {
  const fileSystemDir = join(SUPERHUMAN_APP_DIR, "File System");
  const knownPath = join(fileSystemDir, "000", "t", "00");
  const seen = new Set<string>();

  // Try the known path first (fast — flat directory scan)
  const accounts = await scanDirForAccounts(knownPath, seen);
  if (accounts.length > 0) return accounts;

  // Fall back to recursive search if the known path is empty/missing
  const allFiles = await findFiles(fileSystemDir);
  for (const filePath of allFiles) {
    let fh;
    try {
      fh = await open(filePath, "r");
      const header = Buffer.alloc(HEADER_SIZE);
      await fh.read(header, 0, HEADER_SIZE, 0);

      const headerStr = header.toString("utf-8");
      const emailMatch = headerStr.match(/^\/([^/\0]+)\.sqlite3/);
      if (!emailMatch) continue;

      const email = emailMatch[1];
      if (email === "demo@superhuman.com") continue;
      if (seen.has(email)) continue;
      seen.add(email);

      accounts.push({ email, filePath });
    } catch {
      continue;
    } finally {
      await fh?.close();
    }
  }

  return accounts;
}

/**
 * Read split inboxes from a Superhuman database file.
 * Streams the DB portion (skipping the 4096-byte header) to a temp file,
 * then queries with better-sqlite3. Uses streaming to avoid loading
 * the full file (can be 100MB+) into memory.
 */
export async function readSuperhumanSplits(filePath: string): Promise<SuperhumanSplit[]> {
  const tmpDir = await mkdtemp(join(tmpdir(), "sh-import-"));
  const tmpFile = join(tmpDir, "superhuman.db");

  try {
    // Stream the file from offset HEADER_SIZE to a temp file
    const srcFh = await open(filePath, "r");

    try {
      const srcStream = srcFh.createReadStream({ start: HEADER_SIZE });
      const dstStream = createWriteStream(tmpFile);

      await new Promise<void>((resolve, reject) => {
        srcStream.pipe(dstStream);
        dstStream.on("finish", resolve);
        dstStream.on("error", reject);
        srcStream.on("error", reject);
      });
    } finally {
      await srcFh.close();
    }

    const db = new Database(tmpFile, { readonly: true });
    try {
      const row = db.prepare("SELECT json FROM general WHERE key = 'settings'").get() as
        | { json: string }
        | undefined;

      if (!row) return [];

      const settings = JSON.parse(row.json);
      const splitInboxes = settings?.splitInboxes;
      if (!Array.isArray(splitInboxes)) return [];

      return splitInboxes;
    } finally {
      db.close();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Convert Superhuman splits to our InboxSplit format.
 */
export function convertSuperhumanSplits(
  shSplits: SuperhumanSplit[],
  accountId: string,
  startingOrder: number,
): { splits: InboxSplit[]; warnings: string[] } {
  const splits: InboxSplit[] = [];
  const warnings: string[] = [];
  let order = startingOrder;

  for (const sh of shSplits) {
    // Skip malformed splits missing required fields
    if (!sh.matcher || typeof sh.matcher.query !== "string") continue;

    // Skip disabled splits
    if (sh.isDisabled) continue;

    // Skip shared splits (Superhuman-specific)
    if (sh.type === "shared") continue;

    const { conditions, conditionLogic, skippedClauses } = parseSuperhumanQuery(sh.matcher.query);

    const queryConditionCount = conditions.length;

    // Add label conditions from the labels array (for standard Gmail labels)
    if (Array.isArray(sh.labels)) {
      for (const label of sh.labels) {
        if (typeof label.name !== "string" || typeof label.id !== "string") continue;
        // Skip Superhuman AI labels
        if (label.name.startsWith("[Superhuman]/AI/")) continue;
        // Skip INBOX label — our app already scopes to inbox, so this is redundant
        // and would cause every inbox email to match via OR logic
        if (label.id === "INBOX") continue;
        conditions.push({ type: "label", value: label.id });
      }
    }

    if (conditions.length === 0) {
      warnings.push(
        `Skipped "${sh.matcher.name}": no parseable conditions` +
          (skippedClauses.length > 0 ? ` (unparseable: ${skippedClauses.join(", ")})` : ""),
      );
      continue;
    }

    if (skippedClauses.length > 0) {
      warnings.push(`"${sh.matcher.name}": skipped conditions: ${skippedClauses.join(", ")}`);
    }

    // Use "or" when labels are mixed with query conditions (alternative paths),
    // or when label-only splits have multiple labels (any label should match)
    const finalLogic: "and" | "or" =
      (queryConditionCount > 0 && conditions.length > queryConditionCount) ||
      (queryConditionCount === 0 && conditions.length > 1)
        ? "or"
        : conditionLogic;

    splits.push({
      id: randomUUID(),
      accountId,
      name: sh.matcher.name,
      conditions,
      conditionLogic: finalLogic,
      // leaveThreadsInImportantOther: false means the split captures exclusively
      exclusive: !sh.leaveThreadsInImportantOther,
      order: order++,
    });
  }

  return { splits, warnings };
}

// ============================================
// Superhuman snippets
// ============================================

type SuperhumanSnippet = {
  id: string;
  name: string;
  body: string; // HTML content
  shortcut?: string;
};

/**
 * Read snippets from a Superhuman database file.
 * Uses the same streaming approach as readSuperhumanSplits.
 */
export async function readSuperhumanSnippets(filePath: string): Promise<SuperhumanSnippet[]> {
  const tmpDir = await mkdtemp(join(tmpdir(), "sh-import-"));
  const tmpFile = join(tmpDir, "superhuman.db");

  try {
    const srcFh = await open(filePath, "r");

    try {
      const srcStream = srcFh.createReadStream({ start: HEADER_SIZE });
      const dstStream = createWriteStream(tmpFile);

      await new Promise<void>((resolve, reject) => {
        srcStream.pipe(dstStream);
        dstStream.on("finish", resolve);
        dstStream.on("error", reject);
        srcStream.on("error", reject);
      });
    } finally {
      await srcFh.close();
    }

    const db = new Database(tmpFile, { readonly: true });
    try {
      const row = db.prepare("SELECT json FROM general WHERE key = 'settings'").get() as
        | { json: string }
        | undefined;

      if (!row) return [];

      const settings = JSON.parse(row.json);
      // Superhuman stores snippets under "snippets" key in settings
      const snippets = settings?.snippets;
      if (!Array.isArray(snippets)) return [];

      return snippets;
    } finally {
      db.close();
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Convert Superhuman snippets to our Snippet format.
 */
export function convertSuperhumanSnippets(
  shSnippets: SuperhumanSnippet[],
  accountId: string,
): Snippet[] {
  const now = Date.now();
  const snippets: Snippet[] = [];

  for (const sh of shSnippets) {
    if (!sh.name || typeof sh.body !== "string") continue;

    snippets.push({
      id: randomUUID(),
      accountId,
      name: sh.name,
      body: sh.body,
      shortcut: sh.shortcut || undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  return snippets;
}
