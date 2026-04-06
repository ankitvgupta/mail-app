import { createRequire } from "module";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { getDataDir } from "../data-dir";
import { SCHEMA, FTS5_SCHEMA, FTS5_TRIGGERS } from "./schema";
import type {
  DashboardEmail,
  SentEmail,
  StyleSample,
  Email,
  CorrespondentProfile,
  Memory,
  MemoryScope,
  MemorySource,
  MemoryType,
  DraftMemory,
} from "../../shared/types";
import { createLogger } from "../services/logger";

const log = createLogger("db");

// Use createRequire to load native module at runtime
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

type DatabaseInstance = ReturnType<typeof Database>;
let db: DatabaseInstance | null = null;

export function initDatabase(): DatabaseInstance {
  if (db) return db;

  const isDemoMode = process.env.EXO_DEMO_MODE === "true";
  const isTestMode = process.env.EXO_TEST_MODE === "true";
  // Per-worker database isolation for parallel E2E tests
  const workerSuffix =
    (isDemoMode || isTestMode) && process.env.TEST_WORKER_INDEX
      ? `-w${process.env.TEST_WORKER_INDEX}`
      : "";
  const dbFilename = isDemoMode || isTestMode ? `exo-demo${workerSuffix}.db` : "exo.db";

  const userDataPath = getDataDir();
  const dbDir = join(userDataPath, "data");

  // Ensure directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = join(dbDir, dbFilename);
  log.info(`[DB] Using database: ${dbPath}${isDemoMode || isTestMode ? " (demo/test mode)" : ""}`);
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma("journal_mode = WAL");

  // Run migrations for existing databases
  runMigrations(db);

  // Create tables (IF NOT EXISTS for new columns won't help existing tables)
  db.exec(SCHEMA);

  // Initialize FTS5 (separate because virtual tables have different syntax)
  initFTS5(db);

  return db;
}

function initFTS5(db: DatabaseInstance): void {
  try {
    // Check if FTS5 table exists
    const ftsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails_fts'")
      .get();

    if (ftsExists) {
      // Check if it uses the old porter tokenizer — if so, recreate
      const ftsCreateSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='emails_fts'")
        .get() as { sql: string } | undefined;

      if (ftsCreateSql?.sql && /porter/i.test(ftsCreateSql.sql)) {
        log.info("[DB] Migrating FTS5 from porter tokenizer to unicode61");

        // Drop old triggers, FTS table, and recreate
        db.exec("DROP TRIGGER IF EXISTS emails_fts_insert");
        db.exec("DROP TRIGGER IF EXISTS emails_fts_delete");
        db.exec("DROP TRIGGER IF EXISTS emails_fts_update");
        db.exec("DROP TABLE IF EXISTS emails_fts");

        db.exec(FTS5_SCHEMA);
        db.exec(FTS5_TRIGGERS);

        // Backfill body_text for existing emails that don't have it
        backfillBodyText(db);

        // Populate FTS with body_text
        log.info("[DB] Populating FTS5 index from existing emails (post-migration)");
        db.exec(`
          INSERT INTO emails_fts(rowid, subject, body_text, from_address, to_address)
          SELECT rowid, subject, COALESCE(body_text, body), from_address, to_address FROM emails
        `);
        log.info("[DB] FTS5 migration complete");
      } else {
        // Ensure triggers exist (may be missing if a previous migration was interrupted)
        db.exec(FTS5_TRIGGERS);

        // Check if FTS index is empty while emails exist — repopulate if so
        const ftsCount = (
          db.prepare("SELECT COUNT(*) as cnt FROM emails_fts").get() as { cnt: number }
        ).cnt;
        const emailCount = (
          db.prepare("SELECT COUNT(*) as cnt FROM emails").get() as { cnt: number }
        ).cnt;
        if (ftsCount === 0 && emailCount > 0) {
          log.info(`[DB] FTS5 index is empty but ${emailCount} emails exist — repopulating`);
          backfillBodyText(db);
          db.exec(`
            INSERT INTO emails_fts(rowid, subject, body_text, from_address, to_address)
            SELECT rowid, subject, COALESCE(body_text, body), from_address, to_address FROM emails
          `);
          log.info("[DB] FTS5 index repopulated");
        }
      }
    } else {
      log.info("[DB] Creating FTS5 search index");

      // Create FTS5 virtual table
      db.exec(FTS5_SCHEMA);

      // Create triggers to keep FTS in sync
      db.exec(FTS5_TRIGGERS);

      // Backfill body_text for any existing emails
      backfillBodyText(db);

      // Populate FTS with existing emails
      log.info("[DB] Populating FTS5 index from existing emails");
      db.exec(`
        INSERT INTO emails_fts(rowid, subject, body_text, from_address, to_address)
        SELECT rowid, subject, COALESCE(body_text, body), from_address, to_address FROM emails
      `);
      log.info("[DB] FTS5 search index created and populated");
    }
  } catch (error) {
    log.error({ err: error }, "[DB] Failed to initialize FTS5");
  }
}

/**
 * Backfill body_text column for emails that don't have it yet.
 * Reads HTML body, strips tags, and writes plain text.
 */
function backfillBodyText(db: DatabaseInstance): void {
  const rows = db.prepare("SELECT rowid, body FROM emails WHERE body_text IS NULL").all() as Array<{
    rowid: number;
    body: string;
  }>;
  if (rows.length === 0) return;

  log.info(`[DB] Backfilling body_text for ${rows.length} emails`);
  const updateStmt = db.prepare("UPDATE emails SET body_text = ? WHERE rowid = ?");
  const runAll = db.transaction(() => {
    for (const row of rows) {
      updateStmt.run(stripHtmlForSearch(row.body), row.rowid);
    }
  });
  runAll();
  log.info("[DB] body_text backfill complete");
}

function runMigrations(db: DatabaseInstance): void {
  // Check if emails table exists and has account_id column
  const tableInfo = db.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
  const hasAccountId = tableInfo.some((col) => col.name === "account_id");

  if (tableInfo.length > 0 && !hasAccountId) {
    // Migration: Add account_id column to existing emails table
    log.info("[DB] Running migration: Adding account_id column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN account_id TEXT DEFAULT 'default'");
  }

  // Create index for account_id if it doesn't exist (will be created by schema too, but this ensures it's there)
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id)");
  } catch {
    // Index might already exist, ignore
  }

  // Check if extension_enrichments table exists and has sender_email column
  const enrichmentsTableInfo = db
    .prepare("PRAGMA table_info(extension_enrichments)")
    .all() as Array<{ name: string }>;
  const hasSenderEmail = enrichmentsTableInfo.some((col) => col.name === "sender_email");

  if (enrichmentsTableInfo.length > 0 && !hasSenderEmail) {
    // Migration: Add sender_email column to existing extension_enrichments table
    log.info("[DB] Running migration: Adding sender_email column to extension_enrichments table");
    db.exec("ALTER TABLE extension_enrichments ADD COLUMN sender_email TEXT");
  }

  // Create index for sender_email lookups
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_extension_enrichments_sender ON extension_enrichments(sender_email, extension_id)",
    );
  } catch {
    // Index might already exist, ignore
  }

  // Check if emails table has label_ids column
  const hasLabelIds = tableInfo.some((col) => col.name === "label_ids");
  if (tableInfo.length > 0 && !hasLabelIds) {
    // Migration: Add label_ids column to existing emails table
    log.info("[DB] Running migration: Adding label_ids column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN label_ids TEXT");
  }

  // Check if emails table has cc_address column
  const hasCcAddress = tableInfo.some((col) => col.name === "cc_address");
  if (tableInfo.length > 0 && !hasCcAddress) {
    log.info("[DB] Running migration: Adding cc_address column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN cc_address TEXT");
  }

  const hasBccAddress = tableInfo.some((col) => col.name === "bcc_address");
  if (tableInfo.length > 0 && !hasBccAddress) {
    log.info("[DB] Running migration: Adding bcc_address column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN bcc_address TEXT");
  }

  // Check if calendar_sync_state table has visible column
  const calSyncTableInfo = db.prepare("PRAGMA table_info(calendar_sync_state)").all() as Array<{
    name: string;
  }>;
  const hasCalSyncVisible = calSyncTableInfo.some((col) => col.name === "visible");
  if (calSyncTableInfo.length > 0 && !hasCalSyncVisible) {
    log.info("[DB] Running migration: Adding visible column to calendar_sync_state table");
    db.exec("ALTER TABLE calendar_sync_state ADD COLUMN visible INTEGER DEFAULT 1");
  }

  // Check if emails table has body_text column
  // Re-read tableInfo since we may have added columns above
  const tableInfoRefresh = db.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
  const hasBodyText = tableInfoRefresh.some((col) => col.name === "body_text");
  if (tableInfoRefresh.length > 0 && !hasBodyText) {
    log.info("[DB] Running migration: Adding body_text column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN body_text TEXT");
  }

  // Check if emails table has attachments column
  const tableInfoForAttachments = db.prepare("PRAGMA table_info(emails)").all() as Array<{
    name: string;
  }>;
  const hasAttachments = tableInfoForAttachments.some((col) => col.name === "attachments");
  if (tableInfoForAttachments.length > 0 && !hasAttachments) {
    log.info("[DB] Running migration: Adding attachments column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN attachments TEXT");
  }

  // Check if outbox table has attachments column
  const outboxTableInfo = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  const outboxHasAttachments = outboxTableInfo.some((col) => col.name === "attachments");
  if (outboxTableInfo.length > 0 && !outboxHasAttachments) {
    log.info("[DB] Running migration: Adding attachments column to outbox table");
    db.exec("ALTER TABLE outbox ADD COLUMN attachments TEXT");
  }

  // Check if drafts table has agent_task_id column (for linking drafts to agent traces)
  const draftsTableInfo = db.prepare("PRAGMA table_info(drafts)").all() as Array<{ name: string }>;
  const hasAgentTaskId = draftsTableInfo.some((col) => col.name === "agent_task_id");
  if (draftsTableInfo.length > 0 && !hasAgentTaskId) {
    log.info("[DB] Running migration: Adding agent_task_id column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN agent_task_id TEXT");
  }

  // Check if drafts table has cc/bcc columns
  const draftsTableInfoRefresh = db.prepare("PRAGMA table_info(drafts)").all() as Array<{
    name: string;
  }>;
  const hasDraftCc = draftsTableInfoRefresh.some((col) => col.name === "cc");
  if (draftsTableInfoRefresh.length > 0 && !hasDraftCc) {
    log.info("[DB] Running migration: Adding cc column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN cc TEXT");
  }
  const hasDraftBcc = draftsTableInfoRefresh.some((col) => col.name === "bcc");
  if (draftsTableInfoRefresh.length > 0 && !hasDraftBcc) {
    log.info("[DB] Running migration: Adding bcc column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN bcc TEXT");
  }

  // Check if drafts table has compose_mode column (to remember forward vs reply on Esc)
  const draftsTableInfoForMode = db.prepare("PRAGMA table_info(drafts)").all() as Array<{
    name: string;
  }>;
  const hasDraftComposeMode = draftsTableInfoForMode.some((col) => col.name === "compose_mode");
  if (draftsTableInfoForMode.length > 0 && !hasDraftComposeMode) {
    log.info("[DB] Running migration: Adding compose_mode column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN compose_mode TEXT");
  }

  // Check if drafts table has to_recipients column (for forward recipient persistence)
  const draftsTableInfoForTo = db.prepare("PRAGMA table_info(drafts)").all() as Array<{
    name: string;
  }>;
  const hasDraftToRecipients = draftsTableInfoForTo.some((col) => col.name === "to_recipients");
  if (draftsTableInfoForTo.length > 0 && !hasDraftToRecipients) {
    log.info("[DB] Running migration: Adding to_recipients column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN to_recipients TEXT");
  }

  // Check if emails table has message_id column (RFC 5322 Message-ID for draft cleanup)
  const tableInfoForMessageId = db.prepare("PRAGMA table_info(emails)").all() as Array<{
    name: string;
  }>;
  const hasMessageId = tableInfoForMessageId.some((col) => col.name === "message_id");
  if (tableInfoForMessageId.length > 0 && !hasMessageId) {
    log.info("[DB] Running migration: Adding message_id column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN message_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id)");
  }

  // Check if emails table has in_reply_to column (RFC 5322 In-Reply-To for thread merging)
  const tableInfoForInReplyTo = db.prepare("PRAGMA table_info(emails)").all() as Array<{
    name: string;
  }>;
  const hasInReplyTo = tableInfoForInReplyTo.some((col) => col.name === "in_reply_to");
  if (tableInfoForInReplyTo.length > 0 && !hasInReplyTo) {
    log.info("[DB] Running migration: Adding in_reply_to column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN in_reply_to TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails(in_reply_to)");
  }

  // Check if memories table has memory_type column (for distinguishing drafting vs analysis memories)
  const memoriesTableInfo = db.prepare("PRAGMA table_info(memories)").all() as Array<{
    name: string;
  }>;
  const hasMemoryType = memoriesTableInfo.some((col) => col.name === "memory_type");
  if (memoriesTableInfo.length > 0 && !hasMemoryType) {
    log.info("[DB] Running migration: Adding memory_type column to memories table");
    db.exec("ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'drafting'");
  }

  // Check if draft_memories table has memory_type column
  const draftMemoriesTableInfo = db.prepare("PRAGMA table_info(draft_memories)").all() as Array<{
    name: string;
  }>;
  const hasDraftMemoryType = draftMemoriesTableInfo.some((col) => col.name === "memory_type");
  if (draftMemoriesTableInfo.length > 0 && !hasDraftMemoryType) {
    log.info("[DB] Running migration: Adding memory_type column to draft_memories table");
    db.exec("ALTER TABLE draft_memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'drafting'");
  }

  // === Forward-only numbered migration system ===
  // Existing ad-hoc migrations above are the "baseline" (version 0).
  // All NEW migrations go through the numbered system below.
  runNumberedMigrations(db);
}

// --- Numbered migration system (forward-only, bootstrap baseline) ---

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseInstance) => void;
}

// Add new migrations here. Version numbers must be sequential.
// Existing databases get version 0 (baseline) on first run.
const NUMBERED_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "add_llm_calls_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_calls (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          model TEXT NOT NULL,
          caller TEXT NOT NULL,
          email_id TEXT,
          account_id TEXT,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_create_tokens INTEGER DEFAULT 0,
          cost_cents REAL NOT NULL,
          duration_ms INTEGER NOT NULL,
          success INTEGER NOT NULL DEFAULT 1,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
        CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
      `);
    },
  },
];

function runNumberedMigrations(db: DatabaseInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const currentRow = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
    | { version: number | null }
    | undefined;
  let currentVersion = currentRow?.version ?? -1;

  if (currentVersion === -1) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(0);
    currentVersion = 0;
    log.info({ version: 0 }, "Migration system initialized at baseline");
  }

  for (const migration of NUMBERED_MIGRATIONS) {
    if (migration.version > currentVersion) {
      log.info({ version: migration.version, name: migration.name }, "Running numbered migration");
      const runInTransaction = db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      });
      runInTransaction();
      currentVersion = migration.version;
    }
  }
}

export function getDatabase(): DatabaseInstance {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}

/**
 * Checkpoint the WAL file into the main database file.
 * Call periodically to ensure writes aren't stranded in the WAL.
 */
export function checkpointWal(): void {
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch (e) {
    log.error({ err: e }, "[DB] WAL checkpoint failed");
  }
}

/**
 * Close the database connection, flushing the WAL to the main file.
 * Must be called before the process exits to prevent data loss.
 */
export function closeDatabase(): void {
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    log.error({ err: e }, "[DB] WAL checkpoint failed during close");
  }
  try {
    db.close();
  } catch (e) {
    log.error({ err: e }, "[DB] Error closing database");
  }
  db = null;
}

/**
 * Test-only: inject a database instance (e.g. in-memory) for unit tests.
 */
export function _testSetDatabase(testDb: DatabaseInstance): void {
  db = testDb;
}

// ============================================
// HTML stripping and FTS query sanitization
// ============================================

/**
 * Strip HTML tags and decode common entities for FTS indexing.
 * We want the plain text content, not markup tokens like "strong" or "div".
 */
export function stripHtmlForSearch(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ") // remove style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ") // remove script blocks
    .replace(/<[^>]+>/g, " ") // strip all tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[#\w]+;/gi, " ") // remaining entities
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Escape FTS5 special characters so user input doesn't cause syntax errors.
 * Wraps each non-operator token in double quotes to treat it as a literal phrase.
 */
export function sanitizeFtsQuery(query: string): string {
  // If the query is already a quoted phrase, leave it alone
  if (query.startsWith('"') && query.endsWith('"')) {
    return query;
  }

  // Split on whitespace, wrap tokens that contain FTS5 metacharacters
  const ftsOperators = new Set(["AND", "OR", "NOT", "NEAR"]);
  const tokens = query.split(/\s+/).filter(Boolean);

  return tokens
    .map((token) => {
      // Preserve boolean operators
      if (ftsOperators.has(token.toUpperCase())) {
        return token.toUpperCase();
      }
      // Column filter syntax (from_address:foo) — pass through
      if (/^(subject|body_text|from_address|to_address):/.test(token)) {
        return token;
      }
      // If token has FTS5 special chars, quote it
      if (/[*"():^{}+\-]/.test(token)) {
        // Escape internal double quotes
        return `"${token.replace(/"/g, '""')}"`;
      }
      return token;
    })
    .join(" ");
}

// Email operations
export function getAllEmailIds(accountId?: string): string[] {
  const db = getDatabase();
  if (accountId) {
    const stmt = db.prepare("SELECT id FROM emails WHERE account_id = ?");
    return (stmt.all(accountId) as Array<{ id: string }>).map((row) => row.id);
  }
  const stmt = db.prepare("SELECT id FROM emails");
  return (stmt.all() as Array<{ id: string }>).map((row) => row.id);
}

export function saveEmail(email: Email, accountId: string = "default"): void {
  const db = getDatabase();
  const bodyText = stripHtmlForSearch(email.body);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO emails (id, account_id, thread_id, subject, from_address, to_address, cc_address, bcc_address, body, body_text, snippet, date, fetched_at, label_ids, attachments, message_id, in_reply_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    email.id,
    accountId,
    email.threadId,
    email.subject,
    email.from,
    email.to,
    email.cc || null,
    email.bcc || null,
    email.body,
    bodyText,
    email.snippet || null,
    email.date,
    Date.now(),
    email.labelIds ? JSON.stringify(email.labelIds) : null,
    email.attachments?.length ? JSON.stringify(email.attachments) : null,
    email.messageIdHeader || null,
    email.inReplyTo || null,
  );

  // New email may create new In-Reply-To links that change thread merge groups
  if (email.inReplyTo || email.messageIdHeader) {
    invalidateThreadMergeCache(accountId);
  }
}

export function updateEmailLabelIds(emailId: string, labelIds: string[]): void {
  const db = getDatabase();
  db.prepare("UPDATE emails SET label_ids = ? WHERE id = ?").run(JSON.stringify(labelIds), emailId);
}

export function deleteEmail(emailId: string, accountId: string = "default"): void {
  const db = getDatabase();
  db.prepare("DELETE FROM drafts WHERE email_id = ?").run(emailId);
  db.prepare("DELETE FROM analyses WHERE email_id = ?").run(emailId);
  db.prepare("DELETE FROM emails WHERE id = ? AND account_id = ?").run(emailId, accountId);
  invalidateThreadMergeCache(accountId);
}

export function getEmail(emailId: string): DashboardEmail | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT
      e.id, e.account_id as accountId, e.thread_id as threadId, e.subject, e.from_address as "from",
      e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc", e.body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
      e.message_id as messageId, e.in_reply_to as inReplyTo,
      a.needs_reply as needsReply, a.reason, a.priority, a.analyzed_at as analyzedAt,
      d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus, d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.to_recipients as draftTo, d.cc as draftCc, d.bcc as draftBcc, d.compose_mode as draftComposeMode
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id
    WHERE e.id = ?
  `);

  const row = stmt.get(emailId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return rowToDashboardEmail(row);
}

/** Returns all emails with body intentionally empty ('') for performance.
 *  Use getEmail(id) or getEmailsByThread() when body content is needed. */
export function getAllEmails(accountId?: string): DashboardEmail[] {
  const t0 = performance.now();
  const db = getDatabase();

  let query = `
    SELECT
      e.id, e.account_id as accountId, e.thread_id as threadId, e.subject, e.from_address as "from",
      e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc", '' as body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
      e.message_id as messageId, e.in_reply_to as inReplyTo,
      a.needs_reply as needsReply, a.reason, a.priority, a.analyzed_at as analyzedAt,
      d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus, d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.to_recipients as draftTo, d.cc as draftCc, d.bcc as draftBcc, d.compose_mode as draftComposeMode
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id
  `;

  if (accountId) {
    query += ` WHERE e.account_id = ? `;
  }
  query += ` ORDER BY e.date DESC`;

  const stmt = db.prepare(query);
  const tQuery = performance.now();
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  const queryTime = performance.now() - tQuery;

  const tMap = performance.now();
  const emails = (rows as Record<string, unknown>[]).map(rowToDashboardEmail);
  const mapTime = performance.now() - tMap;

  // Merge threads linked by In-Reply-To headers
  applyThreadMerge(emails);

  const totalTime = performance.now() - t0;
  log.info(
    `[PERF] getAllEmails query=${queryTime.toFixed(1)}ms map=${mapTime.toFixed(1)}ms total=${totalTime.toFixed(1)}ms rows=${rows.length}`,
  );
  return emails;
}

/**
 * Get only INBOX emails (for display in main inbox view).
 * This excludes archived/sent-only emails to keep memory usage low.
 * NOTE: body is intentionally empty ('') for performance.
 * Use getEmail(id) or getEmailsByThread() when body content is needed.
 */
export function getInboxEmails(accountId?: string): DashboardEmail[] {
  const t0 = performance.now();
  const db = getDatabase();

  // Two-query approach: fast inbox query + targeted sent query, merged in JS.
  // A single query with a subquery for sent-in-inbox-threads is O(n²) in SQLite.
  const selectCols = `
      e.id, e.account_id as accountId, e.thread_id as threadId, e.subject, e.from_address as "from",
      e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc", '' as body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
      e.message_id as messageId, e.in_reply_to as inReplyTo,
      a.needs_reply as needsReply, a.reason, a.priority, a.analyzed_at as analyzedAt,
      d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus, d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.to_recipients as draftTo, d.cc as draftCc, d.bcc as draftBcc, d.compose_mode as draftComposeMode`;
  const fromJoins = `
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id`;

  const tQuery = performance.now();

  // Query 1: inbox emails (the original fast query)
  const inboxQuery = accountId
    ? `SELECT ${selectCols} ${fromJoins} WHERE (e.label_ids IS NULL OR e.label_ids LIKE '%"INBOX"%') AND e.account_id = ?`
    : `SELECT ${selectCols} ${fromJoins} WHERE (e.label_ids IS NULL OR e.label_ids LIKE '%"INBOX"%')`;
  const inboxRows = accountId
    ? (db.prepare(inboxQuery).all(accountId) as Record<string, unknown>[])
    : (db.prepare(inboxQuery).all() as Record<string, unknown>[]);

  // Lightweight query for ALL emails: only thread/message linkage fields.
  // Includes archived emails so canonical thread selection is stable across
  // views (getInboxEmails and getEmailsByThread agree on the same canonical ID).
  // Always includes account_id so we can scope merge maps per-account.
  const allLightQuery = accountId
    ? `SELECT e.id, e.account_id as accountId, e.thread_id as threadId, e.message_id as messageId, e.in_reply_to as inReplyTo, e.date, e.label_ids as labelIds FROM emails e WHERE e.account_id = ?`
    : `SELECT e.id, e.account_id as accountId, e.thread_id as threadId, e.message_id as messageId, e.in_reply_to as inReplyTo, e.date, e.label_ids as labelIds FROM emails e`;
  const allLightRows = accountId
    ? (db.prepare(allLightQuery).all(accountId) as Array<{
        id: string;
        accountId: string;
        threadId: string;
        messageId: string | null;
        inReplyTo: string | null;
        date: string;
        labelIds: string | null;
      }>)
    : (db.prepare(allLightQuery).all() as Array<{
        id: string;
        accountId: string;
        threadId: string;
        messageId: string | null;
        inReplyTo: string | null;
        date: string;
        labelIds: string | null;
      }>);
  const queryTime = performance.now() - tQuery;

  // Map inbox rows to DashboardEmail
  const tMap = performance.now();
  const inboxEmails = (inboxRows as Record<string, unknown>[]).map(rowToDashboardEmail);

  // Build per-account merge maps to avoid cross-account thread merging.
  // When no accountId filter is applied, emails from different accounts may share
  // Message-IDs; merging them would corrupt threadIds across account boundaries.
  const lightByAccount = new Map<string, typeof allLightRows>();
  for (const r of allLightRows) {
    const acct = r.accountId;
    const arr = lightByAccount.get(acct);
    if (arr) arr.push(r);
    else lightByAccount.set(acct, [r]);
  }
  // Per-account merge maps to avoid cross-account threadId collisions
  const mergeMaps = new Map<string, Map<string, string>>();
  for (const [acct, accountRows] of lightByAccount) {
    const mergeInputs: Array<
      Pick<DashboardEmail, "threadId" | "messageId" | "inReplyTo" | "date">
    > = accountRows.map((r) => ({
      threadId: r.threadId,
      messageId: r.messageId ?? undefined,
      inReplyTo: r.inReplyTo ?? undefined,
      date: r.date,
    }));
    const accountMergeMap = buildThreadMergeMap(mergeInputs);
    if (accountMergeMap.size > 0) mergeMaps.set(acct, accountMergeMap);
  }

  // Apply merge to inbox emails, scoped by account
  for (const email of inboxEmails) {
    const acctMap = mergeMaps.get(email.accountId ?? "default");
    if (!acctMap) continue;
    const canonical = acctMap.get(email.threadId);
    if (canonical) email.threadId = canonical;
  }

  // Now build inbox thread IDs from merged inbox emails
  const inboxThreadIds = new Set(inboxEmails.map((e) => e.threadId));
  const inboxIds = new Set(inboxEmails.map((e) => e.id));

  // Find sent emails whose threads (after merging) overlap with inbox threads
  const sentIdsForInbox: string[] = [];
  for (const r of allLightRows) {
    if (!r.labelIds?.includes('"SENT"')) continue;
    const acctMap = mergeMaps.get(r.accountId);
    const mergedThreadId = acctMap?.get(r.threadId) ?? r.threadId;
    if (inboxThreadIds.has(mergedThreadId) && !inboxIds.has(r.id)) {
      sentIdsForInbox.push(r.id);
    }
  }

  // Load full data only for the sent emails we actually need
  let fullSentEmails: DashboardEmail[] = [];
  if (sentIdsForInbox.length > 0) {
    const placeholders = sentIdsForInbox.map(() => "?").join(",");
    const fullSentRows = db
      .prepare(`SELECT ${selectCols} ${fromJoins} WHERE e.id IN (${placeholders})`)
      .all(...sentIdsForInbox) as Record<string, unknown>[];
    fullSentEmails = fullSentRows.map(rowToDashboardEmail);
    // Apply thread merge to the full sent emails too, scoped by account
    for (const email of fullSentEmails) {
      const acctMap = mergeMaps.get(email.accountId ?? "default");
      if (!acctMap) continue;
      const canonical = acctMap.get(email.threadId);
      if (canonical) email.threadId = canonical;
    }
  }

  const result = [...inboxEmails, ...fullSentEmails];
  const mapTime = performance.now() - tMap;

  const totalTime = performance.now() - t0;
  log.info(
    `[PERF] getInboxEmails query=${queryTime.toFixed(1)}ms map=${mapTime.toFixed(1)}ms total=${totalTime.toFixed(1)}ms rows=${result.length}`,
  );
  return result;
}

/**
 * Get all SENT emails for an account (for the Sent mail view).
 * NOTE: body is intentionally empty ('') for performance.
 * Use getEmail(id) or getEmailsByThread() when body content is needed.
 */
export function getSentEmails(accountId: string): DashboardEmail[] {
  const t0 = performance.now();
  const db = getDatabase();

  const query = `
    SELECT
      e.id, e.account_id as accountId, e.thread_id as threadId, e.subject, e.from_address as "from",
      e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc", '' as body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
      e.message_id as messageId, e.in_reply_to as inReplyTo,
      a.needs_reply as needsReply, a.reason, a.priority, a.analyzed_at as analyzedAt,
      d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus, d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.to_recipients as draftTo, d.cc as draftCc, d.bcc as draftBcc, d.compose_mode as draftComposeMode
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id
    WHERE EXISTS (SELECT 1 FROM json_each(e.label_ids) WHERE value = 'SENT') AND e.account_id = ?
    ORDER BY e.date DESC
  `;
  const rows = db.prepare(query).all(accountId) as Record<string, unknown>[];
  const emails = rows.map(rowToDashboardEmail);

  const totalTime = performance.now() - t0;
  log.info(`[PERF] getSentEmails total=${totalTime.toFixed(1)}ms rows=${rows.length}`);
  return emails;
}

/**
 * Get emails by thread ID (efficient query for just one thread)
 */
export function getEmailsByThread(threadId: string, accountId?: string): DashboardEmail[] {
  const db = getDatabase();

  // Find all Gmail thread IDs in this merge group (handles forward-reply thread merging)
  const allThreadIds = getMergedGmailThreadIds(threadId, accountId);

  const accountFilter = accountId ? " AND e.account_id = ?" : "";
  const placeholders = allThreadIds.map(() => "?").join(",");
  const query = `
    SELECT
      e.id, e.account_id as accountId, e.thread_id as threadId, e.subject, e.from_address as "from",
      e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc", e.body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
      e.message_id as messageId, e.in_reply_to as inReplyTo,
      a.needs_reply as needsReply, a.reason, a.priority, a.analyzed_at as analyzedAt,
      d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus, d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.to_recipients as draftTo, d.cc as draftCc, d.bcc as draftBcc, d.compose_mode as draftComposeMode
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id
    WHERE e.thread_id IN (${placeholders})${accountFilter}
    ORDER BY e.date ASC
  `;

  const params = accountId ? [...allThreadIds, accountId] : allThreadIds;
  const rows = db.prepare(query).all(...params);
  const emails = (rows as Record<string, unknown>[]).map(rowToDashboardEmail);

  // Rewrite threadIds to canonical so the renderer sees a single thread
  applyThreadMerge(emails);

  return emails;
}

/**
 * Get multiple emails by ID in a single query (batch alternative to N individual getEmail() calls)
 */
export function getEmailsByIds(ids: string[]): DashboardEmail[] {
  if (ids.length === 0) return [];
  const db = getDatabase();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
    SELECT
      e.id, e.account_id as accountId, e.thread_id as threadId, e.subject, e.from_address as "from",
      e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc", e.body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
      e.message_id as messageId, e.in_reply_to as inReplyTo,
      a.needs_reply as needsReply, a.reason, a.priority, a.analyzed_at as analyzedAt,
      d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus, d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.to_recipients as draftTo, d.cc as draftCc, d.bcc as draftBcc, d.compose_mode as draftComposeMode
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id
    WHERE e.id IN (${placeholders})
  `,
    )
    .all(...ids) as Record<string, unknown>[];
  return rows.map(rowToDashboardEmail);
}

/**
 * Check if any emails exist for an account (fast check without loading all emails)
 */
export function hasEmailsForAccount(accountId: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT 1 FROM emails WHERE account_id = ? LIMIT 1`);
  const row = stmt.get(accountId);
  return row !== undefined;
}

/**
 * Get just the email IDs for an account (for checking existence without loading full emails)
 */
export function getInboxThreadIds(accountId: string): Set<string> {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT DISTINCT thread_id FROM emails WHERE account_id = ? AND (label_ids IS NULL OR label_ids LIKE '%"INBOX"%')`,
  );
  const rows = stmt.all(accountId) as { thread_id: string }[];
  return new Set(rows.map((r) => r.thread_id));
}

export function getEmailIds(accountId: string): Set<string> {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT id FROM emails WHERE account_id = ?`);
  const rows = stmt.all(accountId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Fetch only email bodies for a batch of IDs — lightweight query for
 * background prefetching without pulling all joined columns.
 */
export function getEmailBodies(ids: string[]): Array<{ id: string; body: string }> {
  if (ids.length === 0) return [];
  const db = getDatabase();
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT id, body FROM emails WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; body: string }>;
}

// ============================================
// Thread merging via RFC 5322 In-Reply-To
// ============================================

/**
 * Union-Find for thread merging. Groups Gmail threads that are linked
 * by In-Reply-To headers (e.g. when a forward reply gets a new threadId).
 */
class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!result.has(root)) result.set(root, []);
      result.get(root)!.push(key);
    }
    return result;
  }
}

/**
 * Build a map from Gmail threadId → canonical threadId for threads
 * that should be merged based on In-Reply-To headers.
 *
 * The canonical threadId is the one containing the oldest email in the group.
 * Only returns entries for threads that need remapping (not identity mappings).
 */
export function buildThreadMergeMap(
  emails: ReadonlyArray<Pick<DashboardEmail, "threadId" | "messageId" | "inReplyTo" | "date">>,
): Map<string, string> {
  // Collect all threadIds per messageId (handles rare duplicate Message-IDs)
  const msgToThreads = new Map<string, string[]>();
  for (const e of emails) {
    if (e.messageId) {
      const arr = msgToThreads.get(e.messageId);
      if (arr) {
        arr.push(e.threadId);
      } else {
        msgToThreads.set(e.messageId, [e.threadId]);
      }
    }
  }

  const uf = new UnionFind();

  // Union threads that share the same messageId
  for (const threads of msgToThreads.values()) {
    for (let i = 1; i < threads.length; i++) {
      uf.union(threads[0], threads[i]);
    }
  }

  // Union threads linked by In-Reply-To
  for (const e of emails) {
    if (e.inReplyTo) {
      const referencedThreads = msgToThreads.get(e.inReplyTo);
      if (referencedThreads) {
        uf.union(e.threadId, referencedThreads[0]);
      }
    }
  }

  // Find the oldest email timestamp per threadId (for canonical selection).
  // Dates are RFC 2822 strings (e.g. "Mon, 10 Mar 2024 12:00:00 +0000")
  // which are NOT lexicographically comparable, so parse to numeric timestamps.
  const oldestTs = new Map<string, number>();
  for (const e of emails) {
    const ts = new Date(e.date).getTime();
    if (isNaN(ts)) continue;
    const existing = oldestTs.get(e.threadId);
    if (existing === undefined || ts < existing) {
      oldestTs.set(e.threadId, ts);
    }
  }

  // For each group, pick the threadId with the oldest email as canonical
  const mergeMap = new Map<string, string>();
  for (const [, members] of uf.groups()) {
    if (members.length <= 1) continue;

    let canonical = members[0];
    let canonicalTs = oldestTs.get(canonical) ?? Infinity;
    for (let i = 1; i < members.length; i++) {
      const ts = oldestTs.get(members[i]) ?? Infinity;
      if (ts < canonicalTs) {
        canonical = members[i];
        canonicalTs = ts;
      }
    }

    for (const tid of members) {
      if (tid !== canonical) {
        mergeMap.set(tid, canonical);
      }
    }
  }

  return mergeMap;
}

/**
 * Mutate emails in-place: rewrite threadId to canonical for any merged threads.
 */
function applyThreadMerge(emails: DashboardEmail[]): void {
  // Group by accountId and build separate merge maps per account to avoid
  // cross-account merging when emails from different accounts share Message-IDs.
  const byAccount = new Map<string, DashboardEmail[]>();
  for (const email of emails) {
    const acct = email.accountId ?? "default";
    const arr = byAccount.get(acct);
    if (arr) arr.push(email);
    else byAccount.set(acct, [email]);
  }
  for (const accountEmails of byAccount.values()) {
    const mergeMap = buildThreadMergeMap(accountEmails);
    if (mergeMap.size === 0) continue;
    for (const email of accountEmails) {
      const canonical = mergeMap.get(email.threadId);
      if (canonical) email.threadId = canonical;
    }
  }
}

// ── Thread merge group cache ──
//
// Instead of running per-thread BFS queries (which took 33s for 555 threads
// during initial sync), we precompute ALL merge groups in a single O(N) pass
// using Union-Find over (thread_id, message_id, in_reply_to) triples.
//
// The cache maps threadId → canonical threadId[]. Invalidated when emails
// are inserted (new In-Reply-To links may create new merge groups).

// Per-account merge group cache: accountKey → (threadId → threadId[])
// accountKey is accountId or "" for all-accounts queries.
const _mergeGroupsByAccount = new Map<string, Map<string, string[]>>();

function ufFind(parent: Map<string, string>, x: string): string {
  // Initialize if not yet in the parent map (defensive — callers should
  // pre-populate, but avoids infinite loops if they don't).
  if (!parent.has(x)) {
    parent.set(x, x);
    return x;
  }
  let root = x;
  while (parent.get(root) !== root) root = parent.get(root)!;
  // Path compression
  let cur = x;
  while (cur !== root) {
    const next = parent.get(cur)!;
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function ufUnion(
  parent: Map<string, string>,
  rank: Map<string, number>,
  a: string,
  b: string,
): void {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra === rb) return;
  const rankA = rank.get(ra) || 0;
  const rankB = rank.get(rb) || 0;
  if (rankA < rankB) {
    parent.set(ra, rb);
  } else if (rankA > rankB) {
    parent.set(rb, ra);
  } else {
    parent.set(rb, ra);
    rank.set(ra, rankA + 1);
  }
}

/**
 * Build the thread merge map for all emails of an account in one pass.
 * Uses Union-Find to group threadIds connected by In-Reply-To → Message-ID links.
 */
function buildMergeCache(accountId?: string): Map<string, string[]> {
  const t0 = performance.now();
  const db = getDatabase();
  const accountKey = accountId || "";

  const accountFilter = accountId ? " WHERE account_id = ?" : "";
  const params = accountId ? [accountId] : [];

  const rows = db
    .prepare(`SELECT thread_id, message_id, in_reply_to FROM emails${accountFilter}`)
    .all(...params) as {
    thread_id: string;
    message_id: string | null;
    in_reply_to: string | null;
  }[];

  // Build message_id → threadId[] index (a message_id can appear in
  // multiple threads in rare cases — we need to union all of them)
  const msgToThread = new Map<string, string[]>();
  for (const r of rows) {
    if (r.message_id) {
      const existing = msgToThread.get(r.message_id);
      if (existing) {
        existing.push(r.thread_id);
      } else {
        msgToThread.set(r.message_id, [r.thread_id]);
      }
    }
  }

  // Initialize Union-Find with all threadIds
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  const allThreadIds = new Set<string>();
  for (const r of rows) {
    allThreadIds.add(r.thread_id);
    if (!parent.has(r.thread_id)) {
      parent.set(r.thread_id, r.thread_id);
    }
  }

  // Union threads connected by In-Reply-To links
  for (const r of rows) {
    if (r.in_reply_to) {
      const replyToThreads = msgToThread.get(r.in_reply_to);
      if (replyToThreads) {
        for (const replyToThread of replyToThreads) {
          if (replyToThread !== r.thread_id) {
            if (!parent.has(replyToThread)) {
              parent.set(replyToThread, replyToThread);
            }
            ufUnion(parent, rank, r.thread_id, replyToThread);
          }
        }
      }
    }
  }

  // Build groups: root → threadId[]
  const groups = new Map<string, string[]>();
  for (const tid of allThreadIds) {
    const root = ufFind(parent, tid);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(tid);
  }

  // Build lookup: threadId → group
  const mergeGroups = new Map<string, string[]>();
  for (const group of groups.values()) {
    for (const tid of group) {
      mergeGroups.set(tid, group);
    }
  }

  _mergeGroupsByAccount.set(accountKey, mergeGroups);

  log.info(
    `[ThreadMerge] Built merge cache for account=${accountKey || "(all)"}: ${rows.length} emails, ` +
      `${allThreadIds.size} threads, ${groups.size} groups in ${(performance.now() - t0).toFixed(1)}ms`,
  );

  return mergeGroups;
}

/** Invalidate thread-merge cache. Called when new emails are inserted. */
export function invalidateThreadMergeCache(accountId?: string): void {
  if (accountId !== undefined) {
    _mergeGroupsByAccount.delete(accountId);
    // Also invalidate the "all-accounts" key since it overlaps
    _mergeGroupsByAccount.delete("");
  } else {
    _mergeGroupsByAccount.clear();
  }
}

/**
 * Given a threadId, find all Gmail thread IDs that belong to the same
 * merge group via In-Reply-To links.
 *
 * Uses a precomputed Union-Find cache (built in one O(N) pass over all emails)
 * instead of per-thread BFS queries. The cache is lazily built on first call
 * and invalidated when new emails are inserted.
 *
 * Falls back to returning just [threadId] if the cache doesn't know the thread
 * (e.g. for a brand-new email that arrived after cache was built — the cache
 * will be rebuilt on next invalidation).
 */
function getMergedGmailThreadIds(threadId: string, accountId?: string): string[] {
  const accountKey = accountId || "";
  let groups = _mergeGroupsByAccount.get(accountKey);
  if (!groups) {
    groups = buildMergeCache(accountId);
  }
  return groups.get(threadId) || [threadId];
}

/**
 * Get a single email ID for a thread — lightweight alternative to getEmailsByThread
 * when you only need an email ID (e.g. for task queueing). Avoids the expensive
 * BFS thread-merge and full JOIN.
 */
export function getFirstEmailIdForThread(threadId: string, accountId?: string): string | null {
  const db = getDatabase();
  // Resolve merged thread IDs so we find emails even when Gmail has
  // split a conversation across multiple thread_id values.
  const allThreadIds = getMergedGmailThreadIds(threadId, accountId);
  const accountFilter = accountId ? " AND account_id = ?" : "";
  const placeholders = allThreadIds.map(() => "?").join(",");
  const params = accountId ? [...allThreadIds, accountId] : allThreadIds;
  const row = db
    .prepare(`SELECT id FROM emails WHERE thread_id IN (${placeholders})${accountFilter} LIMIT 1`)
    .get(...params) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Check if all non-SENT emails in a thread have been analyzed.
 * Lightweight alternative to loading the full thread via getEmailsByThread.
 */
export function isThreadFullyAnalyzed(threadId: string, accountId?: string): boolean {
  const db = getDatabase();
  const allThreadIds = getMergedGmailThreadIds(threadId, accountId);
  const accountFilter = accountId ? " AND e.account_id = ?" : "";
  const placeholders = allThreadIds.map(() => "?").join(",");
  const params = accountId ? [...allThreadIds, accountId] : allThreadIds;
  // Count inbox (non-SENT) emails that don't have an analysis row
  const row = db
    .prepare(
      `
    SELECT COUNT(*) as unanalyzed
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    WHERE e.thread_id IN (${placeholders})${accountFilter}
      AND (e.label_ids IS NULL OR e.label_ids NOT LIKE '%"SENT"%')
      AND a.email_id IS NULL
  `,
    )
    .get(...params) as { unanalyzed: number };
  return row.unanalyzed === 0;
}

/**
 * Strip inline data: URIs larger than ~50KB from email HTML bodies.
 * These are typically multi-MB base64-encoded images or videos that bloat IPC
 * transfer, Zustand store memory, and DOM rendering in the renderer process.
 * The original bodies remain in the DB; this only affects what crosses IPC.
 */
function stripLargeDataUris(body: string): string {
  if (!body || !body.includes("data:")) return body;
  // If the body is under 50KB total, no substring can exceed the 50KB data URI threshold
  if (body.length < 50_000) return body;

  return body.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*["'])(data:[^"']+)(["'][^>]*>)/gi,
    (match, before: string, dataUri: string, after: string) => {
      if (dataUri.length < 50_000) return match;
      const mimeMatch = dataUri.match(/^data:([^;,]+)/);
      const mime = mimeMatch?.[1] ?? "image";
      const sizeKB = Math.round((dataUri.length * 3) / 4 / 1024);
      const sizeLabel = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
      // Theme-neutral colors: the main process doesn't know the renderer's theme,
      // so use mid-tone grays that are legible on both light and dark backgrounds.
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60">` +
        `<rect width="400" height="60" rx="8" fill="#d1d5db"/>` +
        `<text x="200" y="35" text-anchor="middle" fill="#4b5563" font-family="system-ui" font-size="13">` +
        `Inline ${mime} (${sizeLabel}) — too large to display inline` +
        `</text></svg>`;
      return `${before}data:image/svg+xml,${encodeURIComponent(svg)}${after}`;
    },
  );
}

function rowToDashboardEmail(row: Record<string, unknown>): DashboardEmail {
  // Parse labelIds from JSON string if present
  let labelIds: string[] | undefined;
  if (row.labelIds && typeof row.labelIds === "string") {
    try {
      labelIds = JSON.parse(row.labelIds);
    } catch {
      labelIds = undefined;
    }
  }

  // Parse attachments from JSON string if present
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let attachments: import("../../shared/types").AttachmentMeta[] | undefined;
  if (row.attachmentsJson && typeof row.attachmentsJson === "string") {
    try {
      attachments = JSON.parse(row.attachmentsJson);
    } catch {
      attachments = undefined;
    }
  }

  const email: DashboardEmail = {
    id: row.id as string,
    threadId: row.threadId as string,
    accountId: row.accountId as string | undefined,
    subject: row.subject as string,
    from: row.from as string,
    to: row.to as string,
    ...(row.cc ? { cc: row.cc as string } : {}),
    ...(row.bcc ? { bcc: row.bcc as string } : {}),
    body: stripLargeDataUris(row.body as string),
    snippet: row.snippet as string | undefined,
    date: row.date as string,
    labelIds,
    ...(attachments?.length ? { attachments } : {}),
    ...(row.messageId ? { messageId: row.messageId as string } : {}),
    ...(row.inReplyTo ? { inReplyTo: row.inReplyTo as string } : {}),
  };

  if (row.analyzedAt != null) {
    email.analysis = {
      needsReply: Boolean(row.needsReply),
      reason: row.reason as string,
      priority: row.priority as "high" | "medium" | "low" | undefined,
      analyzedAt: row.analyzedAt as number,
    };
  }

  if (row.draftBody != null && (row.draftBody as string) !== "") {
    let draftTo: string[] | undefined;
    let draftCc: string[] | undefined;
    let draftBcc: string[] | undefined;
    if (row.draftTo && typeof row.draftTo === "string") {
      try {
        draftTo = JSON.parse(row.draftTo);
      } catch {
        /* ignore */
      }
    }
    if (row.draftCc && typeof row.draftCc === "string") {
      try {
        draftCc = JSON.parse(row.draftCc);
      } catch {
        /* ignore */
      }
    }
    if (row.draftBcc && typeof row.draftBcc === "string") {
      try {
        draftBcc = JSON.parse(row.draftBcc);
      } catch {
        /* ignore */
      }
    }

    const validComposeModes = new Set(["reply", "reply-all", "forward"]);
    const rawComposeMode = row.draftComposeMode as string | null;
    const composeMode =
      rawComposeMode && validComposeModes.has(rawComposeMode)
        ? (rawComposeMode as "reply" | "reply-all" | "forward")
        : undefined;

    email.draft = {
      body: row.draftBody as string,
      gmailDraftId: (row.gmailDraftId as string | null) ?? undefined,
      status: row.draftStatus as "pending" | "created" | "edited",
      createdAt: row.draftCreatedAt as number,
      ...(composeMode ? { composeMode } : {}),
      ...(row.agentTaskId ? { agentTaskId: row.agentTaskId as string } : {}),
      ...(draftTo?.length ? { to: draftTo } : {}),
      ...(draftCc?.length ? { cc: draftCc } : {}),
      ...(draftBcc?.length ? { bcc: draftBcc } : {}),
    };
  }

  return email;
}

// Analysis operations
export function saveAnalysis(
  emailId: string,
  needsReply: boolean,
  reason: string,
  priority?: string,
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO analyses (email_id, needs_reply, reason, priority, analyzed_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(emailId, needsReply ? 1 : 0, reason, priority || null, Date.now());
}

// Draft operations
export function saveDraft(
  emailId: string,
  draftBody: string,
  status: string = "pending",
  gmailDraftId?: string,
  options?: { to?: string[]; cc?: string[]; bcc?: string[]; composeMode?: string },
): void {
  const db = getDatabase();
  // Use INSERT ... ON CONFLICT to preserve agent_task_id on updates.
  // INSERT OR REPLACE deletes-then-inserts, which would silently NULL out all columns.
  // agent_task_id is preserved so the trace link survives draft edits and refinements;
  // gmail_draft_id is NOT preserved — regenerated drafts should clear the old Gmail ID
  // to avoid a stale reference to a Gmail draft with different content.
  const toJson = options?.to?.length ? JSON.stringify(options.to) : null;
  const ccJson = options?.cc?.length ? JSON.stringify(options.cc) : null;
  const bccJson = options?.bcc?.length ? JSON.stringify(options.bcc) : null;
  const composeMode = options?.composeMode ?? null;
  // Per-field COALESCE: only overwrite a field if it was explicitly provided in options.
  // This prevents saving composeMode/to from accidentally NULLing out cc/bcc.
  const updateTo =
    options !== undefined && "to" in options
      ? "excluded.to_recipients"
      : "COALESCE(excluded.to_recipients, drafts.to_recipients)";
  const updateCc =
    options !== undefined && "cc" in options ? "excluded.cc" : "COALESCE(excluded.cc, drafts.cc)";
  const updateBcc =
    options !== undefined && "bcc" in options
      ? "excluded.bcc"
      : "COALESCE(excluded.bcc, drafts.bcc)";
  // compose_mode: preserve existing value when not explicitly provided
  const updateComposeMode =
    options !== undefined && "composeMode" in options
      ? "excluded.compose_mode"
      : "COALESCE(excluded.compose_mode, drafts.compose_mode)";
  const stmt = db.prepare(`
    INSERT INTO drafts (email_id, draft_body, gmail_draft_id, status, created_at, to_recipients, cc, bcc, compose_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_id) DO UPDATE SET
      draft_body = excluded.draft_body,
      gmail_draft_id = excluded.gmail_draft_id,
      status = excluded.status,
      created_at = excluded.created_at,
      to_recipients = ${updateTo},
      cc = ${updateCc},
      bcc = ${updateBcc},
      compose_mode = ${updateComposeMode}
  `);
  stmt.run(
    emailId,
    draftBody,
    gmailDraftId || null,
    status,
    Date.now(),
    toJson,
    ccJson,
    bccJson,
    composeMode,
  );
}

export function updateDraftStatus(emailId: string, status: string, gmailDraftId?: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE drafts SET status = ?, gmail_draft_id = COALESCE(?, gmail_draft_id)
    WHERE email_id = ?
  `);
  stmt.run(status, gmailDraftId || null, emailId);
}

/** Update only the gmail_draft_id without changing the draft status. */
export function updateDraftGmailId(emailId: string, gmailDraftId: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE drafts SET gmail_draft_id = ? WHERE email_id = ?`).run(gmailDraftId, emailId);
}

/** Link a draft to the agent task that produced it (for trace retrieval). */
export function updateDraftAgentTaskId(emailId: string, agentTaskId: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`UPDATE drafts SET agent_task_id = ? WHERE email_id = ?`);
  stmt.run(agentTaskId, emailId);
}

/** Delete the draft for a single email. */
export function deleteDraft(emailId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM drafts WHERE email_id = ?").run(emailId);
}

/** Get the RFC 5322 Message-ID header for an email (used for reply threading). */
export function getEmailMessageIdHeader(emailId: string): string | null {
  const db = getDatabase();
  const row = db.prepare("SELECT message_id FROM emails WHERE id = ?").get(emailId) as
    | { message_id: string | null }
    | undefined;
  return row?.message_id ?? null;
}

/** Look up an email by its RFC 5322 Message-ID header. Returns draft info if present. */
export function getEmailByMessageId(messageId: string): {
  emailId: string;
  threadId: string;
  accountId: string;
  gmailDraftId: string | null;
} | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
    SELECT e.id AS emailId, e.thread_id AS threadId, e.account_id AS accountId,
           d.gmail_draft_id AS gmailDraftId
    FROM emails e
    LEFT JOIN drafts d ON e.id = d.email_id
    WHERE e.message_id = ?
  `,
    )
    .get(messageId) as
    | { emailId: string; threadId: string; accountId: string; gmailDraftId: string | null }
    | undefined;
  return row || null;
}

/** Find all emails in a thread that have drafts. */
export function getThreadDrafts(
  threadId: string,
  accountId: string,
): Array<{
  emailId: string;
  gmailDraftId: string | null;
  status: string;
}> {
  const db = getDatabase();
  return db
    .prepare(
      `
    SELECT d.email_id AS emailId, d.gmail_draft_id AS gmailDraftId, d.status
    FROM drafts d
    JOIN emails e ON d.email_id = e.id
    WHERE e.thread_id = ? AND e.account_id = ?
  `,
    )
    .all(threadId, accountId) as Array<{
    emailId: string;
    gmailDraftId: string | null;
    status: string;
  }>;
}

/**
 * Get the most recent AI-generated draft body for a thread.
 * Used by draft-edit learning to compare what was generated vs what was sent.
 */
export function getThreadDraftBody(
  threadId: string,
  accountId: string,
): {
  emailId: string;
  draftBody: string;
  fromAddress: string;
  subject: string;
} | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
    SELECT d.email_id AS emailId, d.draft_body AS draftBody, e.from_address AS fromAddress, e.subject
    FROM drafts d
    JOIN emails e ON d.email_id = e.id
    WHERE e.thread_id = ? AND e.account_id = ? AND d.status = 'pending'
    ORDER BY d.created_at DESC
    LIMIT 1
  `,
    )
    .get(threadId, accountId) as
    | { emailId: string; draftBody: string; fromAddress: string; subject: string }
    | undefined;
  return row ?? null;
}

/**
 * Delete agent traces for inbox emails that have pending (AI-generated) drafts.
 * Must be called BEFORE clearInboxPendingDrafts() since it joins against the drafts table.
 */
export function clearInboxPendingAgentTraces(): number {
  const db = getDatabase();
  const result = db
    .prepare(
      `
    DELETE FROM agent_conversation_mirror WHERE local_task_id IN (
      SELECT d.agent_task_id FROM drafts d
      JOIN emails e ON d.email_id = e.id
      WHERE d.status = 'pending'
        AND d.agent_task_id IS NOT NULL
        AND (e.label_ids IS NULL OR e.label_ids LIKE '%"INBOX"%')
    )
  `,
    )
    .run();
  return result.changes;
}

/**
 * Atomically clear pending drafts AND their associated agent traces.
 * Enforces the correct order: traces first (JOIN needs drafts), then drafts.
 */
export function clearInboxPendingDraftsAndTraces(): {
  draftsCleared: number;
  tracesCleared: number;
} {
  const tracesCleared = clearInboxPendingAgentTraces();
  const draftsCleared = clearInboxPendingDrafts();
  return { draftsCleared, tracesCleared };
}

/**
 * Load agent trace events from the conversation mirror by local_task_id.
 * Returns the parsed events array, or null if no trace exists.
 */
export function getAgentTrace(taskId: string): ConversationMirrorRow | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, provider_id AS providerId, provider_conversation_id AS providerConversationId,
           local_task_id AS localTaskId, status, messages_json AS messagesJson,
           remote_updated_at AS remoteUpdatedAt, last_synced_at AS lastSyncedAt,
           created_at AS createdAt, updated_at AS updatedAt
    FROM agent_conversation_mirror
    WHERE local_task_id = ?
    LIMIT 1
  `);
  const row = stmt.get(taskId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    providerId: row.providerId as string,
    providerConversationId: row.providerConversationId as string,
    localTaskId: row.localTaskId as string | undefined,
    status: row.status as string,
    messagesJson: row.messagesJson as string,
    remoteUpdatedAt: row.remoteUpdatedAt as string | undefined,
    lastSyncedAt: row.lastSyncedAt as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

/** Delete the agent conversation mirror for a given local task ID (cleanup on archive). */
export function deleteAgentTrace(taskId: string): void {
  const db = getDatabase();
  db.prepare(`DELETE FROM agent_conversation_mirror WHERE local_task_id = ?`).run(taskId);
}

// Bulk clearing for prompt changes — scoped to inbox emails only
export function clearInboxAnalyses(): number {
  const db = getDatabase();
  const result = db
    .prepare(
      `
    DELETE FROM analyses WHERE email_id IN (
      SELECT id FROM emails WHERE label_ids IS NULL OR label_ids LIKE '%"INBOX"%'
    )
  `,
    )
    .run();
  return result.changes;
}

/** Get pending inbox drafts that have been synced to Gmail (for bulk cleanup). */
export function getInboxPendingDraftsWithGmail(): Array<{
  emailId: string;
  gmailDraftId: string;
  accountId: string;
}> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT d.email_id, d.gmail_draft_id, e.account_id FROM drafts d
    JOIN emails e ON d.email_id = e.id
    WHERE d.status = 'pending'
      AND d.gmail_draft_id IS NOT NULL
      AND (e.label_ids IS NULL OR e.label_ids LIKE '%"INBOX"%')
  `,
    )
    .all() as Array<{ email_id: string; gmail_draft_id: string; account_id: string }>;
  return rows.map((r) => ({
    emailId: r.email_id,
    gmailDraftId: r.gmail_draft_id,
    accountId: r.account_id,
  }));
}

export function clearInboxPendingDrafts(): number {
  const db = getDatabase();
  // Only clear AI-generated drafts (status 'pending'), not user-edited or created ones
  const result = db
    .prepare(
      `
    DELETE FROM drafts WHERE status = 'pending' AND email_id IN (
      SELECT id FROM emails WHERE label_ids IS NULL OR label_ids LIKE '%"INBOX"%'
    )
  `,
    )
    .run();
  return result.changes;
}

export function clearInboxArchiveReady(): number {
  const db = getDatabase();
  const result = db
    .prepare(
      `
    DELETE FROM archive_ready WHERE thread_id IN (
      SELECT DISTINCT thread_id FROM emails WHERE label_ids IS NULL OR label_ids LIKE '%"INBOX"%'
    )
  `,
    )
    .run();
  return result.changes;
}

// Sent email operations
export function saveSentEmail(email: SentEmail): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sent_emails (id, to_address, subject, body, date, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(email.id, email.toAddress, email.subject, email.body, email.date, Date.now());
}

export function getSentEmailCount(): number {
  const db = getDatabase();
  const stmt = db.prepare("SELECT COUNT(*) as count FROM sent_emails");
  const row = stmt.get() as { count: number };
  return row.count;
}

// Style sample operations
export function saveStyleSample(
  sentEmailId: string,
  context: string,
  characteristics: string[],
  samplePhrases: string[],
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO style_samples (sent_email_id, context, characteristics, sample_phrases)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(sentEmailId, context, JSON.stringify(characteristics), JSON.stringify(samplePhrases));
}

export function getStyleSamplesForDomain(emailDomain: string): StyleSample[] {
  const db = getDatabase();
  // Match emails to the same domain
  const stmt = db.prepare(`
    SELECT ss.id, ss.sent_email_id as sentEmailId, ss.context, ss.characteristics, ss.sample_phrases as samplePhrases
    FROM style_samples ss
    JOIN sent_emails se ON ss.sent_email_id = se.id
    WHERE se.to_address LIKE ?
    ORDER BY se.date DESC
    LIMIT 10
  `);

  const rows = stmt.all(`%@${emailDomain}%`) as Array<{
    id: number;
    sentEmailId: string;
    context: string;
    characteristics: string;
    samplePhrases: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sentEmailId: row.sentEmailId,
    context: row.context as "business" | "casual" | "technical",
    characteristics: JSON.parse(row.characteristics) as string[],
    samplePhrases: JSON.parse(row.samplePhrases) as string[],
  }));
}

// Correspondent profile operations (for style learning)

type SentEmailRow = {
  id: string;
  subject: string;
  body_text: string | null;
  body: string;
  date: string;
  is_reply: number; // 1 if subject starts with Re:
};

export function getSentEmailsToRecipient(
  recipientEmail: string,
  accountId: string,
  limit: number = 10,
): SentEmailRow[] {
  const db = getDatabase();
  // to_address stores "Name <email>" format; match both bare and angle-bracket forms
  const stmt = db.prepare(`
    SELECT id, subject, body_text, body, date,
      CASE WHEN subject LIKE 'Re:%' OR subject LIKE 'RE:%' THEN 1 ELSE 0 END as is_reply
    FROM emails
    WHERE label_ids LIKE '%"SENT"%'
      AND (to_address LIKE ? OR to_address = ?)
      AND account_id = ?
    ORDER BY date DESC
    LIMIT ?
  `);
  return stmt.all(`%<${recipientEmail}>%`, recipientEmail, accountId, limit) as SentEmailRow[];
}

export function getSentEmailsToSameDomain(
  domain: string,
  accountId: string,
  limit: number = 10,
): SentEmailRow[] {
  const db = getDatabase();
  // Match @domain> (angle-bracket format) to avoid matching subdomains like @domain.spoof
  const stmt = db.prepare(`
    SELECT id, subject, body_text, body, date,
      CASE WHEN subject LIKE 'Re:%' OR subject LIKE 'RE:%' THEN 1 ELSE 0 END as is_reply
    FROM emails
    WHERE label_ids LIKE '%"SENT"%'
      AND to_address LIKE ?
      AND account_id = ?
    ORDER BY date DESC
    LIMIT ?
  `);
  return stmt.all(`%@${domain}>%`, accountId, limit) as SentEmailRow[];
}

export function getSentEmailsByFormalityRange(
  accountId: string,
  low: number,
  high: number,
  limit: number = 5,
): SentEmailRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT e.id, e.subject, e.body_text, e.body, e.date,
      CASE WHEN e.subject LIKE 'Re:%' OR e.subject LIKE 'RE:%' THEN 1 ELSE 0 END as is_reply
    FROM emails e
    JOIN correspondent_profiles cp ON (e.to_address LIKE '%<' || cp.email || '>%' OR e.to_address = cp.email)
      AND e.account_id = cp.account_id
    WHERE e.label_ids LIKE '%"SENT"%'
      AND e.account_id = ?
      AND cp.formality_score BETWEEN ? AND ?
    ORDER BY e.date DESC
    LIMIT ?
  `);
  return stmt.all(accountId, low, high, limit) as SentEmailRow[];
}

export function getCorrespondentProfile(
  email: string,
  accountId: string,
): CorrespondentProfile | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT email, account_id as accountId, display_name as displayName,
      email_count as emailCount, avg_word_count as avgWordCount,
      dominant_greeting as dominantGreeting, dominant_signoff as dominantSignoff,
      formality_score as formalityScore, last_computed_at as lastComputedAt
    FROM correspondent_profiles
    WHERE email = ? AND account_id = ?
  `);
  const row = stmt.get(email, accountId) as CorrespondentProfile | undefined;
  return row ?? null;
}

export function saveCorrespondentProfile(profile: CorrespondentProfile): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO correspondent_profiles
      (email, account_id, display_name, email_count, avg_word_count,
       dominant_greeting, dominant_signoff, formality_score, last_computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    profile.email,
    profile.accountId,
    profile.displayName,
    profile.emailCount,
    profile.avgWordCount,
    profile.dominantGreeting,
    profile.dominantSignoff,
    profile.formalityScore,
    profile.lastComputedAt,
  );
}

export function getSentEmailCountToRecipient(recipientEmail: string, accountId: string): number {
  const db = getDatabase();
  // Match both "Name <email>" and bare email formats
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM emails
    WHERE label_ids LIKE '%"SENT"%'
      AND (to_address LIKE ? OR to_address = ?)
      AND account_id = ?
  `);
  const row = stmt.get(`%<${recipientEmail}>%`, recipientEmail, accountId) as { count: number };
  return row.count;
}

// Clear stale data (emails older than 30 days)
export function clearStaleData(): void {
  const db = getDatabase();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  db.exec(`
    DELETE FROM drafts WHERE email_id IN (SELECT id FROM emails WHERE fetched_at < ${thirtyDaysAgo});
    DELETE FROM analyses WHERE email_id IN (SELECT id FROM emails WHERE fetched_at < ${thirtyDaysAgo});
    DELETE FROM emails WHERE fetched_at < ${thirtyDaysAgo};
  `);
}

// ============================================
// Sync state operations
// ============================================

export function getHistoryId(accountId: string): string | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT history_id FROM sync_state WHERE account_id = ?");
  const row = stmt.get(accountId) as { history_id: string } | undefined;
  return row?.history_id || null;
}

export function setHistoryId(accountId: string, historyId: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sync_state (account_id, history_id, last_sync_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(accountId, historyId, Date.now());
}

export function getLastSyncTime(accountId: string): number | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT last_sync_at FROM sync_state WHERE account_id = ?");
  const row = stmt.get(accountId) as { last_sync_at: number } | undefined;
  return row?.last_sync_at || null;
}

// ============================================
// Account management
// ============================================

export type AccountRecord = {
  id: string;
  email: string;
  displayName?: string;
  isPrimary: boolean;
  addedAt: number;
};

export function saveAccount(
  accountId: string,
  email: string,
  displayName?: string,
  isPrimary: boolean = false,
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO accounts (id, email, display_name, is_primary, added_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(accountId, email, displayName || null, isPrimary ? 1 : 0, Date.now());
}

export function getAccounts(): AccountRecord[] {
  const db = getDatabase();
  const stmt = db.prepare(
    "SELECT id, email, display_name as displayName, is_primary as isPrimary, added_at as addedAt FROM accounts ORDER BY added_at ASC",
  );
  const rows = stmt.all() as Array<{
    id: string;
    email: string;
    displayName: string | null;
    isPrimary: number;
    addedAt: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.displayName || undefined,
    isPrimary: Boolean(row.isPrimary),
    addedAt: row.addedAt,
  }));
}

export function updateAccountDisplayName(accountId: string, displayName: string): void {
  const db = getDatabase();
  db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(displayName, accountId);
}

export function removeAccount(accountId: string): void {
  const db = getDatabase();
  const run = db.transaction(() => {
    // Delete data joined via email_id (must come before emails deletion)
    db.prepare(
      "DELETE FROM extension_enrichments WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    db.prepare(
      "DELETE FROM drafts WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    db.prepare(
      "DELETE FROM analyses WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    // Delete data keyed by account_id
    db.prepare("DELETE FROM archive_ready WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM snoozed_emails WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM scheduled_messages WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM outbox WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM local_drafts WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM labels WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM sync_state WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM correspondent_profiles WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM calendar_events WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM calendar_sync_state WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM memories WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM agent_audit_log WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM emails WHERE account_id = ?").run(accountId);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  });
  run();
}

export function setPrimaryAccount(accountId: string): void {
  const db = getDatabase();
  db.prepare("UPDATE accounts SET is_primary = 0").run();
  db.prepare("UPDATE accounts SET is_primary = 1 WHERE id = ?").run(accountId);
}

// ============================================
// Sender profile operations
// ============================================

export type SenderProfile = {
  email: string;
  name?: string;
  summary: string;
  linkedinUrl?: string;
  company?: string;
  title?: string;
  lookupAt: number;
};

export function saveSenderProfile(profile: SenderProfile): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sender_profiles (email, name, summary, linkedin_url, company, title, lookup_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    profile.email.toLowerCase(),
    profile.name || null,
    profile.summary,
    profile.linkedinUrl || null,
    profile.company || null,
    profile.title || null,
    profile.lookupAt,
  );
}

export function getSenderProfile(email: string): SenderProfile | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT email, name, summary, linkedin_url as linkedinUrl, company, title, lookup_at as lookupAt
    FROM sender_profiles WHERE email = ?
  `);
  const row = stmt.get(email.toLowerCase()) as
    | {
        email: string;
        name: string | null;
        summary: string;
        linkedinUrl: string | null;
        company: string | null;
        title: string | null;
        lookupAt: number;
      }
    | undefined;

  if (!row) return null;

  return {
    email: row.email,
    name: row.name || undefined,
    summary: row.summary,
    linkedinUrl: row.linkedinUrl || undefined,
    company: row.company || undefined,
    title: row.title || undefined,
    lookupAt: row.lookupAt,
  };
}

export function getSenderProfiles(): SenderProfile[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT email, name, summary, linkedin_url as linkedinUrl, company, title, lookup_at as lookupAt
    FROM sender_profiles ORDER BY lookup_at DESC
  `);
  const rows = stmt.all() as Array<{
    email: string;
    name: string | null;
    summary: string;
    linkedinUrl: string | null;
    company: string | null;
    title: string | null;
    lookupAt: number;
  }>;

  return rows.map((row) => ({
    email: row.email,
    name: row.name || undefined,
    summary: row.summary,
    linkedinUrl: row.linkedinUrl || undefined,
    company: row.company || undefined,
    title: row.title || undefined,
    lookupAt: row.lookupAt,
  }));
}

// ============================================
// Memory operations
// ============================================

type MemoryRow = {
  id: string;
  account_id: string;
  scope: string;
  scope_value: string | null;
  content: string;
  source: string;
  source_email_id: string | null;
  enabled: number;
  memory_type: string;
  created_at: number;
  updated_at: number;
};

function memoryRowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope as MemoryScope,
    scopeValue: row.scope_value,
    content: row.content,
    source: row.source as MemorySource,
    sourceEmailId: row.source_email_id,
    enabled: row.enabled === 1,
    memoryType: (row.memory_type ?? "drafting") as MemoryType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveMemory(memory: Memory): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO memories (id, account_id, scope, scope_value, content, source, source_email_id, enabled, memory_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    memory.id,
    memory.accountId,
    memory.scope,
    memory.scopeValue,
    memory.content,
    memory.source,
    memory.sourceEmailId ?? null,
    memory.enabled ? 1 : 0,
    memory.memoryType ?? "drafting",
    memory.createdAt,
    memory.updatedAt,
  );
}

export function getMemory(id: string): Memory | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  return row ? memoryRowToMemory(row) : null;
}

export function getMemories(accountId: string, memoryType?: MemoryType): Memory[] {
  const db = getDatabase();
  if (memoryType) {
    const rows = db
      .prepare(
        "SELECT * FROM memories WHERE account_id = ? AND memory_type = ? ORDER BY scope, created_at DESC",
      )
      .all(accountId, memoryType) as MemoryRow[];
    return rows.map(memoryRowToMemory);
  }
  const rows = db
    .prepare("SELECT * FROM memories WHERE account_id = ? ORDER BY scope, created_at DESC")
    .all(accountId) as MemoryRow[];
  return rows.map(memoryRowToMemory);
}

/** Fetch global + category memories for an account (no sender context needed). */
export function getAccountMemories(
  accountId: string,
  memoryType: MemoryType = "drafting",
): Memory[] {
  const db = getDatabase();

  const categoryRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'category' AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, memoryType) as MemoryRow[];

  const globalRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'global' AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, memoryType) as MemoryRow[];

  return [...categoryRows.map(memoryRowToMemory), ...globalRows.map(memoryRowToMemory)];
}

/** Fetch all memories relevant to a given sender email, ordered from most to least specific. */
export function getRelevantMemories(
  senderEmail: string,
  accountId: string,
  memoryType: MemoryType = "drafting",
): Memory[] {
  const db = getDatabase();
  const domain = senderEmail.includes("@") ? senderEmail.split("@")[1] : null;

  // Person-specific
  const personRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'person' AND scope_value = ? AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, senderEmail.toLowerCase(), memoryType) as MemoryRow[];

  // Domain-specific
  const domainRows = domain
    ? (db
        .prepare(
          "SELECT * FROM memories WHERE account_id = ? AND scope = 'domain' AND scope_value = ? AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
        )
        .all(accountId, domain.toLowerCase(), memoryType) as MemoryRow[])
    : [];

  // Category (all — Claude decides relevance)
  const categoryRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'category' AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, memoryType) as MemoryRow[];

  // Global
  const globalRows = db
    .prepare(
      "SELECT * FROM memories WHERE account_id = ? AND scope = 'global' AND enabled = 1 AND memory_type = ? ORDER BY created_at DESC",
    )
    .all(accountId, memoryType) as MemoryRow[];

  // Return in specificity order: person > domain > category > global
  return [
    ...personRows.map(memoryRowToMemory),
    ...domainRows.map(memoryRowToMemory),
    ...categoryRows.map(memoryRowToMemory),
    ...globalRows.map(memoryRowToMemory),
  ];
}

export function updateMemory(
  id: string,
  updates: { content?: string; enabled?: boolean; scope?: MemoryScope; scopeValue?: string | null },
): void {
  const db = getDatabase();
  const memory = getMemory(id);
  if (!memory) return;

  const newContent = updates.content ?? memory.content;
  const newEnabled = updates.enabled ?? memory.enabled;
  const newScope = updates.scope ?? memory.scope;
  const newScopeValue = updates.scopeValue !== undefined ? updates.scopeValue : memory.scopeValue;

  db.prepare(
    "UPDATE memories SET content = ?, enabled = ?, scope = ?, scope_value = ?, updated_at = ? WHERE id = ?",
  ).run(newContent, newEnabled ? 1 : 0, newScope, newScopeValue, Date.now(), id);
}

export function deleteMemory(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export function getMemoryCategories(accountId: string): string[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT DISTINCT scope_value FROM memories WHERE account_id = ? AND scope = 'category' AND scope_value IS NOT NULL ORDER BY scope_value",
    )
    .all(accountId) as Array<{ scope_value: string }>;
  return rows.map((r) => r.scope_value);
}

// ============================================
// Draft Memory operations (low-confidence observations)
// ============================================

type DraftMemoryRow = {
  id: string;
  account_id: string;
  scope: string;
  scope_value: string | null;
  content: string;
  vote_count: number;
  source_email_ids: string;
  sender_email: string | null;
  sender_domain: string | null;
  subject: string | null;
  email_context: string | null;
  memory_type: string;
  created_at: number;
  last_voted_at: number;
};

function draftMemoryRowToDraftMemory(row: DraftMemoryRow): DraftMemory {
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope as MemoryScope,
    scopeValue: row.scope_value,
    content: row.content,
    voteCount: row.vote_count,
    sourceEmailIds: JSON.parse(row.source_email_ids) as string[],
    senderEmail: row.sender_email,
    senderDomain: row.sender_domain,
    subject: row.subject,
    emailContext: row.email_context,
    memoryType: (row.memory_type ?? "drafting") as MemoryType,
    createdAt: row.created_at,
    lastVotedAt: row.last_voted_at,
  };
}

export function saveDraftMemory(dm: DraftMemory): void {
  const db = getDatabase();
  db.prepare(
    `
    INSERT OR REPLACE INTO draft_memories (id, account_id, scope, scope_value, content, vote_count, source_email_ids, sender_email, sender_domain, subject, email_context, memory_type, created_at, last_voted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    dm.id,
    dm.accountId,
    dm.scope,
    dm.scopeValue,
    dm.content,
    dm.voteCount,
    JSON.stringify(dm.sourceEmailIds),
    dm.senderEmail,
    dm.senderDomain,
    dm.subject,
    dm.emailContext,
    dm.memoryType ?? "drafting",
    dm.createdAt,
    dm.lastVotedAt,
  );
}

export function getDraftMemories(accountId: string, memoryType?: MemoryType): DraftMemory[] {
  const db = getDatabase();
  if (memoryType) {
    const rows = db
      .prepare(
        "SELECT * FROM draft_memories WHERE account_id = ? AND memory_type = ? ORDER BY last_voted_at DESC",
      )
      .all(accountId, memoryType) as DraftMemoryRow[];
    return rows.map(draftMemoryRowToDraftMemory);
  }
  const rows = db
    .prepare("SELECT * FROM draft_memories WHERE account_id = ? ORDER BY last_voted_at DESC")
    .all(accountId) as DraftMemoryRow[];
  return rows.map(draftMemoryRowToDraftMemory);
}

export function getDraftMemory(id: string): DraftMemory | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM draft_memories WHERE id = ?").get(id) as
    | DraftMemoryRow
    | undefined;
  return row ? draftMemoryRowToDraftMemory(row) : null;
}

export function incrementDraftMemoryVote(id: string, sourceEmailId: string): DraftMemory | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM draft_memories WHERE id = ?").get(id) as
    | DraftMemoryRow
    | undefined;
  if (!row) return null;

  const sourceEmailIds = JSON.parse(row.source_email_ids) as string[];
  const isNew = !sourceEmailIds.includes(sourceEmailId);
  if (isNew) {
    sourceEmailIds.push(sourceEmailId);
  }
  const now = Date.now();
  const newVoteCount = isNew ? row.vote_count + 1 : row.vote_count;
  db.prepare(
    "UPDATE draft_memories SET vote_count = ?, source_email_ids = ?, last_voted_at = ? WHERE id = ?",
  ).run(newVoteCount, JSON.stringify(sourceEmailIds), now, id);

  return draftMemoryRowToDraftMemory({
    ...row,
    vote_count: newVoteCount,
    source_email_ids: JSON.stringify(sourceEmailIds),
    last_voted_at: now,
  });
}

export function deleteDraftMemory(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM draft_memories WHERE id = ?").run(id);
}

export function getDraftMemoryCount(accountId: string, memoryType?: MemoryType): number {
  const db = getDatabase();
  if (memoryType) {
    const row = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM draft_memories WHERE account_id = ? AND memory_type = ?",
      )
      .get(accountId, memoryType) as { cnt: number };
    return row.cnt;
  }
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM draft_memories WHERE account_id = ?")
    .get(accountId) as { cnt: number };
  return row.cnt;
}

export function evictOldestDraftMemories(
  accountId: string,
  maxCount: number,
  memoryType?: MemoryType,
): void {
  const db = getDatabase();
  const count = getDraftMemoryCount(accountId, memoryType);
  if (count <= maxCount) return;

  const toEvict = count - maxCount;
  if (memoryType) {
    db.prepare(
      `
      DELETE FROM draft_memories WHERE id IN (
        SELECT id FROM draft_memories WHERE account_id = ? AND memory_type = ? ORDER BY last_voted_at ASC LIMIT ?
      )
    `,
    ).run(accountId, memoryType, toEvict);
  } else {
    db.prepare(
      `
      DELETE FROM draft_memories WHERE id IN (
        SELECT id FROM draft_memories WHERE account_id = ? ORDER BY last_voted_at ASC LIMIT ?
      )
    `,
    ).run(accountId, toEvict);
  }
}

// ============================================
// Extension storage operations
// ============================================

export function getExtensionStorage(extensionId: string, key: string): string | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT value FROM extension_storage WHERE extension_id = ? AND key = ?");
  const row = stmt.get(extensionId, key) as { value: string } | undefined;
  return row?.value || null;
}

export function setExtensionStorage(extensionId: string, key: string, value: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO extension_storage (extension_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(extensionId, key, value, Date.now());
}

export function deleteExtensionStorage(extensionId: string, key: string): void {
  const db = getDatabase();
  const stmt = db.prepare("DELETE FROM extension_storage WHERE extension_id = ? AND key = ?");
  stmt.run(extensionId, key);
}

export function getAllExtensionStorage(extensionId: string): Array<{ key: string; value: string }> {
  const db = getDatabase();
  const stmt = db.prepare("SELECT key, value FROM extension_storage WHERE extension_id = ?");
  return stmt.all(extensionId) as Array<{ key: string; value: string }>;
}

// ============================================
// Extension enrichment operations
// ============================================

export type ExtensionEnrichmentRow = {
  emailId: string;
  extensionId: string;
  panelId: string;
  data: string;
  expiresAt: number | null;
  createdAt: number;
  senderEmail: string | null;
};

export function saveExtensionEnrichment(
  emailId: string,
  extensionId: string,
  panelId: string,
  data: string,
  expiresAt: number | null,
  senderEmail?: string,
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO extension_enrichments (email_id, extension_id, panel_id, data, expires_at, created_at, sender_email)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    emailId,
    extensionId,
    panelId,
    data,
    expiresAt,
    Date.now(),
    senderEmail?.toLowerCase() ?? null,
  );
}

export function getExtensionEnrichments(emailId: string): ExtensionEnrichmentRow[] {
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT email_id as emailId, extension_id as extensionId, panel_id as panelId,
           data, expires_at as expiresAt, created_at as createdAt, sender_email as senderEmail
    FROM extension_enrichments
    WHERE email_id = ? AND (expires_at IS NULL OR expires_at > ?)
  `);
  return stmt.all(emailId, now) as ExtensionEnrichmentRow[];
}

export function getExtensionEnrichment(
  emailId: string,
  extensionId: string,
): ExtensionEnrichmentRow | null {
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT email_id as emailId, extension_id as extensionId, panel_id as panelId,
           data, expires_at as expiresAt, created_at as createdAt, sender_email as senderEmail
    FROM extension_enrichments
    WHERE email_id = ? AND extension_id = ? AND (expires_at IS NULL OR expires_at > ?)
  `);
  return (stmt.get(emailId, extensionId, now) as ExtensionEnrichmentRow) || null;
}

/**
 * Get enrichment by sender email address - used for caching across multiple emails from the same sender
 */
export function getExtensionEnrichmentBySender(
  senderEmail: string,
  extensionId: string,
): ExtensionEnrichmentRow | null {
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT email_id as emailId, extension_id as extensionId, panel_id as panelId,
           data, expires_at as expiresAt, created_at as createdAt, sender_email as senderEmail
    FROM extension_enrichments
    WHERE sender_email = ? AND extension_id = ? AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return (stmt.get(senderEmail.toLowerCase(), extensionId, now) as ExtensionEnrichmentRow) || null;
}

export function clearExpiredEnrichments(): number {
  const db = getDatabase();
  const now = Date.now();
  const result = db
    .prepare("DELETE FROM extension_enrichments WHERE expires_at IS NOT NULL AND expires_at <= ?")
    .run(now);
  return result.changes;
}

/**
 * Delete enrichments for a specific sender and extension
 * Used for forcing a refresh of cached data
 */
export function deleteEnrichmentBySender(senderEmail: string, extensionId: string): number {
  const db = getDatabase();
  const result = db
    .prepare("DELETE FROM extension_enrichments WHERE sender_email = ? AND extension_id = ?")
    .run(senderEmail.toLowerCase(), extensionId);
  return result.changes;
}

/**
 * Delete enrichments containing needsAuth placeholder data for an extension.
 * Called after auth completes so these emails get re-enriched with real data.
 * Preserves valid cached enrichments that don't need re-fetching.
 */
export function deleteNeedsAuthEnrichments(extensionId: string): number {
  const db = getDatabase();
  const result = db
    .prepare(
      `DELETE FROM extension_enrichments WHERE extension_id = ? AND data LIKE '%"needsAuth":true%'`,
    )
    .run(extensionId);
  return result.changes;
}

// ============================================
// Local draft operations (for compose)
// ============================================

import type { LocalDraft } from "../../shared/types";

export function saveLocalDraft(draft: LocalDraft): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO local_drafts (
      id, account_id, gmail_draft_id, thread_id, in_reply_to,
      to_addresses, cc_addresses, bcc_addresses, subject,
      body_html, body_text, is_reply, is_forward,
      created_at, updated_at, synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    draft.id,
    draft.accountId,
    draft.gmailDraftId || null,
    draft.threadId || null,
    draft.inReplyTo || null,
    JSON.stringify(draft.to),
    draft.cc ? JSON.stringify(draft.cc) : null,
    draft.bcc ? JSON.stringify(draft.bcc) : null,
    draft.subject,
    draft.bodyHtml,
    draft.bodyText || null,
    draft.isReply ? 1 : 0,
    draft.isForward ? 1 : 0,
    draft.createdAt,
    draft.updatedAt,
    draft.syncedAt || null,
  );
}

export function getLocalDraft(draftId: string): LocalDraft | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, account_id as accountId, gmail_draft_id as gmailDraftId,
           thread_id as threadId, in_reply_to as inReplyTo,
           to_addresses as toAddresses, cc_addresses as ccAddresses,
           bcc_addresses as bccAddresses, subject,
           body_html as bodyHtml, body_text as bodyText,
           is_reply as isReply, is_forward as isForward,
           created_at as createdAt, updated_at as updatedAt,
           synced_at as syncedAt
    FROM local_drafts WHERE id = ?
  `);
  const row = stmt.get(draftId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return rowToLocalDraft(row);
}

export function getLocalDrafts(accountId?: string): LocalDraft[] {
  const db = getDatabase();
  let query = `
    SELECT id, account_id as accountId, gmail_draft_id as gmailDraftId,
           thread_id as threadId, in_reply_to as inReplyTo,
           to_addresses as toAddresses, cc_addresses as ccAddresses,
           bcc_addresses as bccAddresses, subject,
           body_html as bodyHtml, body_text as bodyText,
           is_reply as isReply, is_forward as isForward,
           created_at as createdAt, updated_at as updatedAt,
           synced_at as syncedAt
    FROM local_drafts
  `;
  if (accountId) {
    query += ` WHERE account_id = ?`;
  }
  query += ` ORDER BY updated_at DESC`;

  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  return (rows as Record<string, unknown>[]).map(rowToLocalDraft);
}

export function deleteLocalDraft(draftId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM local_drafts WHERE id = ?").run(draftId);
}

export function updateLocalDraftGmailId(draftId: string, gmailDraftId: string): void {
  const db = getDatabase();
  db.prepare("UPDATE local_drafts SET gmail_draft_id = ?, synced_at = ? WHERE id = ?").run(
    gmailDraftId,
    Date.now(),
    draftId,
  );
}

function rowToLocalDraft(row: Record<string, unknown>): LocalDraft {
  // SQLite returns NULL for missing values, but LocalDraft expects undefined.
  // Coerce nulls at the boundary so Zod validation doesn't reject them.
  return {
    id: row.id as string,
    accountId: row.accountId as string,
    gmailDraftId: (row.gmailDraftId as string | null) ?? undefined,
    threadId: (row.threadId as string | null) ?? undefined,
    inReplyTo: (row.inReplyTo as string | null) ?? undefined,
    to: JSON.parse(row.toAddresses as string) as string[],
    cc: row.ccAddresses ? (JSON.parse(row.ccAddresses as string) as string[]) : undefined,
    bcc: row.bccAddresses ? (JSON.parse(row.bccAddresses as string) as string[]) : undefined,
    subject: row.subject as string,
    bodyHtml: row.bodyHtml as string,
    bodyText: (row.bodyText as string | null) ?? undefined,
    isReply: Boolean(row.isReply),
    isForward: Boolean(row.isForward),
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    syncedAt: (row.syncedAt as number | null) ?? undefined,
  };
}

// ============================================
// Search operations (FTS5)
// ============================================

export type SearchOptions = {
  accountId?: string;
  limit?: number;
  offset?: number;
};

export type SearchResult = {
  id: string;
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  rank: number;
};

/**
 * Search emails using FTS5 full-text search with LIKE fallback.
 * Supports operators: from:, to:, subject:, "exact phrase", AND, OR, NOT.
 */
export function searchEmails(query: string, options: SearchOptions = {}): SearchResult[] {
  const db = getDatabase();
  const { accountId, limit = 50, offset = 0 } = options;

  // Parse special operators
  let ftsQuery = query;
  const additionalFilters: string[] = [];

  // Handle from: operator
  const fromMatch = query.match(/from:([^\s]+)/i);
  if (fromMatch) {
    additionalFilters.push(`from_address:${fromMatch[1]}`);
    ftsQuery = ftsQuery.replace(fromMatch[0], "").trim();
  }

  // Handle to: operator
  const toMatch = query.match(/to:([^\s]+)/i);
  if (toMatch) {
    additionalFilters.push(`to_address:${toMatch[1]}`);
    ftsQuery = ftsQuery.replace(toMatch[0], "").trim();
  }

  // Handle subject: operator
  const subjectMatch = query.match(/subject:([^\s]+)/i);
  if (subjectMatch) {
    additionalFilters.push(`subject:${subjectMatch[1]}`);
    ftsQuery = ftsQuery.replace(subjectMatch[0], "").trim();
  }

  // Sanitize free-text portion to prevent FTS5 syntax errors
  if (ftsQuery) {
    ftsQuery = sanitizeFtsQuery(ftsQuery);
  }

  // Build final FTS query
  const finalQuery = [...additionalFilters, ftsQuery].filter(Boolean).join(" ");

  if (!finalQuery) {
    return [];
  }

  // Try FTS5 first
  let rows: Array<Record<string, unknown>> = [];
  try {
    let sql = `
      SELECT
        e.id, e.thread_id as threadId, e.account_id as accountId,
        e.subject, e.from_address as "from", e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc",
        e.date, e.snippet,
        rank
      FROM emails_fts
      JOIN emails e ON emails_fts.rowid = e.rowid
      WHERE emails_fts MATCH ?
    `;

    const params: (string | number)[] = [finalQuery];

    if (accountId) {
      sql += ` AND e.account_id = ?`;
      params.push(accountId);
    }

    sql += ` ORDER BY rank, e.date DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    rows = stmt.all(...params) as Array<Record<string, unknown>>;
  } catch (error) {
    log.error({ err: error }, "[DB] FTS5 search error, falling back to LIKE");
    // rows stays empty, will trigger LIKE fallback
  }

  // LIKE fallback when FTS5 returns nothing or errored
  if (rows.length === 0) {
    try {
      // Use the original raw query for LIKE (not the sanitized FTS version)
      const likePattern = `%${query}%`;
      let sql = `
        SELECT
          e.id, e.thread_id as threadId, e.account_id as accountId,
          e.subject, e.from_address as "from", e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc",
          e.date, e.snippet,
          0 as rank
        FROM emails e
        WHERE (
          e.subject LIKE ? COLLATE NOCASE
          OR e.body_text LIKE ? COLLATE NOCASE
          OR e.from_address LIKE ? COLLATE NOCASE
          OR e.to_address LIKE ? COLLATE NOCASE
        )
      `;

      const params: (string | number)[] = [likePattern, likePattern, likePattern, likePattern];

      if (accountId) {
        sql += ` AND e.account_id = ?`;
        params.push(accountId);
      }

      sql += ` ORDER BY e.date DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const stmt = db.prepare(sql);
      rows = stmt.all(...params) as Array<Record<string, unknown>>;
    } catch (likeError) {
      log.error({ err: likeError }, "[DB] LIKE fallback search error");
      return [];
    }
  }

  return rows.map((row) => ({
    id: row.id as string,
    threadId: row.threadId as string,
    accountId: row.accountId as string,
    subject: row.subject as string,
    from: row.from as string,
    to: row.to as string,
    date: row.date as string,
    snippet: (row.snippet as string) || "",
    rank: row.rank as number,
  }));
}

/**
 * Get recent search suggestions based on common sender/recipient domains
 */
export function getSearchSuggestions(query: string, limit: number = 10): string[] {
  const db = getDatabase();

  try {
    // Get unique sender addresses matching the query
    const stmt = db.prepare(`
      SELECT DISTINCT from_address as address
      FROM emails
      WHERE from_address LIKE ?
      ORDER BY date DESC
      LIMIT ?
    `);

    const rows = stmt.all(`%${query}%`, limit) as Array<{ address: string }>;
    return rows.map((row) => row.address);
  } catch (error) {
    log.error({ err: error }, "[DB] Search suggestions error");
    return [];
  }
}

/**
 * Rebuild FTS5 index (useful for maintenance)
 */
export function rebuildSearchIndex(): void {
  const db = getDatabase();
  log.info("[DB] Rebuilding FTS5 search index");

  try {
    // Delete all from FTS
    db.exec("DELETE FROM emails_fts");

    // Repopulate from emails table using body_text (plain text, not HTML)
    db.exec(`
      INSERT INTO emails_fts(rowid, subject, body_text, from_address, to_address)
      SELECT rowid, subject, COALESCE(body_text, body), from_address, to_address FROM emails
    `);

    // Optimize the index
    db.exec("INSERT INTO emails_fts(emails_fts) VALUES('optimize')");

    log.info("[DB] FTS5 search index rebuilt");
  } catch (error) {
    log.error({ err: error }, "[DB] Failed to rebuild search index");
  }
}

// ============================================
// Contact suggestions (for email autocomplete)
// ============================================

import type { ContactSuggestion } from "../../shared/types";

/**
 * Parse "Name <email>" formatted strings into individual addresses.
 * Handles: "John Smith <john@ex.com>", "john@ex.com",
 * and comma-separated lists like "Alice <a@ex.com>, Bob <b@ex.com>".
 */
function parseAddresses(str: string): Array<{ name: string; email: string }> {
  if (!str) return [];
  const results: Array<{ name: string; email: string }> = [];

  // Split by commas that are not inside angle brackets
  const parts: string[] = [];
  let current = "";
  let inAngle = false;

  for (const ch of str) {
    if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inAngle) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const trimmed = part.trim();
    const match = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
    if (match) {
      const name = match[1].trim().replace(/^["']|["']$/g, "");
      results.push({ name, email: match[2].trim() });
    } else if (trimmed.includes("@")) {
      results.push({ name: "", email: trimmed });
    }
  }

  return results;
}

/**
 * Get contact suggestions for email autocomplete.
 * Matches against name, email address, and domain from email history,
 * plus name/company from sender_profiles.
 */
export function getContactSuggestions(query: string, limit: number = 10): ContactSuggestion[] {
  const db = getDatabase();
  const likePattern = `%${query}%`;
  const contactMap = new Map<string, { name: string; email: string; frequency: number }>();

  try {
    // 1. Search from_address (senders — one address per row, most reliable)
    const fromRows = db
      .prepare(
        `
      SELECT from_address AS address, COUNT(*) AS freq
      FROM emails
      WHERE from_address LIKE ? COLLATE NOCASE
      GROUP BY from_address COLLATE NOCASE
      ORDER BY freq DESC
      LIMIT ?
    `,
      )
      .all(likePattern, limit * 3) as Array<{ address: string; freq: number }>;

    for (const row of fromRows) {
      for (const addr of parseAddresses(row.address)) {
        const key = addr.email.toLowerCase();
        const existing = contactMap.get(key);
        if (existing) {
          existing.frequency += row.freq;
          if (addr.name && !existing.name) existing.name = addr.name;
        } else {
          contactMap.set(key, { name: addr.name, email: addr.email, frequency: row.freq });
        }
      }
    }

    // 2. Search to_address (recipients — may contain multiple addresses per row)
    const toRows = db
      .prepare(
        `
      SELECT to_address AS address, COUNT(*) AS freq
      FROM emails
      WHERE to_address LIKE ? COLLATE NOCASE
      GROUP BY to_address COLLATE NOCASE
      ORDER BY freq DESC
      LIMIT ?
    `,
      )
      .all(likePattern, limit * 3) as Array<{ address: string; freq: number }>;

    const queryLower = query.toLowerCase();
    for (const row of toRows) {
      for (const addr of parseAddresses(row.address)) {
        // Only include addresses that individually match the query
        if (
          addr.name.toLowerCase().includes(queryLower) ||
          addr.email.toLowerCase().includes(queryLower)
        ) {
          const key = addr.email.toLowerCase();
          const existing = contactMap.get(key);
          if (existing) {
            existing.frequency += row.freq;
            if (addr.name && !existing.name) existing.name = addr.name;
          } else {
            contactMap.set(key, { name: addr.name, email: addr.email, frequency: row.freq });
          }
        }
      }
    }

    // 3. Search sender_profiles (matches by name, email, or company/domain)
    const profileRows = db
      .prepare(
        `
      SELECT email, name, company
      FROM sender_profiles
      WHERE email LIKE ? COLLATE NOCASE
         OR name LIKE ? COLLATE NOCASE
         OR company LIKE ? COLLATE NOCASE
      LIMIT ?
    `,
      )
      .all(likePattern, likePattern, likePattern, limit * 2) as Array<{
      email: string;
      name: string | null;
      company: string | null;
    }>;

    for (const row of profileRows) {
      const key = row.email.toLowerCase();
      const existing = contactMap.get(key);
      if (existing) {
        // Prefer structured name from sender_profiles
        if (row.name && !existing.name) existing.name = row.name;
      } else {
        contactMap.set(key, { name: row.name || "", email: row.email, frequency: 0 });
      }
    }
  } catch (error) {
    log.error({ err: error }, "[DB] Contact suggestions error");
    return [];
  }

  return Array.from(contactMap.values())
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit);
}

// ============================================
// Outbox operations (for offline sending)
// ============================================

export type OutboxStatus = "pending" | "sending" | "sent" | "failed";
export type OutboxType = "send" | "reply";

export type OutboxItem = {
  id: string;
  accountId: string;
  type: OutboxType;
  threadId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    path?: string;
    content?: string;
    size?: number;
  }>;
  status: OutboxStatus;
  errorMessage?: string;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
};

export type OutboxStats = {
  pending: number;
  sending: number;
  failed: number;
  total: number;
};

export function insertOutboxMessage(
  item: Omit<OutboxItem, "status" | "retryCount" | "updatedAt" | "sentAt" | "errorMessage">,
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO outbox (
      id, account_id, type, thread_id, to_addresses, cc_addresses, bcc_addresses,
      subject, body_html, body_text, in_reply_to, references_header,
      attachments, status, retry_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const now = Date.now();
  stmt.run(
    item.id,
    item.accountId,
    item.type,
    item.threadId || null,
    JSON.stringify(item.to),
    item.cc ? JSON.stringify(item.cc) : null,
    item.bcc ? JSON.stringify(item.bcc) : null,
    item.subject,
    item.bodyHtml,
    item.bodyText || null,
    item.inReplyTo || null,
    item.references || null,
    item.attachments ? JSON.stringify(item.attachments) : null,
    item.createdAt,
    now,
  );
}

export function getOutboxStats(accountId?: string): OutboxStats {
  const db = getDatabase();
  let query = `
    SELECT status, COUNT(*) as count
    FROM outbox
  `;
  if (accountId) {
    query += ` WHERE account_id = ?`;
  }
  query += ` GROUP BY status`;

  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();

  const stats: OutboxStats = { pending: 0, sending: 0, failed: 0, total: 0 };
  for (const row of rows as { status: string; count: number }[]) {
    if (row.status === "pending") stats.pending = row.count;
    else if (row.status === "sending") stats.sending = row.count;
    else if (row.status === "failed") stats.failed = row.count;
    stats.total += row.count;
  }
  return stats;
}

export function getPendingOutbox(accountId?: string, limit: number = 10): OutboxItem[] {
  const db = getDatabase();
  let query = `
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader, attachments,
           status, error_message as errorMessage, retry_count as retryCount,
           created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
    FROM outbox
    WHERE status = 'pending'
  `;
  if (accountId) {
    query += ` AND account_id = ?`;
  }
  query += ` ORDER BY created_at ASC LIMIT ?`;

  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId, limit) : stmt.all(limit);
  return (rows as Record<string, unknown>[]).map(rowToOutboxItem);
}

export function getOutboxItems(accountId?: string): OutboxItem[] {
  const db = getDatabase();
  let query = `
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader, attachments,
           status, error_message as errorMessage, retry_count as retryCount,
           created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
    FROM outbox
    WHERE status != 'sent'
  `;
  if (accountId) {
    query += ` AND account_id = ?`;
  }
  query += ` ORDER BY created_at DESC`;

  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  return (rows as Record<string, unknown>[]).map(rowToOutboxItem);
}

export function getOutboxItem(id: string): OutboxItem | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader, attachments,
           status, error_message as errorMessage, retry_count as retryCount,
           created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
    FROM outbox
    WHERE id = ?
  `);
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToOutboxItem(row) : null;
}

export function updateOutboxStatus(
  id: string,
  status: OutboxStatus,
  errorMessage?: string,
  incrementRetry: boolean = false,
): void {
  const db = getDatabase();
  const now = Date.now();

  if (status === "sent") {
    db.prepare(
      `
      UPDATE outbox SET status = ?, sent_at = ?, updated_at = ?, error_message = NULL
      WHERE id = ?
    `,
    ).run(status, now, now, id);
  } else if (incrementRetry) {
    db.prepare(
      `
      UPDATE outbox SET status = ?, error_message = ?, retry_count = retry_count + 1, updated_at = ?
      WHERE id = ?
    `,
    ).run(status, errorMessage || null, now, id);
  } else {
    db.prepare(
      `
      UPDATE outbox SET status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `,
    ).run(status, errorMessage || null, now, id);
  }
}

export function deleteOutboxItem(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
}

export function clearSentOutbox(): number {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM outbox WHERE status = 'sent'").run();
  return result.changes;
}

// ============================================
// Archive-ready operations
// ============================================

export type ArchiveReadyRow = {
  threadId: string;
  accountId: string;
  isReady: boolean;
  reason: string;
  analyzedAt: number;
  dismissed: boolean;
};

export function saveArchiveReady(
  threadId: string,
  accountId: string,
  isReady: boolean,
  reason: string,
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO archive_ready (thread_id, account_id, is_ready, reason, analyzed_at, dismissed)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(thread_id, account_id) DO UPDATE SET
      is_ready = excluded.is_ready,
      reason = excluded.reason,
      analyzed_at = excluded.analyzed_at,
      dismissed = 0
  `);
  stmt.run(threadId, accountId, isReady ? 1 : 0, reason, Date.now());
}

/**
 * Batch-mark emails as skipped during onboarding.
 * Inserts analysis rows (needs_reply=false, priority='skip') and
 * archive_ready rows (is_ready=true) so these emails are treated as
 * already-processed by the prefetch pipeline.
 */
export function batchInsertOnboardingSkips(
  emailIds: string[],
  threadIds: string[],
  accountId: string,
): void {
  if (emailIds.length === 0) return;

  const db = getDatabase();
  const now = Date.now();
  const reason = "Pre-existing email before app setup";

  const insertAnalysis = db.prepare(`
    INSERT OR IGNORE INTO analyses (email_id, needs_reply, reason, priority, analyzed_at)
    VALUES (?, 0, ?, 'skip', ?)
  `);
  const insertArchiveReady = db.prepare(`
    INSERT INTO archive_ready (thread_id, account_id, is_ready, reason, analyzed_at, dismissed)
    VALUES (?, ?, 1, ?, ?, 0)
    ON CONFLICT(thread_id, account_id) DO UPDATE SET
      is_ready = 1,
      reason = excluded.reason,
      analyzed_at = excluded.analyzed_at,
      dismissed = CASE WHEN dismissed = 1 THEN 1 ELSE 0 END
  `);

  const runAll = db.transaction(() => {
    for (const emailId of emailIds) {
      insertAnalysis.run(emailId, reason, now);
    }
    for (const threadId of threadIds) {
      insertArchiveReady.run(threadId, accountId, reason, now);
    }
  });
  runAll();

  log.info(
    `[DB] Onboarding: marked ${emailIds.length} emails as skip, ${threadIds.length} threads as archive-ready`,
  );
}

export function getArchiveReadyThreads(accountId: string): ArchiveReadyRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT thread_id as threadId, account_id as accountId, is_ready as isReady,
           reason, analyzed_at as analyzedAt, dismissed
    FROM archive_ready
    WHERE account_id = ? AND is_ready = 1 AND dismissed = 0
    ORDER BY analyzed_at DESC
  `);
  const rows = stmt.all(accountId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    threadId: row.threadId as string,
    accountId: row.accountId as string,
    isReady: Boolean(row.isReady),
    reason: row.reason as string,
    analyzedAt: row.analyzedAt as number,
    dismissed: Boolean(row.dismissed),
  }));
}

export function getArchiveReadyForThread(
  threadId: string,
  accountId: string,
): ArchiveReadyRow | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT thread_id as threadId, account_id as accountId, is_ready as isReady,
           reason, analyzed_at as analyzedAt, dismissed
    FROM archive_ready
    WHERE thread_id = ? AND account_id = ?
  `);
  const row = stmt.get(threadId, accountId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    threadId: row.threadId as string,
    accountId: row.accountId as string,
    isReady: Boolean(row.isReady),
    reason: row.reason as string,
    analyzedAt: row.analyzedAt as number,
    dismissed: Boolean(row.dismissed),
  };
}

export function dismissArchiveReady(threadId: string, accountId: string): void {
  const db = getDatabase();
  db.prepare("UPDATE archive_ready SET dismissed = 1 WHERE thread_id = ? AND account_id = ?").run(
    threadId,
    accountId,
  );
}

export function clearArchiveReady(accountId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM archive_ready WHERE account_id = ?").run(accountId);
}

export function deleteArchiveReadyForThreads(threadIds: string[], accountId: string): void {
  if (threadIds.length === 0) return;
  const db = getDatabase();
  const placeholders = threadIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM archive_ready WHERE thread_id IN (${placeholders}) AND account_id = ?`,
  ).run(...threadIds, accountId);
}

export function getAnalyzedArchiveThreadIds(accountId: string): Set<string> {
  const db = getDatabase();
  const stmt = db.prepare(
    "SELECT thread_id FROM archive_ready WHERE account_id = ? AND dismissed = 0",
  );
  const rows = stmt.all(accountId) as { thread_id: string }[];
  return new Set(rows.map((r) => r.thread_id));
}

// ============================================
// Snooze operations
// ============================================

import type { SnoozedEmail } from "../../shared/types";

export function snoozeEmail(
  id: string,
  emailId: string,
  threadId: string,
  accountId: string,
  snoozeUntil: number,
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO snoozed_emails (id, email_id, thread_id, account_id, snooze_until, snoozed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, emailId, threadId, accountId, snoozeUntil, Date.now());
}

export function unsnoozeEmail(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM snoozed_emails WHERE id = ?").run(id);
}

export function unsnoozeByThread(threadId: string, accountId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM snoozed_emails WHERE thread_id = ? AND account_id = ?").run(
    threadId,
    accountId,
  );
}

export function clearSnoozedEmails(accountId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM snoozed_emails WHERE account_id = ?").run(accountId);
}

export function getSnoozedEmails(accountId: string): SnoozedEmail[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails
    WHERE account_id = ?
    ORDER BY snooze_until ASC
  `);
  return stmt.all(accountId) as SnoozedEmail[];
}

export function getAllSnoozedEmails(): SnoozedEmail[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails
    ORDER BY snooze_until ASC
  `);
  return stmt.all() as SnoozedEmail[];
}

export function getDueSnoozedEmails(): SnoozedEmail[] {
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails
    WHERE snooze_until <= ?
    ORDER BY snooze_until ASC
  `);
  return stmt.all(now) as SnoozedEmail[];
}

export function getSnoozedByThread(threadId: string, accountId: string): SnoozedEmail | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails
    WHERE thread_id = ? AND account_id = ?
    LIMIT 1
  `);
  return (stmt.get(threadId, accountId) as SnoozedEmail) || null;
}

// ============================================
// Scheduled message operations
// ============================================

export type ScheduledMessageStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export type ScheduledMessageRow = {
  id: string;
  accountId: string;
  type: "send" | "reply";
  threadId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  scheduledAt: number;
  status: ScheduledMessageStatus;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
};

export function insertScheduledMessage(
  item: Omit<ScheduledMessageRow, "status" | "updatedAt" | "sentAt" | "errorMessage">,
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO scheduled_messages (
      id, account_id, type, thread_id, to_addresses, cc_addresses, bcc_addresses,
      subject, body_html, body_text, in_reply_to, references_header,
      scheduled_at, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `);
  const now = Date.now();
  stmt.run(
    item.id,
    item.accountId,
    item.type,
    item.threadId || null,
    JSON.stringify(item.to),
    item.cc ? JSON.stringify(item.cc) : null,
    item.bcc ? JSON.stringify(item.bcc) : null,
    item.subject,
    item.bodyHtml,
    item.bodyText || null,
    item.inReplyTo || null,
    item.references || null,
    item.scheduledAt,
    item.createdAt,
    now,
  );
}

export function getDueScheduledMessages(limit: number = 10): ScheduledMessageRow[] {
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader,
           scheduled_at as scheduledAt, status, error_message as errorMessage,
           created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
    FROM scheduled_messages
    WHERE status = 'scheduled' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
    LIMIT ?
  `);
  const rows = stmt.all(now, limit) as Record<string, unknown>[];
  return rows.map(rowToScheduledMessage);
}

export function getScheduledMessages(accountId?: string): ScheduledMessageRow[] {
  const db = getDatabase();
  let query = `
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader,
           scheduled_at as scheduledAt, status, error_message as errorMessage,
           created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
    FROM scheduled_messages
    WHERE status = 'scheduled'
  `;
  if (accountId) {
    query += ` AND account_id = ?`;
  }
  query += ` ORDER BY scheduled_at ASC`;

  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  return (rows as Record<string, unknown>[]).map(rowToScheduledMessage);
}

export function getScheduledMessage(id: string): ScheduledMessageRow | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader,
           scheduled_at as scheduledAt, status, error_message as errorMessage,
           created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
    FROM scheduled_messages
    WHERE id = ?
  `);
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToScheduledMessage(row) : null;
}

export function updateScheduledMessageStatus(
  id: string,
  status: ScheduledMessageStatus,
  errorMessage?: string,
): void {
  const db = getDatabase();
  const now = Date.now();

  if (status === "sent") {
    db.prepare(
      `
      UPDATE scheduled_messages SET status = ?, sent_at = ?, updated_at = ?, error_message = NULL
      WHERE id = ?
    `,
    ).run(status, now, now, id);
  } else {
    db.prepare(
      `
      UPDATE scheduled_messages SET status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `,
    ).run(status, errorMessage || null, now, id);
  }
}

export function updateScheduledMessageTime(id: string, scheduledAt: number): void {
  const db = getDatabase();
  db.prepare(
    `
    UPDATE scheduled_messages SET scheduled_at = ?, updated_at = ?
    WHERE id = ? AND status = 'scheduled'
  `,
  ).run(scheduledAt, Date.now(), id);
}

export function deleteScheduledMessage(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM scheduled_messages WHERE id = ?").run(id);
}

export function getScheduledMessageStats(accountId?: string): { scheduled: number; total: number } {
  const db = getDatabase();
  let query = `
    SELECT status, COUNT(*) as count
    FROM scheduled_messages
    WHERE status IN ('scheduled', 'sending')
  `;
  if (accountId) {
    query += ` AND account_id = ?`;
  }
  query += ` GROUP BY status`;

  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();

  let scheduled = 0;
  let total = 0;
  for (const row of rows as { status: string; count: number }[]) {
    if (row.status === "scheduled") scheduled = row.count;
    total += row.count;
  }
  return { scheduled, total };
}

function rowToScheduledMessage(row: Record<string, unknown>): ScheduledMessageRow {
  // SQLite returns NULL for missing/optional columns; coerce to undefined at the boundary.
  return {
    id: row.id as string,
    accountId: row.accountId as string,
    type: row.type as "send" | "reply",
    threadId: (row.threadId as string | null) ?? undefined,
    to: JSON.parse(row.toAddresses as string) as string[],
    cc: row.ccAddresses ? (JSON.parse(row.ccAddresses as string) as string[]) : undefined,
    bcc: row.bccAddresses ? (JSON.parse(row.bccAddresses as string) as string[]) : undefined,
    subject: row.subject as string,
    bodyHtml: row.bodyHtml as string,
    bodyText: (row.bodyText as string | null) ?? undefined,
    inReplyTo: (row.inReplyTo as string | null) ?? undefined,
    references: (row.referencesHeader as string | null) ?? undefined,
    scheduledAt: row.scheduledAt as number,
    status: row.status as ScheduledMessageStatus,
    errorMessage: (row.errorMessage as string | null) ?? undefined,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    sentAt: (row.sentAt as number | null) ?? undefined,
  };
}

// ============================================
// Calendar operations
// ============================================

export type CalendarEventRow = {
  id: string;
  accountId: string;
  calendarId: string;
  summary: string;
  startTime: string;
  endTime: string;
  isAllDay: boolean;
  calendarName: string;
  calendarColor: string;
  status: string;
  location?: string;
  htmlLink?: string;
};

export type CalendarSyncStateRow = {
  accountId: string;
  calendarId: string;
  syncToken: string | null;
  calendarName: string | null;
  calendarColor: string | null;
  lastSyncedAt: number;
  visible: boolean;
};

export function saveCalendarEvents(events: CalendarEventRow[]): void {
  if (events.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO calendar_events
      (id, account_id, calendar_id, summary, start_time, end_time, is_all_day, calendar_name, calendar_color, status, location, html_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const runAll = db.transaction(() => {
    for (const e of events) {
      stmt.run(
        e.id,
        e.accountId,
        e.calendarId,
        e.summary,
        e.startTime,
        e.endTime,
        e.isAllDay ? 1 : 0,
        e.calendarName,
        e.calendarColor,
        e.status,
        e.location || null,
        e.htmlLink || null,
      );
    }
  });
  runAll();
}

export function deleteCalendarEvent(id: string, accountId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM calendar_events WHERE id = ? AND account_id = ?").run(id, accountId);
}

/**
 * Get calendar events that overlap with a given date.
 * Uses local date boundaries (YYYY-MM-DDT00:00:00 to YYYY-MM-DDT23:59:59.999).
 * Returns events from ALL accounts.
 */
export function getCalendarEventsForDate(dateStr: string): CalendarEventRow[] {
  const db = getDatabase();
  // For timed events: start_time < end-of-day AND end_time > start-of-day
  // For all-day events: start_time matches the date prefix
  const dayStart = `${dateStr}T00:00:00`;
  const dayEnd = `${dateStr}T23:59:59.999`;
  const datePrefix = `${dateStr}%`;

  const stmt = db.prepare(`
    SELECT ce.id, ce.account_id AS accountId, ce.calendar_id AS calendarId,
           ce.summary, ce.start_time AS startTime, ce.end_time AS endTime,
           ce.is_all_day AS isAllDay, ce.calendar_name AS calendarName,
           ce.calendar_color AS calendarColor, ce.status, ce.location, ce.html_link AS htmlLink
    FROM calendar_events ce
    JOIN calendar_sync_state css ON ce.account_id = css.account_id AND ce.calendar_id = css.calendar_id
    WHERE ce.status != 'cancelled'
      AND css.visible = 1
      AND (
        (ce.is_all_day = 1 AND ce.start_time LIKE ?)
        OR (ce.is_all_day = 0 AND ce.start_time < ? AND ce.end_time > ?)
      )
    ORDER BY ce.start_time ASC
  `);
  const rows = stmt.all(datePrefix, dayEnd, dayStart) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    accountId: row.accountId as string,
    calendarId: row.calendarId as string,
    summary: row.summary as string,
    startTime: row.startTime as string,
    endTime: row.endTime as string,
    isAllDay: Boolean(row.isAllDay),
    calendarName: row.calendarName as string,
    calendarColor: row.calendarColor as string,
    status: row.status as string,
    location: (row.location as string) || undefined,
    htmlLink: (row.htmlLink as string) || undefined,
  }));
}

export function getCalendarSyncState(
  accountId: string,
  calendarId: string,
): CalendarSyncStateRow | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
    SELECT account_id AS accountId, calendar_id AS calendarId,
           sync_token AS syncToken, calendar_name AS calendarName,
           calendar_color AS calendarColor, last_synced_at AS lastSyncedAt,
           visible
    FROM calendar_sync_state
    WHERE account_id = ? AND calendar_id = ?
  `,
    )
    .get(accountId, calendarId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    accountId: row.accountId as string,
    calendarId: row.calendarId as string,
    syncToken: (row.syncToken as string) || null,
    calendarName: (row.calendarName as string) || null,
    calendarColor: (row.calendarColor as string) || null,
    lastSyncedAt: row.lastSyncedAt as number,
    visible: row.visible !== 0,
  };
}

export function saveCalendarSyncState(
  accountId: string,
  calendarId: string,
  syncToken: string | null,
  calendarName: string | null,
  calendarColor: string | null,
  visible?: boolean,
): void {
  const db = getDatabase();
  // Use INSERT ... ON CONFLICT to preserve existing visible value when not explicitly provided
  db.prepare(
    `
    INSERT INTO calendar_sync_state
      (account_id, calendar_id, sync_token, calendar_name, calendar_color, last_synced_at, visible)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, calendar_id) DO UPDATE SET
      sync_token = excluded.sync_token,
      calendar_name = excluded.calendar_name,
      calendar_color = excluded.calendar_color,
      last_synced_at = excluded.last_synced_at,
      visible = COALESCE(excluded.visible, calendar_sync_state.visible)
  `,
  ).run(
    accountId,
    calendarId,
    syncToken,
    calendarName,
    calendarColor,
    Date.now(),
    visible !== undefined ? (visible ? 1 : 0) : null,
  );
}

export function getCalendarSyncStates(accountId: string): CalendarSyncStateRow[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT account_id AS accountId, calendar_id AS calendarId,
           sync_token AS syncToken, calendar_name AS calendarName,
           calendar_color AS calendarColor, last_synced_at AS lastSyncedAt,
           visible
    FROM calendar_sync_state
    WHERE account_id = ?
  `,
    )
    .all(accountId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    accountId: row.accountId as string,
    calendarId: row.calendarId as string,
    syncToken: (row.syncToken as string) || null,
    calendarName: (row.calendarName as string) || null,
    calendarColor: (row.calendarColor as string) || null,
    lastSyncedAt: row.lastSyncedAt as number,
    visible: row.visible !== 0,
  }));
}

export function getAllCalendarSyncStates(): CalendarSyncStateRow[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT account_id AS accountId, calendar_id AS calendarId,
           sync_token AS syncToken, calendar_name AS calendarName,
           calendar_color AS calendarColor, last_synced_at AS lastSyncedAt,
           visible
    FROM calendar_sync_state
    ORDER BY account_id, calendar_name
  `,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    accountId: row.accountId as string,
    calendarId: row.calendarId as string,
    syncToken: (row.syncToken as string) || null,
    calendarName: (row.calendarName as string) || null,
    calendarColor: (row.calendarColor as string) || null,
    lastSyncedAt: row.lastSyncedAt as number,
    visible: row.visible !== 0,
  }));
}

export function setCalendarVisibility(
  accountId: string,
  calendarId: string,
  visible: boolean,
): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE calendar_sync_state SET visible = ? WHERE account_id = ? AND calendar_id = ?",
  ).run(visible ? 1 : 0, accountId, calendarId);
}

export function clearCalendarData(accountId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM calendar_events WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM calendar_sync_state WHERE account_id = ?").run(accountId);
}

export function clearSingleCalendarData(accountId: string, calendarId: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM calendar_events WHERE account_id = ? AND calendar_id = ?").run(
    accountId,
    calendarId,
  );
  db.prepare("DELETE FROM calendar_sync_state WHERE account_id = ? AND calendar_id = ?").run(
    accountId,
    calendarId,
  );
}

function rowToOutboxItem(row: Record<string, unknown>): OutboxItem {
  // SQLite returns NULL for missing/optional columns; coerce to undefined at the boundary.
  return {
    id: row.id as string,
    accountId: row.accountId as string,
    type: row.type as OutboxType,
    threadId: (row.threadId as string | null) ?? undefined,
    to: JSON.parse(row.toAddresses as string) as string[],
    cc: row.ccAddresses ? (JSON.parse(row.ccAddresses as string) as string[]) : undefined,
    bcc: row.bccAddresses ? (JSON.parse(row.bccAddresses as string) as string[]) : undefined,
    subject: row.subject as string,
    bodyHtml: row.bodyHtml as string,
    bodyText: (row.bodyText as string | null) ?? undefined,
    inReplyTo: (row.inReplyTo as string | null) ?? undefined,
    references: (row.referencesHeader as string | null) ?? undefined,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    status: row.status as OutboxStatus,
    errorMessage: (row.errorMessage as string | null) ?? undefined,
    retryCount: row.retryCount as number,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    sentAt: (row.sentAt as number | null) ?? undefined,
  };
}

// ============================================
// Agent audit log operations
// ============================================

export type AuditEntryRow = {
  id?: number;
  taskId: string;
  providerId: string;
  timestamp: string;
  eventType: string;
  toolName?: string;
  inputJson?: string;
  outputJson?: string;
  redactionApplied: boolean;
  userApproved?: boolean;
  accountId?: string;
  expiresAt?: string;
};

export function saveAuditEntry(entry: AuditEntryRow): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO agent_audit_log
      (task_id, provider_id, timestamp, event_type, tool_name, input_json, output_json, redaction_applied, user_approved, account_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.taskId,
    entry.providerId,
    entry.timestamp,
    entry.eventType,
    entry.toolName || null,
    entry.inputJson || null,
    entry.outputJson || null,
    entry.redactionApplied ? 1 : 0,
    entry.userApproved !== undefined ? (entry.userApproved ? 1 : 0) : null,
    entry.accountId || null,
    entry.expiresAt || null,
  );
}

export function getAuditEntries(taskId: string): AuditEntryRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, task_id AS taskId, provider_id AS providerId, timestamp, event_type AS eventType,
           tool_name AS toolName, input_json AS inputJson, output_json AS outputJson,
           redaction_applied AS redactionApplied, user_approved AS userApproved,
           account_id AS accountId, expires_at AS expiresAt
    FROM agent_audit_log
    WHERE task_id = ?
    ORDER BY id ASC
  `);
  const rows = stmt.all(taskId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    taskId: row.taskId as string,
    providerId: row.providerId as string,
    timestamp: row.timestamp as string,
    eventType: row.eventType as string,
    toolName: row.toolName as string | undefined,
    inputJson: row.inputJson as string | undefined,
    outputJson: row.outputJson as string | undefined,
    redactionApplied: Boolean(row.redactionApplied),
    userApproved: row.userApproved !== null ? Boolean(row.userApproved) : undefined,
    accountId: row.accountId as string | undefined,
    expiresAt: row.expiresAt as string | undefined,
  }));
}

export function cleanupExpiredAudit(): number {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db
    .prepare("DELETE FROM agent_audit_log WHERE expires_at IS NOT NULL AND expires_at < ?")
    .run(now);
  return result.changes;
}

// ============================================
// Agent conversation mirror operations
// ============================================

export type ConversationMirrorRow = {
  id?: number;
  providerId: string;
  providerConversationId: string;
  localTaskId?: string;
  status: string;
  messagesJson: string;
  remoteUpdatedAt?: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
};

export function upsertConversationMirror(
  providerId: string,
  conversationId: string,
  data: {
    localTaskId?: string;
    status: string;
    messagesJson: string;
    remoteUpdatedAt?: string;
  },
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO agent_conversation_mirror
      (provider_id, provider_conversation_id, local_task_id, status, messages_json, remote_updated_at, last_synced_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, provider_conversation_id) DO UPDATE SET
      local_task_id = COALESCE(excluded.local_task_id, agent_conversation_mirror.local_task_id),
      status = excluded.status,
      messages_json = excluded.messages_json,
      remote_updated_at = excluded.remote_updated_at,
      last_synced_at = excluded.last_synced_at,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    providerId,
    conversationId,
    data.localTaskId || null,
    data.status,
    data.messagesJson,
    data.remoteUpdatedAt || null,
    now,
    now,
    now,
  );
}

export function getConversationMirror(
  providerId: string,
  conversationId: string,
): ConversationMirrorRow | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, provider_id AS providerId, provider_conversation_id AS providerConversationId,
           local_task_id AS localTaskId, status, messages_json AS messagesJson,
           remote_updated_at AS remoteUpdatedAt, last_synced_at AS lastSyncedAt,
           created_at AS createdAt, updated_at AS updatedAt
    FROM agent_conversation_mirror
    WHERE provider_id = ? AND provider_conversation_id = ?
  `);
  const row = stmt.get(providerId, conversationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    providerId: row.providerId as string,
    providerConversationId: row.providerConversationId as string,
    localTaskId: row.localTaskId as string | undefined,
    status: row.status as string,
    messagesJson: row.messagesJson as string,
    remoteUpdatedAt: row.remoteUpdatedAt as string | undefined,
    lastSyncedAt: row.lastSyncedAt as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

export function listConversationMirrors(providerId?: string): ConversationMirrorRow[] {
  const db = getDatabase();
  let query = `
    SELECT id, provider_id AS providerId, provider_conversation_id AS providerConversationId,
           local_task_id AS localTaskId, status, messages_json AS messagesJson,
           remote_updated_at AS remoteUpdatedAt, last_synced_at AS lastSyncedAt,
           created_at AS createdAt, updated_at AS updatedAt
    FROM agent_conversation_mirror
  `;
  if (providerId) {
    query += ` WHERE provider_id = ?`;
  }
  query += ` ORDER BY updated_at DESC`;

  const stmt = db.prepare(query);
  const rows = providerId ? stmt.all(providerId) : stmt.all();
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as number,
    providerId: row.providerId as string,
    providerConversationId: row.providerConversationId as string,
    localTaskId: row.localTaskId as string | undefined,
    status: row.status as string,
    messagesJson: row.messagesJson as string,
    remoteUpdatedAt: row.remoteUpdatedAt as string | undefined,
    lastSyncedAt: row.lastSyncedAt as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  }));
}
