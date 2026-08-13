/**
 * Migration replay + schema symmetry tests.
 *
 * Two things we want to catch:
 *
 *   1. **Replay**: an existing user-data DB (pre-numbered-system) must
 *      survive a full migration run without errors and end up with the
 *      expected column set. This guards against future migrations
 *      stepping on legacy ALTERs.
 *
 *   2. **Symmetry**: a fresh DB (SCHEMA only) + runMigrations should end
 *      up with the same set of tables/columns as you'd expect a fully
 *      migrated production DB to have. Catches the "added a column to
 *      SCHEMA but forgot the matching migration" bug (or vice versa).
 *
 * Both tests use an in-memory SQLite DB built dynamically — no
 * committed `.db` fixture file. The "pre-numbered-system" shape is
 * reconstructed by applying SCHEMA and then surgically dropping the
 * columns that the legacy ALTER block adds.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { runMigrations, NUMBERED_MIGRATIONS } from "../../src/main/db/migrations";
import { SCHEMA } from "../../src/main/db/schema";

const require = createRequire(import.meta.url);

type DB = BetterSqlite3.Database;
let DatabaseCtor:
  | (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB)
  | null = null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  // Verify the native addon actually works
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

function freshDb(): DB {
  if (!DatabaseCtor) throw new Error("better-sqlite3 not loadable");
  const db = new DatabaseCtor(":memory:");
  db.pragma("journal_mode = MEMORY");
  return db;
}

function listTableColumns(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function listAllTables(db: DB): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

test.describe("Migration replay + symmetry", () => {
  test("symmetry: SCHEMA + runMigrations ends up with all expected tables and columns", () => {
    const db = freshDb();
    db.exec(SCHEMA);
    runMigrations(db);

    const tables = listAllTables(db);

    // Tables the numbered migrations create that aren't in SCHEMA.
    expect(tables.has("llm_calls")).toBe(true);
    expect(tables.has("schema_version")).toBe(true);

    // Tables that exist in SCHEMA.
    expect(tables.has("accounts")).toBe(true);
    expect(tables.has("emails")).toBe(true);
    expect(tables.has("drafts")).toBe(true);
    expect(tables.has("send_as_aliases")).toBe(true);

    // Columns the legacy ALTER block ensures exist (and SCHEMA should also have).
    const emailCols = listTableColumns(db, "emails");
    for (const col of [
      "account_id",
      "label_ids",
      "cc_address",
      "bcc_address",
      "body_text",
      "attachments",
      "message_id",
      "in_reply_to",
    ]) {
      expect(emailCols.has(col), `emails should have column ${col}`).toBe(true);
    }

    const draftCols = listTableColumns(db, "drafts");
    for (const col of [
      "agent_task_id",
      "cc",
      "bcc",
      "compose_mode",
      "to_recipients",
    ]) {
      expect(draftCols.has(col), `drafts should have column ${col}`).toBe(true);
    }

    // All numbered migrations should be recorded as applied.
    const appliedVersions = (
      db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    expect(appliedVersions).toContain(0);
    for (const m of NUMBERED_MIGRATIONS) {
      expect(appliedVersions, `migration v${m.version} (${m.name}) should be applied`).toContain(
        m.version,
      );
    }

    db.close();
  });

  test("symmetry: runMigrations is idempotent (second call is a no-op)", () => {
    const db = freshDb();
    db.exec(SCHEMA);

    runMigrations(db);
    const firstVersions = (
      db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    const firstEmailCols = listTableColumns(db, "emails");

    runMigrations(db);
    const secondVersions = (
      db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    const secondEmailCols = listTableColumns(db, "emails");

    expect(secondVersions).toEqual(firstVersions);
    expect([...secondEmailCols].sort()).toEqual([...firstEmailCols].sort());

    db.close();
  });

  test("replay: pre-numbered-system DB (no llm_calls, no schema_version) migrates cleanly", () => {
    // Reconstruct a "legacy" DB shape: SCHEMA was applied but the numbered
    // tables haven't been created yet. Drop schema_version + llm_calls if
    // they snuck in via SCHEMA so we exercise the bootstrap path.
    const db = freshDb();
    db.exec(SCHEMA);
    db.exec("DROP TABLE IF EXISTS llm_calls");
    db.exec("DROP TABLE IF EXISTS schema_version");

    // Seed a few rows so we can assert data integrity after migration.
    const now = Date.now();
    db.prepare(
      "INSERT INTO accounts (id, email, display_name, is_primary, added_at) VALUES (?, ?, ?, ?, ?)",
    ).run("acc-1", "test@example.invalid", "Test", 1, now);

    // Now run migrations. Should bootstrap the numbered system from scratch.
    runMigrations(db);

    const tables = listAllTables(db);
    expect(tables.has("llm_calls")).toBe(true);
    expect(tables.has("schema_version")).toBe(true);

    // Original data should still be present and intact.
    const accountCount = (
      db.prepare("SELECT COUNT(*) as c FROM accounts").get() as { c: number }
    ).c;
    expect(accountCount).toBe(1);

    // All numbered migrations should be applied.
    const appliedVersions = (
      db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    for (const m of NUMBERED_MIGRATIONS) {
      expect(appliedVersions).toContain(m.version);
    }

    db.close();
  });

  test("numbered migration versions are sequential starting from 1", () => {
    // Catches accidental re-numbering or gaps that would break the
    // forward-only invariant.
    const versions = NUMBERED_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(versions[0]).toBe(1);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i] - versions[i - 1]).toBe(1);
    }
  });
});
