import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

const AGENT_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    email_id TEXT,
    thread_id TEXT,
    account_id TEXT NOT NULL,
    provider_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_account ON agent_sessions(account_id);
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_email ON agent_sessions(email_id);
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);
`;

test.describe("agent_sessions table", () => {
  test("creates table and inserts/reads sessions", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);
    const now = Date.now();
    db.prepare(`
      INSERT INTO agent_sessions (id, title, email_id, thread_id, account_id, provider_ids, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("sess-1", "Draft reply", "email-1", "thread-1", "acct-1", '["claude"]', now, now, "active");
    const row = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get("sess-1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.title).toBe("Draft reply");
    expect(row.email_id).toBe("email-1");
    expect(row.status).toBe("active");
    expect(JSON.parse(row.provider_ids as string)).toEqual(["claude"]);
  });

  test("lists sessions ordered by updated_at desc", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);
    const now = Date.now();
    db.prepare(`INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("sess-old", "Old", "acct-1", '["claude"]', now - 2000, now - 2000, "completed");
    db.prepare(`INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("sess-new", "New", "acct-1", '["claude"]', now, now, "active");
    const rows = db.prepare("SELECT id FROM agent_sessions WHERE account_id = ? ORDER BY updated_at DESC").all("acct-1") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["sess-new", "sess-old"]);
  });

  test("updates session status and updated_at", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);
    const now = Date.now();
    db.prepare(`INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("sess-1", "Test", "acct-1", '["claude"]', now, now, "active");
    const later = now + 5000;
    db.prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?").run("completed", later, "sess-1");
    const row = db.prepare("SELECT status, updated_at FROM agent_sessions WHERE id = ?").get("sess-1") as { status: string; updated_at: number };
    expect(row.status).toBe("completed");
    expect(row.updated_at).toBe(later);
  });

  test("deletes session", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);
    const now = Date.now();
    db.prepare(`INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("sess-1", "Delete me", "acct-1", '["claude"]', now, now, "active");
    db.prepare("DELETE FROM agent_sessions WHERE id = ?").run("sess-1");
    const row = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get("sess-1");
    expect(row).toBeUndefined();
  });
});
