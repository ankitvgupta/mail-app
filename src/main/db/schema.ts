export const SCHEMA = `
-- Accounts for multi-inbox support
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  is_primary INTEGER DEFAULT 0,
  added_at INTEGER NOT NULL
);

-- Sync state for each account (for incremental sync)
CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT PRIMARY KEY,
  history_id TEXT NOT NULL,
  last_sync_at INTEGER NOT NULL
);

-- Sender profiles (cached from web search)
CREATE TABLE IF NOT EXISTS sender_profiles (
  email TEXT PRIMARY KEY,
  name TEXT,
  summary TEXT NOT NULL,
  linkedin_url TEXT,
  company TEXT,
  title TEXT,
  lookup_at INTEGER NOT NULL
);

-- Emails from Gmail
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  account_id TEXT DEFAULT 'default',
  thread_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  cc_address TEXT,
  bcc_address TEXT,
  body TEXT NOT NULL,
  body_text TEXT,
  snippet TEXT,
  date TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  label_ids TEXT,
  attachments TEXT,
  message_id TEXT,
  in_reply_to TEXT
);

-- Analysis results from Claude
CREATE TABLE IF NOT EXISTS analyses (
  email_id TEXT PRIMARY KEY REFERENCES emails(id),
  needs_reply INTEGER NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT,
  analyzed_at INTEGER NOT NULL
);

-- Generated drafts
CREATE TABLE IF NOT EXISTS drafts (
  email_id TEXT PRIMARY KEY REFERENCES emails(id),
  draft_body TEXT NOT NULL,
  gmail_draft_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  agent_task_id TEXT,
  cc TEXT,
  bcc TEXT,
  compose_mode TEXT,
  to_recipients TEXT
);

-- Sent emails for style learning
CREATE TABLE IF NOT EXISTS sent_emails (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  date TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- Style samples extracted from sent emails
CREATE TABLE IF NOT EXISTS style_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_email_id TEXT REFERENCES sent_emails(id),
  context TEXT NOT NULL,
  characteristics TEXT NOT NULL,
  sample_phrases TEXT NOT NULL
);

-- Correspondent profiles for style learning (per-recipient formality)
CREATE TABLE IF NOT EXISTS correspondent_profiles (
  email TEXT NOT NULL,
  account_id TEXT NOT NULL,
  display_name TEXT,
  email_count INTEGER NOT NULL,
  avg_word_count REAL NOT NULL,
  dominant_greeting TEXT NOT NULL,
  dominant_signoff TEXT NOT NULL,
  formality_score REAL NOT NULL,
  last_computed_at INTEGER NOT NULL,
  PRIMARY KEY (email, account_id)
);

-- Extension storage (key-value per extension)
CREATE TABLE IF NOT EXISTS extension_storage (
  extension_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (extension_id, key)
);

-- Extension enrichments (cached data per email per extension)
CREATE TABLE IF NOT EXISTS extension_enrichments (
  email_id TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  sender_email TEXT,
  PRIMARY KEY (email_id, extension_id)
);

-- Local drafts for compose (offline support)
CREATE TABLE IF NOT EXISTS local_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  gmail_draft_id TEXT,
  thread_id TEXT,
  in_reply_to TEXT,
  to_addresses TEXT NOT NULL,
  cc_addresses TEXT,
  bcc_addresses TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  is_reply INTEGER DEFAULT 0,
  is_forward INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Labels for folder/label management
CREATE TABLE IF NOT EXISTS labels (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color TEXT,
  message_count INTEGER DEFAULT 0,
  PRIMARY KEY (id, account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Snoozed emails (hidden from inbox until snooze_until time)
CREATE TABLE IF NOT EXISTS snoozed_emails (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  snooze_until INTEGER NOT NULL,
  snoozed_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Scheduled messages for send-later
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT,
  to_addresses TEXT NOT NULL,
  cc_addresses TEXT,
  bcc_addresses TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  scheduled_at INTEGER NOT NULL,
  status TEXT DEFAULT 'scheduled',
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Outbox for offline message sending
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT,
  to_addresses TEXT NOT NULL,
  cc_addresses TEXT,
  bcc_addresses TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  attachments TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Calendar events (synced from Google Calendar)
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_all_day INTEGER DEFAULT 0,
  calendar_name TEXT NOT NULL,
  calendar_color TEXT NOT NULL,
  status TEXT DEFAULT 'confirmed',
  location TEXT,
  html_link TEXT,
  PRIMARY KEY (id, account_id)
);

-- Calendar sync state (sync tokens per calendar per account)
CREATE TABLE IF NOT EXISTS calendar_sync_state (
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  sync_token TEXT,
  calendar_name TEXT,
  calendar_color TEXT,
  last_synced_at INTEGER NOT NULL,
  visible INTEGER DEFAULT 1,
  PRIMARY KEY (account_id, calendar_id)
);

-- Archive-ready analysis results (per thread)
CREATE TABLE IF NOT EXISTS archive_ready (
  thread_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  is_ready INTEGER NOT NULL,
  reason TEXT NOT NULL,
  analyzed_at INTEGER NOT NULL,
  dismissed INTEGER DEFAULT 0,
  PRIMARY KEY (thread_id, account_id)
);

-- Agent audit log (tracks all agent tool calls with redacted payloads)
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  input_json TEXT,
  output_json TEXT,
  redaction_applied INTEGER NOT NULL DEFAULT 1,
  user_approved INTEGER,
  account_id TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_task ON agent_audit_log(task_id);

-- Agent conversation mirror (syncs remote provider conversation state locally)
CREATE TABLE IF NOT EXISTS agent_conversation_mirror (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  provider_conversation_id TEXT NOT NULL,
  local_task_id TEXT,
  status TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  remote_updated_at TEXT,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, provider_conversation_id)
);

-- Index for looking up agent traces by local_task_id
CREATE INDEX IF NOT EXISTS idx_agent_conversation_mirror_task ON agent_conversation_mirror(local_task_id);

-- Agent memories (persistent preferences for draft generation and analysis)
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_value TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_email_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  memory_type TEXT NOT NULL DEFAULT 'drafting',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Draft memories (low-confidence observations, promoted after repeated confirmation)
CREATE TABLE IF NOT EXISTS draft_memories (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_value TEXT,
  content TEXT NOT NULL,
  vote_count INTEGER NOT NULL DEFAULT 1,
  source_email_ids TEXT NOT NULL DEFAULT '[]',
  sender_email TEXT,
  sender_domain TEXT,
  subject TEXT,
  email_context TEXT,
  memory_type TEXT NOT NULL DEFAULT 'drafting',
  created_at INTEGER NOT NULL,
  last_voted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draft_memories_account ON draft_memories(account_id);
CREATE INDEX IF NOT EXISTS idx_draft_memories_last_voted ON draft_memories(last_voted_at);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
CREATE INDEX IF NOT EXISTS idx_analyses_needs_reply ON analyses(needs_reply);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_sent_to_address ON sent_emails(to_address);
CREATE INDEX IF NOT EXISTS idx_sender_profiles_email ON sender_profiles(email);
CREATE INDEX IF NOT EXISTS idx_extension_enrichments_email ON extension_enrichments(email_id);
CREATE INDEX IF NOT EXISTS idx_extension_enrichments_expires ON extension_enrichments(expires_at);
CREATE INDEX IF NOT EXISTS idx_extension_enrichments_sender ON extension_enrichments(sender_email, extension_id);
CREATE INDEX IF NOT EXISTS idx_local_drafts_account ON local_drafts(account_id);
CREATE INDEX IF NOT EXISTS idx_local_drafts_updated ON local_drafts(updated_at);
CREATE INDEX IF NOT EXISTS idx_labels_account ON labels(account_id);
CREATE INDEX IF NOT EXISTS idx_snoozed_emails_account ON snoozed_emails(account_id);
CREATE INDEX IF NOT EXISTS idx_snoozed_emails_thread ON snoozed_emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_snoozed_emails_until ON snoozed_emails(snooze_until);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_account ON outbox(account_id);
CREATE INDEX IF NOT EXISTS idx_archive_ready_account ON archive_ready(account_id);
CREATE INDEX IF NOT EXISTS idx_archive_ready_ready ON archive_ready(is_ready, dismissed);
CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_messages(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_account ON scheduled_messages(account_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_messages(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_cal_events_date ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_cal_events_account ON calendar_events(account_id);
CREATE INDEX IF NOT EXISTS idx_memories_account ON memories(account_id);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_value);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails(in_reply_to);
`;

// FTS5 full-text search schema (separate because SQLite can't IF NOT EXISTS for virtual tables)
export const FTS5_SCHEMA = `
-- FTS5 virtual table for email search
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject,
  body_text,
  from_address,
  to_address,
  content='emails',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
`;

// Triggers to keep FTS in sync (created separately)
export const FTS5_TRIGGERS = `
-- Trigger for INSERT
CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, body_text, from_address, to_address)
  VALUES (new.rowid, new.subject, new.body_text, new.from_address, new.to_address);
END;

-- Trigger for DELETE
CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, body_text, from_address, to_address)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_address, old.to_address);
END;

-- Trigger for UPDATE
CREATE TRIGGER IF NOT EXISTS emails_fts_update AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, body_text, from_address, to_address)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_address, old.to_address);
  INSERT INTO emails_fts(rowid, subject, body_text, from_address, to_address)
  VALUES (new.rowid, new.subject, new.body_text, new.from_address, new.to_address);
END;
`;
