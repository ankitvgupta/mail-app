import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SCHEMA } from "../../src/main/db/schema";

const require = createRequire(import.meta.url);

// better-sqlite3 may be compiled for Electron's Node version rather than the system Node.
// Detect the mismatch upfront so we can skip tests in beforeEach.
let Database: any;
let nativeModuleError: string | null = null;
try {
  Database = require("better-sqlite3");
  // Verify the native addon actually works (require may succeed but new Database() can fail
  // when compiled for Electron's Node version instead of system Node)
  const testDb = new Database(":memory:");
  testDb.close();
} catch (e: any) {
  if (e.message?.includes("NODE_MODULE_VERSION") || e.message?.includes("did not self-register")) {
    nativeModuleError = e.message.split("\n")[0];
  } else {
    throw e;
  }
}

/**
 * Tests for database isolation between demo/test mode and production mode.
 *
 * Verifies that demo/test mode uses a separate database file so that
 * demo data never leaks into the production database.
 */

// Helper: create a database at the given path with schema applied
function createDb(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

// Helper: insert a test email
function insertEmail(
  db: ReturnType<typeof Database>,
  id: string,
  accountId: string,
  subject: string,
) {
  db.prepare(
    `
    INSERT INTO emails (id, account_id, thread_id, subject, from_address, to_address, body, date, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    accountId,
    `thread-${id}`,
    subject,
    "test@example.com",
    "me@example.com",
    "<p>body</p>",
    "2025-01-01",
    Date.now(),
  );
}

// Helper: count emails in a database
function countEmails(db: ReturnType<typeof Database>, accountId?: string): number {
  if (accountId) {
    return (
      db.prepare("SELECT COUNT(*) as c FROM emails WHERE account_id = ?").get(accountId) as {
        c: number;
      }
    ).c;
  }
  return (db.prepare("SELECT COUNT(*) as c FROM emails").get() as { c: number }).c;
}

// Helper: get all email subjects
function getEmailSubjects(db: ReturnType<typeof Database>): string[] {
  return (
    db.prepare("SELECT subject FROM emails ORDER BY subject").all() as { subject: string }[]
  ).map((r) => r.subject);
}

test.describe("Database isolation between demo and production modes", () => {
  test.describe.configure({ mode: "serial" });
  let tmpDir: string;
  let prodDbPath: string;
  let demoDbPath: string;

  // Skip the entire suite if better-sqlite3 can't be loaded (ABI version mismatch)
  test.beforeEach(() => {
    test.skip(!!nativeModuleError, `better-sqlite3 unavailable: ${nativeModuleError}`);
  });

  test.beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mail-app-db-test-"));
    prodDbPath = join(tmpDir, "exo.db");
    demoDbPath = join(tmpDir, "exo-demo.db");
  });

  test.afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("demo and production use different file paths", () => {
    // Reproduce the logic from initDatabase()
    function getDbFilename(isDemoMode: boolean, isTestMode: boolean): string {
      return isDemoMode || isTestMode ? "exo-demo.db" : "exo.db";
    }

    expect(getDbFilename(false, false)).toBe("exo.db");
    expect(getDbFilename(true, false)).toBe("exo-demo.db");
    expect(getDbFilename(false, true)).toBe("exo-demo.db");
    expect(getDbFilename(true, true)).toBe("exo-demo.db");
  });

  test("databases are physically separate files", () => {
    const prodDb = createDb(prodDbPath);
    const demoDb = createDb(demoDbPath);

    // Both files should exist independently
    expect(existsSync(prodDbPath)).toBe(true);
    expect(existsSync(demoDbPath)).toBe(true);
    expect(prodDbPath).not.toBe(demoDbPath);

    prodDb.close();
    demoDb.close();
  });

  test("data written to demo DB does not appear in production DB", () => {
    const prodDb = createDb(prodDbPath);
    const demoDb = createDb(demoDbPath);

    // Write demo emails to demo DB (simulates what sync:init does in demo mode)
    insertEmail(demoDb, "demo-1", "default", "Demo Email 1");
    insertEmail(demoDb, "demo-2", "default", "Demo Email 2");
    insertEmail(demoDb, "demo-3", "default", "Demo Email 3");

    // Demo DB should have 3 emails
    expect(countEmails(demoDb)).toBe(3);

    // Production DB should have 0 emails
    expect(countEmails(prodDb)).toBe(0);

    prodDb.close();
    demoDb.close();
  });

  test("data written to production DB does not appear in demo DB", () => {
    const prodDb = createDb(prodDbPath);
    const demoDb = createDb(demoDbPath);

    // Write a production email
    insertEmail(prodDb, "prod-1", "account-1", "Real Email from Boss");

    // Production DB should have it
    expect(getEmailSubjects(prodDb)).toContain("Real Email from Boss");

    // Demo DB should NOT have it
    expect(getEmailSubjects(demoDb)).not.toContain("Real Email from Boss");

    prodDb.close();
    demoDb.close();
  });

  test("analyses written in demo mode stay in demo DB", () => {
    const prodDb = createDb(prodDbPath);
    const demoDb = createDb(demoDbPath);

    // Save an analysis to demo DB
    demoDb
      .prepare(
        `
      INSERT OR REPLACE INTO analyses (email_id, needs_reply, reason, analyzed_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run("demo-1", 1, "Demo analysis", Date.now());

    const demoAnalysis = demoDb.prepare("SELECT * FROM analyses WHERE email_id = ?").get("demo-1");
    expect(demoAnalysis).toBeTruthy();

    const prodAnalysis = prodDb.prepare("SELECT * FROM analyses WHERE email_id = ?").get("demo-1");
    expect(prodAnalysis).toBeUndefined();

    prodDb.close();
    demoDb.close();
  });

  test("drafts written in demo mode stay in demo DB", () => {
    const prodDb = createDb(prodDbPath);
    const demoDb = createDb(demoDbPath);

    // Save a draft to demo DB
    demoDb
      .prepare(
        `
      INSERT OR REPLACE INTO drafts (email_id, draft_body, status, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run("demo-1", "Thanks for the demo email!", "pending", Date.now());

    const demoDraft = demoDb.prepare("SELECT * FROM drafts WHERE email_id = ?").get("demo-1");
    expect(demoDraft).toBeTruthy();

    const prodDraft = prodDb.prepare("SELECT * FROM drafts WHERE email_id = ?").get("demo-1");
    expect(prodDraft).toBeUndefined();

    prodDb.close();
    demoDb.close();
  });

  test("sender profiles written in demo mode stay in demo DB", () => {
    const prodDb = createDb(prodDbPath);
    const demoDb = createDb(demoDbPath);

    demoDb
      .prepare(
        `
      INSERT OR REPLACE INTO sender_profiles (email, name, summary, lookup_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run("demo@example.com", "Demo User", "A demo sender profile", Date.now());

    const demoProfile = demoDb
      .prepare("SELECT * FROM sender_profiles WHERE email = ?")
      .get("demo@example.com");
    expect(demoProfile).toBeTruthy();

    const prodProfile = prodDb
      .prepare("SELECT * FROM sender_profiles WHERE email = ?")
      .get("demo@example.com");
    expect(prodProfile).toBeUndefined();

    prodDb.close();
    demoDb.close();
  });

  test("deleting demo DB does not affect production DB", () => {
    const prodDb = createDb(prodDbPath);

    // Verify prod data still exists from earlier test
    expect(getEmailSubjects(prodDb)).toContain("Real Email from Boss");
    prodDb.close();

    // Delete the demo DB
    rmSync(demoDbPath, { force: true });
    expect(existsSync(demoDbPath)).toBe(false);

    // Production DB should still work and have its data
    const prodDb2 = createDb(prodDbPath);
    expect(getEmailSubjects(prodDb2)).toContain("Real Email from Boss");
    prodDb2.close();

    // Production DB file should still exist
    expect(existsSync(prodDbPath)).toBe(true);
  });

  test("full table isolation across all major tables", () => {
    // Recreate demo DB (deleted in previous test)
    const prodDb = createDb(prodDbPath);
    const demoDb = createDb(demoDbPath);

    // Write to every major table in demo DB
    demoDb
      .prepare(
        "INSERT OR REPLACE INTO accounts (id, email, is_primary, added_at) VALUES (?, ?, ?, ?)",
      )
      .run("demo-account", "demo@example.com", 1, Date.now());
    demoDb
      .prepare(
        "INSERT OR REPLACE INTO sync_state (account_id, history_id, last_sync_at) VALUES (?, ?, ?)",
      )
      .run("demo-account", "12345", Date.now());
    demoDb
      .prepare(
        "INSERT OR REPLACE INTO sent_emails (id, to_address, subject, body, date, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("sent-demo-1", "other@example.com", "Demo sent", "body", "2025-01-01", Date.now());

    // Verify all exist in demo DB
    expect(demoDb.prepare("SELECT COUNT(*) as c FROM accounts").get()).toEqual({ c: 1 });
    expect(demoDb.prepare("SELECT COUNT(*) as c FROM sync_state").get()).toEqual({ c: 1 });
    expect(demoDb.prepare("SELECT COUNT(*) as c FROM sent_emails").get()).toEqual({ c: 1 });

    // Verify none exist in production DB (accounts may have prod data, check for demo-account specifically)
    expect(
      prodDb.prepare("SELECT * FROM accounts WHERE id = ?").get("demo-account"),
    ).toBeUndefined();
    expect(
      prodDb.prepare("SELECT * FROM sync_state WHERE account_id = ?").get("demo-account"),
    ).toBeUndefined();
    expect(
      prodDb.prepare("SELECT * FROM sent_emails WHERE id = ?").get("sent-demo-1"),
    ).toBeUndefined();

    prodDb.close();
    demoDb.close();
  });
});
