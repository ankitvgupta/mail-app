/**
 * Unit tests for persisted undo-send.
 *
 * The undo-send delay used to be a setTimeout inside a React component, so
 * closing the window mid-delay silently dropped the message. It now shares the
 * scheduled_messages table and the main-process scheduler. These tests cover the
 * behaviours that make that safe: the schema/migration, the cancel-vs-fire race
 * guard, the due/next-due queries that drive recovery and flush, and the
 * send-later regressions that the unification could have broken.
 *
 * Run with: npx playwright test tests/unit/undo-send-persistence.spec.ts
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
  db.exec(SCHEMA);
  runMigrations(db);
  // scheduled_messages.account_id is a FK to accounts.
  db.prepare(
    "INSERT INTO accounts (id, email, display_name, is_primary, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run("acc-1", "test@example.invalid", "Test", 1, Date.now());
  return db;
}

type SeedOptions = {
  id: string;
  scheduledAt: number;
  kind?: "scheduled" | "undo";
  status?: string;
  attachments?: string;
  composeContext?: string;
  archiveThreadId?: string;
  createdAt?: number;
};

function seed(db: DB, opts: SeedOptions): void {
  const now = opts.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO scheduled_messages (
       id, account_id, type, thread_id, to_addresses, subject, body_html,
       attachments, scheduled_at, kind, archive_thread_id, compose_context,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    "acc-1",
    "send",
    null,
    JSON.stringify(["someone@example.invalid"]),
    "Subject",
    "<p>Body</p>",
    opts.attachments ?? null,
    opts.scheduledAt,
    opts.kind ?? "undo",
    opts.archiveThreadId ?? null,
    opts.composeContext ?? null,
    opts.status ?? "scheduled",
    now,
    now,
  );
}

/**
 * Mirrors claimScheduledMessage() in db/index.ts. The production helper needs an
 * initialized Electron-bound singleton, so the SQL is replicated here to test the
 * guarantee it relies on: the conditional UPDATE is indivisible.
 */
function claim(db: DB, id: string, nextStatus: string): boolean {
  const result = db
    .prepare(
      `UPDATE scheduled_messages SET status = ?, updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    )
    .run(nextStatus, Date.now(), id);
  return result.changes > 0;
}

test.describe("undo-send persistence — schema", () => {
  test("scheduled_messages carries the columns undo-send needs", () => {
    const db = freshDb();
    const cols = new Set(
      (db.prepare("PRAGMA table_info(scheduled_messages)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const col of ["attachments", "kind", "archive_thread_id", "compose_context"]) {
      expect(cols.has(col), `scheduled_messages should have ${col}`).toBe(true);
    }
    db.close();
  });

  test("migration version is unique — a collision would silently skip it", () => {
    // Migrations are forward-only and keyed by version number: if two branches
    // ship the same number, whichever lands second never runs on a DB that
    // already recorded that version, and its columns go missing at runtime.
    const versions = NUMBERED_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("migration adds the columns to a pre-existing DB and defaults kind to 'scheduled'", () => {
    const db = freshDb();

    // Reconstruct the old shape: drop the new columns, keep a legacy row.
    db.exec("DROP TABLE scheduled_messages");
    db.exec(`
      CREATE TABLE scheduled_messages (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL,
        thread_id TEXT, from_address TEXT, to_addresses TEXT NOT NULL,
        cc_addresses TEXT, bcc_addresses TEXT, subject TEXT NOT NULL,
        body_html TEXT NOT NULL, body_text TEXT, in_reply_to TEXT,
        references_header TEXT, scheduled_at INTEGER NOT NULL,
        status TEXT DEFAULT 'scheduled', error_message TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER
      )
    `);
    // The recreated table above intentionally omits the FK, matching the
    // pre-migration shape closely enough for this test.
    const now = Date.now();
    db.prepare(
      `INSERT INTO scheduled_messages
         (id, account_id, type, to_addresses, subject, body_html, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy-1", "acc-1", "send", '["a@b.invalid"]', "Old", "<p>x</p>", now, now, now);

    // Re-run only the undo-send migration by resetting the recorded version.
    db.prepare("DELETE FROM schema_version WHERE version >= 9").run();
    runMigrations(db);

    const cols = new Set(
      (db.prepare("PRAGMA table_info(scheduled_messages)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    expect(cols.has("attachments")).toBe(true);
    expect(cols.has("kind")).toBe(true);

    // Pre-existing rows are send-later, never undo.
    const row = db.prepare("SELECT kind FROM scheduled_messages WHERE id = ?").get("legacy-1") as {
      kind: string;
    };
    expect(row.kind).toBe("scheduled");
    db.close();
  });
});

test.describe("undo-send persistence — cancel vs. fire race", () => {
  test("cancel before the send claims the row wins, and the send is skipped", () => {
    const db = freshDb();
    seed(db, { id: "u1", scheduledAt: Date.now() + 15_000 });

    // User hits Undo first.
    expect(claim(db, "u1", "cancelled")).toBe(true);
    // The timer then fires and tries to claim — must lose.
    expect(claim(db, "u1", "sending")).toBe(false);

    const row = db.prepare("SELECT status FROM scheduled_messages WHERE id = ?").get("u1") as {
      status: string;
    };
    expect(row.status).toBe("cancelled");
    db.close();
  });

  test("cancel after the send has claimed the row loses and does not double-send", () => {
    const db = freshDb();
    seed(db, { id: "u2", scheduledAt: Date.now() - 1 });

    // Timer fires first.
    expect(claim(db, "u2", "sending")).toBe(true);
    // Undo arrives late — must not flip a message that is already going out.
    expect(claim(db, "u2", "cancelled")).toBe(false);

    const row = db.prepare("SELECT status FROM scheduled_messages WHERE id = ?").get("u2") as {
      status: string;
    };
    expect(row.status).toBe("sending");
    db.close();
  });

  test("only one of two concurrent claims can succeed", () => {
    const db = freshDb();
    seed(db, { id: "u3", scheduledAt: Date.now() });
    const results = [claim(db, "u3", "sending"), claim(db, "u3", "cancelled")];
    expect(results.filter(Boolean)).toHaveLength(1);
    db.close();
  });
});

test.describe("undo-send persistence — recovery and flush", () => {
  const dueQuery = `SELECT id FROM scheduled_messages
                    WHERE status = 'scheduled' AND scheduled_at <= ?
                    ORDER BY scheduled_at ASC`;

  test("a row that came due while the app was closed is picked up as due", () => {
    const db = freshDb();
    // Persisted 15s undo whose deadline passed while the process was gone.
    seed(db, { id: "past", scheduledAt: Date.now() - 60_000 });
    const due = db.prepare(dueQuery).all(Date.now()) as Array<{ id: string }>;
    expect(due.map((r) => r.id)).toContain("past");
    db.close();
  });

  test("a row still inside its delay is not due yet", () => {
    const db = freshDb();
    seed(db, { id: "future", scheduledAt: Date.now() + 15_000 });
    const due = db.prepare(dueQuery).all(Date.now()) as Array<{ id: string }>;
    expect(due.map((r) => r.id)).not.toContain("future");
    db.close();
  });

  test("cancelled and sent rows are never recovered", () => {
    const db = freshDb();
    seed(db, { id: "c1", scheduledAt: Date.now() - 1000, status: "cancelled" });
    seed(db, { id: "s1", scheduledAt: Date.now() - 1000, status: "sent" });
    const due = db.prepare(dueQuery).all(Date.now()) as Array<{ id: string }>;
    expect(due).toHaveLength(0);
    db.close();
  });

  test("flush selects every pending row regardless of remaining delay", () => {
    const db = freshDb();
    seed(db, { id: "f1", scheduledAt: Date.now() + 15_000 });
    seed(db, { id: "f2", scheduledAt: Date.now() + 3_600_000, kind: "scheduled" });
    seed(db, { id: "f3", scheduledAt: Date.now() - 1, status: "sent" });

    // flushPendingNow() uses getScheduledMessages() — all pending, no time filter.
    const pending = db
      .prepare("SELECT id FROM scheduled_messages WHERE status = 'scheduled'")
      .all() as Array<{ id: string }>;
    expect(pending.map((r) => r.id).sort()).toEqual(["f1", "f2"]);
    db.close();
  });

  test("next-due time is the earliest pending row, which drives precise timing", () => {
    const db = freshDb();
    const base = Date.now();
    // A 15s undo queued behind a send-later an hour out must not wait an hour.
    seed(db, { id: "later", scheduledAt: base + 3_600_000, kind: "scheduled" });
    seed(db, { id: "undo", scheduledAt: base + 15_000 });

    const row = db
      .prepare("SELECT MIN(scheduled_at) as next FROM scheduled_messages WHERE status = 'scheduled'")
      .get() as { next: number };
    expect(row.next).toBe(base + 15_000);

    // The old 30s poll would have overshot a 15s delay; the computed sleep must not.
    const MAX_SLEEP = 30_000;
    const sleep = Math.min(Math.max(row.next - base, 0), MAX_SLEEP);
    expect(sleep).toBe(15_000);
    db.close();
  });

  test("long-horizon rows clamp to the max sleep so they re-arm periodically", () => {
    const db = freshDb();
    const base = Date.now();
    seed(db, { id: "far", scheduledAt: base + 7 * 24 * 3_600_000, kind: "scheduled" });
    const row = db
      .prepare("SELECT MIN(scheduled_at) as next FROM scheduled_messages WHERE status = 'scheduled'")
      .get() as { next: number };
    const sleep = Math.min(Math.max(row.next - base, 0), 30_000);
    expect(sleep).toBe(30_000);
    db.close();
  });
});

test.describe("undo-send persistence — payload round-trip", () => {
  test("composeContext survives the round-trip so Undo can reopen compose", () => {
    const db = freshDb();
    const context = JSON.stringify({
      mode: "reply",
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      to: ["a@b.invalid"],
      subject: "Re: test",
      optimisticEmailId: "pending-123",
    });
    seed(db, { id: "ctx", scheduledAt: Date.now() + 15_000, composeContext: context });

    const row = db
      .prepare("SELECT compose_context as ctx FROM scheduled_messages WHERE id = ?")
      .get("ctx") as { ctx: string };
    const parsed = JSON.parse(row.ctx) as { optimisticEmailId: string; subject: string };
    expect(parsed.optimisticEmailId).toBe("pending-123");
    expect(parsed.subject).toBe("Re: test");
    db.close();
  });

  test("archiveThreadId round-trips for send-and-archive", () => {
    const db = freshDb();
    seed(db, { id: "arch", scheduledAt: Date.now() + 15_000, archiveThreadId: "thread-9" });
    const row = db
      .prepare("SELECT archive_thread_id as t FROM scheduled_messages WHERE id = ?")
      .get("arch") as { t: string };
    expect(row.t).toBe("thread-9");
    db.close();
  });
});

test.describe("send-later regressions (unification must not break it)", () => {
  test("attachments now persist — previously dropped by scheduled send", () => {
    const db = freshDb();
    const attachments = JSON.stringify([
      { filename: "report.pdf", mimeType: "application/pdf", size: 1024 },
    ]);
    seed(db, { id: "att", scheduledAt: Date.now() + 60_000, kind: "scheduled", attachments });

    const row = db
      .prepare("SELECT attachments FROM scheduled_messages WHERE id = ?")
      .get("att") as { attachments: string };
    const parsed = JSON.parse(row.attachments) as Array<{ filename: string }>;
    expect(parsed[0].filename).toBe("report.pdf");
    db.close();
  });

  test("send-later rows fire through the same due query as undo rows", () => {
    const db = freshDb();
    seed(db, { id: "sl", scheduledAt: Date.now() - 1000, kind: "scheduled" });
    const due = db
      .prepare(
        `SELECT id, kind FROM scheduled_messages WHERE status = 'scheduled' AND scheduled_at <= ?`,
      )
      .all(Date.now()) as Array<{ id: string; kind: string }>;
    expect(due).toHaveLength(1);
    expect(due[0].kind).toBe("scheduled");
    db.close();
  });

  test("the send-later badge ignores in-flight undo sends", () => {
    const db = freshDb();
    seed(db, { id: "undo-1", scheduledAt: Date.now() + 15_000, kind: "undo" });
    seed(db, { id: "sched-1", scheduledAt: Date.now() + 3_600_000, kind: "scheduled" });

    const stats = db
      .prepare(
        `SELECT COUNT(*) as c FROM scheduled_messages
         WHERE status IN ('scheduled','sending') AND kind = 'scheduled'`,
      )
      .get() as { c: number };
    expect(stats.c).toBe(1);
    db.close();
  });

  test("cancelling a send-later row is still distinguishable from an undo row", () => {
    const db = freshDb();
    seed(db, { id: "sl-cancel", scheduledAt: Date.now() + 60_000, kind: "scheduled" });
    expect(claim(db, "sl-cancel", "cancelled")).toBe(true);
    const row = db
      .prepare("SELECT kind, status FROM scheduled_messages WHERE id = ?")
      .get("sl-cancel") as { kind: string; status: string };
    // kind drives the cancel policy: 'scheduled' creates a Gmail draft,
    // 'undo' returns composeContext instead.
    expect(row.kind).toBe("scheduled");
    expect(row.status).toBe("cancelled");
    db.close();
  });
});
