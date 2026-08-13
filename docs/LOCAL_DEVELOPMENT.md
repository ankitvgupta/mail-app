# Local Development

Everything you need to develop, test, and verify changes locally without
ever touching your real Gmail inbox. The test account — referenced
throughout this doc as `$EXOEMAILTEST_EMAIL`, the env var set in
`.env.local` and `~/src/mail-app/.env` — is the only inbox dev/tests
interact with. The literal address is not committed anywhere in this
repo; it lives only in your local `.env*` files.

## Quick start (fresh worktree)

```bash
# 1. Install dependencies
npm install

# 2. Copy env files from the main worktree
cp /Users/ankit/src/mail-app/.env .          # build-time OAuth client + ANTHROPIC_API_KEY
cp .env.local.example .env.local             # local-only test creds

# 3. Fill in .env.local
#    ANTHROPIC_API_KEY — required for evals, agentic-verify, pre-pr
#    EXOEMAILTEST_CLIENT_ID + _SECRET — copy from .env
#       (drop the MAIN_VITE_GOOGLE_ prefix)
#    EXOEMAILTEST_REFRESH_TOKEN — get via the seed script (next step)

# 4. Seed the test inbox (one-time OAuth + insert 19 fixtures)
node scripts/seed-test-inbox.mjs

# 5. Prime .dev-data/ so the app boots already signed in as the test
#    account (no setup wizard, no manual OAuth in the app UI)
node scripts/setup-dev-data.mjs

# 6. Launch dev
npm run dev
```

After step 6, the app comes up signed in as `$EXOEMAILTEST_EMAIL`
and syncs the 19 seeded fixture emails. You're developing against
real Gmail-shaped data, never your personal inbox.

## How the credential layout works

| File | What it holds | Who reads it | Source of truth |
|---|---|---|---|
| `.env` | Build-time Google OAuth client (`MAIN_VITE_GOOGLE_CLIENT_*`) + optional `ANTHROPIC_API_KEY` | `electron-vite` at build time | The main worktree, copied per checkout |
| `.env.local` | `ANTHROPIC_API_KEY`, `EXOEMAILTEST_*` (client id/secret + refresh token) | Eval / spike / seed / agentic-verify scripts | Per-worktree, never committed |
| `.dev-data/credentials.json` | OAuth client id/secret in the format the app expects | Electron at runtime | Written by `scripts/setup-dev-data.mjs` |
| `.dev-data/tokens.json` | OAuth tokens (access + refresh) for the default account | Electron at runtime | Written by `scripts/setup-dev-data.mjs` |
| `.dev-data/data/exo.db` | SQLite — accounts, emails, drafts, analyses | Electron at runtime | Populated by sync on first dev run |

`.dev-data/` is gitignored. Every worktree starts empty and rebuilds
from the OAuth refresh token in `.env.local`.

`.env.local` is gitignored. The repo never sees the test account's
refresh token. CI never sees Anthropic or Gmail credentials.

## What does what

### The dev environment

| Command | What it does | When you run it |
|---|---|---|
| `npm run dev` | Launches Electron in dev mode against `.dev-data/`. Signs in as `$EXOEMAILTEST_EMAIL` if tokens are present. | Day-to-day development. |
| `npm run dev:demo` | Launches in demo mode — mock data, no real Gmail, no API calls. | Quickly poking at UI without OAuth setup. |
| `node scripts/setup-dev-data.mjs` | Refreshes the OAuth tokens in `.dev-data/` from `.env.local` and writes credentials.json. Idempotent. | When `.dev-data/` is missing tokens, or after a token revoke/refresh. |
| `node scripts/seed-test-inbox.mjs` | Inserts 19 fixture emails into the test Gmail inbox via `users.messages.insert`. Idempotent (skips if already seeded). | First-time setup. After a Gmail wipe. Or `--reset` to re-seed cleanly. |

### Local-only AI-aware checks

These all need `ANTHROPIC_API_KEY` in `.env.local`. They cost real
money (~cents per run). Never CI.

| Command | What it does |
|---|---|
| `npm run pre-pr` | Run before opening a PR. Full eval suite + agentic verification of the diff + optional real-Gmail. Aggregates results into `.pre-pr-report.md` and injects them into the PR body. ~15 min. |
| `npm run pre-pr -- --quick` | Same but only evals affected by the diff. Agentic-verify still runs. Skips real-gmail. ~3-5 min. |
| `npm run pre-pr -- --full-sync` | Default + the real-Gmail full-sync test. Run when touching sync / OAuth / PrefetchService. |
| `npm run pre-pr -- --no-inject` | Run everything but don't touch the PR body. Useful for dry-runs. |
| `npm run eval` | Analyzer eval against committed baseline. |
| `npm run eval:features -- --feature <name>` | Run one feature eval. Features: `draft-generator`, `calendaring-agent`, `archive-ready-analyzer` (so far). |
| `npm run eval:features -- --all` | All feature evals. Reports TODO list of remaining features. |
| `npm run eval:features -- --feature <name> --update-baseline` | Capture this run's scores as the new baseline. Use after intentionally improving a prompt. |
| `npm run agentic-verify` | Launch Electron + run the diff-scoped agentic verification driver. Standalone (also runs as part of `pre-pr`). |
| `npm run agentic-explore` | Open-ended exploration mode — agent wanders the app looking for anomalies. ~$2/run. Run weekly or after big changes. |

### Hermetic checks (also run in CI)

These don't need any secrets and are fast.

| Command | What it does |
|---|---|
| `npm test` | Full Playwright suite — unit + e2e (demo mode) + integration. |
| `npm run test:unit` | Unit tests only. ~5s. |
| `npm run test:e2e` | E2E tests against the dev build in demo mode. |
| `npx playwright test --project=migrations` | Migration replay + schema symmetry. ~1s. |
| `npx playwright test --project=agentic` | Pure-logic tests for agentic-verify helpers. ~500ms. |
| `npm run test:bench` | Performance benchmarks with budget assertions. ~5s. |
| `npx tsc --noEmit` | Typecheck. |
| `npm run lint` | ESLint. |
| `npm run format:check` | Prettier dry-run. |

### Real-Gmail tests (local only)

```bash
# 9a — Tests against cached .dev-data/ (no fresh sync). Fast.
EXO_REAL_GMAIL_TEST=true npx playwright test --project=real-gmail

# 9b — Full sync from empty. Slow. Run when touching sync code.
EXO_REAL_GMAIL_TEST=true npx playwright test --project=real-gmail-full-sync
```

Both require `EXOEMAILTEST_*` creds in `.env.local`. Both target
`$EXOEMAILTEST_EMAIL` only.

### Packaged-app smoke

Catches PATH / native-module / asar bugs that dev never sees.

```bash
npm run build
npm run pack
# On macOS:
EXO_PACKAGED_BINARY="release/mac-arm64/Exo.app/Contents/MacOS/Exo" \
  npx playwright test --project=packaged
# On Linux (also what CI does):
EXO_PACKAGED_BINARY="release/linux-unpacked/exo" \
  npx playwright test --project=packaged
```

(electron-builder outputs to `release/`, per `build.directories.output` in
package.json.)

The smoke spec launches the binary with `EXO_USER_DATA_DIR` pointing at the
project-local `.packaged-test-data/`. This is critical on macOS: a
locally-built .app has the same productName as the real install, so without
the override the packaged test would read and write the user's production
data dir. Never launch a locally-built packaged binary against production
data — if you need to run it by hand, set `EXO_USER_DATA_DIR` to an absolute
scratch path.

### Soak test

Long-running memory growth detector. Default 60 min, configurable:

```bash
# Quick sanity (5 min):
EXO_SOAK_DURATION_MS=300000 EXO_SOAK_INTERVAL_MS=30000 \
  npx playwright test --project=soak

# Full run:
npx playwright test --project=soak
```

## OAuth troubleshooting

The seed script and `setup-dev-data.mjs` both use the **loopback OAuth
flow** (`http://localhost:3847/oauth2callback`) — same as the main app.
Google deprecated the older OOB flow (`urn:ietf:wg:oauth:2.0:oob`) in
October 2022; any script using it will fail with `invalid_request`.

### "Port 3847 already in use"

The Exo app is running. Quit it, then re-run the script.

### "Google didn't return a refresh_token"

You've consented to this OAuth client with the test account before.
Google only returns a refresh token on FIRST consent.

Fix:
1. Visit https://myaccount.google.com/permissions (signed in as
   `$EXOEMAILTEST_EMAIL`)
2. Find and revoke the Exo app
3. Re-run `node scripts/seed-test-inbox.mjs`

### "Access blocked: this app's request is invalid"

The test account isn't on the OAuth consent screen's test-users list.

Fix:
1. Google Cloud Console → APIs & Services → OAuth consent screen
2. Pick the project that owns your app's OAuth client
3. Test users → Add users → `$EXOEMAILTEST_EMAIL`

### "Access token expired" / sync failures

Run `node scripts/setup-dev-data.mjs` to refresh.

## Eval workflow

### Adding a new fixture to an existing feature

1. Create `tests/evals/feature-fixtures/<feature>/<id>.json` matching
   the shape (see `feature-fixtures/README.md`).
2. Run `npm run eval:features -- --feature <feature>` to see the
   initial score.
3. Iterate on the rubric until the score is stable.
4. Run with `--update-baseline` to lock it in.

### Adding a new feature

1. Create `tests/evals/features/<feature>.ts` exporting
   `async function runXxxFixture(input: unknown, fixtureId: string): Promise<string>`.
   The string is what the judge grades.
2. Register it in `tests/evals/feature-evals.ts` under `FEATURES`.
3. Create starter fixtures in `feature-fixtures/<feature>/`.
4. Run `--update-baseline` once to capture initial scores.
5. Remove from `TODO_FEATURES` in `feature-evals.ts`.

The data-dir module lazy-loads electron now (May 2026 refactor), so
new feature modules don't need any per-service surgery — they just
work outside Electron context under `tsx`.

## Agentic verification

### Interactive (Claude in this session)

If Claude is helping you build a feature, it can verify the result
itself via the `electron-devtools-testing` skill. Use it.

### Scripted (pre-PR)

`scripts/agentic-verify.mjs` is the scripted equivalent. Two modes:

- `--mode=verify-diff` — agent reads `git diff origin/main..HEAD`,
  generates a verification plan, drives the running app via the
  `chrome-devtools` MCP, captures anomalies. 40 actions, $0.50,
  10-min cap.
- `--mode=explore` — open-ended. 100 actions, $2, 10-min cap.

Output goes to `scripts/.agentic-runs/<timestamp>-<mode>.{log,md,json}`.

The agent is sandboxed: only the chrome-devtools MCP is exposed, no
file or shell access.

## Pre-PR gate

`npm run pre-pr` is the local gate that lives between you and merge.
It runs every LLM-dependent check and injects a marker block into the
PR body via `gh pr edit`:

```html
<!-- PRE-PR-REPORT-START SHA=<sha> mode=<full|quick|full-sync> -->
... aggregated report ...
<!-- PRE-PR-REPORT-END -->
```

The CI job `verify-prepr-report` checks the marker:
- Marker absent → fail (run pre-pr at least once on the PR).
- `mode=quick` → fail (final report must be from a full run; quick
  skips real-Gmail).
- Verdict != PASS → fail.
- Otherwise → pass.

The marker `SHA=` is informational only — it's NOT gated against HEAD.
One passing full run per PR is sufficient; iterate freely with
`--quick` and switch to full before requesting review or merging.

In addition to the body marker, `pre-pr` upserts a single PR comment
identified by `<!-- AGENTIC-VERIFY-COMMENT -->`. The comment carries
the phase table at the top and the full agentic-verify markdown
report inside a `<details>` block, so reviewers can see the verdict
without expanding and read the whole transcript when they want to.
Repeated runs PATCH the same comment in place — the thread stays
clean. Use `--no-comment` to skip it (the body marker / CI gate is
unaffected).

No Anthropic key, no Gmail token, no third-party API key ever lives
in CI.

## Project-wide invariants

- **Dev signs in as `$EXOEMAILTEST_EMAIL` only.** Never your real
  inbox. Years of personal email is not a development surface.
- **No LLM or Gmail credentials in CI.** Anything that calls Claude
  runs locally. Anything that touches Gmail runs locally.
- **`.dev-data/` is the test account's state.** Wiping it is safe;
  just re-run `setup-dev-data.mjs` to rebuild from the refresh token.
- **`.pre-pr-report.md` is gitignored.** It's a local artifact; the
  PR body holds the authoritative version once injected.

## Plan reference

The plan that drove all this work is at
`~/.claude/plans/enter-plan-mode-for-floofy-wolf.md`. The eng review
section captures every architectural decision and tradeoff with the
reasoning, in case you ever wonder "why did we do it this way?".
