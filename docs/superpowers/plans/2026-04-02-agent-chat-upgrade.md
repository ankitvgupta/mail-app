# Agent Chat Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Agent Chat from a single-session-per-email timeline into a multi-session chat with persistent history, live thread context, and a polished chat UI.

**Architecture:** Add an `agent_sessions` DB table to persist sessions independently of emails. Replace the flat event timeline with a chat-bubble UI composed of small focused components under `AgentPanel/`. The renderer watches `selectedEmailId` changes and lazily injects thread context into agent messages.

**Tech Stack:** Electron, React, TypeScript, Zustand, Tailwind CSS, better-sqlite3, Playwright (tests)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/shared/agent-types.ts` | Add `AgentSession`, `AgentSessionSummary`, `ThreadContextMessage` types |
| `src/main/db/schema.ts` | Add `agent_sessions` table DDL |
| `src/main/db/index.ts` | Migration v2 + session CRUD functions |
| `src/main/ipc/agent.ipc.ts` | New session IPC handlers, modify `agent:run` |
| `src/main/agents/agent-coordinator.ts` | Session creation/update on task lifecycle |
| `src/preload/index.ts` | Expose new session IPC methods + `getThreadEmails` |
| `src/renderer/store/index.ts` | Replace task state with session state, add context tracking |
| `src/renderer/components/AgentPanel.tsx` | Slim down to barrel export + `AgentTabContent` shell |
| `src/renderer/components/AgentPanel/SessionDropdown.tsx` | Session list dropdown |
| `src/renderer/components/AgentPanel/ChatMessage.tsx` | User/agent message bubbles |
| `src/renderer/components/AgentPanel/CollapsedToolCalls.tsx` | Foldable tool call groups |
| `src/renderer/components/AgentPanel/ChatInput.tsx` | Multi-line input with send button |
| `src/renderer/components/AgentPanel/ThreadBar.tsx` | Current thread indicator |
| `src/renderer/components/AgentPanel/TypingIndicator.tsx` | Animated dots while agent runs |
| `src/renderer/components/AgentPanel/index.ts` | Barrel exports |
| `src/renderer/components/AgentCommandPalette.tsx` | Use session-based flow |
| `src/renderer/components/EmailPreviewSidebar.tsx` | Update to use session state |
| `src/renderer/components/AgentsSidebar.tsx` | Pull history from sessions |
| `tests/unit/agent-sessions-db.spec.ts` | DB CRUD + migration tests |
| `tests/unit/agent-chat-ui.spec.ts` | Component rendering tests |

---

### Task 1: Add Types to `agent-types.ts`

**Files:**
- Modify: `src/shared/agent-types.ts`

- [ ] **Step 1: Add `AgentSession` type**

At the end of `src/shared/agent-types.ts`, add:

```typescript
/** A persistent agent chat session, decoupled from email lifecycle */
export interface AgentSession {
  id: string;
  title: string;
  emailId: string | null;
  threadId: string | null;
  accountId: string;
  providerIds: string[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "completed" | "failed" | "cancelled";
  runs: Record<string, AgentProviderRun>;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  status: AgentSession["status"];
  updatedAt: number;
  emailId: string | null;
}

/** Plain-text representation of one message in a thread, for agent context injection */
export interface ThreadContextMessage {
  from: string;
  date: string;
  body: string;
  isFromUser: boolean;
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (new types are additive, no consumers yet)

- [ ] **Step 3: Commit**

```bash
git add src/shared/agent-types.ts
git commit -m "feat(agent): add AgentSession, AgentSessionSummary, ThreadContextMessage types"
```

---

### Task 2: Add `agent_sessions` DB Table & Migration

**Files:**
- Modify: `src/main/db/schema.ts`
- Modify: `src/main/db/index.ts`
- Create: `tests/unit/agent-sessions-db.spec.ts`

- [ ] **Step 1: Write the failing test for session CRUD**

Create `tests/unit/agent-sessions-db.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

/**
 * These tests create an in-memory SQLite DB, run the schema + migrations,
 * then exercise the session CRUD functions. We import the functions directly
 * from the db module after initializing with the test DB.
 */

// We'll test the raw SQL since the db module requires electron app paths.
// This validates the schema and migration SQL are correct.

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

const AGENT_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    email_id TEXT,
    thread_id TEXT,
    account_id TEXT NOT NULL,
    provider_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_account ON agent_sessions(account_id);
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_email ON agent_sessions(email_id);
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);
`;

test.describe("agent_sessions table", () => {
  test("creates table and inserts/reads sessions", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);

    const now = Date.now();
    db.prepare(`
      INSERT INTO agent_sessions (id, title, email_id, thread_id, account_id, provider_ids, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("sess-1", "Draft reply", "email-1", "thread-1", "acct-1", '["claude"]', now, now, "active");

    const row = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get("sess-1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.title).toBe("Draft reply");
    expect(row.email_id).toBe("email-1");
    expect(row.status).toBe("active");
    expect(JSON.parse(row.provider_ids as string)).toEqual(["claude"]);
  });

  test("lists sessions ordered by updated_at desc", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);

    const now = Date.now();
    db.prepare(`
      INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-old", "Old", "acct-1", '["claude"]', now - 2000, now - 2000, "completed");
    db.prepare(`
      INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-new", "New", "acct-1", '["claude"]', now, now, "active");

    const rows = db.prepare(
      "SELECT id FROM agent_sessions WHERE account_id = ? ORDER BY updated_at DESC"
    ).all("acct-1") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["sess-new", "sess-old"]);
  });

  test("updates session status and updated_at", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);

    const now = Date.now();
    db.prepare(`
      INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-1", "Test", "acct-1", '["claude"]', now, now, "active");

    const later = now + 5000;
    db.prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run("completed", later, "sess-1");

    const row = db.prepare("SELECT status, updated_at FROM agent_sessions WHERE id = ?")
      .get("sess-1") as { status: string; updated_at: number };
    expect(row.status).toBe("completed");
    expect(row.updated_at).toBe(later);
  });

  test("deletes session", () => {
    const db = createTestDb();
    db.exec(AGENT_SESSIONS_DDL);

    const now = Date.now();
    db.prepare(`
      INSERT INTO agent_sessions (id, title, account_id, provider_ids, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-1", "Delete me", "acct-1", '["claude"]', now, now, "active");

    db.prepare("DELETE FROM agent_sessions WHERE id = ?").run("sess-1");
    const row = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get("sess-1");
    expect(row).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (schema DDL is self-contained in test)**

Run: `npm run test:unit -- --grep "agent_sessions table"`
Expected: PASS (4 tests)

- [ ] **Step 3: Add table DDL to `schema.ts`**

In `src/main/db/schema.ts`, add after the `memories` table definition:

```typescript
// Agent chat sessions — persistent multi-session support
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  email_id TEXT,
  thread_id TEXT,
  account_id TEXT NOT NULL,
  provider_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_account ON agent_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_email ON agent_sessions(email_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);
```

- [ ] **Step 4: Add migration v2 to `index.ts`**

In `src/main/db/index.ts`, add to `NUMBERED_MIGRATIONS` array after version 1:

```typescript
{
  version: 2,
  name: "add_agent_sessions_table",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        email_id TEXT,
        thread_id TEXT,
        account_id TEXT NOT NULL,
        provider_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_account ON agent_sessions(account_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_email ON agent_sessions(email_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);
    `);

    // Migrate existing traces to sessions
    const traces = db.prepare("SELECT * FROM agent_conversation_mirror").all() as Array<{
      local_task_id: string;
      provider_id: string;
      messages_json: string;
      created_at: string;
      updated_at: string;
    }>;

    const insertSession = db.prepare(`
      INSERT OR IGNORE INTO agent_sessions (id, title, email_id, thread_id, account_id, provider_ids, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const trace of traces) {
      if (!trace.local_task_id) continue;
      // Extract title from first user_message event
      let title = "Untitled session";
      try {
        const events = JSON.parse(trace.messages_json) as Array<{ type: string; text?: string }>;
        const firstUserMsg = events.find((e) => e.type === "user_message");
        if (firstUserMsg?.text) {
          title = firstUserMsg.text.length > 40
            ? firstUserMsg.text.slice(0, 40).replace(/\s+\S*$/, "") + "..."
            : firstUserMsg.text;
        }
      } catch { /* ignore parse errors */ }

      const createdAt = new Date(trace.created_at).getTime() || Date.now();
      const updatedAt = new Date(trace.updated_at).getTime() || Date.now();

      insertSession.run(
        trace.local_task_id,
        title,
        null,  // email_id not stored in mirror table
        null,  // thread_id not stored in mirror table
        "",    // account_id not stored in mirror table
        JSON.stringify([trace.provider_id]),
        createdAt,
        updatedAt,
        "completed"
      );
    }
  },
},
```

- [ ] **Step 5: Add session CRUD functions to `index.ts`**

Add these functions to `src/main/db/index.ts` near the other agent-related functions:

```typescript
// ---------------------------------------------------------------------------
// Agent Sessions
// ---------------------------------------------------------------------------

export interface AgentSessionRow {
  id: string;
  title: string;
  email_id: string | null;
  thread_id: string | null;
  account_id: string;
  provider_ids: string;  // JSON array
  created_at: number;
  updated_at: number;
  status: string;
}

export function saveAgentSession(session: AgentSessionRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO agent_sessions
       (id, title, email_id, thread_id, account_id, provider_ids, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      session.id,
      session.title,
      session.email_id,
      session.thread_id,
      session.account_id,
      session.provider_ids,
      session.created_at,
      session.updated_at,
      session.status
    );
}

export function getAgentSession(sessionId: string): AgentSessionRow | null {
  return (
    getDb()
      .prepare("SELECT * FROM agent_sessions WHERE id = ?")
      .get(sessionId) as AgentSessionRow | undefined
  ) ?? null;
}

export function listAgentSessions(accountId: string, limit = 50): AgentSessionRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM agent_sessions WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?"
    )
    .all(accountId, limit) as AgentSessionRow[];
}

export function listAgentSessionsForEmail(emailId: string): AgentSessionRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM agent_sessions WHERE email_id = ? ORDER BY updated_at DESC"
    )
    .all(emailId) as AgentSessionRow[];
}

export function updateAgentSessionStatus(
  sessionId: string,
  status: string,
  updatedAt = Date.now()
): void {
  getDb()
    .prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, updatedAt, sessionId);
}

export function updateAgentSessionTitle(sessionId: string, title: string): void {
  getDb()
    .prepare("UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, Date.now(), sessionId);
}

export function deleteAgentSession(sessionId: string): void {
  getDb().prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId);
  // Also clean up associated traces
  getDb()
    .prepare("DELETE FROM agent_conversation_mirror WHERE local_task_id = ?")
    .run(sessionId);
}
```

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/db/schema.ts src/main/db/index.ts tests/unit/agent-sessions-db.spec.ts
git commit -m "feat(agent): add agent_sessions table, migration v2, CRUD functions"
```

---

### Task 3: Add Session IPC Handlers

**Files:**
- Modify: `src/main/ipc/agent.ipc.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add session IPC handlers to `agent.ipc.ts`**

Import the new DB functions at the top of `src/main/ipc/agent.ipc.ts`:

```typescript
import {
  // ... existing imports ...
  saveAgentSession,
  getAgentSession,
  listAgentSessions,
  listAgentSessionsForEmail,
  updateAgentSessionStatus,
  updateAgentSessionTitle,
  deleteAgentSession,
  type AgentSessionRow,
} from "../db";
```

Add these handlers inside `registerAgentIpc()`, after the existing handlers:

```typescript
ipcMain.handle(
  "agent:list-sessions",
  async (_, { accountId, emailId }: { accountId: string; emailId?: string }) => {
    try {
      const rows = emailId
        ? listAgentSessionsForEmail(emailId)
        : listAgentSessions(accountId);
      const summaries = rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        updatedAt: r.updated_at,
        emailId: r.email_id,
      }));
      return { success: true, data: summaries };
    } catch (err) {
      log.error({ err }, "Failed to list agent sessions");
      return { success: false, error: String(err) };
    }
  }
);

ipcMain.handle(
  "agent:get-session",
  async (_, { sessionId }: { sessionId: string }) => {
    try {
      const row = getAgentSession(sessionId);
      if (!row) return { success: false, error: "Session not found" };
      return {
        success: true,
        data: {
          id: row.id,
          title: row.title,
          emailId: row.email_id,
          threadId: row.thread_id,
          accountId: row.account_id,
          providerIds: JSON.parse(row.provider_ids),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          status: row.status,
        },
      };
    } catch (err) {
      log.error({ err }, "Failed to get agent session");
      return { success: false, error: String(err) };
    }
  }
);

ipcMain.handle(
  "agent:rename-session",
  async (_, { sessionId, title }: { sessionId: string; title: string }) => {
    try {
      updateAgentSessionTitle(sessionId, title);
      return { success: true, data: null };
    } catch (err) {
      log.error({ err }, "Failed to rename agent session");
      return { success: false, error: String(err) };
    }
  }
);

ipcMain.handle(
  "agent:delete-session",
  async (_, { sessionId }: { sessionId: string }) => {
    try {
      deleteAgentSession(sessionId);
      return { success: true, data: null };
    } catch (err) {
      log.error({ err }, "Failed to delete agent session");
      return { success: false, error: String(err) };
    }
  }
);
```

- [ ] **Step 2: Expose in preload bridge**

In `src/preload/index.ts`, add to the `agent` object (inside the `contextBridge.exposeInMainWorld` call, after the existing agent methods):

```typescript
listSessions(accountId: string, emailId?: string): Promise<{ success: boolean; data?: AgentSessionSummary[]; error?: string }> {
  return ipcRenderer.invoke("agent:list-sessions", { accountId, emailId });
},
getSession(sessionId: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return ipcRenderer.invoke("agent:get-session", { sessionId });
},
renameSession(sessionId: string, title: string): Promise<{ success: boolean; error?: string }> {
  return ipcRenderer.invoke("agent:rename-session", { sessionId, title });
},
deleteSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
  return ipcRenderer.invoke("agent:delete-session", { sessionId });
},
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/agent.ipc.ts src/preload/index.ts
git commit -m "feat(agent): add session IPC handlers and preload bridge"
```

---

### Task 4: Update Agent Coordinator for Session Lifecycle

**Files:**
- Modify: `src/main/agents/agent-coordinator.ts`

- [ ] **Step 1: Import session DB functions**

Add imports at top of `src/main/agents/agent-coordinator.ts`:

```typescript
import {
  saveAgentSession,
  updateAgentSessionStatus,
  type AgentSessionRow,
} from "../db";
```

- [ ] **Step 2: Create session on `runAgent()` call**

In the `runAgent()` method, after the existing setup code (where `taskEvents[taskId]` is initialized), add session creation:

```typescript
// Create or update session in DB
const now = Date.now();
const sessionRow: AgentSessionRow = {
  id: taskId,
  title: prompt.length > 40
    ? prompt.slice(0, 40).replace(/\s+\S*$/, "") + "..."
    : prompt,
  email_id: context.currentEmailId || null,
  thread_id: context.currentThreadId || null,
  account_id: context.accountId,
  provider_ids: JSON.stringify(providerIds),
  created_at: now,
  updated_at: now,
  status: "active",
};
saveAgentSession(sessionRow);
```

- [ ] **Step 3: Update session status on terminal state**

In the terminal state detection block (where `persistTaskEvents()` is called), add:

```typescript
const terminalStatus = state === "completed" ? "completed"
  : state === "cancelled" ? "cancelled"
  : "failed";
updateAgentSessionStatus(taskId, terminalStatus);
```

- [ ] **Step 4: Update session status on cancel**

In the `cancel()` method, add after persisting:

```typescript
updateAgentSessionStatus(taskId, "cancelled");
```

- [ ] **Step 5: Add session DB methods to worker proxy**

Add to the `dbMethods` map so the worker can access sessions if needed:

```typescript
saveAgentSession: (session: AgentSessionRow) => saveAgentSession(session),
updateAgentSessionStatus: (sessionId: string, status: string) =>
  updateAgentSessionStatus(sessionId, status),
```

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/agents/agent-coordinator.ts
git commit -m "feat(agent): coordinator creates/updates sessions on task lifecycle"
```

---

### Task 5: Update Zustand Store — Session State

**Files:**
- Modify: `src/renderer/store/index.ts`

- [ ] **Step 1: Add session state fields**

Add alongside the existing agent state fields (do NOT remove old fields yet — we'll keep both during transition):

```typescript
// Session-based agent state (new)
agentSessions: Record<string, AgentSession>;
activeSessionId: string | null;
sessionList: AgentSessionSummary[];
viewedThreadId: string | null;  // tracks which thread the user is currently viewing
```

Initialize in the store creator:

```typescript
agentSessions: {},
activeSessionId: null,
sessionList: [],
viewedThreadId: null,
```

- [ ] **Step 2: Add session actions**

```typescript
// Session management
setActiveSessionId: (sessionId: string | null) => void;
loadSessionList: (accountId: string) => void;
createSession: (session: AgentSession) => void;
updateSessionInStore: (sessionId: string, updates: Partial<AgentSession>) => void;
removeSession: (sessionId: string) => void;
setViewedThreadId: (threadId: string | null) => void;
```

Implement them:

```typescript
setActiveSessionId: (sessionId) => set({ activeSessionId: sessionId }),

loadSessionList: async (accountId) => {
  const result = await window.api.agent.listSessions(accountId);
  if (result.success && result.data) {
    set({ sessionList: result.data });
  }
},

createSession: (session) =>
  set((state) => ({
    agentSessions: { ...state.agentSessions, [session.id]: session },
    activeSessionId: session.id,
    sessionList: [
      { id: session.id, title: session.title, status: session.status, updatedAt: session.updatedAt, emailId: session.emailId },
      ...state.sessionList,
    ],
  })),

updateSessionInStore: (sessionId, updates) =>
  set((state) => {
    const existing = state.agentSessions[sessionId];
    if (!existing) return state;
    const updated = { ...existing, ...updates, updatedAt: Date.now() };
    return {
      agentSessions: { ...state.agentSessions, [sessionId]: updated },
      sessionList: state.sessionList.map((s) =>
        s.id === sessionId
          ? { ...s, title: updated.title, status: updated.status, updatedAt: updated.updatedAt }
          : s
      ),
    };
  }),

removeSession: (sessionId) =>
  set((state) => {
    const { [sessionId]: _, ...rest } = state.agentSessions;
    return {
      agentSessions: rest,
      sessionList: state.sessionList.filter((s) => s.id !== sessionId),
      activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
    };
  }),

setViewedThreadId: (threadId) => set({ viewedThreadId: threadId }),
```

- [ ] **Step 3: Wire `appendAgentEvent` to also update session runs**

In the existing `appendAgentEvent` implementation, after updating `agentTasks`, add:

```typescript
// Also update session if it exists
const session = state.agentSessions[taskId];
if (session) {
  const providerId = event.providerId || session.providerIds[0] || "unknown";
  const run = session.runs[providerId] || { status: "running" as const, events: [] };
  const updatedRun = { ...run, events: [...run.events, event] };

  if (event.type === "state") {
    updatedRun.status = event.state;
  }
  if (event.type === "confirmation_required") {
    updatedRun.pendingConfirmation = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      description: event.description,
    };
  }
  if (event.providerConversationId) {
    updatedRun.providerConversationId = event.providerConversationId;
  }

  return {
    ...state,
    agentSessions: {
      ...state.agentSessions,
      [taskId]: {
        ...session,
        runs: { ...session.runs, [providerId]: updatedRun },
        updatedAt: Date.now(),
      },
    },
  };
}
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/index.ts
git commit -m "feat(agent): add session state and actions to Zustand store"
```

---

### Task 6: Build Chat UI Components

**Files:**
- Create: `src/renderer/components/AgentPanel/index.ts`
- Create: `src/renderer/components/AgentPanel/ChatMessage.tsx`
- Create: `src/renderer/components/AgentPanel/CollapsedToolCalls.tsx`
- Create: `src/renderer/components/AgentPanel/TypingIndicator.tsx`
- Create: `src/renderer/components/AgentPanel/ThreadBar.tsx`
- Create: `src/renderer/components/AgentPanel/ChatInput.tsx`
- Create: `src/renderer/components/AgentPanel/SessionDropdown.tsx`

- [ ] **Step 1: Create barrel export**

Create `src/renderer/components/AgentPanel/index.ts`:

```typescript
export { ChatMessage } from "./ChatMessage";
export { CollapsedToolCalls } from "./CollapsedToolCalls";
export { TypingIndicator } from "./TypingIndicator";
export { ThreadBar } from "./ThreadBar";
export { ChatInput } from "./ChatInput";
export { SessionDropdown } from "./SessionDropdown";
```

- [ ] **Step 2: Create `ChatMessage.tsx`**

Create `src/renderer/components/AgentPanel/ChatMessage.tsx`:

```tsx
import { memo } from "react";
import ReactMarkdown from "react-markdown";

interface ChatMessageProps {
  role: "user" | "agent";
  content: string;
  timestamp?: number;
}

export const ChatMessage = memo(function ChatMessage({
  role,
  content,
  timestamp,
}: ChatMessageProps) {
  const isUser = role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-2`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
          isUser
            ? "bg-blue-500 text-white rounded-br-sm"
            : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-bl-sm"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        )}
        {timestamp && (
          <div
            className={`text-[10px] mt-1 ${
              isUser ? "text-blue-200" : "text-gray-400 dark:text-gray-500"
            }`}
          >
            {new Date(timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
    </div>
  );
});
```

- [ ] **Step 3: Create `CollapsedToolCalls.tsx`**

Create `src/renderer/components/AgentPanel/CollapsedToolCalls.tsx`:

```tsx
import { useState, memo } from "react";
import type { ScopedAgentEvent } from "../../../shared/agent-types";

interface CollapsedToolCallsProps {
  events: ScopedAgentEvent[];
}

export const CollapsedToolCalls = memo(function CollapsedToolCalls({
  events,
}: CollapsedToolCallsProps) {
  const [expanded, setExpanded] = useState(false);

  const toolNames = events
    .filter((e) => e.type === "tool_call_start")
    .map((e) => (e as { toolName: string }).toolName);

  const uniqueTools = [...new Set(toolNames)];
  const summary =
    uniqueTools.length <= 2
      ? uniqueTools.join(", ")
      : `${uniqueTools.slice(0, 2).join(", ")} +${uniqueTools.length - 2}`;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      >
        <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>
          ▸
        </span>
        <span className="font-mono">
          Used {toolNames.length} tool{toolNames.length !== 1 ? "s" : ""}
          {summary ? ` (${summary})` : ""}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-3 space-y-1 border-l-2 border-gray-200 dark:border-gray-700 pl-2">
          {events.map((event, i) => {
            if (event.type === "tool_call_start") {
              const e = event as { toolName: string; input: unknown };
              return (
                <div key={i} className="text-xs text-gray-500 dark:text-gray-400">
                  <span className="font-mono font-medium">{e.toolName}</span>
                  <pre className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 overflow-x-auto max-h-20 overflow-y-auto">
                    {typeof e.input === "string"
                      ? e.input.slice(0, 200)
                      : JSON.stringify(e.input, null, 2).slice(0, 200)}
                  </pre>
                </div>
              );
            }
            if (event.type === "tool_call_end") {
              const e = event as { result: unknown };
              return (
                <div
                  key={i}
                  className="text-[10px] text-gray-400 dark:text-gray-500 font-mono overflow-x-auto max-h-16 overflow-y-auto"
                >
                  → {typeof e.result === "string"
                    ? e.result.slice(0, 150)
                    : JSON.stringify(e.result).slice(0, 150)}
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
});
```

- [ ] **Step 4: Create `TypingIndicator.tsx`**

Create `src/renderer/components/AgentPanel/TypingIndicator.tsx`:

```tsx
export function TypingIndicator() {
  return (
    <div className="flex justify-start mb-2">
      <div className="bg-gray-100 dark:bg-gray-800 rounded-xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `ThreadBar.tsx`**

Create `src/renderer/components/AgentPanel/ThreadBar.tsx`:

```tsx
import { useAppStore } from "../../store";

export function ThreadBar() {
  const selectedEmailId = useAppStore((s) => s.selectedEmailId);
  const emails = useAppStore((s) => s.emails);

  const selectedEmail = selectedEmailId
    ? emails.find((e) => e.id === selectedEmailId)
    : null;

  if (!selectedEmail) {
    return (
      <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 dark:text-gray-500">
        No thread selected
      </div>
    );
  }

  return (
    <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 truncate">
      <span className="mr-1">📎</span>
      {selectedEmail.subject || "(no subject)"}
    </div>
  );
}
```

- [ ] **Step 6: Create `ChatInput.tsx`**

Create `src/renderer/components/AgentPanel/ChatInput.tsx`:

```tsx
import { useState, useRef, useCallback, type KeyboardEvent } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 96) + "px"; // max ~4 lines
  }, []);

  return (
    <div className="flex items-end gap-1.5 p-2 border-t border-gray-200 dark:border-gray-700">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          handleInput();
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || "Ask about this thread..."}
        disabled={disabled}
        rows={1}
        className="flex-1 resize-none rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
      />
      <button
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        className="flex-shrink-0 w-8 h-8 rounded-lg bg-blue-500 text-white flex items-center justify-center hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 10l7-7m0 0l7 7m-7-7v18"
          />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Create `SessionDropdown.tsx`**

Create `src/renderer/components/AgentPanel/SessionDropdown.tsx`:

```tsx
import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore } from "../../store";
import type { AgentSessionSummary } from "../../../shared/agent-types";

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function statusDot(status: AgentSessionSummary["status"]): string {
  switch (status) {
    case "active":
      return "bg-green-500";
    case "completed":
      return "bg-gray-400";
    case "failed":
      return "bg-red-500";
    case "cancelled":
      return "bg-yellow-500";
  }
}

interface SessionDropdownProps {
  onNewChat: () => void;
}

export function SessionDropdown({ onNewChat }: SessionDropdownProps) {
  const [open, setOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const agentSessions = useAppStore((s) => s.agentSessions);
  const sessionList = useAppStore((s) => s.sessionList);
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  const currentSession = activeSessionId
    ? agentSessions[activeSessionId]
    : null;

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus input when editing
  useEffect(() => {
    if (editingTitle && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTitle]);

  const handleRename = useCallback(async () => {
    if (!activeSessionId || !titleDraft.trim()) {
      setEditingTitle(false);
      return;
    }
    await window.api.agent.renameSession(activeSessionId, titleDraft.trim());
    useAppStore.getState().updateSessionInStore(activeSessionId, {
      title: titleDraft.trim(),
    });
    setEditingTitle(false);
  }, [activeSessionId, titleDraft]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      setOpen(false);
    },
    [setActiveSessionId]
  );

  const activeSessions = sessionList.filter(
    (s) => s.status === "active"
  );
  const recentSessions = sessionList.filter(
    (s) => s.status !== "active"
  );

  return (
    <div ref={dropdownRef} className="relative border-b border-gray-200 dark:border-gray-700">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-400">▾</span>
          {editingTitle ? (
            <input
              ref={inputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") setEditingTitle(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="text-sm bg-transparent border-b border-blue-500 outline-none text-gray-900 dark:text-gray-100 w-full"
            />
          ) : (
            <span
              className="truncate text-gray-900 dark:text-gray-100"
              onDoubleClick={() => {
                if (currentSession) {
                  setTitleDraft(currentSession.title);
                  setEditingTitle(true);
                }
              }}
            >
              {currentSession?.title || "No active chat"}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-b-lg shadow-lg max-h-[300px] overflow-y-auto">
          <button
            onClick={() => {
              onNewChat();
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-sm text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-left font-medium"
          >
            + New Chat
          </button>

          {activeSessions.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium">
                Active
              </div>
              {activeSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleSelect(s.id)}
                  className={`w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 ${
                    s.id === activeSessionId
                      ? "bg-gray-50 dark:bg-gray-800"
                      : ""
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(s.status)}`}
                  />
                  <span className="truncate text-gray-900 dark:text-gray-100">
                    {s.title}
                  </span>
                  <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">
                    {formatRelativeTime(s.updatedAt)}
                  </span>
                </button>
              ))}
            </>
          )}

          {recentSessions.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium">
                Recent
              </div>
              {recentSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleSelect(s.id)}
                  className={`w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 ${
                    s.id === activeSessionId
                      ? "bg-gray-50 dark:bg-gray-800"
                      : ""
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(s.status)}`}
                  />
                  <span className="truncate text-gray-700 dark:text-gray-300">
                    {s.title}
                  </span>
                  <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">
                    {formatRelativeTime(s.updatedAt)}
                  </span>
                </button>
              ))}
            </>
          )}

          {sessionList.length === 0 && (
            <div className="px-3 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">
              No chat history
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/renderer/components/AgentPanel/
git commit -m "feat(agent): add chat UI components — bubbles, tools, input, dropdown"
```

---

### Task 7: Rewrite `AgentPanel.tsx` as Chat Interface

**Files:**
- Modify: `src/renderer/components/AgentPanel.tsx`

This is the biggest change. We rewrite `AgentTabContent` to use the new components while keeping `EventTimeline` and `SubAgentBlock` as internal helpers for backward compat.

- [ ] **Step 1: Rewrite `AgentTabContent`**

Replace the `AgentTabContent` component in `src/renderer/components/AgentPanel.tsx`. Keep all the helper components (`SqlHighlighter`, `SubAgentBlock`, etc.) that are used internally — we still need them for expanded tool details. The key change is the outer structure:

```tsx
import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { useAppStore } from "../store";
import {
  ChatMessage,
  CollapsedToolCalls,
  TypingIndicator,
  ThreadBar,
  ChatInput,
  SessionDropdown,
} from "./AgentPanel/index";
import type { ScopedAgentEvent, AgentSession } from "../../shared/agent-types";

// ... keep existing helper components (SqlHighlighter, SubAgentBlock, etc.) ...

/** Groups consecutive tool events between text segments */
function groupEventsForChat(events: ScopedAgentEvent[]): Array<
  | { kind: "user"; text: string; timestamp?: number }
  | { kind: "agent"; text: string; timestamp?: number }
  | { kind: "tools"; events: ScopedAgentEvent[] }
  | { kind: "confirmation"; event: ScopedAgentEvent }
  | { kind: "error"; message: string }
  | { kind: "context"; text: string }
> {
  const groups: ReturnType<typeof groupEventsForChat> = [];
  let textBuffer = "";
  let toolBuffer: ScopedAgentEvent[] = [];

  function flushText() {
    if (textBuffer.trim()) {
      groups.push({ kind: "agent", text: textBuffer.trim() });
      textBuffer = "";
    }
  }

  function flushTools() {
    if (toolBuffer.length > 0) {
      groups.push({ kind: "tools", events: [...toolBuffer] });
      toolBuffer = [];
    }
  }

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        flushTools();
        textBuffer += (event as { text: string }).text;
        break;
      case "user_message":
        flushText();
        flushTools();
        groups.push({ kind: "user", text: (event as { text: string }).text });
        break;
      case "tool_call_start":
      case "tool_call_end":
      case "tool_call_pending":
        flushText();
        toolBuffer.push(event);
        break;
      case "confirmation_required":
        flushText();
        flushTools();
        groups.push({ kind: "confirmation", event });
        break;
      case "error":
        flushText();
        flushTools();
        groups.push({ kind: "error", message: (event as { message: string }).message });
        break;
      case "done":
        flushText();
        flushTools();
        break;
      case "state":
        // Skip state events in chat display
        break;
    }
  }
  flushText();
  flushTools();

  return groups;
}

export const AgentTabContent = memo(function AgentTabContent({
  emailId,
}: {
  emailId: string;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const agentSessions = useAppStore((s) => s.agentSessions);
  const currentAccountId = useAppStore((s) => s.currentAccountId);
  const selectedEmailId = useAppStore((s) => s.selectedEmailId);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const emails = useAppStore((s) => s.emails);
  const availableProviders = useAppStore((s) => s.availableProviders);
  const selectedAgentIds = useAppStore((s) => s.selectedAgentIds);
  const startAgentTask = useAppStore((s) => s.startAgentTask);
  const createSession = useAppStore((s) => s.createSession);
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);
  const loadSessionList = useAppStore((s) => s.loadSessionList);

  const session = activeSessionId ? agentSessions[activeSessionId] : null;

  // Load session list on mount and account change
  useEffect(() => {
    if (currentAccountId) {
      loadSessionList(currentAccountId);
    }
  }, [currentAccountId, loadSessionList]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.runs]);

  // Build thread context for the agent
  const buildThreadContext = useCallback((): string => {
    if (!selectedThreadId) return "";
    const threadEmails = emails
      .filter((e) => e.threadId === selectedThreadId)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    if (threadEmails.length === 0) return "";

    const currentEmail = selectedEmailId
      ? emails.find((e) => e.id === selectedEmailId)
      : threadEmails[0];
    const subject = currentEmail?.subject || "(no subject)";

    const lines = [`[Currently viewing thread: "${subject}"]`];
    lines.push(
      `${threadEmails.length} message${threadEmails.length !== 1 ? "s" : ""} in thread`
    );
    lines.push("---");
    for (let i = 0; i < threadEmails.length; i++) {
      const e = threadEmails[i];
      const date = new Date(e.date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      lines.push(`[${i + 1}] From: ${e.from} | ${date}`);
      // Use snippet for thread context — body may be large
      lines.push(e.snippet || "(no content)");
      lines.push("");
    }
    return lines.join("\n");
  }, [selectedThreadId, selectedEmailId, emails]);

  const handleSend = useCallback(
    async (message: string) => {
      const providerIds =
        selectedAgentIds.length > 0
          ? selectedAgentIds
          : availableProviders.length > 0
            ? [availableProviders[0].id]
            : [];

      if (providerIds.length === 0) return;

      const threadContext = buildThreadContext();
      const fullPrompt = threadContext
        ? `${threadContext}\n\n---\nUser: ${message}`
        : message;

      // If we have an active session with a running provider, do a follow-up
      if (session && Object.values(session.runs).some((r) => r.status === "completed" || r.status === "failed")) {
        // Follow-up on existing session
        const taskId = session.id;
        useAppStore.getState().followUpAgentTask(emailId, message);
        await window.api.agent.run(taskId, providerIds, fullPrompt, {
          accountId: currentAccountId || "",
          currentEmailId: selectedEmailId || undefined,
          currentThreadId: selectedThreadId || undefined,
          userEmail: "",
        });
        return;
      }

      // Create new session
      const taskId = crypto.randomUUID();
      const title =
        message.length > 40
          ? message.slice(0, 40).replace(/\s+\S*$/, "") + "..."
          : message;

      const now = Date.now();
      const newSession: AgentSession = {
        id: taskId,
        title,
        emailId: selectedEmailId || null,
        threadId: selectedThreadId || null,
        accountId: currentAccountId || "",
        providerIds,
        createdAt: now,
        updatedAt: now,
        status: "active",
        runs: Object.fromEntries(
          providerIds.map((pid) => [pid, { status: "running" as const, events: [] }])
        ),
      };
      createSession(newSession);

      // Also create in old system for backward compat
      startAgentTask(
        taskId,
        emailId,
        providerIds,
        message,
        {
          accountId: currentAccountId || "",
          currentEmailId: selectedEmailId || undefined,
          currentThreadId: selectedThreadId || undefined,
          userEmail: "",
        }
      );

      const result = await window.api.agent.run(
        taskId,
        providerIds,
        fullPrompt,
        {
          accountId: currentAccountId || "",
          currentEmailId: selectedEmailId || undefined,
          currentThreadId: selectedThreadId || undefined,
          userEmail: "",
        }
      );

      if (result && !result.success) {
        useAppStore.getState().appendAgentEvent(taskId, {
          type: "error",
          message: result.error || "Failed to start agent",
        });
      }
    },
    [
      session,
      emailId,
      selectedAgentIds,
      availableProviders,
      currentAccountId,
      selectedEmailId,
      selectedThreadId,
      buildThreadContext,
      createSession,
      startAgentTask,
    ]
  );

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
  }, [setActiveSessionId]);

  // Get events from session runs
  const allEvents = useMemo(() => {
    if (!session) return [];
    return Object.values(session.runs).flatMap((r) => r.events);
  }, [session]);

  const groups = useMemo(() => groupEventsForChat(allEvents), [allEvents]);

  const isRunning = session
    ? Object.values(session.runs).some((r) => r.status === "running")
    : false;

  const hasConfirmation = session
    ? Object.values(session.runs).some((r) => r.pendingConfirmation)
    : false;

  // Also check old task system for backward compat
  const oldTask = useAppStore((s) => s.agentTasks[emailId]);
  const effectiveGroups =
    groups.length > 0
      ? groups
      : oldTask
        ? groupEventsForChat(
            Object.values(oldTask.runs).flatMap((r) => r.events)
          )
        : [];

  const effectiveRunning =
    isRunning ||
    (oldTask
      ? Object.values(oldTask.runs).some((r) => r.status === "running")
      : false);

  const placeholder = selectedEmailId
    ? "Ask about this thread… (⌘↩ to send)"
    : "Start a conversation… (⌘↩ to send)";

  return (
    <div className="flex flex-col h-full">
      <SessionDropdown onNewChat={handleNewChat} />

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {effectiveGroups.length === 0 && !effectiveRunning && (
          <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
            <div className="text-center">
              <p>Start a conversation</p>
              <p className="text-xs mt-1">
                {selectedEmailId
                  ? "I can see the thread you're viewing"
                  : "Select an email for context"}
              </p>
            </div>
          </div>
        )}

        {effectiveGroups.map((group, i) => {
          switch (group.kind) {
            case "user":
              return <ChatMessage key={i} role="user" content={group.text} />;
            case "agent":
              return <ChatMessage key={i} role="agent" content={group.text} />;
            case "tools":
              return <CollapsedToolCalls key={i} events={group.events} />;
            case "confirmation": {
              const e = group.event as {
                toolCallId: string;
                toolName: string;
                description: string;
                input: unknown;
              };
              return (
                <div
                  key={i}
                  className="mb-2 rounded-lg border border-yellow-300 dark:border-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 p-2 text-sm"
                >
                  <p className="font-medium text-yellow-800 dark:text-yellow-200">
                    Approval needed: {e.toolName}
                  </p>
                  <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-1">
                    {e.description}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() =>
                        window.api.agent.confirm(e.toolCallId, true)
                      }
                      className="px-2 py-1 text-xs rounded bg-green-500 text-white hover:bg-green-600"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() =>
                        window.api.agent.confirm(e.toolCallId, false)
                      }
                      className="px-2 py-1 text-xs rounded bg-red-500 text-white hover:bg-red-600"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              );
            }
            case "error":
              return (
                <div
                  key={i}
                  className="mb-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-2 text-sm text-red-700 dark:text-red-300"
                >
                  {group.message}
                </div>
              );
            case "context":
              return (
                <div
                  key={i}
                  className="text-center text-xs text-gray-400 dark:text-gray-500 py-1"
                >
                  · {group.text} ·
                </div>
              );
            default:
              return null;
          }
        })}

        {effectiveRunning && <TypingIndicator />}

        <div ref={messagesEndRef} />
      </div>

      <ThreadBar />
      <ChatInput
        onSend={handleSend}
        disabled={effectiveRunning || hasConfirmation}
        placeholder={placeholder}
      />
    </div>
  );
});
```

Note: The existing `AgentTabContent` export name is preserved so `EmailPreviewSidebar.tsx` doesn't need changes yet.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AgentPanel.tsx
git commit -m "feat(agent): rewrite AgentTabContent as chat interface with bubbles"
```

---

### Task 8: Update `EmailPreviewSidebar.tsx` for Session State

**Files:**
- Modify: `src/renderer/components/EmailPreviewSidebar.tsx`

- [ ] **Step 1: Update trace loading to populate sessions**

In the trace loading effect (the debounced block around lines 232-287), after calling `replayAgentTrace()`, also create a session in the store:

```typescript
// After replayAgentTrace call, also populate session store
const { createSession } = useAppStore.getState();
createSession({
  id: taskId,
  title: prompt || "Restored session",
  emailId: emailId,
  threadId: null,
  accountId: currentAccountId || "",
  providerIds: ["claude"],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  status: "completed",
  runs: {
    claude: {
      status: "completed",
      events: traceResult.events,
    },
  },
});
```

- [ ] **Step 2: Set active session when switching to agent tab**

When the agent tab is selected and there's a task for the current email, set the active session ID:

```typescript
// In the agent tab display logic, when a task exists:
useEffect(() => {
  const task = useAppStore.getState().agentTasks[displayAgentKey];
  if (task && sidebarTab === "agent") {
    useAppStore.getState().setActiveSessionId(task.taskId);
  }
}, [displayAgentKey, sidebarTab]);
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/EmailPreviewSidebar.tsx
git commit -m "feat(agent): wire session state into EmailPreviewSidebar trace loading"
```

---

### Task 9: Update `AgentCommandPalette.tsx` for Session Flow

**Files:**
- Modify: `src/renderer/components/AgentCommandPalette.tsx`

- [ ] **Step 1: Create session when launching from command palette**

In the `handleSubmit` function (around line 268), after the existing `startAgentTask` call, also create a session:

```typescript
// After startAgentTask(taskId, taskKey, providerIds, prompt, context):
const now = Date.now();
useAppStore.getState().createSession({
  id: taskId,
  title: prompt.length > 40 ? prompt.slice(0, 40).replace(/\s+\S*$/, "") + "..." : prompt,
  emailId: selectedEmailId || null,
  threadId: selectedThreadId || null,
  accountId: currentAccountId || "",
  providerIds,
  createdAt: now,
  updatedAt: now,
  status: "active",
  runs: Object.fromEntries(
    providerIds.map((pid) => [pid, { status: "running" as const, events: [] }])
  ),
});
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AgentCommandPalette.tsx
git commit -m "feat(agent): create session from command palette launches"
```

---

### Task 10: Update `AgentsSidebar.tsx` to Pull from Sessions

**Files:**
- Modify: `src/renderer/components/AgentsSidebar.tsx`

- [ ] **Step 1: Use session list for recent tasks**

In the recent tasks section of `AgentsSidebar.tsx`, replace the `agentTaskHistory` usage with `sessionList`:

```typescript
// Replace:
// const taskHistory = useAppStore((s) => s.agentTaskHistory);
// With:
const sessionList = useAppStore((s) => s.sessionList);

// Then in the JSX, map sessionList instead of taskHistory:
// Each session summary has: id, title, status, updatedAt, emailId
```

Map the session fields to the existing display format — `title` → task label, `status` → icon, `updatedAt` → relative time.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AgentsSidebar.tsx
git commit -m "feat(agent): AgentsSidebar reads from session list instead of task history"
```

---

### Task 11: Live Thread Context — Watch Navigation Changes

**Files:**
- Modify: `src/renderer/store/index.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Track `viewedThreadId` in store on email selection**

In `src/renderer/store/index.ts`, in the `setSelectedEmail` action (or wherever `selectedEmailId` is set), also update `viewedThreadId`:

```typescript
// In setSelectedEmail or similar:
setViewedThreadId: (threadId) => set({ viewedThreadId: threadId }),
```

- [ ] **Step 2: Sync thread ID in App.tsx**

In `src/renderer/App.tsx`, add an effect that keeps `viewedThreadId` in sync with the selected email:

```typescript
// In the main App component:
const selectedThreadId = useAppStore((s) => s.selectedThreadId);
const setViewedThreadId = useAppStore((s) => s.setViewedThreadId);

useEffect(() => {
  setViewedThreadId(selectedThreadId || null);
}, [selectedThreadId, setViewedThreadId]);
```

This is deliberately simple — the context injection happens lazily in `AgentTabContent.handleSend()` (Task 7), which reads the current `selectedThreadId` and builds the context block at send time. No streaming or real-time push needed.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/index.ts src/renderer/App.tsx
git commit -m "feat(agent): track viewed thread ID for live context injection"
```

---

### Task 12: Integration Testing & Smoke Test

**Files:**
- Modify: `tests/unit/agent-sessions-db.spec.ts` (already created in Task 2)

- [ ] **Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: PASS with no errors

- [ ] **Step 2: Run linter**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run unit tests**

Run: `npm run test:unit`
Expected: All existing tests pass + new session DB tests pass

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Manual smoke test**

Run: `npm install && npm run dev`

Verify:
1. Agent tab shows session dropdown at top with "No active chat"
2. Typing in the input and pressing Cmd+Enter creates a new session
3. Agent responses appear as chat bubbles (left-aligned, gray)
4. User messages appear as bubbles (right-aligned, blue)
5. Tool calls collapse into "▸ Used N tools" line
6. Session dropdown shows the new session
7. Switching emails updates the ThreadBar
8. Starting a new chat clears the view
9. Previous sessions appear in dropdown and can be resumed
10. Typing indicator shows while agent is processing

- [ ] **Step 6: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix(agent): smoke test fixes for chat UI"
```

---

### Task 13: Cleanup & Final Commit

- [ ] **Step 1: Remove dead code**

Check if any old `EventTimeline` rendering code in `AgentPanel.tsx` is now unused. Remove it if the new chat UI fully replaces it. Keep `SubAgentBlock` and `SqlHighlighter` if they're still referenced by `CollapsedToolCalls` or expanded tool views.

- [ ] **Step 2: Run format check**

Run: `npm run format:check`
If failures: `npx prettier --write src/`

- [ ] **Step 3: Final type check + lint + test**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: All pass

- [ ] **Step 4: Commit cleanup**

```bash
git add -A
git commit -m "refactor(agent): remove dead timeline code, format cleanup"
```
