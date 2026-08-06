/**
 * Migration runner — extracted from db/index.ts so it can be imported in
 * non-Electron test contexts (notably tests/migrations/replay.spec.ts).
 *
 * The only runtime dependencies this file may take are the better-sqlite3
 * type and the logger (which uses lazy `createRequire` against Electron and
 * degrades to tmpdir-based logging when Electron isn't available — see
 * services/logger.ts:18-25). Do NOT import data-dir, electron, or anything
 * that pulls them in transitively.
 */
import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../services/logger";
import { stripLargeDataUris, DATA_URI_STRIP_THRESHOLD } from "../../shared/body-sanitizer";

const log = createLogger("db-migrations");

type DatabaseInstance = BetterSqlite3.Database;

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseInstance) => void;
  /**
   * Run VACUUM after all pending migrations complete. VACUUM cannot run
   * inside a transaction (each migration runs in one), so it's deferred to
   * the end of runNumberedMigrations and executed at most once.
   */
  vacuumAfter?: boolean;
}

/**
 * Run all migrations against the given DB.
 *
 * The legacy block (pre-versioning) uses `tableInfo.length > 0` guards
 * everywhere because on a fresh DB the tables don't exist yet — SCHEMA
 * creates them with the final column set, so these ALTERs are no-ops on
 * fresh DBs and only fire on existing pre-numbered-system DBs that
 * predate the column additions.
 *
 * After the legacy block runs, `runNumberedMigrations` handles the
 * forward-only numbered system.
 */
export function runMigrations(db: DatabaseInstance): void {
  // Check if emails table exists and has account_id column
  const tableInfo = db.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
  const hasAccountId = tableInfo.some((col) => col.name === "account_id");

  if (tableInfo.length > 0 && !hasAccountId) {
    log.info("[DB] Running migration: Adding account_id column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN account_id TEXT DEFAULT 'default'");
  }

  // Create index for account_id (idempotent)
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id)");
  } catch {
    // ignore
  }

  // Check if extension_enrichments table exists and has sender_email column
  const enrichmentsTableInfo = db
    .prepare("PRAGMA table_info(extension_enrichments)")
    .all() as Array<{ name: string }>;
  const hasSenderEmail = enrichmentsTableInfo.some((col) => col.name === "sender_email");

  if (enrichmentsTableInfo.length > 0 && !hasSenderEmail) {
    log.info("[DB] Running migration: Adding sender_email column to extension_enrichments table");
    db.exec("ALTER TABLE extension_enrichments ADD COLUMN sender_email TEXT");
  }

  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_extension_enrichments_sender ON extension_enrichments(sender_email, extension_id)",
    );
  } catch {
    // ignore
  }

  const hasLabelIds = tableInfo.some((col) => col.name === "label_ids");
  if (tableInfo.length > 0 && !hasLabelIds) {
    log.info("[DB] Running migration: Adding label_ids column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN label_ids TEXT");
  }

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

  const calSyncTableInfo = db.prepare("PRAGMA table_info(calendar_sync_state)").all() as Array<{
    name: string;
  }>;
  const hasCalSyncVisible = calSyncTableInfo.some((col) => col.name === "visible");
  if (calSyncTableInfo.length > 0 && !hasCalSyncVisible) {
    log.info("[DB] Running migration: Adding visible column to calendar_sync_state table");
    db.exec("ALTER TABLE calendar_sync_state ADD COLUMN visible INTEGER DEFAULT 1");
  }

  // Re-read tableInfo since we may have added columns above
  const tableInfoRefresh = db.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
  const hasBodyText = tableInfoRefresh.some((col) => col.name === "body_text");
  if (tableInfoRefresh.length > 0 && !hasBodyText) {
    log.info("[DB] Running migration: Adding body_text column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN body_text TEXT");
  }

  const tableInfoForAttachments = db.prepare("PRAGMA table_info(emails)").all() as Array<{
    name: string;
  }>;
  const hasAttachments = tableInfoForAttachments.some((col) => col.name === "attachments");
  if (tableInfoForAttachments.length > 0 && !hasAttachments) {
    log.info("[DB] Running migration: Adding attachments column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN attachments TEXT");
  }

  const outboxTableInfo = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  const outboxHasAttachments = outboxTableInfo.some((col) => col.name === "attachments");
  if (outboxTableInfo.length > 0 && !outboxHasAttachments) {
    log.info("[DB] Running migration: Adding attachments column to outbox table");
    db.exec("ALTER TABLE outbox ADD COLUMN attachments TEXT");
  }

  const draftsTableInfo = db.prepare("PRAGMA table_info(drafts)").all() as Array<{ name: string }>;
  const hasAgentTaskId = draftsTableInfo.some((col) => col.name === "agent_task_id");
  if (draftsTableInfo.length > 0 && !hasAgentTaskId) {
    log.info("[DB] Running migration: Adding agent_task_id column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN agent_task_id TEXT");
  }

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

  const draftsTableInfoForMode = db.prepare("PRAGMA table_info(drafts)").all() as Array<{
    name: string;
  }>;
  const hasDraftComposeMode = draftsTableInfoForMode.some((col) => col.name === "compose_mode");
  if (draftsTableInfoForMode.length > 0 && !hasDraftComposeMode) {
    log.info("[DB] Running migration: Adding compose_mode column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN compose_mode TEXT");
  }

  const draftsTableInfoForTo = db.prepare("PRAGMA table_info(drafts)").all() as Array<{
    name: string;
  }>;
  const hasDraftToRecipients = draftsTableInfoForTo.some((col) => col.name === "to_recipients");
  if (draftsTableInfoForTo.length > 0 && !hasDraftToRecipients) {
    log.info("[DB] Running migration: Adding to_recipients column to drafts table");
    db.exec("ALTER TABLE drafts ADD COLUMN to_recipients TEXT");
  }

  const tableInfoForMessageId = db.prepare("PRAGMA table_info(emails)").all() as Array<{
    name: string;
  }>;
  const hasMessageId = tableInfoForMessageId.some((col) => col.name === "message_id");
  if (tableInfoForMessageId.length > 0 && !hasMessageId) {
    log.info("[DB] Running migration: Adding message_id column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN message_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id)");
  }

  const tableInfoForInReplyTo = db.prepare("PRAGMA table_info(emails)").all() as Array<{
    name: string;
  }>;
  const hasInReplyTo = tableInfoForInReplyTo.some((col) => col.name === "in_reply_to");
  if (tableInfoForInReplyTo.length > 0 && !hasInReplyTo) {
    log.info("[DB] Running migration: Adding in_reply_to column to emails table");
    db.exec("ALTER TABLE emails ADD COLUMN in_reply_to TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails(in_reply_to)");
  }

  const memoriesTableInfo = db.prepare("PRAGMA table_info(memories)").all() as Array<{
    name: string;
  }>;
  const hasMemoryType = memoriesTableInfo.some((col) => col.name === "memory_type");
  if (memoriesTableInfo.length > 0 && !hasMemoryType) {
    log.info("[DB] Running migration: Adding memory_type column to memories table");
    db.exec("ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'drafting'");
  }

  const draftMemoriesTableInfo = db.prepare("PRAGMA table_info(draft_memories)").all() as Array<{
    name: string;
  }>;
  const hasDraftMemoryType = draftMemoriesTableInfo.some((col) => col.name === "memory_type");
  if (draftMemoriesTableInfo.length > 0 && !hasDraftMemoryType) {
    log.info("[DB] Running migration: Adding memory_type column to draft_memories table");
    db.exec("ALTER TABLE draft_memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'drafting'");
  }

  // === Forward-only numbered migration system ===
  runNumberedMigrations(db);
}

// Add new migrations here. Version numbers must be sequential.
// Existing databases get version 0 (baseline) on first run.
export const NUMBERED_MIGRATIONS: Migration[] = [
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
  {
    version: 2,
    name: "add_send_as_aliases_and_from_address",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS send_as_aliases (
          email TEXT NOT NULL,
          account_id TEXT NOT NULL,
          display_name TEXT,
          is_default INTEGER DEFAULT 0,
          reply_to_address TEXT,
          verification_status TEXT,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY (email, account_id),
          FOREIGN KEY (account_id) REFERENCES accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_send_as_account ON send_as_aliases(account_id);
      `);

      // ALTER TABLE only for existing databases — fresh DBs get the column from SCHEMA
      const tables = ["local_drafts", "outbox", "scheduled_messages"];
      for (const table of tables) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (cols.length > 0 && !cols.some((c) => c.name === "from_address")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN from_address TEXT`);
        }
      }
    },
  },
  {
    version: 3,
    name: "index_agent_conversation_mirror_local_task_id",
    up: (db) => {
      // Guard: migrations run before SCHEMA (see initDatabase order), so on a
      // fresh DB the table doesn't exist yet. CREATE INDEX IF NOT EXISTS only
      // guards the index, not the table — skip here and let SCHEMA + the index
      // in the schema file handle fresh DBs.
      const tableExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_conversation_mirror'",
        )
        .get();
      if (!tableExists) return;
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_agent_conversation_mirror_task_status
         ON agent_conversation_mirror(local_task_id, status)`,
      );
    },
  },
  {
    version: 4,
    name: "add_blocked_senders_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blocked_senders (
          sender_email TEXT NOT NULL,
          account_id TEXT NOT NULL,
          gmail_filter_id TEXT,
          blocked_at INTEGER NOT NULL,
          PRIMARY KEY (sender_email, account_id),
          FOREIGN KEY (account_id) REFERENCES accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_blocked_senders_account ON blocked_senders(account_id);
      `);
    },
  },
  {
    version: 5,
    name: "drop_analyses_priority_column",
    up: (db) => {
      // Three-level priority (high/medium/low) was collapsed to a binary
      // Priority/Other classification (issue #143). The column is unused
      // after this release. Guard on table existence so fresh DBs (which
      // get the final SCHEMA without the column) are a no-op here.
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analyses'")
        .get();
      if (!tableExists) return;
      const cols = db.prepare("PRAGMA table_info(analyses)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "priority")) {
        db.exec("ALTER TABLE analyses DROP COLUMN priority");
      }
    },
  },
  {
    version: 6,
    name: "add_emails_merge_covering_index",
    // buildMergeCache (db/index.ts) runs
    //   SELECT thread_id, message_id, in_reply_to FROM emails WHERE account_id = ?
    // every time the per-account merge cache is invalidated by saveEmail/
    // deleteEmail. With ~8k inbox rows and the existing idx_emails_account index
    // (which doesn't cover the SELECT columns), SQLite has to do row-by-row
    // lookups in the main table — 190ms per rebuild, and the prefetch service
    // can trigger 20+ rebuilds in one burst, causing 7-9s main-thread
    // beachballs. A covering index lets the rebuild be served entirely from
    // index pages, dropping it from ~190ms to single-digit ms.
    //
    // Guard on table existence: migrations run BEFORE the SCHEMA `CREATE TABLE`
    // statements in initDatabase, so on a fresh DB the `emails` table won't
    // exist yet — this migration only matters for existing DBs. (Migration 8
    // later replaces this index with the wider idx_emails_all_light, which is
    // what schema.ts now creates for fresh DBs.)
    up: (db) => {
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails'")
        .get();
      if (!tableExists) return;
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_emails_merge_cover
          ON emails(account_id, thread_id, message_id, in_reply_to);
      `);
    },
  },
  {
    version: 7,
    name: "add_llm_calls_provider_column",
    up: (db) => {
      // Track which LLM backend handled each call. Defaults to "anthropic"
      // for existing rows.
      const cols = db.prepare("PRAGMA table_info(llm_calls)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some((c) => c.name === "provider")) {
        db.exec(`ALTER TABLE llm_calls ADD COLUMN provider TEXT DEFAULT 'anthropic'`);
      }
    },
  },
  {
    version: 8,
    name: "strip_large_data_uris_and_widen_merge_cover_index",
    vacuumAfter: true,
    // Prod forensics (July 2026): the emails table was 1.6GB for ~15k rows
    // because inline images were stored as base64 data: URIs inside body HTML
    // (avg 106KB/row, max 29MB) — content the renderer strips to a placeholder
    // before display anyway. Because `body` is declared before label_ids/
    // message_id/in_reply_to, every inbox/sent/search scan had to walk each
    // row's overflow-page chain even when body wasn't selected, freezing the
    // main process for 0.8-12s per query (better-sqlite3 is synchronous).
    // saveEmail now strips at the write boundary; this migration strips the
    // rows written before the fix and reclaims the space via vacuumAfter.
    //
    // The index change widens idx_emails_merge_cover (whose four columns are
    // this index's prefix, so it's strictly superseded) into a covering index
    // for getInboxEmails' allLight query — SELECT id, account_id, thread_id,
    // message_id, in_reply_to, date, label_ids over every row of an account —
    // so it's served from index pages without touching table rows at all.
    //
    // Guard on table existence: migrations run BEFORE SCHEMA on fresh DBs;
    // schema.ts creates the new index for those.
    up: (db) => {
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails'")
        .get();
      if (!tableExists) return;

      // Strip BEFORE building the index. Building idx_emails_all_light must read
      // label_ids/message_id/in_reply_to, which are declared after body, so on
      // the pre-strip table it walks every fat row's overflow-page chain — the
      // exact cost this migration removes. Stripping first shrinks the table so
      // the index build scans the small version.
      //
      // Two-pass strip: collect candidate ids first, then load one body at a
      // time — better-sqlite3 can't run statements while an iterator is open,
      // and .all() on the bodies would pull the whole 1.5GB into memory. LIKE is
      // ASCII-case-insensitive in SQLite by default, so `DATA:` bodies are also
      // selected here (the strip itself is case-insensitive too).
      const fatRows = db
        .prepare("SELECT id FROM emails WHERE LENGTH(body) >= ? AND body LIKE '%data:%'")
        .all(DATA_URI_STRIP_THRESHOLD) as Array<{ id: string }>;

      if (fatRows.length > 0) {
        log.info(
          { candidates: fatRows.length },
          "One-time migration: stripping oversized inline images from stored email bodies — this may take a minute on large databases",
        );
        const selectBody = db.prepare("SELECT body FROM emails WHERE id = ?");
        const updateBody = db.prepare("UPDATE emails SET body = ? WHERE id = ?");
        let strippedCount = 0;
        let reclaimedChars = 0;
        for (const { id } of fatRows) {
          const row = selectBody.get(id) as { body: string } | undefined;
          if (!row?.body) continue;
          const stripped = stripLargeDataUris(row.body);
          if (stripped !== row.body) {
            updateBody.run(stripped, id);
            strippedCount++;
            reclaimedChars += row.body.length - stripped.length;
          }
        }
        log.info(
          { stripped: strippedCount, reclaimedMB: Math.round(reclaimedChars / 1024 / 1024) },
          "Inline-image strip migration complete",
        );
      }

      db.exec("DROP INDEX IF EXISTS idx_emails_merge_cover");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_emails_all_light
          ON emails(account_id, thread_id, message_id, in_reply_to, date, label_ids, id);
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

  let needsVacuum = false;
  for (const migration of NUMBERED_MIGRATIONS) {
    if (migration.version > currentVersion) {
      log.info({ version: migration.version, name: migration.name }, "Running numbered migration");
      const runInTransaction = db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      });
      runInTransaction();
      currentVersion = migration.version;
      if (migration.vacuumAfter) needsVacuum = true;
    }
  }

  maybeVacuum(db, needsVacuum);
}

/**
 * VACUUM to reclaim freed pages after a migration.
 *
 * VACUUM can't run inside a transaction, so it happens here after all
 * migrations commit. The decision is also self-healing: a migration bumps
 * schema_version and frees pages in one committed transaction, but VACUUM runs
 * separately — if the app is force-quit in that window, the flag is lost and the
 * freed space would never be reclaimed. So we ALSO vacuum whenever the freelist
 * is large (checked cheaply on every startup), which reclaims after any
 * interruption and skips when there's nothing to reclaim.
 *
 * VACUUM is an optimization, not a correctness requirement: it needs transient
 * temp space and can throw SQLITE_FULL on a near-full disk. Since it runs at
 * module load before any window exists, an unhandled throw would crash startup
 * (a boot loop) even though every migration already committed — so failures are
 * logged and swallowed.
 */
function maybeVacuum(db: DatabaseInstance, migrationRequestedVacuum: boolean): void {
  let shouldVacuum = migrationRequestedVacuum;
  if (!shouldVacuum) {
    const pageCount = db.pragma("page_count", { simple: true }) as number;
    const freelist = db.pragma("freelist_count", { simple: true }) as number;
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    // >20% of the file free and >50MB of reclaimable space — enough to be worth
    // the rewrite, rare enough not to fire on normal fragmentation.
    if (pageCount > 0 && freelist / pageCount > 0.2 && freelist * pageSize > 50 * 1024 * 1024) {
      shouldVacuum = true;
    }
  }
  if (!shouldVacuum) return;

  log.info("Running VACUUM to reclaim freed database space");
  const start = Date.now();
  try {
    db.exec("VACUUM");
    log.info({ durationMs: Date.now() - start }, "VACUUM complete");
  } catch (err) {
    // Non-fatal: the DB is fully consistent without VACUUM; it just stays large.
    log.warn({ err }, "VACUUM failed — continuing startup; space will be reclaimed on a later run");
  }
}
