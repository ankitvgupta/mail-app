# Agent Chat Upgrade: Multi-Session, Live Thread Context, UI Redesign

## Summary

Transform the Agent Chat from a single-session-per-email timeline into a multi-session chat interface with persistent session history, live email thread context awareness, and a polished chat UI within the existing 320px sidebar.

## Goals

1. **Multi-session**: Users can have multiple independent chat sessions per email, plus global sessions. All sessions are browsable and resumable from a session dropdown within the Agent tab.
2. **Live thread context**: The agent automatically knows which email thread the user is viewing. Thread content is injected into the conversation when the user sends a message, so the agent always has current context without manual passing.
3. **UI redesign**: Replace the flat event timeline with a proper chat interface — message bubbles, collapsed tool calls, typing indicators, and a better input area.

## Non-Goals

- Pop-out / resizable chat panel (future enhancement)
- Changes to the Agents Sidebar (left panel) — it keeps its current role
- Changes to agent providers, orchestration, or tool system
- Virtual scrolling (overkill for 320px sidebar)

---

## Design

### 1. Data Model

#### New type: `AgentSession`

```typescript
interface AgentSession {
  id: string;                              // UUID
  title: string;                           // Auto-generated from first prompt, editable
  emailId: string | null;                  // null for global sessions
  threadId: string | null;                 // thread the session was viewing at creation
  accountId: string;
  providerIds: string[];
  createdAt: number;                       // epoch ms
  updatedAt: number;                       // epoch ms, updated on every new message
  status: "active" | "completed" | "failed" | "cancelled";
  runs: Record<string, AgentProviderRun>;  // reuses existing type, keyed by providerId
}

interface AgentSessionSummary {
  id: string;
  title: string;
  status: AgentSession["status"];
  updatedAt: number;
  emailId: string | null;
}
```

#### DB table: `agent_sessions`

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  email_id TEXT,
  thread_id TEXT,
  account_id TEXT NOT NULL,
  provider_ids TEXT NOT NULL,        -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX idx_agent_sessions_account ON agent_sessions(account_id);
CREATE INDEX idx_agent_sessions_email ON agent_sessions(email_id);
CREATE INDEX idx_agent_sessions_updated ON agent_sessions(updated_at DESC);
```

The existing `agent_conversation_mirror` table continues to store event traces. Its `local_task_id` column maps to `agent_sessions.id` going forward.

#### Store changes

```typescript
// Replace
agentTasks: Record<string, AgentTaskInfo>;        // emailId → task
agentTaskIdMap: Record<string, string>;            // taskId → emailId

// With
agentSessions: Record<string, AgentSession>;       // sessionId → session
activeSessionId: string | null;                     // currently displayed session
sessionList: AgentSessionSummary[];                 // for the dropdown, sorted by updatedAt desc

// Keep (backward compat during migration)
agentTaskHistory: AgentTaskHistoryEntry[];
```

#### Session title generation

Auto-generated from the first user prompt:
- Truncate to ~40 chars at a word boundary
- Append "..." if truncated
- User can rename via the session dropdown (click on title → inline edit)

### 2. Live Thread Context

#### Mechanism

The renderer watches `selectedEmailId` and `selectedThreadId` in the Zustand store. When the user sends a message in an agent session:

1. Fetch all messages in the currently viewed thread via `sync:get-thread-emails` IPC (existing)
2. Build a structured context block:
   ```
   [Currently viewing thread: "Re: Q2 Planning"]
   From: alice@example.com, 3 messages in thread
   ---
   [1] From: alice@example.com | Apr 1, 2026
   Hey, can we meet Thursday to discuss Q2?

   [2] From: you | Apr 1, 2026
   Sure, what time works?

   [3] From: alice@example.com | Apr 2, 2026
   How about 2pm?
   ```
3. Prepend this context block to the user's message as a system context section
4. The context is **lazy** — only fetched when the user actually sends a message, not on every navigation
5. If the thread hasn't changed since the last message, skip re-injection to avoid redundancy

#### Context change indicator

When the viewed thread changes while a session is active, show a subtle indicator in the chat:
- A small divider line: `· Viewing: "New Subject…" ·`
- This is purely visual — the actual context injection happens on next message send

#### AgentContext changes

Add to the existing `AgentContext` type:

```typescript
interface AgentContext {
  // ... existing fields ...
  currentThreadMessages?: ThreadContextMessage[];  // full thread for context injection
}

interface ThreadContextMessage {
  from: string;
  date: string;
  body: string;       // plain text, stripped HTML
  isFromUser: boolean;
}
```

### 3. Chat UI Redesign

#### Layout

```
┌──────────────────────────┐
│ ▾ "Draft reply to Ali…"  │  Session dropdown
│   + New Chat              │
├──────────────────────────┤
│                          │
│  ┌────────────────────┐  │  Agent bubble (left, gray bg)
│  │ I'll draft a reply │  │
│  │ to Alice's email.  │  │
│  │ ▸ Used 2 tools     │  │  Collapsed tool summary
│  └────────────────────┘  │
│                          │
│         ┌────────────┐   │  User bubble (right, accent bg)
│         │ Make it    │   │
│         │ shorter    │   │
│         └────────────┘   │
│                          │
│  ┌────────────────────┐  │
│  │ Here's a shorter   │  │
│  │ version: …         │  │
│  └────────────────────┘  │
│                          │
│  · Viewing: "Q2 Plan…" · │  Context change indicator
│                          │
├──────────────────────────┤
│ 📎 Re: Q2 Planning       │  Current thread bar
├──────────────────────────┤
│ [Ask about this thread…] │  Input textarea
│                   [↑]    │  Send button
└──────────────────────────┘
```

#### Component breakdown

**SessionDropdown** — New component at top of Agent tab:
- Shows current session title (truncated with ellipsis)
- Click to expand dropdown listing all sessions for current account
- Sessions grouped: "Active" (running/active status) then "Recent" (completed/failed/cancelled)
- Each item shows: title, relative timestamp, status dot (green=active, gray=completed, red=failed)
- "New Chat" button at top of dropdown
- Click session to switch `activeSessionId`
- Click title text to rename inline

**ChatMessage** — New component replacing inline event rendering:
- Two variants: `user` (right-aligned, accent background) and `agent` (left-aligned, gray background)
- Agent messages render markdown (reuse existing markdown rendering)
- Streaming text shows with a blinking cursor

**CollapsedToolCalls** — New component for tool call groups:
- Between agent text segments, consecutive tool calls collapse into "▸ Used N tools"
- Click to expand and show tool name, input summary, result summary
- Errors and confirmation requests remain always-visible (not collapsed)
- Pending confirmations show inline approve/deny buttons as before

**ContextIndicator** — Small divider component:
- Shows when the viewed thread changes: `· Viewing: "Subject…" ·`
- Muted text, centered, small font

**ThreadBar** — Above the input area:
- Shows the currently viewed thread subject (or "No thread selected")
- Small paperclip icon prefix
- Truncated with ellipsis
- Clicking scrolls to / selects that email in the email list

**ChatInput** — Improved input area:
- Multi-line textarea (min 1 row, max 4 rows, auto-grows)
- Placeholder: "Ask about this thread…" (when thread selected) or "Start a conversation…" (no thread)
- Cmd+Enter to send (primary), Enter for newline
- Send button (arrow up icon) appears when input is non-empty
- Disabled state with "Thinking…" while agent is responding

**TypingIndicator** — Replaces status bar:
- Three-dot animation in an agent-style bubble at the bottom of the message list
- Shows while agent is processing (between first event and done/error)

#### Styling

- Message bubbles: rounded corners (12px), padding 8px 12px
- User bubbles: `bg-blue-500 text-white` (or app accent color)
- Agent bubbles: `bg-gray-100 text-gray-900` (light mode), `bg-gray-800 text-gray-100` (dark mode)
- Tool call collapsed line: `text-xs text-gray-500`, monospace icon
- Session dropdown: standard dropdown styling, max-height 300px with scroll
- All existing Tailwind CSS patterns in the codebase

### 4. Session Lifecycle

#### Creating a session

1. User types in the chat input and presses send (no command palette needed for basic usage)
2. If no active session for this context → create new `AgentSession` with auto-generated title
3. If active session exists → append as follow-up message
4. Command palette still works for structured actions — creates a session the same way

#### Switching sessions

1. Click session in dropdown → set `activeSessionId`
2. Load events from `agent_conversation_mirror` if not already in memory
3. Display the session's chat history
4. Input placeholder updates based on session's email context vs current view

#### Resuming sessions

1. Sessions with status "active" or "completed" can receive follow-up messages
2. On follow-up, the session's `updatedAt` is bumped
3. If status was "completed", it transitions back to "active"
4. Thread context is re-injected based on the **currently viewed** thread (not the original)

#### Session cleanup

- No auto-deletion — sessions persist until manually cleared
- Future: add a "Clear all sessions" option in Agents Sidebar settings

### 5. Migration

On first launch after upgrade:

1. Migration reads all rows from `agent_conversation_mirror`
2. For each unique `local_task_id`, creates an `agent_sessions` row:
   - `id` = existing `local_task_id`
   - `title` = first user message text (truncated) or "Untitled session"
   - `email_id`, `thread_id`, `account_id` = extracted from stored events context
   - `provider_ids` = from `provider_id` column
   - `status` = "completed" (all migrated sessions are historical)
   - Timestamps from existing data
3. No data loss — event traces remain in `agent_conversation_mirror` unchanged

### 6. IPC Changes

**New handlers:**
- `agent:list-sessions` — returns `AgentSessionSummary[]` for current account, sorted by `updatedAt` desc, limit 50
- `agent:get-session` — returns full `AgentSession` by ID
- `agent:rename-session` — updates session title
- `agent:delete-session` — deletes session and its traces

**Modified handlers:**
- `agent:run` — accepts `sessionId` parameter. If provided, appends to existing session. If not, creates new session and returns its ID.
- `agent:get-trace` — works with session IDs (backward compatible since old task IDs become session IDs)

**New events:**
- `agent:session-updated` — broadcast when session status/title changes

### 7. Testing Strategy

- **Unit tests**: Session CRUD in DB, title generation, context block building, migration logic
- **E2E tests**: Create session → send message → switch thread → send follow-up (verify context injection) → switch sessions → verify history loads
- **Integration tests**: IPC round-trip for session lifecycle

---

## File Impact

| File | Change |
|------|--------|
| `src/shared/agent-types.ts` | Add `AgentSession`, `AgentSessionSummary`, `ThreadContextMessage` types |
| `src/main/db/schema.ts` | Add `agent_sessions` table |
| `src/main/db/index.ts` | Add migration, session CRUD functions |
| `src/main/ipc/agent.ipc.ts` | Add session IPC handlers, modify `agent:run` |
| `src/main/agents/agent-coordinator.ts` | Session creation/update on task lifecycle |
| `src/preload/index.ts` | Expose new session IPC methods |
| `src/renderer/store/index.ts` | Replace task state with session state |
| `src/renderer/components/AgentPanel.tsx` | Full rewrite → chat UI with message bubbles |
| `src/renderer/components/AgentPanel/SessionDropdown.tsx` | New component |
| `src/renderer/components/AgentPanel/ChatMessage.tsx` | New component |
| `src/renderer/components/AgentPanel/CollapsedToolCalls.tsx` | New component |
| `src/renderer/components/AgentPanel/ChatInput.tsx` | New component |
| `src/renderer/components/AgentPanel/ContextIndicator.tsx` | New component |
| `src/renderer/components/AgentPanel/ThreadBar.tsx` | New component |
| `src/renderer/components/AgentCommandPalette.tsx` | Use session-based flow |
| `src/renderer/components/EmailPreviewSidebar.tsx` | Update to use session state |
| `src/renderer/components/AgentsSidebar.tsx` | Minor: pull history from sessions |
