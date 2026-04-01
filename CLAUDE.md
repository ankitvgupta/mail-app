# How I Work
I value correctness, simplicity and first principles over empirical observations. Code that works but that I don't understand is not acceptable. If there are tradeoffs, explain them. If something is complex, explain why the complexity is necessary.

Your primary job is to be a pair programmer. I'm an experienced engineer that has worked with a wide variety of systems, but of course you have access to a lot of the world's information. you should take my guidance not as dogma, but as a starting point for discussion, and then use your own judgment to research alternatives. It is preferable to ask questions for clarity instead of taking actions that we have not agreed on yet. You should heavily use your planning abilities -- in the ideal case you will spend a ton of effort planning and iterating with clarity, and then go one-shot your execution of that plan. Once we agree on a plan you should execute tirelessly.

For complex work (migrations, multi-file refactors, architectural changes), you should always write a plan before executing. For analysis tasks, prefer specialized tools (type checkers, linters, LSP, IDE features) over grep patterns when available.

## Parallel development
- In general, I may have between 2 and 10 parallel sessions running at any given time, so you should assume that there are other agents that may be editing the codebase. You can assume that I have already created isolation using git worktrees, so you are free to edit any file you want but you have to assume that either you or other agents might run into merge conflicts when merging later.
- You should make a best effort, however, to keep this parallelism in mind when doing development. For example, if you're developing an app, you should make the .app assets have some sort of suffix (if possible) to be able to distinguish the build coming from this agent run vs the others. this is likely something from the branch name or something to that effect.
- **Branch name in app title**: When launching the app for dev (`npm run dev`), append the current git branch name to the app title so it's easy to tell which worktree build is running. The title is in `src/renderer/App.tsx` — find the `<h1>` containing "Exo" (in the titlebar div) and append a `<span>` with the branch name, e.g. `<span className="text-xs font-normal text-gray-400">[claude/my-feature]</span>`. **Remove this change before committing** — it's only for local dev visibility, not for the codebase. Note: the HTML `<title>` in `index.html` is NOT visible because the Electron window uses `titleBarStyle: "hiddenInset"`.

## Coding Standards

### Simplicity
- Reduce state, coupling, complexity and code, in that order (https://news.ycombinator.com/item?id=11042400)
- Use library features when available, be skeptical about code that you are implementing that must be solved abstractly already (e.g. it's ridiculous to write your own CSRF token handling)
- Design interfaces before implementation - think about how consuming code will use the system first

### Consistency
- Follow existing patterns in the codebase - look at similar files first
- If you want to establish a new pattern, explain why
- Only write comments that explain *why* code is written the way it was, especially when it's unintuitive

### Robustness
- Use proper APIs (URL parsing, not substring matching)
- Validate at boundaries, trust internal code - required values should fail explicitly, not silently default
- Think "error-first" with useful feedback for expected failure paths (e.g. network requests), but don't over-catch - wrapping everything in try/catch doesn't make code better

### Typescript
- NEVER use `any` in TypeScript - fix the actual type instead
- Avoid type assertions (`as`) - prefer proper typing or type guards
- Use zod schemas for runtime validation
- Use ts-pattern to match conditions

### React
- Reduce state, effects, refs whenever possible
- URL is state - prefer URLs (react-router) state over component state when relevant
- Server state belongs in react-query, not useState - let the library handle caching, loading, errors
- Derive values instead of syncing state - if you can compute it, don't store it

### Ruby/Rails
- Without type safety, simplicity matters more - keep interfaces narrow, prefer explicit arguments over instance variable soup, keep data structures as simple as possible
- Prefer explicit code over less code - when code flow is hard to trace, be more explicit
- ActiveRecord's lazy loading makes N+1s easy to introduce, always consider preloads when referencing associations
- Extract complex query conditions into named scopes for reusability

# Python
- Use type hints whenever possible
- Prefer to use standard library features over third party libraries whenever possible, though not if they add considerable complexity or performance overhead

## Testing
Don't write tests just to have tests. Think hard about which tests are valuable and only keep those. Don't make tests brittle.
For experiences that involve a interface (website, app, etc), make sure to have tests that actually use the application and test it end to end. e.g. for electron apps, you should always configure playwright to do automation.
Do not allow flaky tests. If you have 1 test that fails in a large test run, don't write it off as flakiness -- call it a failure. you should finish running all of the tests and then clearly denote to me that there was a test failure and ask for what I want to do about that.

## Pull requests
- Always write a detailed description of the changes you made
- Always include a summary of the changes you made
- Always include a list of the changes you made
- Prior to making a pull request, always run the tests and ensure they pass
- Prior to making a pull request, always run the linters and ensure they pass
- Prior to making a pull request, always run the type checker and ensure they pass
- Once a pull request has been open for a branch, you should ask me whether you should commit and push changes to that branch. After every push to a branch, include a link to the branch in the output to me so I can quickly navigate to the PR.

# Git commands
You should regularly make commits in the feature branch for major functionality you ship.
Generally i will give one git worktree one branch to work with and itll be clear.

### Updating branches
- **Never force push or rebase** to get updates from main. Instead, merge main into the branch: `git fetch origin && git merge origin/main`.
- If I ask you to "rebase" a branch, I mean merge remote main into it — not `git rebase`. Rebases require force pushes which we avoid.
- If I explicitly ask for a real rebase, verify with me first before proceeding.

### Safe (run freely without confirmation)
- Read-only: `git status`, `git log`, `git diff`, `git show`, `git branch` (listing), `git remote -v`, `git tag` (listing), `git rev-parse`, `git ls-files`, `git blame`, `git shortlog`, `git stash list`
- Local writes: `git add`, `git commit`, `git fetch`, `git checkout <branch>` / `git switch`, `git branch <name>` (creating), `git stash`, `git stash pop`, `git merge`, `git pull`

### Requires confirmation
- `git push` — makes changes visible to others; always ask first
- `git push --force` — never without explicit approval
- `git reset --hard` — never without explicit approval
- `git rebase` — never without explicit approval
- `git clean -f`, `git checkout .`, `git restore .`, `git branch -D` — destructive, always ask first
- you should not under any circumstances attempt to merge code into the main branch

## Dependencies
- **Always run `npm install` before `npm run dev`** — especially after merging branches, switching worktrees, or starting a fresh checkout. Missing dependencies cause cryptic build failures. Don't wait for the error; install proactively.

## Git worktrees
- Worktrees are new checkouts from the same repo — untracked and gitignored files (e.g. `.env`, `.env.local`, `.env.development`) are NOT present in new worktrees.
- When starting work in a new worktree, copy over any gitignored files needed from the main worktree (environment variables, local config, credentials, etc.).
- Do NOT copy `.claude/` directory contents or `CLAUDE.md` — those are tracked by git and will already be in the worktree.
- Do NOT use `git -C <path>` or `git -c` flags unnecessarily — you are already working inside the worktree, so just run git commands directly from the current directory.
- **Worktree dev setup for this project**: The main worktree is at `/Users/ankit/src/mail-app/`. To run `npm run dev` with real accounts, copy `.env` from the main worktree — it's needed at build time for `MAIN_VITE_GOOGLE_CLIENT_ID` / `MAIN_VITE_GOOGLE_CLIENT_SECRET` and `ANTHROPIC_API_KEY`. Everything else (tokens, config, splits) is shared via `~/Library/Application Support/exo/` or `.dev-data/` and does not need to be copied.

## Code reviews
- All of my repos are set up to use automatic code review software, either provided by claude or other review apps.
- After creating a PR, you should check at the 2, 5, and 10 minute marks for if the code review bots have put in a review, or any other users have. If they haven't at the 10 minute mark, alert me.
- Once the code review bots do their review, you should medodically analyze their review comments, and resolve the high priority ones. anything that is a major security issue or breaking failure should get first priority. for lower priority issues, make your best determination around whether they are critical to solve now or if they can be dealt with later. summarize your findings in a PR comment, both with what issues you chose to solve and which ones you did not.
- if I ask you to do another pass through the reviews, you should primarily look at the PR comments since the last commit you made to assess what things to fix. i may have gone in and put in manual comments.

## Bash commands
- This is absolutely critical: you should not syntax like  `2>&1 &` to run in the background because it causes unnecessary permission prompts. Instead, use the `run_in_background` parameter of the Bash tool. This leads to better process management.
- NEVER use `pkill -f "electron"` or similar broad patterns - this kills ALL Electron-based apps (VS Code, Slack, Discord, etc). To kill a specific Electron dev app, use the PID directly or a unique identifier from the command line (e.g., the specific project path).
- Do NOT chain independent commands with `;` or `&&` in a single Bash call. Permission allow-patterns (e.g. `Bash(ls:*)`) only match when the command starts with that prefix — compound commands break pattern matching and trigger unnecessary permission prompts. Instead, make separate parallel Bash tool calls for independent commands.

## SQLite
- When only reading from a SQLite database, use `sqlite3 -readonly` to open it. This is auto-approved in permissions; without `-readonly` you will be prompted.

## GitHub API
When you need to interact with GitHub (PRs, issues, checks, API calls), use the `gh` CLI. See `.claude/skills/github-cli.md` for environment-specific setup — local Mac has `gh` pre-authenticated, Claude Code on web needs `gh` installed and uses `GITHUB_TOKEN` + the `--repo` flag since remotes go through a proxy.

## Tooling
This machine is configured via the `$BOOTSTRAP` directory.

---

# Mail Client

Desktop Gmail client with AI-powered email analysis and draft generation. Built with Electron, React, TypeScript, and Tailwind CSS.

## Features

### Core Email Features
- **Multi-account Gmail support**: OAuth authentication with shared credentials, per-account tokens
- **Background sync**: Incremental sync via Gmail History API (30-second intervals)
- **Thread view**: Emails grouped by thread with expandable message details (To/From/Date)

### AI-Powered Features
- **Email analysis**: Claude detects which emails need replies with priority levels (high/medium/low)
- **Draft generation**: AI-generated reply drafts considering analysis context
- **Sender lookup**: Web search via Claude to find sender info (role, company, background) - displayed in sidebar panel
- **Draft refinement**: Iteratively improve drafts with feedback ("make this more informal")
- **Reminder detection**: Identifies Boomerang/reminder service emails and finds original sender from thread

### Executive Assistant Integration
- **Scheduling detection**: CalendaringAgent identifies emails involving scheduling
- **Auto-CC**: Automatically CC your EA on scheduling emails
- **Deferral language**: Drafts include text deferring scheduling to your assistant
- Configurable in Settings → Executive Assistant tab

### Background Prefetching
The PrefetchService automatically processes new emails:
1. Analyzes unanalyzed emails
2. Looks up sender profiles for high/medium priority emails
3. Auto-generates drafts for high priority emails (if enabled)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ELECTRON APP                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐     IPC      ┌─────────────────────────────────┐  │
│  │   RENDERER PROCESS  │◄────────────►│       MAIN PROCESS              │  │
│  │   (React + Zustand) │              │                                 │  │
│  │                     │              │  IPC Handlers:                  │  │
│  │  Components:        │              │  - gmail.ipc.ts (OAuth, fetch)  │  │
│  │  - App.tsx          │              │  - sync.ipc.ts (multi-account)  │  │
│  │  - EmailList        │              │  - analysis.ipc.ts              │  │
│  │  - EmailDetail      │              │  - drafts.ipc.ts (incl refine)  │  │
│  │  - DraftEditor      │              │  - settings.ipc.ts              │  │
│  │  - SettingsPanel    │              │                                 │  │
│  │  - SenderProfilePanel│             │  Services:                      │  │
│  │                     │              │  - gmail-client.ts              │  │
│  │  Store:             │              │  - email-sync.ts                │  │
│  │  - emails[]         │              │  - email-analyzer.ts            │  │
│  │  - accounts[]       │              │  - draft-generator.ts           │  │
│  │  - syncStatuses     │              │  - calendaring-agent.ts         │  │
│  │  - currentAccountId │              │  - sender-lookup.ts             │  │
│  │                     │              │  - prefetch-service.ts          │  │
│  └─────────────────────┘              │                                 │  │
│                                       │  Database (SQLite):             │  │
│                                       │  - emails, analyses, drafts     │  │
│                                       │  - accounts, sender_profiles    │  │
│                                       │  - sync_state, style_samples    │  │
│                                       └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                    External: Gmail API, Claude API (with web_search tool)
```

## Directory Structure

```
src/
├── main/                         # Electron main process
│   ├── index.ts                 # App entry point
│   ├── db/
│   │   ├── index.ts             # CRUD operations
│   │   └── schema.ts            # Table definitions
│   ├── ipc/
│   │   ├── gmail.ipc.ts         # OAuth, email fetch
│   │   ├── sync.ipc.ts          # Multi-account sync, account CRUD
│   │   ├── analysis.ipc.ts      # Email analysis
│   │   ├── drafts.ipc.ts        # Draft generation + refinement
│   │   └── settings.ipc.ts      # Config, prompts, EA settings
│   └── services/
│       ├── gmail-client.ts      # Gmail API wrapper
│       ├── email-sync.ts        # Background sync with History API
│       ├── email-analyzer.ts    # Claude analysis
│       ├── draft-generator.ts   # Claude draft generation
│       ├── calendaring-agent.ts # Scheduling detection
│       ├── sender-lookup.ts     # Web search for sender info
│       ├── prefetch-service.ts  # Background prefetching
│       └── style-indexer.ts     # Writing style extraction
├── renderer/
│   ├── App.tsx                  # Main app, account switching
│   ├── components/
│   │   ├── EmailList.tsx        # Thread list sidebar
│   │   ├── EmailDetail.tsx      # Email view + SenderProfilePanel
│   │   ├── DraftEditor.tsx      # Draft editing + refinement
│   │   ├── SettingsPanel.tsx    # Settings (incl EA tab)
│   │   └── SetupWizard.tsx      # OAuth setup flow
│   └── store/index.ts           # Zustand state management
├── preload/index.ts             # IPC API exposure to renderer
└── shared/types.ts              # TypeScript types + Zod schemas
```

## Key Data Flows

### Multi-Account Sync (on startup)
1. `sync:init` → load accounts from DB
2. For each account: create `GmailClient` with account-specific tokens
3. If no stored emails → full sync; else → incremental via History API
4. Emails saved with `accountId`, pushed to renderer via IPC events

### Account Switching
1. Click account → `setCurrentAccountId` in store
2. Load emails from DB via `sync:get-emails`
3. `useThreadedEmails` selector filters by `currentAccountId`
4. Trigger background sync for new emails

### Sender Lookup Flow
1. PrefetchService queues sender profile lookup for high/medium priority emails
2. Checks if email is from reminder service → finds original sender from thread
3. SenderLookup uses Claude with `web_search_20250305` tool
4. Results cached in DB with 7-day expiration
5. EmailDetail shows SenderProfilePanel in sidebar

### Draft Generation Flow
1. User clicks "Generate Draft" or auto-draft triggers for high priority
2. DraftGenerator optionally looks up sender context
3. If EA enabled: CalendaringAgent checks for scheduling → adds CC + deferral language
4. Claude generates draft with analysis context + sender context
5. Draft saved to DB, displayed in DraftEditor

### Draft Refinement Flow
1. User enters critique in DraftEditor ("make it shorter")
2. `drafts:refine` IPC → Claude refines draft based on feedback
3. Refined draft saved and displayed

## Packaging & Bundling

The packaged Electron app (`.dmg`/`.zip` via `electron-builder`) only includes `out/` and `resources/` in the asar archive — **no `src/` directory**. This has important implications:

### Extensions
All extensions (bundled and private) are inlined into the JS bundle at build time. There is **no runtime filesystem scanning** for extensions.

- **Bundled extensions** (`src/extensions/mail-ext-*`): Their `package.json` manifests are imported as JSON and parsed through `ExtensionManifestSchema` at startup. Their modules are statically imported. Both are registered via `extensionHost.registerBundledExtensionFull(manifest, module)`.
- **Private extensions** (`src/extensions-private/mail-ext-*`): Discovered at build time via Vite's `import.meta.glob` in `private-extensions.ts`. The glob inlines both the module code and `package.json` manifest data into the bundle. Same `registerBundledExtensionFull` path.
- **Adding a new extension**: If bundled, add a static import for its `package.json` and module in `src/main/index.ts`. If private, just create the directory under `extensions-private/` — the glob picks it up automatically.

### Agent Providers
Private agent providers (`src/agents-private/*/`) use the same `import.meta.glob` pattern in `private-providers.ts` and `private-providers-main.ts`. No filesystem access at runtime.

### macOS PATH
Packaged macOS apps launched from Finder/Dock get a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). The app fixes this at startup by running `zsh -ilc 'echo $PATH'` to inherit the user's shell PATH. This is needed for the Claude Agent SDK to spawn `node`.

## Configuration Paths

All config lives under `app.getPath("userData")` — `~/Library/Application Support/exo/` on macOS.

- **OAuth credentials**: `credentials.json`
- **Tokens**: `tokens.json` (default), `tokens-{accountId}.json` (others)
- **Database**: `data/exo.db`
- **App config**: `config.json` (electron-store)

**IMPORTANT:** Reading from `~/Library/Application Support/exo/` is always fine, but **never write to or modify files in that production directory without explicitly asking first**. This is real user data shared across packaged app installs. Dev runs use `.dev-data/` instead.

## Recent Bug Fixes (Jan 2025)

1. **Missing import**: `getAllEmails` not imported in `sync.ipc.ts` - second account emails wouldn't load
2. **History ID bug**: New accounts tried incremental sync instead of full sync - fixed by clearing `lastHistoryId` when no stored emails exist
3. **Sender profile panel**: Fixed to clear previous profile when switching emails

## Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm test         # Run unit + e2e + integration tests
npm run test:unit       # Run unit tests only
npm run test:e2e        # Run e2e tests only
npm run test:problematic # Run flaky/incomplete tests (not in main suite)
npx tsc --noEmit # Type check
npm run lint            # ESLint on src/
npm run format:check    # Prettier check on src/**/*.{ts,tsx}
npm run eval            # Run email analysis evals (see docs/EVALS.md)
```

## Testing Environment

### Test Script (`scripts/run-tests.sh`)
The test script handles the better-sqlite3 ABI compatibility issue automatically:
- **Unit tests**: Rebuilds better-sqlite3 for system Node, then runs unit tests
- **Integration tests**: Runs without native module dependencies
- **E2E tests**: Rebuilds better-sqlite3 for Electron, then runs with xvfb

This ensures NO tests are skipped due to ABI mismatch.

### Prerequisites
1. **Xvfb** (for headless E2E): `apt-get install xvfb`
2. **Build tools** for native module compilation: `build-essential`, `python3`

### Test Execution Order
The script runs tests in this order for correct ABI handling:
1. Unit tests (system Node ABI 127)
2. Integration tests (no native modules)
3. E2E tests (Electron ABI 132)

### Problematic Tests
Tests in `tests/problematic/` are excluded from the main test suite:
- **Flaky tests**: Timing-sensitive or have state isolation issues
- **Incomplete features**: Tests for features not fully implemented in demo mode

Run them with `npm run test:problematic` for debugging.

## Infrastructure

### AnthropicService (`src/main/services/anthropic-service.ts`)
All LLM calls go through `createMessage()`. Handles retry with exponential backoff on rate limits / server errors, records every call to `llm_calls` table for cost tracking (model-aware pricing), and supports caller attribution. For testing, use `_setClientForTesting()` to inject a mock client.

### Logger (`src/main/services/logger.ts`)
Use `createLogger("namespace")` — never raw `console.log`. Outputs JSON lines to daily log files with 7-day retention, plus pretty console output in dev. Redaction policy: email body, subject, snippet, and prompt fields are automatically redacted. Only log IDs (email_id, account_id, thread_id).

### Migrations
Add new migrations to `NUMBERED_MIGRATIONS` in `src/main/db/index.ts`. Each migration has a version number, name, and `up()` function. Migrations run in a transaction with version bookkeeping in the `schema_version` table.

### Evals
Run `npm run eval` before any prompt change. The eval harness (`tests/evals/`) runs email fixtures through the analyzer and checks for regressions against a stored baseline. Update baseline with `npm run eval -- --update-baseline`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system diagram, data flows, IPC inventory, extension/agent systems
- [Testing](docs/TESTING.md) — test framework, projects, mocking patterns, worker isolation
- [Evals](docs/EVALS.md) — eval harness, fixtures, scoring, baseline management

## Environment Variables

- `ANTHROPIC_API_KEY` - Required for Claude API
- `EXO_TEST_MODE=true` - Use mock data for testing
- `EXO_DEMO_MODE=true` - Use demo data without real API calls
