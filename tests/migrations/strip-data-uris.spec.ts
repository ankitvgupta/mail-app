/**
 * Migration 8 (strip_large_data_uris_and_widen_merge_cover_index) tests.
 *
 * Exercises the real runMigrations against an in-memory DB that simulates a
 * pre-migration production database: fat bodies with base64 inline images,
 * the old idx_emails_merge_cover index, and a populated FTS5 index. Verifies
 * the strip, the index swap, FTS integrity (the AFTER UPDATE triggers fire
 * during the backfill), and idempotency.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "../../src/main/db/migrations";
import { SCHEMA, FTS5_SCHEMA, FTS5_TRIGGERS } from "../../src/main/db/schema";
import { DATA_URI_STRIP_THRESHOLD } from "../../src/shared/body-sanitizer";

const require = createRequire(import.meta.url);

type DB = BetterSqlite3.Database;
let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const probe = new DatabaseCtor!(":memory:");
  probe.close();
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("NODE_MODULE_VERSION") || msg.includes("did not self-register")) {
    nativeModuleError = msg.split("\n")[0];
  } else {
    throw e;
  }
}

test.beforeEach(() => {
  if (nativeModuleError) {
    test.skip(true, `better-sqlite3 native module mismatch: ${nativeModuleError}`);
  }
});

const BIG_URI = "data:image/png;base64," + "A".repeat(DATA_URI_STRIP_THRESHOLD);
const SMALL_URI = "data:image/png;base64," + "B".repeat(500);

/** A DB shaped like prod before migration 8: version 7, old index, fat bodies. */
function preMigration8Db(): DB {
  if (!DatabaseCtor) throw new Error("better-sqlite3 not loadable");
  const db = new DatabaseCtor(":memory:");
  db.pragma("journal_mode = MEMORY");
  db.exec(SCHEMA);
  db.exec(FTS5_SCHEMA);
  db.exec(FTS5_TRIGGERS);

  // Recreate the pre-migration index landscape
  db.exec("DROP INDEX IF EXISTS idx_emails_all_light");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_emails_merge_cover ON emails(account_id, thread_id, message_id, in_reply_to)",
  );

  const insert = db.prepare(`
    INSERT INTO emails (id, account_id, thread_id, subject, from_address, to_address, body, body_text, date, fetched_at, label_ids)
    VALUES (?, 'acct1', ?, ?, 'a@b.com', 'c@d.com', ?, ?, '2026-07-01T00:00:00Z', 0, '["INBOX"]')
  `);
  insert.run(
    "fat",
    "t1",
    "Quarterly report",
    `<p>numbers attached</p><img src="${BIG_URI}">`,
    "numbers attached quarterly",
  );
  insert.run("small", "t2", "Logo email", `<p>see logo</p><img src="${SMALL_URI}">`, "see logo");

  // Mark DB as already migrated through version 7
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(7);
  return db;
}

function indexNames(db: DB): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='emails'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

test.describe("migration 8: strip large data URIs + widen merge-cover index", () => {
  test("strips oversized inline images from stored bodies, keeps small ones", () => {
    const db = preMigration8Db();
    runMigrations(db);

    const fat = db.prepare("SELECT body FROM emails WHERE id = 'fat'").get() as { body: string };
    expect(fat.body).not.toContain(BIG_URI);
    expect(fat.body).toContain("data:image/svg+xml");
    expect(fat.body).toContain("<p>numbers attached</p>");

    const small = db.prepare("SELECT body FROM emails WHERE id = 'small'").get() as {
      body: string;
    };
    expect(small.body).toContain(SMALL_URI);
  });

  test("replaces idx_emails_merge_cover with idx_emails_all_light", () => {
    const db = preMigration8Db();
    runMigrations(db);

    const names = indexNames(db);
    expect(names.has("idx_emails_all_light")).toBe(true);
    expect(names.has("idx_emails_merge_cover")).toBe(false);
  });

  test("FTS index stays consistent through the backfill UPDATEs", () => {
    const db = preMigration8Db();
    runMigrations(db);

    // The AFTER UPDATE trigger re-indexes the row with unchanged body_text;
    // search must still find the stripped email exactly once.
    const hits = db
      .prepare("SELECT rowid FROM emails_fts WHERE emails_fts MATCH 'quarterly'")
      .all();
    expect(hits.length).toBe(1);
  });

  test("is idempotent: a second run changes nothing", () => {
    const db = preMigration8Db();
    runMigrations(db);
    const bodyAfterFirst = (
      db.prepare("SELECT body FROM emails WHERE id = 'fat'").get() as { body: string }
    ).body;

    runMigrations(db);
    const bodyAfterSecond = (
      db.prepare("SELECT body FROM emails WHERE id = 'fat'").get() as { body: string }
    ).body;
    expect(bodyAfterSecond).toBe(bodyAfterFirst);
    expect(indexNames(db).has("idx_emails_all_light")).toBe(true);
  });

  test("a candidate row whose only data URIs are small survives byte-identical", () => {
    const db = preMigration8Db();
    // Pad an all-small-URI body past the candidate threshold so it's SELECTed
    // but stripLargeDataUris leaves it unchanged (exercises the no-op skip).
    const body = `<p>${"x".repeat(DATA_URI_STRIP_THRESHOLD)}</p><img src="${SMALL_URI}">`;
    db.prepare(
      `INSERT INTO emails (id, account_id, thread_id, subject, from_address, to_address, body, body_text, date, fetched_at, label_ids)
       VALUES ('padded', 'acct1', 't3', 's', 'a@b.com', 'c@d.com', ?, 'x', '2026-07-01T00:00:00Z', 0, '["INBOX"]')`,
    ).run(body);

    runMigrations(db);

    const after = db.prepare("SELECT body FROM emails WHERE id = 'padded'").get() as {
      body: string;
    };
    expect(after.body).toBe(body);
  });

  test("idx_emails_all_light covers the getInboxEmails allLight query", () => {
    if (!DatabaseCtor) throw new Error("better-sqlite3 not loadable");
    // Fresh DB via SCHEMA (not the pre-migration shape) — asserts the covering
    // property this PR exists to deliver, on the index schema.ts ships.
    const db = new DatabaseCtor(":memory:");
    db.pragma("journal_mode = MEMORY");
    db.exec(SCHEMA);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, account_id, thread_id, message_id, in_reply_to, date, label_ids FROM emails WHERE account_id = ?",
      )
      .all("acct1") as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join("\n")).toContain(
      "USING COVERING INDEX idx_emails_all_light",
    );
  });

  test("fresh DB (no emails table yet) is a safe no-op", () => {
    if (!DatabaseCtor) throw new Error("better-sqlite3 not loadable");
    const db = new DatabaseCtor(":memory:");
    db.pragma("journal_mode = MEMORY");
    // Migrations run before SCHEMA in initDatabase — must not throw
    runMigrations(db);
    const version = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
      v: number;
    };
    expect(version.v).toBeGreaterThanOrEqual(8);
  });
});
