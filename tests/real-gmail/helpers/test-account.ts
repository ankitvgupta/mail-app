/**
 * Helper utilities for the real-Gmail Playwright project.
 *
 * Auth via refresh token (no interactive OAuth in tests). Reads creds
 * from .env.local. Provides Gmail client + cleanup helpers scoped to a
 * single test run via the [exo-test-{runId}] label pattern.
 *
 * Local-only. The real-gmail Playwright project is gated on
 * EXO_REAL_GMAIL_TEST=true and the project is never enabled in CI.
 */
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { OAuth2Client } from "google-auth-library";
import { google, type gmail_v1 } from "googleapis";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

// ============================================================
// .env.local loader (no dotenv dep)
// ============================================================

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(join(REPO_ROOT, ".env.local"));

// ============================================================
// Config
// ============================================================

/**
 * The test account email is read from EXOEMAILTEST_EMAIL in .env.local
 * (never committed). Falls back to an empty string if not set; consumers
 * should pingAccount() before using which will throw with a clear error.
 */
export const TEST_ACCOUNT = process.env.EXOEMAILTEST_EMAIL ?? "";
// Same loopback the seed script and main app use. We don't actually
// initiate OAuth from here (we only use the refresh token), but keep
// the constant consistent so the OAuth2Client is constructed identically.
const OAUTH_REDIRECT = "http://localhost:3847/oauth2callback";

/**
 * Check whether the env is set up enough to run real-Gmail tests.
 * Returns the reason for skipping, or null if ready.
 */
export function requiredEnvCheck(): string | null {
  if (process.env.EXO_REAL_GMAIL_TEST !== "true") {
    return "EXO_REAL_GMAIL_TEST != true — real-gmail tests gated";
  }
  const required = [
    "EXOEMAILTEST_EMAIL",
    "EXOEMAILTEST_CLIENT_ID",
    "EXOEMAILTEST_CLIENT_SECRET",
    "EXOEMAILTEST_REFRESH_TOKEN",
  ];
  for (const k of required) {
    if (!process.env[k]) return `${k} missing from .env.local`;
  }
  return null;
}

// ============================================================
// Gmail client
// ============================================================

let _gmail: gmail_v1.Gmail | null = null;

export function getGmail(): gmail_v1.Gmail {
  if (_gmail) return _gmail;
  const client = new OAuth2Client(
    process.env.EXOEMAILTEST_CLIENT_ID!,
    process.env.EXOEMAILTEST_CLIENT_SECRET!,
    OAUTH_REDIRECT,
  );
  client.setCredentials({ refresh_token: process.env.EXOEMAILTEST_REFRESH_TOKEN! });
  _gmail = google.gmail({ version: "v1", auth: client });
  return _gmail;
}

// ============================================================
// Run-id scoped labels
// ============================================================

/**
 * Each test run gets a unique [exo-test-{epoch}] label. All resources
 * the test creates (drafts, sent messages, labels) are tagged with it
 * so teardown can delete by-prefix without touching anything else.
 */
export function makeRunId(): string {
  return `exo-test-${Date.now().toString(36)}`;
}

export async function findOrCreateLabel(name: string): Promise<string> {
  const gmail = getGmail();
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

export async function deleteMessagesWithLabel(labelId: string): Promise<number> {
  const gmail = getGmail();
  let deleted = 0;
  let pageToken: string | undefined = undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: 500,
      pageToken,
    });
    const ids = (res.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length > 0) {
      await gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids } });
      deleted += ids.length;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return deleted;
}

export async function deleteLabelByName(name: string): Promise<boolean> {
  const gmail = getGmail();
  const list = await gmail.users.labels.list({ userId: "me" });
  const existing = (list.data.labels ?? []).find((l) => l.name === name);
  if (!existing?.id) return false;
  await gmail.users.labels.delete({ userId: "me", id: existing.id });
  return true;
}

// ============================================================
// Sanity check — call from beforeAll to ensure the account is reachable
// ============================================================

export async function pingAccount(): Promise<string> {
  const gmail = getGmail();
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress ?? "";
  if (email.toLowerCase() !== TEST_ACCOUNT.toLowerCase()) {
    throw new Error(
      `Auth is for ${email}, expected ${TEST_ACCOUNT}. ` +
        `Check EXOEMAILTEST_REFRESH_TOKEN in .env.local — it must be for the test account.`,
    );
  }
  return email;
}
