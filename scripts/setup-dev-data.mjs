#!/usr/bin/env node
/**
 * Pre-populate .dev-data/ with the test account's OAuth state so
 * `npm run dev` boots already signed in as the test account (configured
 * via EXOEMAILTEST_EMAIL in .env.local).
 *
 * Reads .env.local for EXOEMAILTEST_CLIENT_ID / _SECRET / _REFRESH_TOKEN,
 * exchanges the refresh token for a fresh access token, and writes:
 *   .dev-data/credentials.json   — OAuth client id/secret
 *   .dev-data/tokens.json        — full tokens object (the app's default
 *                                  account uses no -accountId suffix)
 *
 * Idempotent: re-running just refreshes the access token. Doesn't
 * touch the SQLite DB — the app's startup flow handles creating the
 * account row when it sees fresh tokens.
 *
 * Run after the seed script's OAuth dance has populated .env.local.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEV_DATA = join(REPO_ROOT, ".dev-data");

function loadEnvFile(path) {
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

async function main() {
  const { EXOEMAILTEST_CLIENT_ID, EXOEMAILTEST_CLIENT_SECRET, EXOEMAILTEST_REFRESH_TOKEN } =
    process.env;

  for (const [k, v] of Object.entries({
    EXOEMAILTEST_CLIENT_ID,
    EXOEMAILTEST_CLIENT_SECRET,
    EXOEMAILTEST_REFRESH_TOKEN,
  })) {
    if (!v) {
      console.error(`FATAL: ${k} missing from .env.local. Run scripts/seed-test-inbox.mjs first.`);
      process.exit(1);
    }
  }

  mkdirSync(DEV_DATA, { recursive: true });

  // Same redirect the app uses — keeps the OAuth client config consistent
  const client = new OAuth2Client(
    EXOEMAILTEST_CLIENT_ID,
    EXOEMAILTEST_CLIENT_SECRET,
    "http://localhost:3847/oauth2callback",
  );
  client.setCredentials({ refresh_token: EXOEMAILTEST_REFRESH_TOKEN });

  console.log("Exchanging refresh token for fresh access token...");
  const { credentials } = await client.refreshAccessToken();

  // Merge: always preserve refresh_token (refreshAccessToken sometimes omits it)
  const tokens = {
    refresh_token: EXOEMAILTEST_REFRESH_TOKEN,
    ...credentials,
  };

  const tokensPath = join(DEV_DATA, "tokens.json");
  writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Wrote ${tokensPath}`);

  const credentialsPath = join(DEV_DATA, "credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      { client_id: EXOEMAILTEST_CLIENT_ID, client_secret: EXOEMAILTEST_CLIENT_SECRET },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Wrote ${credentialsPath}`);

  // Print account info as a sanity check
  const expiryDate = tokens.expiry_date ?? 0;
  const expiresIn = Math.round((expiryDate - Date.now()) / 1000 / 60);
  console.log(`\nAccess token: ${(tokens.access_token ?? "").length} chars`);
  console.log(`Refresh token: present`);
  console.log(`Expires in: ~${expiresIn} min`);
  const acct = process.env.EXOEMAILTEST_EMAIL ?? "the test account";
  console.log(`\n.dev-data/ is ready. Run \`npm run dev\` — the app should boot signed in as ${acct}.`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
