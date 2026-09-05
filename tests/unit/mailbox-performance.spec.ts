import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import {
  _testSetDatabase,
  saveEmail,
  getInboxEmails,
  getEmailsByThread,
  getEmailsByIds,
  searchEmails,
  updateEmailLabelIds,
  deleteEmail,
} from "../../src/main/db";
import { SCHEMA, FTS5_SCHEMA, FTS5_TRIGGERS } from "../../src/main/db/schema";
import { runMigrations } from "../../src/main/db/migrations";
import { getRawLogger } from "../../src/main/services/logger";
import type { Email } from "../../src/shared/types";

// Exercise production functions, not copies of their SQL or threading logic.
let db: Database.Database;
let queries: string[];
test.beforeEach(() => {
  getRawLogger().level = "silent";
  queries = [];
  db = new Database(":memory:", {
    nativeBinding: process.env.EXO_PERF_NATIVE_BINDING,
    verbose: (sql) => {
      if (typeof sql === "string") queries.push(sql);
    },
  });
  db.exec(SCHEMA);
  db.exec(FTS5_SCHEMA);
  db.exec(FTS5_TRIGGERS);
  _testSetDatabase(db);
});
test.afterEach(() => db.close());

function seed(id: string, overrides: Partial<Email> = {}, account = "a") {
  saveEmail(
    {
      id,
      threadId: id,
      subject: "Project kickoff",
      from: "Person <person@example.test>",
      to: "me@example.test",
      body: "<p>A searchable conversation about delivery.</p>",
      date: "2026-01-01T00:00:00Z",
      labelIds: ["INBOX", "UNREAD"],
      messageIdHeader: `<${id}@example.test>`,
      ...overrides,
    },
    account,
  );
}

test("search starts from FTS matches and preserves ordering, limits and account scope", () => {
  seed("old", { date: "2025-01-01T00:00:00Z" });
  seed("new");
  seed("other-account", {}, "b");
  queries.length = 0;
  expect(searchEmails("project", { accountId: "a", limit: 1 }).map((r) => r.id)).toEqual(["new"]);
  const query = queries.find((sql) => sql.includes("FROM emails_fts"));
  expect(query).toBeDefined();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>;
  expect(plan[0].detail).toContain("emails_fts");
  expect(searchEmails("project", { accountId: "a", limit: 1, offset: 1 }).map((r) => r.id)).toEqual(
    ["old"],
  );
});

test("search handles email addresses, phrases, operators and substring fallback", () => {
  seed("match");
  for (const query of [
    "from:person@example.test",
    "from:pers*",
    "to:me@example.test",
    "person@example.test",
    "subject:kickoff",
    "subject:kick*",
    '"project kickoff"',
    "project AND kickoff",
    "absent OR kickoff",
    "project NOT absent",
    "roject",
  ]) {
    expect(
      searchEmails(query, { accountId: "a" }).map((r) => r.id),
      query,
    ).toEqual(["match"]);
  }
  expect(searchEmails("missingterm", { accountId: "a" })).toEqual([]);
  expect(searchEmails("", { accountId: "a" })).toEqual([]);
});

test("inbox refresh reuses linkage but reflects label changes immediately", () => {
  seed("archived", { threadId: "old", date: "2025-01-01T00:00:00Z", labelIds: [] });
  seed("received", { threadId: "new", inReplyTo: "<archived@example.test>" });
  seed("sent", { threadId: "reply", labelIds: ["SENT"], inReplyTo: "<received@example.test>" });
  seed("unrelated", { labelIds: ["SENT"] });
  const inbox = getInboxEmails("a");
  expect(inbox.map((e) => e.id).sort()).toEqual(["received", "sent"]);
  expect(inbox.every((e) => e.threadId === "old" && e.body === "")).toBe(true);
  expect(
    getEmailsByThread("old", "a")
      .map((e) => e.id)
      .sort(),
  ).toEqual(["archived", "received", "sent"]);
  queries.length = 0;
  updateEmailLabelIds("received", ["INBOX"]);
  expect(getInboxEmails("a").find((e) => e.id === "received")?.labelIds).toEqual(["INBOX"]);
  expect(queries.some((sql) => sql.includes("in_reply_to AS inReplyTo, date FROM emails"))).toBe(
    false,
  );
  updateEmailLabelIds("received", []);
  expect(getInboxEmails("a")).toEqual([]);
  updateEmailLabelIds("received", ["INBOX"]);
  expect(getInboxEmails("a")).toHaveLength(2);
});

test("linkage invalidates on insert, replacement and deletion", () => {
  seed("received");
  expect(getInboxEmails("a")[0].threadId).toBe("received");
  seed("older", {
    date: "2025-01-01T00:00:00Z",
    labelIds: [],
    inReplyTo: "<received@example.test>",
  });
  expect(getInboxEmails("a")[0].threadId).toBe("older");
  // Removing linkage from an existing message must invalidate the cache too.
  seed("older", { date: "2025-01-01T00:00:00Z", labelIds: [], messageIdHeader: undefined });
  expect(getInboxEmails("a")[0].threadId).toBe("received");
  seed("older", {
    date: "2025-01-01T00:00:00Z",
    labelIds: [],
    inReplyTo: "<received@example.test>",
  });
  expect(getInboxEmails("a")[0].threadId).toBe("older");
  deleteEmail("older", "a");
  expect(getInboxEmails("a")[0].threadId).toBe("received");
});

test("unified inbox does not pull another account's sent mail into colliding threads", () => {
  seed("a-inbox", { threadId: "shared" });
  seed("b-sent", { threadId: "shared", labelIds: ["SENT"] }, "b");
  seed("b-inbox", { threadId: "b-thread", inReplyTo: "<a-inbox@example.test>" }, "b");
  expect(
    getInboxEmails()
      .map((e) => [e.id, e.threadId])
      .sort(),
  ).toEqual([
    ["a-inbox", "shared"],
    ["b-inbox", "b-thread"],
  ]);
});

test("duplicate Message-IDs agree in inbox and detail, including archived canonical thread", () => {
  seed("old", { date: "2025-01-01T00:00:00Z", labelIds: [] });
  seed("new", { messageIdHeader: "<old@example.test>" });
  expect(getInboxEmails("a")[0].threadId).toBe("old");
  expect(
    getEmailsByThread("old", "a")
      .map((e) => e.id)
      .sort(),
  ).toEqual(["new", "old"]);
  expect(
    getEmailsByThread("new")
      .map((e) => e.id)
      .sort(),
  ).toEqual(["new", "old"]);
});

test("metadata search results omit bodies but detail retrieval remains complete", () => {
  seed("one");
  const full = getEmailsByIds(["one"])[0];
  expect(full.body).toContain("searchable conversation");
  expect(getEmailsByIds(["one"], { includeBody: false })).toEqual([{ ...full, body: "" }]);
  expect(getEmailsByIds([], { includeBody: false })).toEqual([]);
});

test("large sent conversation context does not exceed SQLite's variable limit", () => {
  seed("inbox", { threadId: "large-thread" });
  const insert = db.prepare(`INSERT INTO emails
    (id, account_id, thread_id, subject, from_address, to_address, body, date, fetched_at, label_ids)
    VALUES (?, 'a', 'large-thread', 'Reply', 'me@example.test', 'person@example.test', '',
      '2026-01-01T00:00:00Z', 0, '["SENT"]')`);
  db.transaction(() => {
    for (let i = 0; i < 33_000; i++) insert.run(`sent-${i}`);
  })();
  expect(getInboxEmails("a")).toHaveLength(33_001);
});

test("label updates do not write the search index; changed text remains searchable", () => {
  seed("one");
  const changes = () => db.prepare("SELECT total_changes() AS n").get() as { n: number };
  const before = changes().n;
  updateEmailLabelIds("one", ["INBOX"]);
  expect(changes().n - before).toBe(1);
  expect(searchEmails("delivery")).toHaveLength(1);
  db.prepare("UPDATE emails SET body_text = ? WHERE id = ?").run("replacementterm", "one");
  expect(searchEmails("replacementterm")).toHaveLength(1);
  expect(searchEmails("delivery")).toHaveLength(0);
});

test("migration replaces the old FTS trigger on existing databases without losing search", () => {
  seed("one");
  db.exec("DROP TRIGGER emails_fts_update");
  db.exec(`CREATE TRIGGER emails_fts_update AFTER UPDATE ON emails BEGIN SELECT 1; END`);
  db.exec("DROP INDEX idx_emails_inbox");
  runMigrations(db);
  runMigrations(db);
  db.prepare("UPDATE emails SET subject = ? WHERE id = ?").run("migrationneedle", "one");
  expect(searchEmails("migrationneedle")).toHaveLength(1);
  expect(searchEmails("kickoff")).toHaveLength(0);
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_emails_inbox'").get(),
  ).toBeTruthy();
});

test("resyncing a message preserves its rowid and does not leave stale FTS postings", () => {
  seed("one", { body: "originalneedle" });
  const original = db.prepare("SELECT rowid FROM emails WHERE id = 'one'").get();
  seed("two");
  seed("one", { body: "replacementneedle" });
  expect(db.prepare("SELECT rowid FROM emails WHERE id = 'one'").get()).toEqual(original);
  expect(searchEmails("originalneedle")).toEqual([]);
  expect(searchEmails("replacementneedle").map((e) => e.id)).toEqual(["one"]);
  db.exec("INSERT INTO emails_fts(emails_fts, rank) VALUES('integrity-check', 1)");
});
