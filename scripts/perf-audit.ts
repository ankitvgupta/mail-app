/** Run with NODE_ENV=production npx tsx scripts/perf-audit.ts [10000 50000].
 * Uses production DB functions, a disposable on-disk mailbox, and no credentials.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  _testSetDatabase,
  invalidateThreadMergeCache,
  getInboxEmails,
  getEmailsByThread,
  getEmailsByIds,
  searchEmails,
  updateEmailLabelIds,
} from "../src/main/db";
import { SCHEMA, FTS5_SCHEMA, FTS5_TRIGGERS } from "../src/main/db/schema";
import { getRawLogger, closeLogs } from "../src/main/services/logger";
import { DEMO_INBOX_EMAILS } from "../src/main/demo/fake-inbox";
import { stripHtmlForSearch } from "../src/main/db";

getRawLogger().level = "silent";

function measure(run: () => unknown, iterations = 9) {
  const start = performance.now();
  run();
  // Keep the unoptimized baseline tractable when a single query takes seconds.
  if (performance.now() - start > 200) iterations = 3;
  const samples = Array.from({ length: iterations }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return {
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)),
    p95Ms: Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(2)),
  };
}

const sizes = process.argv.slice(2).map(Number);
if (sizes.some((size) => !Number.isSafeInteger(size) || size < 1000)) {
  throw new Error("Mailbox sizes must be integers >= 1000");
}
const reports = [];
for (const count of sizes.length ? sizes : [10_000, 50_000]) {
  const directory = mkdtempSync(join(tmpdir(), "exo-perf-"));
  let captureQuery = false;
  let searchSql = "";
  const db = new Database(join(directory, "mailbox.db"), {
    nativeBinding: process.env.EXO_PERF_NATIVE_BINDING,
    verbose: (sql) => {
      if (captureQuery && typeof sql === "string" && sql.includes("FROM emails_fts"))
        searchSql = sql;
    },
  });
  try {
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    db.exec(FTS5_SCHEMA);
    db.exec(FTS5_TRIGGERS);
    _testSetDatabase(db);
    invalidateThreadMergeCache();
    const insert = db.prepare(`INSERT INTO emails
      (id, account_id, thread_id, subject, from_address, to_address, body, body_text,
       snippet, date, fetched_at, label_ids, message_id, in_reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const templates = DEMO_INBOX_EMAILS.map((email) => ({
      ...email,
      text: stripHtmlForSearch(email.body),
    }));
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const template = templates[i % templates.length];
        const thread = Math.floor(i / 4);
        const account = `account-${thread % 2}`;
        const sent = i % 4 === 3;
        const inbox = i < 2000 && !sent;
        insert.run(
          `email-${i}`,
          account,
          `thread-${thread}`,
          `Project ${template.subject}`,
          `Person ${thread % 100} <person${thread % 100}@example.test>`,
          "me@example.test",
          template.body,
          template.text,
          template.snippet ?? template.text.slice(0, 150),
          new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
          0,
          JSON.stringify(inbox ? ["INBOX", "UNREAD"] : sent ? ["SENT"] : []),
          `<email-${i}@example.test>`,
          i % 4 ? `<email-${i - 1}@example.test>` : null,
        );
      }
    })();
    db.pragma("wal_checkpoint(TRUNCATE)");
    const search = (query: string) => searchEmails(query, { accountId: "account-0", limit: 20 });
    const inbox = getInboxEmails("account-0");
    const results = {
      count,
      inboxCount: inbox.length,
      inboxRefresh: measure(() => getInboxEmails("account-0")),
      openThread: measure(() => getEmailsByThread("thread-0", "account-0")),
      searchCommon: measure(() => search("project")),
      searchSelective: measure(() => search("kickoff")),
      searchAddress: measure(() => search("from:person42@example.test")),
      searchSubstring: measure(() => search("roject")),
      searchMiss: measure(() => search("nonexistentneedle")),
      fullSearch: measure(() =>
        getEmailsByIds(
          searchEmails("project", { accountId: "account-0", limit: 500 }).map((r) => r.id),
          { includeBody: false },
        ),
      ),
      mark100Read: measure(() =>
        db.transaction(() => {
          for (let i = 0; i < 100; i++) updateEmailLabelIds(`email-${i}`, ["INBOX"]);
        })(),
      ),
      searchPayloadBytes: Buffer.byteLength(
        JSON.stringify(
          getEmailsByIds(
            searchEmails("project", { accountId: "account-0", limit: 500 }).map((r) => r.id),
            { includeBody: false },
          ),
        ),
      ),
    };
    captureQuery = true;
    search("project");
    captureQuery = false;
    const searchPlan = db.prepare(`EXPLAIN QUERY PLAN ${searchSql}`).all();
    reports.push({ ...results, searchPlan });
    console.error(`Measured ${count.toLocaleString()} emails`);
  } finally {
    db.close();
    invalidateThreadMergeCache();
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({ node: process.version, platform: process.platform, reports }, null, 2),
);
closeLogs();
