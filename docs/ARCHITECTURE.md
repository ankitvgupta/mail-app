# Architecture

Exo is a desktop Gmail client built with Electron, React, TypeScript, and Tailwind CSS. AI features run through Claude (Anthropic SDK + Claude Agent SDK).

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                               ELECTRON APP                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────────┐     IPC Bridge      ┌────────────────────────────┐   │
│  │   RENDERER PROCESS   │◄──────────────────►│      MAIN PROCESS          │   │
│  │   (React + Zustand)  │   preload/index.ts  │                            │   │
│  │                      │                     │  IPC Handlers (ipc/*.ts)   │   │
│  │  Components:         │                     │  Services (services/*.ts)  │   │
│  │  - App.tsx           │                     │  Database (db/)            │   │
│  │  - EmailList         │                     │  Agents (agents/)          │   │
│  │  - EmailDetail       │                     │  Extensions (extensions/)  │   │
│  │  - DraftEditor       │                     │                            │   │
│  │  - SettingsPanel     │                     │  Infrastructure:           │   │
│  │  - SenderProfilePanel│                     │  - AnthropicService        │   │
│  │  - SetupWizard       │                     │  - Logger (pino)           │   │
│  │                      │                     │  - SQLite (better-sqlite3) │   │
│  │  Store:              │                     │                            │   │
│  │  - Zustand (state)   │                     │                            │   │
│  │  - React Query       │                     │                            │   │
│  │    (server state)    │                     │                            │   │
│  └──────────────────────┘                     └────────────────────────────┘   │
│                                                         │                       │
└─────────────────────────────────────────────────────────│───────────────────────┘
                                                          │
                                              ┌───────────▼──────────┐
                                              │   External Services  │
                                              │  - Gmail API (OAuth) │
                                              │  - Claude API        │
                                              │  - Google Calendar   │
                                              │  - MCP Servers       │
                                              └──────────────────────┘
```

## IPC Channel Inventory

All IPC is `ipcMain.handle` / `ipcRenderer.invoke` (request-response). The channels are namespaced by file:

| Namespace | File | Purpose |
|-----------|------|---------|
| `gmail:*` | `gmail.ipc.ts` | OAuth flow, token management, email fetch |
| `sync:*` | `sync.ipc.ts` | Multi-account sync, account CRUD, email loading |
| `analysis:*` | `analysis.ipc.ts` | Email analysis (needs-reply detection) |
| `drafts:*` | `drafts.ipc.ts` | Draft generation, refinement, pipeline |
| `settings:*` | `settings.ipc.ts` | Config, prompts, EA settings, agent config, LLM usage |
| `agent:*` | `agent.ipc.ts` | Agent chat, task management |
| `extensions:*` | `extensions.ipc.ts` | Extension panels, enrichments |
| `prefetch:*` | `prefetch.ipc.ts` | Background prefetch status, manual triggers |
| `compose:*` | `compose.ipc.ts` | Compose window, local drafts |
| `search:*` | `search.ipc.ts` | FTS5 full-text search |
| `snooze:*` | `snooze.ipc.ts` | Email snooze/unsnooze |
| `outbox:*` | `outbox.ipc.ts` | Offline send queue, network status |
| `calendar:*` | `calendar.ipc.ts` | Google Calendar sync |
| `memory:*` | `memory.ipc.ts` | Agent memories (persistent preferences) |
| `splits:*` | `splits.ipc.ts` | Inbox splits (custom views) |
| `scheduled-send:*` | `scheduled-send.ipc.ts` | Send-later scheduling |
| `archive-ready:*` | `archive-ready.ipc.ts` | Archive-readiness analysis |
| `attachments:*` | `attachments.ipc.ts` | Attachment handling |
| `updates:*` | `updates.ipc.ts` | Auto-updater |
| `onboarding:*` | `onboarding.ipc.ts` | First-run setup |

## Data Flows

### Email Sync
1. `sync:init` loads accounts from DB, creates per-account `GmailClient` instances
2. Each account: full sync if no stored emails, else incremental via Gmail History API
3. Background sync runs every 30 seconds per account
4. Emails stored with `accountId`, pushed to renderer via IPC events

### Analysis
1. PrefetchService queues unanalyzed emails after sync
2. `EmailAnalyzer.analyze()` calls Claude via `AnthropicService.createMessage()`
3. Returns `{ needs_reply, reason, priority }`, stored in `analyses` table
4. Renderer reads analysis alongside email data

### Draft Generation
1. Triggered by user ("Generate Draft") or auto-draft for high priority emails
2. `DraftGenerator` assembles context: email thread, sender profile, analysis, memories
3. If EA enabled: `CalendaringAgent` checks for scheduling, adds CC + deferral language
4. Claude generates draft, stored in `drafts` table
5. User can refine via `drafts:refine` (iterative feedback loop)

### Agent Chat
1. User opens agent chat panel, sends message
2. `AgentCoordinator` dispatches to `ClaudeAgentProvider` (Claude Agent SDK)
3. Agent has access to MCP tools: email search, draft creation, calendar lookup
4. All tool calls go through `PermissionGate` and are logged to `agent_audit_log`
5. Conversation state mirrored in `agent_conversation_mirror` table

## Database

SQLite via `better-sqlite3` with WAL mode. Schema in `src/main/db/schema.ts`.

Key tables (25+ total):
- **`emails`** — cached Gmail messages with full body, metadata, labels
- **`analyses`** — Claude analysis results per email
- **`drafts`** — generated reply drafts
- **`accounts`** — multi-inbox account records
- **`sync_state`** — per-account history IDs for incremental sync
- **`sender_profiles`** — cached web-search results for sender info
- **`llm_calls`** — every Claude API call (cost tracking, managed by AnthropicService)
- **`memories`** / **`draft_memories`** — persistent user preferences for draft generation
- **`agent_audit_log`** — agent tool call audit trail
- **`emails_fts`** — FTS5 virtual table for full-text search

Migrations: see "Infrastructure" section below.

## Extension System

Extensions are inlined at build time. No runtime filesystem scanning.

- **Bundled** (`src/extensions/mail-ext-*`): Static imports in `src/main/index.ts`, manifests parsed through `ExtensionManifestSchema`
- **Private** (`src/extensions-private/mail-ext-*`): Discovered via Vite `import.meta.glob` in `private-extensions.ts`, auto-inlined
- Extensions register panels, enrichments, and hooks via `extensionHost.registerBundledExtensionFull()`

## Agent System

The agent system uses Claude Agent SDK with MCP for tool execution.

```
src/main/agents/
├── agent-coordinator.ts     # Dispatches tasks to providers
├── orchestrator.ts          # Claude Agent SDK orchestration
├── agent-worker.ts          # Worker thread for agent execution
├── permission-gate.ts       # Tool call approval logic
├── audit-log.ts             # Writes to agent_audit_log table
├── types.ts                 # AgentContext, AgentTask interfaces
├── providers/
│   ├── registry.ts                    # Provider registry
│   ├── claude-agent-provider.ts       # Claude Agent SDK provider
│   ├── opencode/                      # OpenCode provider (local `opencode serve` + MCP bridge)
│   ├── hostler/                       # Hostler provider (hosted cloud sandbox via hostler.dev;
│   │                                  #   tools execute locally via Hostler's client-tools loop)
│   └── remote-conversation-provider.ts # Remote provider protocol
├── private-providers.ts     # import.meta.glob for private providers
├── private-providers-main.ts
└── tools/
    ├── index.ts             # Tool registry
    ├── registry.ts          # MCP tool definitions
    ├── email-tools.ts       # Email search, read, archive
    ├── context-tools.ts     # Thread context, sender info
    ├── analysis-tools.ts    # Run analysis on emails
    ├── browser-tools.ts     # Web browsing capability
    ├── sub-agent-tool.ts    # Sub-agent delegation
    └── types.ts
```

## Infrastructure

### AnthropicService (`src/main/services/anthropic-service.ts`)
All Claude API calls go through `createMessage()`. Provides:
- Exponential backoff retry on rate limits, server errors, connection errors
- Per-call cost tracking in `llm_calls` table (model-aware pricing)
- Caller attribution (which service made the call)
- Timeout support via AbortController
- Test seam: `_setClientForTesting()` replaces the SDK client

### Logger (`src/main/services/logger.ts`)
Structured logging via pino. Use `createLogger("namespace")` — never raw `console.log`.
- JSON lines to daily log files (7-day retention)
- Pretty console output in dev mode
- Redaction policy: body, subject, snippet, prompt fields are auto-redacted

### Migration System (`src/main/db/index.ts`)
Numbered migrations in `NUMBERED_MIGRATIONS` array. Each migration:
- Has a `version` number and `name`
- Runs in a transaction with version bookkeeping in `schema_version` table
- Older ad-hoc migrations (pre-numbered) still run for backward compatibility
