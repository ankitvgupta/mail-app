import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { SCHEMA, FTS5_SCHEMA, FTS5_TRIGGERS } from "../../src/main/db/schema";

const require = createRequire(import.meta.url);

type DB = BetterSqlite3.Database;

// better-sqlite3 may be compiled for Electron's Node version rather than system Node.
let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const testDb = new DatabaseCtor!(":memory:");
  testDb.close();
} catch (e: unknown) {
  const err = e as Error;
  if (
    err.message?.includes("NODE_MODULE_VERSION") ||
    err.message?.includes("did not self-register")
  ) {
    nativeModuleError = err.message.split("\n")[0];
  } else {
    throw e;
  }
}

/**
 * Comprehensive unit tests for the database layer (src/main/db/index.ts).
 *
 * Since the db module imports from 'electron' (which is unavailable in unit tests),
 * we test the SQL operations directly against an in-memory better-sqlite3 database.
 * This mirrors the approach used by db-isolation.spec.ts and tests the same SQL
 * patterns that the exported functions use.
 */

// Strip HTML for FTS indexing (copied from db/index.ts — pure function)
function stripHtmlForSearch(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[#\w]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Sanitize FTS5 query (copied from db/index.ts — pure function)
function sanitizeFtsQuery(query: string): string {
  if (query.startsWith('"') && query.endsWith('"')) return query;
  const ftsOperators = new Set(["AND", "OR", "NOT", "NEAR"]);
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens
    .map((token) => {
      if (ftsOperators.has(token.toUpperCase())) return token.toUpperCase();
      if (/^(subject|body_text|from_address|to_address):/.test(token)) return token;
      if (/[*"():^{}+\-]/.test(token)) return `"${token.replace(/"/g, '""')}"`;
      return token;
    })
    .join(" ");
}

function createTestDb(): DB {
  const db = new DatabaseCtor!(":memory:");
  db.pragma("journal_mode = WAL");
  // Disable FK enforcement for tests — the production code also does not enable it,
  // but better-sqlite3 may enable it by default depending on compile flags.
  db.pragma("foreign_keys = OFF");
  db.exec(SCHEMA);
  db.exec(FTS5_SCHEMA);
  db.exec(FTS5_TRIGGERS);
  return db;
}

// ---- DB operation wrappers (mirror src/main/db/index.ts logic) ----

function saveEmail(
  db: DB,
  email: {
    id: string;
    threadId: string;
    subject: string;
    from: string;
    to: string;
    cc?: string;
    bcc?: string;
    body: string;
    snippet?: string;
    date: string;
    labelIds?: string[];
    attachments?: unknown[];
    messageIdHeader?: string;
  },
  accountId = "default",
) {
  const bodyText = stripHtmlForSearch(email.body);
  db.prepare(
    `
    INSERT OR REPLACE INTO emails (id, account_id, thread_id, subject, from_address, to_address, cc_address, bcc_address, body, body_text, snippet, date, fetched_at, label_ids, attachments, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
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
  );
}

function getEmail(db: DB, emailId: string) {
  return db
    .prepare(
      `
    SELECT e.id, e.account_id as accountId, e.thread_id as threadId, e.subject,
      e.from_address as "from", e.to_address as "to", e.cc_address as cc, e.bcc_address as bcc,
      e.body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
      a.needs_reply as needsReply, a.reason, a.analyzed_at as analyzedAt,
      d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus,
      d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.cc as draftCc, d.bcc as draftBcc
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id
    WHERE e.id = ?
  `,
    )
    .get(emailId);
}

// Shared SELECT columns matching production's getAllEmails, getInboxEmails, getEmailsByThread, getEmailsByIds, getSentEmails
const DASHBOARD_EMAIL_SELECT = `
    e.id, e.account_id as accountId, e.thread_id as threadId, e.subject, e.from_address as "from",
    e.to_address as "to", e.cc_address as "cc", e.bcc_address as "bcc", e.body, e.snippet, e.date, e.label_ids as labelIds, e.attachments as attachmentsJson,
    a.needs_reply as needsReply, a.reason, a.analyzed_at as analyzedAt,
    d.draft_body as draftBody, d.gmail_draft_id as gmailDraftId, d.status as draftStatus, d.created_at as draftCreatedAt, d.agent_task_id as agentTaskId, d.cc as draftCc, d.bcc as draftBcc`;

const DASHBOARD_EMAIL_FROM_JOINS = `
    FROM emails e
    LEFT JOIN analyses a ON e.id = a.email_id
    LEFT JOIN drafts d ON e.id = d.email_id`;

function getAllEmails(db: DB, accountId?: string) {
  let query = `SELECT ${DASHBOARD_EMAIL_SELECT} ${DASHBOARD_EMAIL_FROM_JOINS}`;
  if (accountId) query += ` WHERE e.account_id = ?`;
  query += ` ORDER BY e.date DESC`;
  const stmt = db.prepare(query);
  return accountId ? stmt.all(accountId) : stmt.all();
}

function getInboxEmails(db: DB, accountId?: string) {
  let query = `SELECT ${DASHBOARD_EMAIL_SELECT} ${DASHBOARD_EMAIL_FROM_JOINS}
    WHERE (e.label_ids IS NULL OR e.label_ids LIKE '%"INBOX"%')`;
  if (accountId) query += ` AND e.account_id = ?`;
  const stmt = db.prepare(query);
  return accountId ? stmt.all(accountId) : stmt.all();
}

function deleteEmail(db: DB, emailId: string, accountId = "default") {
  db.prepare("DELETE FROM drafts WHERE email_id = ?").run(emailId);
  db.prepare("DELETE FROM analyses WHERE email_id = ?").run(emailId);
  db.prepare("DELETE FROM emails WHERE id = ? AND account_id = ?").run(emailId, accountId);
}

function getEmailsByThread(db: DB, threadId: string, accountId?: string) {
  const accountFilter = accountId ? " AND e.account_id = ?" : "";
  const query = `SELECT ${DASHBOARD_EMAIL_SELECT} ${DASHBOARD_EMAIL_FROM_JOINS}
    WHERE e.thread_id = ?${accountFilter}
    ORDER BY e.date ASC`;
  const stmt = db.prepare(query);
  return accountId ? stmt.all(threadId, accountId) : stmt.all(threadId);
}

function getEmailsByIds(db: DB, ids: string[]) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT ${DASHBOARD_EMAIL_SELECT} ${DASHBOARD_EMAIL_FROM_JOINS}
    WHERE e.id IN (${placeholders})`,
    )
    .all(...ids);
}

function getAllEmailIds(db: DB, accountId?: string): string[] {
  if (accountId) {
    return (
      db.prepare("SELECT id FROM emails WHERE account_id = ?").all(accountId) as { id: string }[]
    ).map((r) => r.id);
  }
  return (db.prepare("SELECT id FROM emails").all() as { id: string }[]).map((r) => r.id);
}

function getEmailIds(db: DB, accountId: string): Set<string> {
  const rows = db.prepare("SELECT id FROM emails WHERE account_id = ?").all(accountId) as {
    id: string;
  }[];
  return new Set(rows.map((r) => r.id));
}

function updateEmailLabelIds(db: DB, emailId: string, labelIds: string[]) {
  db.prepare("UPDATE emails SET label_ids = ? WHERE id = ?").run(JSON.stringify(labelIds), emailId);
}

function saveAnalysis(db: DB, emailId: string, needsReply: boolean, reason: string) {
  db.prepare(
    `
    INSERT OR REPLACE INTO analyses (email_id, needs_reply, reason, analyzed_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(emailId, needsReply ? 1 : 0, reason, Date.now());
}

function saveDraft(
  db: DB,
  emailId: string,
  draftBody: string,
  status = "pending",
  gmailDraftId?: string,
  options?: { cc?: string[]; bcc?: string[] },
) {
  const ccJson = options?.cc?.length ? JSON.stringify(options.cc) : null;
  const bccJson = options?.bcc?.length ? JSON.stringify(options.bcc) : null;
  const updateCc = options !== undefined ? "excluded.cc" : "COALESCE(excluded.cc, drafts.cc)";
  const updateBcc = options !== undefined ? "excluded.bcc" : "COALESCE(excluded.bcc, drafts.bcc)";
  db.prepare(
    `
    INSERT INTO drafts (email_id, draft_body, gmail_draft_id, status, created_at, cc, bcc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_id) DO UPDATE SET
      draft_body = excluded.draft_body,
      gmail_draft_id = excluded.gmail_draft_id,
      status = excluded.status,
      created_at = excluded.created_at,
      cc = ${updateCc},
      bcc = ${updateBcc}
  `,
  ).run(emailId, draftBody, gmailDraftId || null, status, Date.now(), ccJson, bccJson);
}

function deleteDraft(db: DB, emailId: string) {
  db.prepare("DELETE FROM drafts WHERE email_id = ?").run(emailId);
}

function updateDraftAgentTaskId(db: DB, emailId: string, agentTaskId: string) {
  db.prepare("UPDATE drafts SET agent_task_id = ? WHERE email_id = ?").run(agentTaskId, emailId);
}

function saveAccount(
  db: DB,
  accountId: string,
  email: string,
  displayName?: string,
  isPrimary = false,
) {
  db.prepare(
    `
    INSERT OR REPLACE INTO accounts (id, email, display_name, is_primary, added_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(accountId, email, displayName || null, isPrimary ? 1 : 0, Date.now());
}

function getAccounts(db: DB) {
  const rows = db
    .prepare(
      "SELECT id, email, display_name as displayName, is_primary as isPrimary, added_at as addedAt FROM accounts ORDER BY added_at ASC",
    )
    .all() as {
    id: string;
    email: string;
    displayName: string | null;
    isPrimary: number;
    addedAt: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName || undefined,
    isPrimary: Boolean(r.isPrimary),
    addedAt: r.addedAt,
  }));
}

function updateAccountDisplayName(db: DB, accountId: string, displayName: string) {
  db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(displayName, accountId);
}

function setPrimaryAccount(db: DB, accountId: string) {
  db.prepare("UPDATE accounts SET is_primary = 0").run();
  db.prepare("UPDATE accounts SET is_primary = 1 WHERE id = ?").run(accountId);
}

function removeAccount(db: DB, accountId: string) {
  const run = db.transaction(() => {
    db.prepare(
      "DELETE FROM extension_enrichments WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    db.prepare(
      "DELETE FROM drafts WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
    db.prepare(
      "DELETE FROM analyses WHERE email_id IN (SELECT id FROM emails WHERE account_id = ?)",
    ).run(accountId);
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

function saveSentEmail(
  db: DB,
  email: { id: string; toAddress: string; subject: string; body: string; date: string },
) {
  db.prepare(
    `
    INSERT OR REPLACE INTO sent_emails (id, to_address, subject, body, date, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(email.id, email.toAddress, email.subject, email.body, email.date, Date.now());
}

function getSentEmails(db: DB, accountId: string) {
  return db
    .prepare(
      `SELECT ${DASHBOARD_EMAIL_SELECT} ${DASHBOARD_EMAIL_FROM_JOINS}
    WHERE EXISTS (SELECT 1 FROM json_each(e.label_ids) WHERE value = 'SENT') AND e.account_id = ?
    ORDER BY e.date DESC
  `,
    )
    .all(accountId);
}

function snoozeEmail(
  db: DB,
  id: string,
  emailId: string,
  threadId: string,
  accountId: string,
  snoozeUntil: number,
) {
  db.prepare(
    `
    INSERT OR REPLACE INTO snoozed_emails (id, email_id, thread_id, account_id, snooze_until, snoozed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(id, emailId, threadId, accountId, snoozeUntil, Date.now());
}

function unsnoozeEmail(db: DB, id: string) {
  db.prepare("DELETE FROM snoozed_emails WHERE id = ?").run(id);
}

function getSnoozedEmails(db: DB, accountId: string) {
  return db
    .prepare(
      `
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails WHERE account_id = ? ORDER BY snooze_until ASC
  `,
    )
    .all(accountId);
}

function clearSnoozedEmails(db: DB, accountId: string) {
  db.prepare("DELETE FROM snoozed_emails WHERE account_id = ?").run(accountId);
}

function insertScheduledMessage(
  db: DB,
  item: {
    id: string;
    accountId: string;
    type: string;
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
    createdAt: number;
  },
) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO scheduled_messages (
      id, account_id, type, thread_id, to_addresses, cc_addresses, bcc_addresses,
      subject, body_html, body_text, in_reply_to, references_header,
      scheduled_at, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `,
  ).run(
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

function getDueScheduledMessages(db: DB, limit = 10) {
  const now = Date.now();
  const rows = db
    .prepare(
      `
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, status, scheduled_at as scheduledAt
    FROM scheduled_messages
    WHERE status = 'scheduled' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC LIMIT ?
  `,
    )
    .all(now, limit);
  return (rows as Record<string, unknown>[]).map((r) => ({
    ...r,
    to: JSON.parse(r.toAddresses as string),
  }));
}

function getScheduledMessages(db: DB, accountId?: string) {
  let query = `
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader,
           scheduled_at as scheduledAt, status, error_message as errorMessage,
           created_at as createdAt, updated_at as updatedAt
    FROM scheduled_messages WHERE status = 'scheduled'
  `;
  if (accountId) query += ` AND account_id = ?`;
  query += ` ORDER BY scheduled_at ASC`;
  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  return (rows as Record<string, unknown>[]).map((r) => ({
    ...r,
    to: JSON.parse(r.toAddresses as string),
    cc: r.ccAddresses ? JSON.parse(r.ccAddresses as string) : undefined,
    bcc: r.bccAddresses ? JSON.parse(r.bccAddresses as string) : undefined,
    references: r.referencesHeader,
  }));
}

function updateScheduledMessageStatus(db: DB, id: string, status: string, errorMessage?: string) {
  const now = Date.now();
  if (status === "sent") {
    db.prepare(
      "UPDATE scheduled_messages SET status = ?, sent_at = ?, updated_at = ?, error_message = NULL WHERE id = ?",
    ).run(status, now, now, id);
  } else {
    db.prepare(
      "UPDATE scheduled_messages SET status = ?, error_message = ?, updated_at = ? WHERE id = ?",
    ).run(status, errorMessage || null, now, id);
  }
}

function getScheduledMessageStats(db: DB, accountId?: string) {
  let query =
    "SELECT status, COUNT(*) as count FROM scheduled_messages WHERE status IN ('scheduled', 'sending')";
  if (accountId) query += ` AND account_id = ?`;
  query += " GROUP BY status";
  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  let scheduled = 0,
    total = 0;
  for (const row of rows as { status: string; count: number }[]) {
    if (row.status === "scheduled") scheduled = row.count;
    total += row.count;
  }
  return { scheduled, total };
}

function insertOutboxMessage(
  db: DB,
  item: {
    id: string;
    accountId: string;
    type: string;
    threadId?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: unknown[];
    createdAt: number;
  },
) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO outbox (
      id, account_id, type, thread_id, to_addresses, cc_addresses, bcc_addresses,
      subject, body_html, body_text, in_reply_to, references_header,
      attachments, status, retry_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `,
  ).run(
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

function getOutboxItem(db: DB, id: string) {
  const row = db
    .prepare(
      `
    SELECT id, account_id as accountId, type, thread_id as threadId,
           to_addresses as toAddresses, cc_addresses as ccAddresses, bcc_addresses as bccAddresses,
           subject, body_html as bodyHtml, body_text as bodyText,
           in_reply_to as inReplyTo, references_header as referencesHeader, attachments,
           status, error_message as errorMessage, retry_count as retryCount,
           created_at as createdAt, updated_at as updatedAt, sent_at as sentAt
    FROM outbox WHERE id = ?
  `,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    to: JSON.parse(row.toAddresses as string),
    cc: row.ccAddresses ? JSON.parse(row.ccAddresses as string) : undefined,
    bcc: row.bccAddresses ? JSON.parse(row.bccAddresses as string) : undefined,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
  };
}

function getOutboxItems(db: DB, accountId?: string) {
  let query = `
    SELECT id, account_id as accountId, status, created_at as createdAt
    FROM outbox WHERE status != 'sent'
  `;
  if (accountId) query += ` AND account_id = ?`;
  query += ` ORDER BY created_at DESC`;
  const stmt = db.prepare(query);
  return accountId ? stmt.all(accountId) : stmt.all();
}

function updateOutboxStatus(
  db: DB,
  id: string,
  status: string,
  errorMessage?: string,
  incrementRetry = false,
) {
  const now = Date.now();
  if (status === "sent") {
    db.prepare(
      "UPDATE outbox SET status = ?, sent_at = ?, updated_at = ?, error_message = NULL WHERE id = ?",
    ).run(status, now, now, id);
  } else if (incrementRetry) {
    db.prepare(
      "UPDATE outbox SET status = ?, error_message = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?",
    ).run(status, errorMessage || null, now, id);
  } else {
    db.prepare("UPDATE outbox SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
      status,
      errorMessage || null,
      now,
      id,
    );
  }
}

function deleteOutboxItem(db: DB, id: string) {
  db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
}

function getOutboxStats(db: DB, accountId?: string) {
  let query = "SELECT status, COUNT(*) as count FROM outbox";
  if (accountId) query += ` WHERE account_id = ?`;
  query += " GROUP BY status";
  const stmt = db.prepare(query);
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  const stats = { pending: 0, sending: 0, failed: 0, total: 0 };
  for (const row of rows as { status: string; count: number }[]) {
    if (row.status === "pending") stats.pending = row.count;
    else if (row.status === "sending") stats.sending = row.count;
    else if (row.status === "failed") stats.failed = row.count;
    stats.total += row.count;
  }
  return stats;
}

function getPendingOutbox(db: DB, accountId?: string, limit = 10) {
  let query = "SELECT id, account_id as accountId, status FROM outbox WHERE status = 'pending'";
  if (accountId) query += ` AND account_id = ?`;
  query += ` ORDER BY created_at ASC LIMIT ?`;
  const stmt = db.prepare(query);
  return accountId ? stmt.all(accountId, limit) : stmt.all(limit);
}

function saveLocalDraft(
  db: DB,
  draft: {
    id: string;
    accountId: string;
    gmailDraftId?: string;
    threadId?: string;
    inReplyTo?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    isReply?: boolean;
    isForward?: boolean;
    createdAt: number;
    updatedAt: number;
    syncedAt?: number;
  },
) {
  db.prepare(
    `
    INSERT OR REPLACE INTO local_drafts (
      id, account_id, gmail_draft_id, thread_id, in_reply_to,
      to_addresses, cc_addresses, bcc_addresses, subject,
      body_html, body_text, is_reply, is_forward,
      created_at, updated_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
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

function getLocalDraft(db: DB, draftId: string) {
  const row = db
    .prepare(
      `
    SELECT id, account_id as accountId, gmail_draft_id as gmailDraftId,
           thread_id as threadId, in_reply_to as inReplyTo,
           to_addresses as toAddresses, cc_addresses as ccAddresses,
           bcc_addresses as bccAddresses, subject,
           body_html as bodyHtml, body_text as bodyText,
           is_reply as isReply, is_forward as isForward,
           created_at as createdAt, updated_at as updatedAt, synced_at as syncedAt
    FROM local_drafts WHERE id = ?
  `,
    )
    .get(draftId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    to: JSON.parse(row.toAddresses as string),
    cc: row.ccAddresses ? JSON.parse(row.ccAddresses as string) : undefined,
    bcc: row.bccAddresses ? JSON.parse(row.bccAddresses as string) : undefined,
    isReply: Boolean(row.isReply),
    isForward: Boolean(row.isForward),
  };
}

function getLocalDrafts(db: DB, accountId?: string) {
  let query = `
    SELECT id, account_id as accountId, subject, updated_at as updatedAt
    FROM local_drafts
  `;
  if (accountId) query += ` WHERE account_id = ?`;
  query += ` ORDER BY updated_at DESC`;
  const stmt = db.prepare(query);
  return accountId ? stmt.all(accountId) : stmt.all();
}

function updateLocalDraftGmailId(db: DB, draftId: string, gmailDraftId: string) {
  db.prepare("UPDATE local_drafts SET gmail_draft_id = ?, synced_at = ? WHERE id = ?").run(
    gmailDraftId,
    Date.now(),
    draftId,
  );
}

function deleteLocalDraft(db: DB, draftId: string) {
  db.prepare("DELETE FROM local_drafts WHERE id = ?").run(draftId);
}

function saveArchiveReady(
  db: DB,
  threadId: string,
  accountId: string,
  isReady: boolean,
  reason: string,
) {
  db.prepare(
    `
    INSERT INTO archive_ready (thread_id, account_id, is_ready, reason, analyzed_at, dismissed)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(thread_id, account_id) DO UPDATE SET
      is_ready = excluded.is_ready, reason = excluded.reason,
      analyzed_at = excluded.analyzed_at, dismissed = 0
  `,
  ).run(threadId, accountId, isReady ? 1 : 0, reason, Date.now());
}

function getArchiveReadyThreads(db: DB, accountId: string) {
  return db
    .prepare(
      `
    SELECT thread_id as threadId, account_id as accountId, is_ready as isReady,
           reason, analyzed_at as analyzedAt, dismissed
    FROM archive_ready
    WHERE account_id = ? AND is_ready = 1 AND dismissed = 0
    ORDER BY analyzed_at DESC
  `,
    )
    .all(accountId)
    .map((r: Record<string, unknown>) => ({
      threadId: r.threadId,
      accountId: r.accountId,
      isReady: Boolean(r.isReady),
      reason: r.reason,
      analyzedAt: r.analyzedAt,
      dismissed: Boolean(r.dismissed),
    }));
}

function getArchiveReadyForThread(db: DB, threadId: string, accountId: string) {
  const row = db
    .prepare(
      `
    SELECT thread_id as threadId, account_id as accountId, is_ready as isReady,
           reason, analyzed_at as analyzedAt, dismissed
    FROM archive_ready WHERE thread_id = ? AND account_id = ?
  `,
    )
    .get(threadId, accountId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    threadId: row.threadId,
    accountId: row.accountId,
    isReady: Boolean(row.isReady),
    reason: row.reason,
    analyzedAt: row.analyzedAt,
    dismissed: Boolean(row.dismissed),
  };
}

function dismissArchiveReady(db: DB, threadId: string, accountId: string) {
  db.prepare("UPDATE archive_ready SET dismissed = 1 WHERE thread_id = ? AND account_id = ?").run(
    threadId,
    accountId,
  );
}

function saveMemory(
  db: DB,
  memory: {
    id: string;
    accountId: string;
    scope: string;
    scopeValue: string | null;
    content: string;
    source: string;
    sourceEmailId?: string | null;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
  },
) {
  db.prepare(
    `
    INSERT OR REPLACE INTO memories (id, account_id, scope, scope_value, content, source, source_email_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    memory.id,
    memory.accountId,
    memory.scope,
    memory.scopeValue,
    memory.content,
    memory.source,
    memory.sourceEmailId ?? null,
    memory.enabled ? 1 : 0,
    memory.createdAt,
    memory.updatedAt,
  );
}

function getMemory(db: DB, id: string) {
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope,
    scopeValue: row.scope_value,
    content: row.content,
    source: row.source,
    sourceEmailId: row.source_email_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getMemories(db: DB, accountId: string) {
  const rows = db
    .prepare("SELECT * FROM memories WHERE account_id = ? ORDER BY scope, created_at DESC")
    .all(accountId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    scope: row.scope,
    scopeValue: row.scope_value,
    content: row.content,
    source: row.source,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function updateMemory(
  db: DB,
  id: string,
  updates: { content?: string; enabled?: boolean; scope?: string; scopeValue?: string | null },
) {
  const memory = getMemory(db, id);
  if (!memory) return;
  const newContent = updates.content ?? memory.content;
  const newEnabled = updates.enabled ?? memory.enabled;
  const newScope = updates.scope ?? memory.scope;
  const newScopeValue = updates.scopeValue !== undefined ? updates.scopeValue : memory.scopeValue;
  db.prepare(
    "UPDATE memories SET content = ?, enabled = ?, scope = ?, scope_value = ?, updated_at = ? WHERE id = ?",
  ).run(newContent, newEnabled ? 1 : 0, newScope, newScopeValue, Date.now(), id);
}

function deleteMemory(db: DB, id: string) {
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

function searchEmails(
  db: DB,
  query: string,
  options: { accountId?: string; limit?: number; offset?: number } = {},
) {
  const { accountId, limit = 50, offset = 0 } = options;

  let ftsQuery = query;
  const additionalFilters: string[] = [];
  const fromMatch = query.match(/from:([^\s]+)/i);
  if (fromMatch) {
    additionalFilters.push(`from_address:${fromMatch[1]}`);
    ftsQuery = ftsQuery.replace(fromMatch[0], "").trim();
  }
  const toMatch = query.match(/to:([^\s]+)/i);
  if (toMatch) {
    additionalFilters.push(`to_address:${toMatch[1]}`);
    ftsQuery = ftsQuery.replace(toMatch[0], "").trim();
  }
  if (ftsQuery) ftsQuery = sanitizeFtsQuery(ftsQuery);
  const finalQuery = [...additionalFilters, ftsQuery].filter(Boolean).join(" ");
  if (!finalQuery) return [];

  let rows: Record<string, unknown>[] = [];
  try {
    let sql = `
      SELECT e.id, e.thread_id as threadId, e.account_id as accountId, e.subject,
        e.from_address as "from", e.to_address as "to", e.date, e.snippet, rank
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
    rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  } catch {
    /* FTS error, fall through to LIKE */
  }

  if (rows.length === 0) {
    try {
      const likePattern = `%${query}%`;
      let sql = `
        SELECT e.id, e.thread_id as threadId, e.account_id as accountId, e.subject,
          e.from_address as "from", e.to_address as "to", e.date, e.snippet, 0 as rank
        FROM emails e
        WHERE (e.subject LIKE ? COLLATE NOCASE OR e.body_text LIKE ? COLLATE NOCASE
               OR e.from_address LIKE ? COLLATE NOCASE OR e.to_address LIKE ? COLLATE NOCASE)
      `;
      const params: (string | number)[] = [likePattern, likePattern, likePattern, likePattern];
      if (accountId) {
        sql += ` AND e.account_id = ?`;
        params.push(accountId);
      }
      sql += ` ORDER BY e.date DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }

  return rows.map((r) => ({
    id: r.id as string,
    threadId: r.threadId as string,
    accountId: r.accountId as string,
    subject: r.subject as string,
    from: r.from as string,
    to: r.to as string,
    date: r.date as string,
    snippet: (r.snippet as string) || "",
    rank: r.rank as number,
  }));
}

function saveLabels(
  db: DB,
  accountId: string,
  labels: { id: string; name: string; type: string; color?: string; messageCount?: number }[],
) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO labels (id, account_id, name, type, color, message_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const runAll = db.transaction(() => {
    for (const l of labels) {
      stmt.run(l.id, accountId, l.name, l.type, l.color || null, l.messageCount || 0);
    }
  });
  runAll();
}

function getLabels(db: DB, accountId: string) {
  return db
    .prepare(
      "SELECT id, account_id as accountId, name, type, color, message_count as messageCount FROM labels WHERE account_id = ?",
    )
    .all(accountId);
}

function deleteLabels(db: DB, accountId: string) {
  db.prepare("DELETE FROM labels WHERE account_id = ?").run(accountId);
}

// ---- Default email helper ----
function makeEmail(overrides: { id: string; threadId: string; [k: string]: unknown }) {
  return {
    subject: "Test Subject",
    from: "sender@example.com",
    to: "recipient@example.com",
    date: "2025-06-01T12:00:00Z",
    body: "<p>Hello</p>",
    ...overrides,
  };
}

// ========================================================
// Tests
// ========================================================

test.describe("Database CRUD operations", () => {
  let db: DB;

  test.beforeEach(() => {
    test.skip(!!nativeModuleError, `better-sqlite3 unavailable: ${nativeModuleError}`);
    db = createTestDb();
  });

  test.afterEach(() => {
    if (db) db.close();
  });

  // ===== Email operations =====
  test.describe("Email operations", () => {
    test("saveEmail and getEmail round-trip", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", snippet: "hello snippet" }), "acct1");
      const result = getEmail(db, "e1");
      expect(result).toBeTruthy();
      expect(result.id).toBe("e1");
      expect(result.threadId).toBe("t1");
      expect(result.subject).toBe("Test Subject");
      expect(result.from).toBe("sender@example.com");
      expect(result.to).toBe("recipient@example.com");
      expect(result.snippet).toBe("hello snippet");
    });

    test("getEmail returns undefined for nonexistent email", () => {
      expect(getEmail(db, "nonexistent")).toBeUndefined();
    });

    test("saveEmail with labelIds persists them as JSON", () => {
      saveEmail(
        db,
        makeEmail({ id: "e2", threadId: "t2", labelIds: ["INBOX", "IMPORTANT"] }),
        "acct1",
      );
      const result = getEmail(db, "e2");
      expect(JSON.parse(result.labelIds)).toEqual(["INBOX", "IMPORTANT"]);
    });

    test("saveEmail with cc and bcc", () => {
      saveEmail(
        db,
        makeEmail({ id: "e3", threadId: "t3", cc: "cc@example.com", bcc: "bcc@example.com" }),
        "acct1",
      );
      const result = getEmail(db, "e3");
      expect(result.cc).toBe("cc@example.com");
      expect(result.bcc).toBe("bcc@example.com");
    });

    test("saveEmail upserts on duplicate id", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", subject: "Original" }), "acct1");
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", subject: "Updated" }), "acct1");
      const result = getEmail(db, "e1");
      expect(result.subject).toBe("Updated");
    });

    test("getAllEmails returns all emails", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct1");
      saveEmail(db, makeEmail({ id: "e3", threadId: "t3" }), "acct2");
      expect(getAllEmails(db)).toHaveLength(3);
    });

    test("getAllEmails filters by accountId", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct2");
      const result = getAllEmails(db, "acct1");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("e1");
    });

    test("getAllEmails returns empty array when no emails exist", () => {
      expect(getAllEmails(db)).toHaveLength(0);
    });

    test("getInboxEmails returns emails with INBOX label or null labelIds", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", labelIds: ["INBOX"] }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct1"); // null labelIds
      saveEmail(db, makeEmail({ id: "e3", threadId: "t3", labelIds: ["SENT"] }), "acct1");
      const inbox = getInboxEmails(db, "acct1");
      const ids = inbox.map((e: Record<string, unknown>) => e.id);
      expect(ids).toContain("e1");
      expect(ids).toContain("e2");
      expect(ids).not.toContain("e3");
    });

    test("deleteEmail removes email and associated analyses/drafts", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveAnalysis(db, "e1", true, "needs reply");
      saveDraft(db, "e1", "draft body");
      deleteEmail(db, "e1", "acct1");
      expect(getEmail(db, "e1")).toBeUndefined();
      expect(db.prepare("SELECT * FROM analyses WHERE email_id = ?").get("e1")).toBeUndefined();
      expect(db.prepare("SELECT * FROM drafts WHERE email_id = ?").get("e1")).toBeUndefined();
    });

    test("deleteEmail is a no-op for nonexistent email", () => {
      deleteEmail(db, "nonexistent", "acct1"); // should not throw
    });

    test("getEmailsByThread returns emails in a thread ordered by date ASC", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", date: "2025-06-01T10:00:00Z" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t1", date: "2025-06-01T11:00:00Z" }), "acct1");
      saveEmail(db, makeEmail({ id: "e3", threadId: "t2", date: "2025-06-01T12:00:00Z" }), "acct1");
      const thread = getEmailsByThread(db, "t1");
      expect(thread).toHaveLength(2);
      expect(thread[0].id).toBe("e1");
      expect(thread[1].id).toBe("e2");
    });

    test("getEmailsByThread with accountId filter", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t1" }), "acct2");
      expect(getEmailsByThread(db, "t1", "acct1")).toHaveLength(1);
    });

    test("getEmailsByThread returns empty for nonexistent thread", () => {
      expect(getEmailsByThread(db, "nonexistent")).toHaveLength(0);
    });

    test("getEmailsByIds returns requested emails", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct1");
      saveEmail(db, makeEmail({ id: "e3", threadId: "t3" }), "acct1");
      const results = getEmailsByIds(db, ["e1", "e3"]);
      expect(results).toHaveLength(2);
      const ids = results.map((r: Record<string, unknown>) => r.id);
      expect(ids).toContain("e1");
      expect(ids).toContain("e3");
    });

    test("getEmailsByIds returns empty for empty input", () => {
      expect(getEmailsByIds(db, [])).toHaveLength(0);
    });

    test("getAllEmailIds returns all ids", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct2");
      const ids = getAllEmailIds(db);
      expect(ids).toHaveLength(2);
      expect(ids).toContain("e1");
      expect(ids).toContain("e2");
    });

    test("getAllEmailIds filters by accountId", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct2");
      expect(getAllEmailIds(db, "acct1")).toEqual(["e1"]);
    });

    test("getEmailIds returns a Set", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct1");
      const ids = getEmailIds(db, "acct1");
      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(2);
      expect(ids.has("e1")).toBe(true);
    });

    test("updateEmailLabelIds updates label_ids", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", labelIds: ["INBOX"] }), "acct1");
      updateEmailLabelIds(db, "e1", ["INBOX", "STARRED"]);
      const result = getEmail(db, "e1");
      expect(JSON.parse(result.labelIds)).toEqual(["INBOX", "STARRED"]);
    });
  });

  // ===== Analysis operations =====
  test.describe("Analysis operations", () => {
    test("saveAnalysis attaches analysis to email", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveAnalysis(db, "e1", true, "Needs urgent reply");
      const result = getEmail(db, "e1");
      expect(result.needsReply).toBe(1);
      expect(result.reason).toBe("Needs urgent reply");
      expect(result.analyzedAt).toBeGreaterThan(0);
    });

    test("saveAnalysis with needsReply=false", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveAnalysis(db, "e1", false, "Newsletter");
      const result = getEmail(db, "e1");
      expect(result.needsReply).toBe(0);
    });

    test("saveAnalysis upserts on duplicate email_id", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveAnalysis(db, "e1", true, "first");
      saveAnalysis(db, "e1", false, "updated");
      const result = getEmail(db, "e1");
      expect(result.needsReply).toBe(0);
      expect(result.reason).toBe("updated");
    });

    test("getAllEmails includes analysis data when present", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2" }), "acct1");
      saveAnalysis(db, "e1", true, "Reply needed");
      const all = getAllEmails(db, "acct1");
      const analyzed = all.find((e: Record<string, unknown>) => e.id === "e1");
      const unanalyzed = all.find((e: Record<string, unknown>) => e.id === "e2");
      expect(analyzed).toBeTruthy();
      expect(unanalyzed).toBeTruthy();
      expect(analyzed!.needsReply).toBe(1);
      expect(unanalyzed!.needsReply).toBeNull();
    });
  });

  // ===== Draft operations =====
  test.describe("Draft operations", () => {
    test("saveDraft and retrieve via getEmail", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveDraft(db, "e1", "Here is my draft reply", "pending");
      const result = getEmail(db, "e1");
      expect(result.draftBody).toBe("Here is my draft reply");
      expect(result.draftStatus).toBe("pending");
    });

    test("saveDraft with cc and bcc options", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveDraft(db, "e1", "Draft with cc", "pending", undefined, {
        cc: ["cc1@example.com"],
        bcc: ["bcc1@example.com"],
      });
      const result = getEmail(db, "e1");
      expect(JSON.parse(result.draftCc)).toEqual(["cc1@example.com"]);
      expect(JSON.parse(result.draftBcc)).toEqual(["bcc1@example.com"]);
    });

    test("saveDraft upserts and preserves agent_task_id", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveDraft(db, "e1", "Original draft", "pending");
      updateDraftAgentTaskId(db, "e1", "task-123");
      saveDraft(db, "e1", "Updated draft", "edited");
      const result = getEmail(db, "e1");
      expect(result.draftBody).toBe("Updated draft");
      expect(result.agentTaskId).toBe("task-123");
    });

    test("deleteDraft removes the draft", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveDraft(db, "e1", "Draft to delete", "pending");
      deleteDraft(db, "e1");
      const result = getEmail(db, "e1");
      expect(result.draftBody).toBeNull();
    });

    test("deleteDraft is a no-op for nonexistent draft", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      deleteDraft(db, "e1"); // should not throw
    });

    test("updateDraftAgentTaskId links a task", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveDraft(db, "e1", "Draft body", "pending");
      updateDraftAgentTaskId(db, "e1", "task-456");
      expect(getEmail(db, "e1").agentTaskId).toBe("task-456");
    });

    test("saveDraft with gmailDraftId", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveDraft(db, "e1", "Draft body", "created", "gmail-draft-id-123");
      const result = getEmail(db, "e1");
      expect(result.gmailDraftId).toBe("gmail-draft-id-123");
      expect(result.draftStatus).toBe("created");
    });
  });

  // ===== Account operations =====
  test.describe("Account operations", () => {
    test("saveAccount and getAccounts", () => {
      saveAccount(db, "acct1", "user@gmail.com", "User One", true);
      const accounts = getAccounts(db);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe("acct1");
      expect(accounts[0].email).toBe("user@gmail.com");
      expect(accounts[0].displayName).toBe("User One");
      expect(accounts[0].isPrimary).toBe(true);
      expect(accounts[0].addedAt).toBeGreaterThan(0);
    });

    test("getAccounts returns empty array when no accounts", () => {
      expect(getAccounts(db)).toHaveLength(0);
    });

    test("saveAccount upserts on duplicate id", () => {
      saveAccount(db, "acct1", "old@gmail.com");
      saveAccount(db, "acct1", "new@gmail.com");
      const accounts = getAccounts(db);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].email).toBe("new@gmail.com");
    });

    test("removeAccount deletes account and all associated data", () => {
      saveAccount(db, "acct1", "user@gmail.com");
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveAnalysis(db, "e1", true, "needs reply");
      saveDraft(db, "e1", "draft body");
      saveArchiveReady(db, "t1", "acct1", true, "ready");
      removeAccount(db, "acct1");
      expect(getAccounts(db)).toHaveLength(0);
      expect(getEmail(db, "e1")).toBeUndefined();
      expect(getArchiveReadyForThread(db, "t1", "acct1")).toBeNull();
    });

    test("setPrimaryAccount updates primary status", () => {
      saveAccount(db, "acct1", "a@gmail.com", undefined, true);
      saveAccount(db, "acct2", "b@gmail.com");
      setPrimaryAccount(db, "acct2");
      const accounts = getAccounts(db);
      expect(accounts.find((a: Record<string, unknown>) => a.id === "acct1")!.isPrimary).toBe(
        false,
      );
      expect(accounts.find((a: Record<string, unknown>) => a.id === "acct2")!.isPrimary).toBe(true);
    });

    test("updateAccountDisplayName updates the display name", () => {
      saveAccount(db, "acct1", "user@gmail.com", "Old Name");
      updateAccountDisplayName(db, "acct1", "New Name");
      expect(getAccounts(db)[0].displayName).toBe("New Name");
    });
  });

  // ===== Sent email operations =====
  test.describe("Sent email operations", () => {
    test("saveSentEmail inserts into sent_emails table", () => {
      saveSentEmail(db, {
        id: "s1",
        toAddress: "friend@example.com",
        subject: "Hello",
        body: "<p>Hey!</p>",
        date: "2025-06-01",
      });
      const row = db.prepare("SELECT * FROM sent_emails WHERE id = ?").get("s1");
      expect(row).toBeTruthy();
      expect(row.subject).toBe("Hello");
    });

    test("saveSentEmail upserts on duplicate id", () => {
      saveSentEmail(db, {
        id: "s1",
        toAddress: "a@b.com",
        subject: "First",
        body: "b",
        date: "2025-01-01",
      });
      saveSentEmail(db, {
        id: "s1",
        toAddress: "a@b.com",
        subject: "Updated",
        body: "b",
        date: "2025-01-01",
      });
      const row = db.prepare("SELECT subject FROM sent_emails WHERE id = ?").get("s1") as {
        subject: string;
      };
      expect(row.subject).toBe("Updated");
    });

    test("getSentEmails returns emails with SENT label", () => {
      saveAccount(db, "acct1", "me@gmail.com");
      saveEmail(
        db,
        makeEmail({
          id: "e1",
          threadId: "t1",
          labelIds: ["SENT"],
          from: "me@gmail.com",
          to: "friend@example.com",
        }),
        "acct1",
      );
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2", labelIds: ["INBOX"] }), "acct1");
      const sent = getSentEmails(db, "acct1");
      expect(sent).toHaveLength(1);
      expect(sent[0].id).toBe("e1");
    });
  });

  // ===== Snooze operations =====
  test.describe("Snooze operations", () => {
    test("snoozeEmail and getSnoozedEmails", () => {
      const future = Date.now() + 3600000;
      snoozeEmail(db, "snz1", "e1", "t1", "acct1", future);
      const snoozed = getSnoozedEmails(db, "acct1");
      expect(snoozed).toHaveLength(1);
      expect(snoozed[0].id).toBe("snz1");
      expect(snoozed[0].emailId).toBe("e1");
      expect(snoozed[0].snoozeUntil).toBe(future);
    });

    test("unsnoozeEmail removes snooze", () => {
      snoozeEmail(db, "snz1", "e1", "t1", "acct1", Date.now() + 3600000);
      unsnoozeEmail(db, "snz1");
      expect(getSnoozedEmails(db, "acct1")).toHaveLength(0);
    });

    test("unsnoozeEmail is a no-op for nonexistent snooze", () => {
      unsnoozeEmail(db, "nonexistent"); // should not throw
    });

    test("clearSnoozedEmails removes all snoozes for account", () => {
      snoozeEmail(db, "snz1", "e1", "t1", "acct1", Date.now() + 3600000);
      snoozeEmail(db, "snz2", "e2", "t2", "acct1", Date.now() + 7200000);
      snoozeEmail(db, "snz3", "e3", "t3", "acct2", Date.now() + 3600000);
      clearSnoozedEmails(db, "acct1");
      expect(getSnoozedEmails(db, "acct1")).toHaveLength(0);
      expect(getSnoozedEmails(db, "acct2")).toHaveLength(1);
    });

    test("getSnoozedEmails returns empty for account with no snoozes", () => {
      expect(getSnoozedEmails(db, "acct1")).toHaveLength(0);
    });

    test("getSnoozedEmails orders by snooze_until ASC", () => {
      const base = Date.now();
      snoozeEmail(db, "snz2", "e2", "t2", "acct1", base + 7200000);
      snoozeEmail(db, "snz1", "e1", "t1", "acct1", base + 3600000);
      const snoozed = getSnoozedEmails(db, "acct1");
      expect(snoozed[0].snoozeUntil).toBeLessThan(snoozed[1].snoozeUntil);
    });
  });

  // ===== Scheduled message operations =====
  test.describe("Scheduled message operations", () => {
    const makeScheduledMsg = (overrides: Record<string, unknown> = {}) => ({
      id: "sm1",
      accountId: "acct1",
      type: "send",
      to: ["recipient@example.com"],
      subject: "Scheduled email",
      bodyHtml: "<p>Body</p>",
      scheduledAt: Date.now() + 3600000,
      createdAt: Date.now(),
      ...overrides,
    });

    test("insertScheduledMessage and getScheduledMessages", () => {
      insertScheduledMessage(db, makeScheduledMsg());
      const messages = getScheduledMessages(db, "acct1");
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("sm1");
      expect(messages[0].status).toBe("scheduled");
      expect(messages[0].to).toEqual(["recipient@example.com"]);
    });

    test("getDueScheduledMessages returns only due messages", () => {
      insertScheduledMessage(db, makeScheduledMsg({ id: "sm1", scheduledAt: Date.now() - 1000 }));
      insertScheduledMessage(
        db,
        makeScheduledMsg({ id: "sm2", scheduledAt: Date.now() + 9999999 }),
      );
      const due = getDueScheduledMessages(db);
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe("sm1");
    });

    test("getScheduledMessages without accountId returns all", () => {
      insertScheduledMessage(db, makeScheduledMsg({ id: "sm1", accountId: "acct1" }));
      insertScheduledMessage(db, makeScheduledMsg({ id: "sm2", accountId: "acct2" }));
      expect(getScheduledMessages(db)).toHaveLength(2);
    });

    test("updateScheduledMessageStatus to sent excludes from list", () => {
      insertScheduledMessage(db, makeScheduledMsg({ id: "sm1", scheduledAt: Date.now() - 1000 }));
      updateScheduledMessageStatus(db, "sm1", "sent");
      expect(getScheduledMessages(db, "acct1")).toHaveLength(0);
    });

    test("updateScheduledMessageStatus to failed with error", () => {
      insertScheduledMessage(db, makeScheduledMsg({ id: "sm1" }));
      updateScheduledMessageStatus(db, "sm1", "failed", "Network error");
      const row = db
        .prepare("SELECT status, error_message FROM scheduled_messages WHERE id = ?")
        .get("sm1");
      expect(row.status).toBe("failed");
      expect(row.error_message).toBe("Network error");
    });

    test("getScheduledMessageStats counts correctly", () => {
      insertScheduledMessage(db, makeScheduledMsg({ id: "sm1" }));
      insertScheduledMessage(db, makeScheduledMsg({ id: "sm2" }));
      const stats = getScheduledMessageStats(db, "acct1");
      expect(stats.scheduled).toBe(2);
      expect(stats.total).toBe(2);
    });

    test("getScheduledMessageStats returns zeros when empty", () => {
      const stats = getScheduledMessageStats(db, "acct1");
      expect(stats.scheduled).toBe(0);
      expect(stats.total).toBe(0);
    });

    test("insertScheduledMessage with cc, bcc, reply fields", () => {
      insertScheduledMessage(
        db,
        makeScheduledMsg({
          id: "sm1",
          type: "reply",
          threadId: "t1",
          cc: ["cc@example.com"],
          bcc: ["bcc@example.com"],
          inReplyTo: "<msg-id@example.com>",
          references: "<ref1@example.com>",
        }),
      );
      const msgs = getScheduledMessages(db, "acct1");
      expect(msgs[0].type).toBe("reply");
      expect(msgs[0].threadId).toBe("t1");
      expect(msgs[0].cc).toEqual(["cc@example.com"]);
      expect(msgs[0].bcc).toEqual(["bcc@example.com"]);
      expect(msgs[0].inReplyTo).toBe("<msg-id@example.com>");
      expect(msgs[0].references).toBe("<ref1@example.com>");
    });
  });

  // ===== Outbox operations =====
  test.describe("Outbox operations", () => {
    const makeOutboxItem = (overrides: Record<string, unknown> = {}) => ({
      id: "ob1",
      accountId: "acct1",
      type: "send",
      to: ["recipient@example.com"],
      subject: "Outbox email",
      bodyHtml: "<p>Outbox body</p>",
      createdAt: Date.now(),
      ...overrides,
    });

    test("insertOutboxMessage and getOutboxItem", () => {
      insertOutboxMessage(db, makeOutboxItem());
      const item = getOutboxItem(db, "ob1");
      expect(item).not.toBeNull();
      expect(item!.id).toBe("ob1");
      expect(item!.status).toBe("pending");
      expect(item!.retryCount).toBe(0);
      expect(item!.to).toEqual(["recipient@example.com"]);
    });

    test("getOutboxItem returns null for nonexistent item", () => {
      expect(getOutboxItem(db, "nonexistent")).toBeNull();
    });

    test("getOutboxItems excludes sent items", () => {
      insertOutboxMessage(db, makeOutboxItem({ id: "ob1" }));
      insertOutboxMessage(db, makeOutboxItem({ id: "ob2" }));
      updateOutboxStatus(db, "ob2", "sent");
      expect(getOutboxItems(db)).toHaveLength(1);
    });

    test("updateOutboxStatus to sent sets sent_at", () => {
      insertOutboxMessage(db, makeOutboxItem({ id: "ob1" }));
      updateOutboxStatus(db, "ob1", "sent");
      const row = db.prepare("SELECT status, sent_at FROM outbox WHERE id = ?").get("ob1");
      expect(row.status).toBe("sent");
      expect(row.sent_at).toBeGreaterThan(0);
    });

    test("updateOutboxStatus to failed with incrementRetry", () => {
      insertOutboxMessage(db, makeOutboxItem({ id: "ob1" }));
      updateOutboxStatus(db, "ob1", "failed", "Timeout", true);
      const item = getOutboxItem(db, "ob1");
      expect(item!.status).toBe("failed");
      expect(item!.errorMessage).toBe("Timeout");
      expect(item!.retryCount).toBe(1);
      updateOutboxStatus(db, "ob1", "failed", "Timeout again", true);
      expect(getOutboxItem(db, "ob1")!.retryCount).toBe(2);
    });

    test("deleteOutboxItem removes the item", () => {
      insertOutboxMessage(db, makeOutboxItem({ id: "ob1" }));
      deleteOutboxItem(db, "ob1");
      expect(getOutboxItem(db, "ob1")).toBeNull();
    });

    test("getOutboxStats counts by status", () => {
      insertOutboxMessage(db, makeOutboxItem({ id: "ob1" }));
      insertOutboxMessage(db, makeOutboxItem({ id: "ob2" }));
      updateOutboxStatus(db, "ob2", "failed", "Error");
      const stats = getOutboxStats(db);
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.total).toBe(2);
    });

    test("getOutboxStats returns zeros when empty", () => {
      const stats = getOutboxStats(db);
      expect(stats.pending).toBe(0);
      expect(stats.sending).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.total).toBe(0);
    });

    test("getPendingOutbox returns only pending items", () => {
      insertOutboxMessage(db, makeOutboxItem({ id: "ob1" }));
      insertOutboxMessage(db, makeOutboxItem({ id: "ob2" }));
      updateOutboxStatus(db, "ob2", "sending");
      const pending = getPendingOutbox(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe("ob1");
    });

    test("getPendingOutbox filters by accountId", () => {
      insertOutboxMessage(db, makeOutboxItem({ id: "ob1", accountId: "acct1" }));
      insertOutboxMessage(db, makeOutboxItem({ id: "ob2", accountId: "acct2" }));
      const pending = getPendingOutbox(db, "acct1");
      expect(pending).toHaveLength(1);
      expect(pending[0].accountId).toBe("acct1");
    });

    test("insertOutboxMessage with attachments", () => {
      insertOutboxMessage(
        db,
        makeOutboxItem({
          id: "ob1",
          attachments: [{ filename: "doc.pdf", mimeType: "application/pdf", size: 1024 }],
        }),
      );
      const item = getOutboxItem(db, "ob1");
      expect(item!.attachments).toHaveLength(1);
      expect(item!.attachments[0].filename).toBe("doc.pdf");
    });
  });

  // ===== Local draft operations =====
  test.describe("Local draft operations", () => {
    const makeLocalDraft = (overrides: Record<string, unknown> = {}) => ({
      id: "ld1",
      accountId: "acct1",
      to: ["recipient@example.com"],
      subject: "My Draft",
      bodyHtml: "<p>Draft content</p>",
      isReply: false,
      isForward: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    });

    test("saveLocalDraft and getLocalDraft", () => {
      saveLocalDraft(db, makeLocalDraft());
      const draft = getLocalDraft(db, "ld1");
      expect(draft).not.toBeNull();
      expect(draft!.id).toBe("ld1");
      expect(draft!.subject).toBe("My Draft");
      expect(draft!.to).toEqual(["recipient@example.com"]);
      expect(draft!.isReply).toBe(false);
    });

    test("getLocalDraft returns null for nonexistent draft", () => {
      expect(getLocalDraft(db, "nonexistent")).toBeNull();
    });

    test("getLocalDrafts returns drafts ordered by updatedAt DESC", () => {
      const now = Date.now();
      saveLocalDraft(db, makeLocalDraft({ id: "ld1", updatedAt: now - 1000 }));
      saveLocalDraft(db, makeLocalDraft({ id: "ld2", updatedAt: now }));
      const drafts = getLocalDrafts(db);
      expect(drafts).toHaveLength(2);
      expect(drafts[0].id).toBe("ld2");
    });

    test("getLocalDrafts filters by accountId", () => {
      saveLocalDraft(db, makeLocalDraft({ id: "ld1", accountId: "acct1" }));
      saveLocalDraft(db, makeLocalDraft({ id: "ld2", accountId: "acct2" }));
      expect(getLocalDrafts(db, "acct1")).toHaveLength(1);
    });

    test("updateLocalDraftGmailId sets gmailDraftId and syncedAt", () => {
      saveLocalDraft(db, makeLocalDraft({ id: "ld1" }));
      updateLocalDraftGmailId(db, "ld1", "gmail-id-123");
      const draft = getLocalDraft(db, "ld1");
      expect(draft!.gmailDraftId).toBe("gmail-id-123");
      expect(draft!.syncedAt).toBeGreaterThan(0);
    });

    test("deleteLocalDraft removes the draft", () => {
      saveLocalDraft(db, makeLocalDraft({ id: "ld1" }));
      deleteLocalDraft(db, "ld1");
      expect(getLocalDraft(db, "ld1")).toBeNull();
    });

    test("saveLocalDraft with reply fields", () => {
      saveLocalDraft(
        db,
        makeLocalDraft({
          id: "ld1",
          threadId: "t1",
          inReplyTo: "msg-id",
          isReply: true,
          cc: ["cc@example.com"],
          bcc: ["bcc@example.com"],
        }),
      );
      const draft = getLocalDraft(db, "ld1");
      expect(draft!.threadId).toBe("t1");
      expect(draft!.inReplyTo).toBe("msg-id");
      expect(draft!.isReply).toBe(true);
      expect(draft!.cc).toEqual(["cc@example.com"]);
      expect(draft!.bcc).toEqual(["bcc@example.com"]);
    });

    test("saveLocalDraft upserts on duplicate id", () => {
      saveLocalDraft(db, makeLocalDraft({ id: "ld1", subject: "Original" }));
      saveLocalDraft(db, makeLocalDraft({ id: "ld1", subject: "Updated" }));
      const drafts = getLocalDrafts(db);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].subject).toBe("Updated");
    });
  });

  // ===== Archive ready operations =====
  test.describe("Archive ready operations", () => {
    test("saveArchiveReady and getArchiveReadyThreads", () => {
      saveArchiveReady(db, "t1", "acct1", true, "All replies received");
      const ready = getArchiveReadyThreads(db, "acct1");
      expect(ready).toHaveLength(1);
      expect(ready[0].threadId).toBe("t1");
      expect(ready[0].isReady).toBe(true);
      expect(ready[0].reason).toBe("All replies received");
      expect(ready[0].dismissed).toBe(false);
    });

    test("getArchiveReadyForThread returns specific thread", () => {
      saveArchiveReady(db, "t1", "acct1", true, "Done");
      const result = getArchiveReadyForThread(db, "t1", "acct1");
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("t1");
    });

    test("getArchiveReadyForThread returns null for nonexistent", () => {
      expect(getArchiveReadyForThread(db, "nonexistent", "acct1")).toBeNull();
    });

    test("dismissArchiveReady hides from results", () => {
      saveArchiveReady(db, "t1", "acct1", true, "Done");
      dismissArchiveReady(db, "t1", "acct1");
      expect(getArchiveReadyThreads(db, "acct1")).toHaveLength(0);
      const row = getArchiveReadyForThread(db, "t1", "acct1");
      expect(row!.dismissed).toBe(true);
    });

    test("saveArchiveReady upserts and resets dismissed", () => {
      saveArchiveReady(db, "t1", "acct1", true, "Original");
      dismissArchiveReady(db, "t1", "acct1");
      saveArchiveReady(db, "t1", "acct1", true, "Updated reason");
      const ready = getArchiveReadyThreads(db, "acct1");
      expect(ready).toHaveLength(1);
      expect(ready[0].reason).toBe("Updated reason");
    });

    test("getArchiveReadyThreads excludes is_ready=false", () => {
      saveArchiveReady(db, "t1", "acct1", false, "Not ready");
      expect(getArchiveReadyThreads(db, "acct1")).toHaveLength(0);
    });
  });

  // ===== Memory operations =====
  test.describe("Memory operations", () => {
    const makeMemory = (overrides: Record<string, unknown> = {}) => ({
      id: "mem1",
      accountId: "acct1",
      scope: "global",
      scopeValue: null,
      content: "Always sign off with Best",
      source: "manual",
      sourceEmailId: null,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    });

    test("saveMemory and getMemory", () => {
      saveMemory(db, makeMemory());
      const memory = getMemory(db, "mem1");
      expect(memory).not.toBeNull();
      expect(memory!.id).toBe("mem1");
      expect(memory!.content).toBe("Always sign off with Best");
      expect(memory!.scope).toBe("global");
      expect(memory!.enabled).toBe(true);
    });

    test("getMemory returns null for nonexistent memory", () => {
      expect(getMemory(db, "nonexistent")).toBeNull();
    });

    test("getMemories returns memories for account", () => {
      saveMemory(db, makeMemory({ id: "mem1", accountId: "acct1" }));
      saveMemory(
        db,
        makeMemory({
          id: "mem2",
          accountId: "acct1",
          scope: "person",
          scopeValue: "boss@example.com",
        }),
      );
      saveMemory(db, makeMemory({ id: "mem3", accountId: "acct2" }));
      expect(getMemories(db, "acct1")).toHaveLength(2);
    });

    test("getMemories returns empty for account with no memories", () => {
      expect(getMemories(db, "acct1")).toHaveLength(0);
    });

    test("updateMemory updates content", () => {
      saveMemory(db, makeMemory({ id: "mem1" }));
      updateMemory(db, "mem1", { content: "Updated content" });
      expect(getMemory(db, "mem1")!.content).toBe("Updated content");
    });

    test("updateMemory toggles enabled", () => {
      saveMemory(db, makeMemory({ id: "mem1", enabled: true }));
      updateMemory(db, "mem1", { enabled: false });
      expect(getMemory(db, "mem1")!.enabled).toBe(false);
    });

    test("updateMemory updates scope", () => {
      saveMemory(db, makeMemory({ id: "mem1", scope: "global" }));
      updateMemory(db, "mem1", { scope: "person", scopeValue: "someone@example.com" });
      const memory = getMemory(db, "mem1");
      expect(memory!.scope).toBe("person");
      expect(memory!.scopeValue).toBe("someone@example.com");
    });

    test("updateMemory is a no-op for nonexistent memory", () => {
      updateMemory(db, "nonexistent", { content: "test" }); // should not throw
    });

    test("deleteMemory removes the memory", () => {
      saveMemory(db, makeMemory({ id: "mem1" }));
      deleteMemory(db, "mem1");
      expect(getMemory(db, "mem1")).toBeNull();
    });

    test("deleteMemory is a no-op for nonexistent memory", () => {
      deleteMemory(db, "nonexistent"); // should not throw
    });

    test("saveMemory with all scopes", () => {
      saveMemory(db, makeMemory({ id: "m1", scope: "global", scopeValue: null }));
      saveMemory(db, makeMemory({ id: "m2", scope: "person", scopeValue: "boss@example.com" }));
      saveMemory(db, makeMemory({ id: "m3", scope: "domain", scopeValue: "example.com" }));
      saveMemory(db, makeMemory({ id: "m4", scope: "category", scopeValue: "sales" }));
      expect(getMemory(db, "m1")!.scope).toBe("global");
      expect(getMemory(db, "m2")!.scope).toBe("person");
      expect(getMemory(db, "m3")!.scope).toBe("domain");
      expect(getMemory(db, "m4")!.scope).toBe("category");
    });

    test("saveMemory upserts on duplicate id", () => {
      saveMemory(db, makeMemory({ id: "mem1", content: "Original" }));
      saveMemory(db, makeMemory({ id: "mem1", content: "Updated" }));
      expect(getMemories(db, "acct1")).toHaveLength(1);
      expect(getMemory(db, "mem1")!.content).toBe("Updated");
    });
  });

  // ===== Labels operations =====
  test.describe("Labels operations", () => {
    test("saveLabels and getLabels", () => {
      saveLabels(db, "acct1", [
        { id: "INBOX", name: "Inbox", type: "system" },
        { id: "SENT", name: "Sent", type: "system" },
        { id: "Label_1", name: "Work", type: "user", color: "#ff0000", messageCount: 42 },
      ]);
      const labels = getLabels(db, "acct1");
      expect(labels).toHaveLength(3);
      const work = labels.find((l: Record<string, unknown>) => l.id === "Label_1");
      expect(work).toBeTruthy();
      expect(work!.name).toBe("Work");
      expect(work!.color).toBe("#ff0000");
      expect(work!.messageCount).toBe(42);
    });

    test("getLabels returns empty for unknown account", () => {
      expect(getLabels(db, "unknown")).toHaveLength(0);
    });

    test("deleteLabels removes labels for account", () => {
      saveLabels(db, "acct1", [{ id: "INBOX", name: "Inbox", type: "system" }]);
      saveLabels(db, "acct2", [{ id: "INBOX", name: "Inbox", type: "system" }]);
      deleteLabels(db, "acct1");
      expect(getLabels(db, "acct1")).toHaveLength(0);
      expect(getLabels(db, "acct2")).toHaveLength(1);
    });

    test("saveLabels upserts existing labels", () => {
      saveLabels(db, "acct1", [{ id: "Label_1", name: "Old", type: "user" }]);
      saveLabels(db, "acct1", [{ id: "Label_1", name: "New", type: "user" }]);
      const labels = getLabels(db, "acct1");
      expect(labels).toHaveLength(1);
      expect(labels[0].name).toBe("New");
    });
  });

  // ===== FTS5 search operations =====
  test.describe("FTS5 search operations", () => {
    test("searchEmails finds by subject", () => {
      saveEmail(
        db,
        makeEmail({ id: "e1", threadId: "t1", subject: "Meeting tomorrow at 3pm" }),
        "acct1",
      );
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2", subject: "Unrelated email" }), "acct1");
      const results = searchEmails(db, "Meeting");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r: Record<string, unknown>) => r.id === "e1")).toBe(true);
    });

    test("searchEmails finds by body content", () => {
      saveEmail(
        db,
        makeEmail({
          id: "e1",
          threadId: "t1",
          subject: "Hello",
          body: "<p>The quarterly report is attached</p>",
        }),
        "acct1",
      );
      const results = searchEmails(db, "quarterly report");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("e1");
    });

    test("searchEmails finds by from address via LIKE fallback", () => {
      saveEmail(
        db,
        makeEmail({ id: "e1", threadId: "t1", from: "special-sender@company.com" }),
        "acct1",
      );
      // Search by sender address directly (uses LIKE fallback since from_address column filter
      // with special characters may fail in FTS5)
      const results = searchEmails(db, "special-sender@company.com");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test("searchEmails returns empty for no match", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", subject: "Hello" }), "acct1");
      expect(searchEmails(db, "xyznonexistent")).toHaveLength(0);
    });

    test("searchEmails returns empty for empty query", () => {
      expect(searchEmails(db, "")).toHaveLength(0);
    });

    test("searchEmails respects accountId filter", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1", subject: "Project Update" }), "acct1");
      saveEmail(db, makeEmail({ id: "e2", threadId: "t2", subject: "Project Update" }), "acct2");
      const results = searchEmails(db, "Project", { accountId: "acct1" });
      expect(results.every((r: Record<string, unknown>) => r.accountId === "acct1")).toBe(true);
    });

    test("searchEmails respects limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        saveEmail(
          db,
          makeEmail({ id: `e${i}`, threadId: `t${i}`, subject: "Common keyword" }),
          "acct1",
        );
      }
      const page1 = searchEmails(db, "Common", { limit: 2, offset: 0 });
      const page2 = searchEmails(db, "Common", { limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
    });
  });

  // ===== HTML stripping and FTS query sanitization =====
  test.describe("stripHtmlForSearch", () => {
    test("strips HTML tags", () => {
      expect(stripHtmlForSearch("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
    });

    test("strips style and script blocks", () => {
      expect(stripHtmlForSearch("<style>.foo { color: red; }</style><p>content</p>")).toBe(
        "content",
      );
      expect(stripHtmlForSearch("<script>alert('hi')</script><p>content</p>")).toBe("content");
    });

    test("decodes HTML entities", () => {
      expect(stripHtmlForSearch("&amp; &lt; &gt; &quot; &#39;")).toBe("& < > \" '");
    });

    test("collapses whitespace", () => {
      expect(stripHtmlForSearch("<p>  multiple   spaces  </p>")).toBe("multiple spaces");
    });

    test("handles empty string", () => {
      expect(stripHtmlForSearch("")).toBe("");
    });
  });

  test.describe("sanitizeFtsQuery", () => {
    test("passes through simple tokens", () => {
      expect(sanitizeFtsQuery("hello world")).toBe("hello world");
    });

    test("preserves boolean operators", () => {
      expect(sanitizeFtsQuery("hello AND world")).toBe("hello AND world");
      expect(sanitizeFtsQuery("hello OR world")).toBe("hello OR world");
    });

    test("preserves already-quoted phrases", () => {
      expect(sanitizeFtsQuery('"exact phrase"')).toBe('"exact phrase"');
    });

    test("quotes tokens with special characters", () => {
      const result = sanitizeFtsQuery("hello+world");
      expect(result).toContain('"');
    });

    test("preserves column filter syntax", () => {
      expect(sanitizeFtsQuery("from_address:test")).toBe("from_address:test");
      expect(sanitizeFtsQuery("subject:meeting")).toBe("subject:meeting");
    });
  });

  // ===== Cross-table data integrity =====
  test.describe("Cross-table data integrity", () => {
    test("getEmail joins analysis and draft data", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveAnalysis(db, "e1", true, "Important");
      saveDraft(db, "e1", "Reply draft", "pending");
      const result = getEmail(db, "e1");
      expect(result.needsReply).toBe(1);
      expect(result.draftBody).toBe("Reply draft");
    });

    test("email without analysis or draft has null join fields", () => {
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      const result = getEmail(db, "e1");
      expect(result.analyzedAt).toBeNull();
      expect(result.draftBody).toBeNull();
    });

    test("removing an account cascades all related data", () => {
      saveAccount(db, "acct1", "user@gmail.com");
      saveEmail(db, makeEmail({ id: "e1", threadId: "t1" }), "acct1");
      saveAnalysis(db, "e1", true, "reply needed");
      saveDraft(db, "e1", "draft body");
      snoozeEmail(db, "snz1", "e1", "t1", "acct1", Date.now() + 3600000);
      saveArchiveReady(db, "t1", "acct1", true, "ready");
      saveMemory(db, {
        id: "mem1",
        accountId: "acct1",
        scope: "global",
        scopeValue: null,
        content: "test",
        source: "manual",
        sourceEmailId: null,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      removeAccount(db, "acct1");

      expect(getAccounts(db)).toHaveLength(0);
      expect(getEmail(db, "e1")).toBeUndefined();
      expect(getSnoozedEmails(db, "acct1")).toHaveLength(0);
      expect(getArchiveReadyThreads(db, "acct1")).toHaveLength(0);
      expect(getMemories(db, "acct1")).toHaveLength(0);
    });
  });
});
