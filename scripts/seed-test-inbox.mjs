#!/usr/bin/env node
/**
 * Seed the test Gmail account (configured via EXOEMAILTEST_EMAIL in
 * .env.local) with realistic fixture emails via Gmail API
 * `users.messages.insert`. This is NOT an external send —
 * `messages.insert` places a message directly into the inbox with
 * whatever From/To/Subject headers we specify in the raw RFC 2822
 * body. No SMTP, no external traffic.
 *
 * Used as a precondition for:
 *   - Layer 9a real-Gmail smoke tests (need realistic data in the inbox)
 *   - `npm run dev` against the test account (so dev feels real)
 *
 * Idempotent: every inserted message gets a `[exo-seed]` Gmail label.
 * On a second run with no flag, if ≥ TARGET_COUNT messages already have
 * the label, the script exits 0. Pass `--reset` to delete all labeled
 * messages first and re-seed.
 *
 * One-time OAuth setup
 * --------------------
 * Before running this, you need a refresh token for the test account
 * (configured via EXOEMAILTEST_EMAIL) with the gmail.modify scope. The
 * simplest path:
 *
 *   1. In a browser signed in as the test account, visit the OAuth
 *      consent URL printed by the script when EXOEMAILTEST_REFRESH_TOKEN
 *      is missing.
 *   2. Approve the consent (you'll need the test account added as a test
 *      user on the project's OAuth consent screen).
 *   3. Paste the resulting code back into the script.
 *   4. The script prints the refresh token; save it in .env.local as
 *      EXOEMAILTEST_REFRESH_TOKEN.
 *
 * Usage:
 *   node scripts/seed-test-inbox.mjs           # idempotent seed
 *   node scripts/seed-test-inbox.mjs --reset   # delete labeled, re-seed
 *   node scripts/seed-test-inbox.mjs --dry-run # validate fixtures, no API
 */

import { createServer } from "node:http";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

import { directQuestions } from "./seed-fixtures/direct-questions.mjs";
import { newsletters } from "./seed-fixtures/newsletters.mjs";
import { scheduling } from "./seed-fixtures/scheduling.mjs";
import { withAttachments } from "./seed-fixtures/with-attachments.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env parser — keeps the script dependency-free.
 * Handles `KEY=value`, `KEY="value with spaces"`, comments, blank lines.
 * Does not handle multiline values or shell expansion (we don't need them).
 */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// .env.local takes precedence over .env (loaded first wins because we
// check `key in process.env` before setting).
loadEnvFile(join(__dirname, "..", ".env.local"));
loadEnvFile(join(__dirname, "..", ".env"));

const TEST_ACCOUNT = process.env.EXOEMAILTEST_EMAIL ?? "";
const SEED_LABEL = "exo-seed";
const TARGET_COUNT_DEFAULT = 80;
const OAUTH_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
// Match the loopback redirect the main app uses — the OAuth client in
// MAIN_VITE_GOOGLE_CLIENT_ID already whitelists this URI. Google
// deprecated the OOB ("urn:ietf:wg:oauth:2.0:oob") flow in 2022.
const OAUTH_REDIRECT_PORT = 3847;
const OAUTH_REDIRECT = `http://localhost:${OAUTH_REDIRECT_PORT}/oauth2callback`;
const ENV_LOCAL_PATH = join(__dirname, "..", ".env.local");

const args = new Set(process.argv.slice(2));
const FLAG_RESET = args.has("--reset");
const FLAG_DRY_RUN = args.has("--dry-run");

const ALL_FIXTURES = [
  ...directQuestions,
  ...newsletters,
  ...scheduling,
  ...withAttachments,
];

// ============================================================
// RFC 2822 builder
// ============================================================

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rfcDate(d) {
  return d.toUTCString();
}

/**
 * Construct an RFC 2822 message. Returns { raw: base64urlString, messageId }.
 *
 * The Message-ID we set here gets pinned to the fixture id so subsequent
 * fixtures with `inReplyTo`/`references` can stitch threads together.
 */
function buildRawMessage(fixture, indexAcrossAll, idToMessageId) {
  const to = fixture.to ?? TEST_ACCOUNT;
  const messageId = `<${fixture.id}-${Date.now()}@test-inbox.local>`;
  idToMessageId.set(fixture.id, messageId);

  // Spread dates across ~30 days, most recent fixtures get most recent dates
  const daysAgo = 30 * (1 - indexAcrossAll / ALL_FIXTURES.length);
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  const headers = [
    `From: ${fixture.from}`,
    `To: ${to}`,
    fixture.cc ? `Cc: ${fixture.cc}` : null,
    `Subject: ${fixture.subject}`,
    `Date: ${rfcDate(fixture.date ? new Date(fixture.date) : date)}`,
    `Message-ID: ${messageId}`,
    fixture.inReplyTo ? `In-Reply-To: ${idToMessageId.get(fixture.inReplyTo) ?? `<${fixture.inReplyTo}@test-inbox.local>`}` : null,
    fixture.references
      ? `References: ${fixture.references.map((r) => idToMessageId.get(r) ?? `<${r}@test-inbox.local>`).join(" ")}`
      : null,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const hasAttachments = (fixture.attachments?.length ?? 0) > 0;
  const isHtml = !!fixture.html;

  let body;
  if (hasAttachments) {
    const boundary = `----=_Part_${fixture.id}_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [];
    parts.push(
      `--${boundary}\r\n` +
        `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8\r\n` +
        `Content-Transfer-Encoding: 7bit\r\n\r\n` +
        fixture.body +
        `\r\n`,
    );
    for (const att of fixture.attachments) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n` +
          `Content-Disposition: attachment; filename="${att.filename}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n\r\n` +
          // Wrap base64 at 76 chars per RFC 2045
          att.contentBase64.match(/.{1,76}/g).join("\r\n") +
          `\r\n`,
      );
    }
    parts.push(`--${boundary}--\r\n`);
    body = parts.join("");
  } else {
    headers.push(
      `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
      "Content-Transfer-Encoding: 7bit",
    );
    body = fixture.body;
  }

  const raw = headers.join("\r\n") + "\r\n\r\n" + body;
  return { raw: base64url(raw), messageId };
}

// ============================================================
// OAuth + label helpers
// ============================================================

/**
 * Open URL in the user's default browser (best-effort).
 */
function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* ignore — we already printed the URL */
  }
}

/**
 * Run the OAuth dance via a local HTTP loopback server. Returns the
 * Google `tokens` response (access_token + refresh_token).
 *
 * Same redirect URI the main app uses, so the OAuth client doesn't
 * need any extra whitelist entries.
 */
async function runOAuthLoopback(client) {
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES,
  });

  console.log(
    `\n────────────────────────────────────────────────────────────────────\n` +
      `OAuth setup for ${TEST_ACCOUNT}\n` +
      `────────────────────────────────────────────────────────────────────\n\n` +
      `Opening your browser to the Google consent screen. If it doesn't\n` +
      `open automatically, paste this URL into a browser signed in as\n` +
      `${TEST_ACCOUNT}:\n\n  ${authUrl}\n\n` +
      `Listening on ${OAUTH_REDIRECT} — Google will redirect here with the\n` +
      `auth code as soon as you approve.\n`,
  );

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${OAUTH_REDIRECT_PORT}`);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
          res.end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
          res.end(`OAuth error: ${error}`);
          server.closeAllConnections?.();
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
          res.end("Missing authorization code");
          server.closeAllConnections?.();
          server.close();
          reject(new Error("Missing authorization code in callback"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(`<html><body style="font-family: system-ui; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;"><div style="text-align:center"><h1>✓ Test account connected</h1><p>You can close this tab and return to the terminal.</p></div></body></html>`);

        // Close the server right after responding so node can exit cleanly.
        setTimeout(() => {
          server.closeAllConnections?.();
          server.close();
        }, 100);

        const { tokens } = await client.getToken(code);
        resolve(tokens);
      } catch (err) {
        try {
          res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
          res.end("Internal error");
        } catch {
          /* response may already be sent */
        }
        server.closeAllConnections?.();
        server.close();
        reject(err);
      }
    });

    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${OAUTH_REDIRECT_PORT} is in use — another process is bound (perhaps the Exo app is running?). Quit it and try again.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(OAUTH_REDIRECT_PORT, "127.0.0.1", () => {
      openInBrowser(authUrl);
    });
  });
}

/**
 * Persist EXOEMAILTEST_REFRESH_TOKEN into .env.local in-place.
 * Replaces the existing line if present, otherwise appends. Idempotent.
 */
function persistRefreshToken(refreshToken) {
  let content = "";
  if (existsSync(ENV_LOCAL_PATH)) {
    content = readFileSync(ENV_LOCAL_PATH, "utf8");
  }
  const re = /^EXOEMAILTEST_REFRESH_TOKEN=.*$/m;
  if (re.test(content)) {
    content = content.replace(re, `EXOEMAILTEST_REFRESH_TOKEN=${refreshToken}`);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    content += `EXOEMAILTEST_REFRESH_TOKEN=${refreshToken}\n`;
  }
  writeFileSync(ENV_LOCAL_PATH, content, { mode: 0o600 });
}

async function ensureCredentials() {
  const { EXOEMAILTEST_EMAIL, EXOEMAILTEST_CLIENT_ID, EXOEMAILTEST_CLIENT_SECRET, EXOEMAILTEST_REFRESH_TOKEN } =
    process.env;

  if (!EXOEMAILTEST_EMAIL) {
    console.error(
      `\nMissing EXOEMAILTEST_EMAIL in .env.local. This is the test\n` +
        `account this script seeds. Add it alongside the other\n` +
        `EXOEMAILTEST_* vars in .env.local.\n`,
    );
    process.exit(1);
  }

  if (!EXOEMAILTEST_CLIENT_ID || !EXOEMAILTEST_CLIENT_SECRET) {
    console.error(
      `\nMissing OAuth client credentials. Set EXOEMAILTEST_CLIENT_ID and\n` +
        `EXOEMAILTEST_CLIENT_SECRET in .env.local. You can reuse the same OAuth\n` +
        `client you use for app dev (the test account just needs to be added\n` +
        `as a test user on the OAuth consent screen).\n`,
    );
    process.exit(1);
  }

  const client = new OAuth2Client(
    EXOEMAILTEST_CLIENT_ID,
    EXOEMAILTEST_CLIENT_SECRET,
    OAUTH_REDIRECT,
  );

  if (EXOEMAILTEST_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: EXOEMAILTEST_REFRESH_TOKEN });
    return client;
  }

  // Run the loopback OAuth flow.
  const tokens = await runOAuthLoopback(client);
  if (!tokens.refresh_token) {
    console.error(
      "\nGoogle returned tokens but no refresh_token. This usually means\n" +
        "you've consented to this app before with the same account. To fix:\n" +
        "  1. Visit https://myaccount.google.com/permissions\n" +
        "  2. Sign in as " + TEST_ACCOUNT + "\n" +
        "  3. Remove the Exo entry\n" +
        "  4. Re-run this script\n",
    );
    process.exit(1);
  }

  persistRefreshToken(tokens.refresh_token);
  console.log(
    `\nRefresh token persisted to .env.local. Continuing to seed the inbox...\n`,
  );
  client.setCredentials(tokens);
  return client;
}

async function findOrCreateLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: "me" });
  const existing = (list.data.labels ?? []).find((l) => l.name === name);
  if (existing?.id) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  if (!created.data.id) throw new Error(`failed to create label ${name}`);
  return created.data.id;
}

async function countLabeledMessages(gmail, labelId) {
  let count = 0;
  let pageToken = undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: 500,
      pageToken,
    });
    count += res.data.messages?.length ?? 0;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return count;
}

async function deleteLabeledMessages(gmail, labelId) {
  let deleted = 0;
  let pageToken = undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: 500,
      pageToken,
    });
    const ids = (res.data.messages ?? []).map((m) => m.id).filter(Boolean);
    if (ids.length > 0) {
      await gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids } });
      deleted += ids.length;
      console.log(`  Deleted ${deleted} messages...`);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return deleted;
}

// ============================================================
// Main
// ============================================================

function categoryOf(id) {
  if (id.startsWith("dq-")) return "direct-questions";
  if (id.startsWith("nl-")) return "newsletters";
  if (id.startsWith("sched-")) return "scheduling";
  if (id.startsWith("att-")) return "with-attachments";
  return "other";
}

async function main() {
  console.log(`Loaded ${ALL_FIXTURES.length} fixtures across categories:`);
  const byCategory = new Map();
  for (const f of ALL_FIXTURES) {
    const cat = categoryOf(f.id);
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
  }
  for (const [cat, n] of byCategory) console.log(`  - ${cat}: ${n}`);

  if (FLAG_DRY_RUN) {
    console.log("\n[dry-run] Validating fixture shapes...");
    for (const f of ALL_FIXTURES) {
      if (!f.id || !f.from || !f.subject || !f.body) {
        console.error(`  ✗ ${f.id ?? "(no id)"}: missing required field`);
        process.exit(1);
      }
    }
    console.log("  ✓ All fixtures valid.");
    console.log(`\n[dry-run] Skipping API calls. Run without --dry-run to actually seed.`);
    return;
  }

  const auth = await ensureCredentials();
  const gmail = google.gmail({ version: "v1", auth });

  console.log(`\nEnsuring label "${SEED_LABEL}" exists...`);
  const labelId = await findOrCreateLabel(gmail, SEED_LABEL);
  console.log(`  Label id: ${labelId}`);

  if (FLAG_RESET) {
    console.log(`\n--reset: deleting existing "${SEED_LABEL}" messages...`);
    const deleted = await deleteLabeledMessages(gmail, labelId);
    console.log(`  Deleted ${deleted} messages.`);
  } else {
    const existing = await countLabeledMessages(gmail, labelId);
    console.log(`\nFound ${existing} existing labeled messages.`);
    if (existing >= ALL_FIXTURES.length) {
      console.log(`  Already seeded (>= ${ALL_FIXTURES.length}). Skipping. Pass --reset to re-seed.`);
      return;
    }
  }

  console.log(`\nInserting ${ALL_FIXTURES.length} fixtures...`);
  const idToMessageId = new Map();
  let inserted = 0;
  for (let i = 0; i < ALL_FIXTURES.length; i++) {
    const fixture = ALL_FIXTURES[i];
    const { raw } = buildRawMessage(fixture, i, idToMessageId);
    try {
      await gmail.users.messages.insert({
        userId: "me",
        internalDateSource: "dateHeader",
        requestBody: { raw, labelIds: ["INBOX", "UNREAD", labelId] },
      });
      inserted++;
      if (inserted % 10 === 0 || inserted === ALL_FIXTURES.length) {
        console.log(`  ${inserted}/${ALL_FIXTURES.length}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to insert ${fixture.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDone. Inserted ${inserted}/${ALL_FIXTURES.length} fixtures.`);
  console.log(`\nNext step: open the app (npm run dev), sign in as ${TEST_ACCOUNT}, and watch the seeded emails sync in.`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
