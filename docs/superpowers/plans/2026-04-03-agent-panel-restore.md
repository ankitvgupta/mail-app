# Agent Panel Restore — Address Owner Feedback

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the original EventTimeline-based agent rendering that ankitvgupta requires, while keeping the solid backend session infrastructure for future non-email agent runs.

**Architecture:** Revert the renderer-side AgentPanel, AgentsSidebar, and EmailPreviewSidebar to their pre-branch versions (which have rich rendering: SubAgentBlock, ToolCallEvent with SQL highlighting, TextBlock with remarkGfm). Keep all backend changes (agent_sessions DB table, IPC handlers, coordinator lifecycle). Fix all review bot issues (cancel session sync, sessionList staleness, error handling).

**Tech Stack:** React, TypeScript, Zustand, SQLite, Electron IPC

---

## Context: Why This Plan Exists

The PR owner (ankitvgupta) rejected the current UX direction with these specific complaints:
1. External agent calls (e.g. OpenClaw) no longer render nicely inline — the old `SubAgentBlock` with recursive `EventTimeline` was replaced by `CollapsedToolCalls` which just shows "Used N tools"
2. Table formatting breaks — the old `TextBlock` used `ReactMarkdown + remarkGfm`; the new `ChatMessage` may not include `remarkGfm`
3. Agent traces are no longer tightly tied to each email — this is a key design element he won't change
4. SessionDropdown per-email doesn't make sense — for emails, follow-ups should append to the existing trace
5. UX changes too much overall

The strategy: restore old rendering, keep backend infrastructure (it's solid and useful for future non-email agent run improvements).

## File Structure

| File | Action | Description |
|------|--------|-------------|
| `src/renderer/components/AgentPanel.tsx` | **Restore** from merge base | Brings back EventTimeline, TextBlock, ToolCallEvent, SubAgentBlock, ErrorBlock, handleFollowUp, handleAuth, handleRetry, handleRegenerate |
| `src/renderer/components/AgentPanel/` | **Delete** directory | ChatMessage, CollapsedToolCalls, TypingIndicator, ThreadBar, ChatInput, SessionDropdown, index.ts — all unused after restore |
| `src/renderer/components/AgentsSidebar.tsx` | **Restore** from merge base | Brings back TaskHistoryRow instead of SessionRow, reads agentTaskHistory instead of sessionList |
| `src/renderer/components/EmailPreviewSidebar.tsx` | **Restore** from merge base | Restores tight email-agent binding, removes session-related effects |
| `src/renderer/store/index.ts` | **Edit** | Fix cancelAgentTask to update sessions, fix appendAgentEvent to sync sessionList, fix loadSessionList error handling |
| `src/renderer/App.tsx` | **Edit** | Remove accidental blank lines left by viewedThreadId removal |

### Files NOT touched (kept from this branch)

| File | Why kept |
|------|----------|
| `src/main/db/index.ts` | agent_sessions table, migration v2, CRUD — solid backend infrastructure |
| `src/main/db/schema.ts` | agent_sessions DDL in base schema |
| `src/main/ipc/agent.ipc.ts` | Session IPC handlers — will be useful for non-email runs |
| `src/main/agents/agent-coordinator.ts` | Session lifecycle hooks — creates/updates session rows alongside tasks |
| `src/preload/index.ts` | Session preload bridge methods |
| `src/shared/agent-types.ts` | AgentSession, AgentSessionSummary types |
| `src/renderer/components/AgentCommandPalette.tsx` | Session creation on command palette launch |
| `tests/unit/agent-sessions-db.spec.ts` | Unit tests for session CRUD |

---

### Task 1: Restore AgentPanel.tsx from merge base

**Files:**
- Restore: `src/renderer/components/AgentPanel.tsx`

- [ ] **Step 1: Restore the old file**

```bash
MERGE_BASE=$(git merge-base origin/main HEAD)
git show ${MERGE_BASE}:src/renderer/components/AgentPanel.tsx > src/renderer/components/AgentPanel.tsx
```

- [ ] **Step 2: Verify the restore**

The restored file should be ~1046 lines and contain:
- `TextBlock` using `ReactMarkdown` with `remarkGfm`
- `ToolCallEvent` with `SqlHighlight`, expandable input/result, `ToolIcon`
- `SubAgentBlock` with recursive `EventTimeline`
- `ErrorBlock` handling `AGENT_AUTH_REQUIRED`, `OPENCLAW_NOT_CONFIGURED`
- `EventTimeline` with sub-agent wrapper detection
- `buildConversationHistory` for stateless follow-ups
- `AgentTabContent` using `agentTasks[emailId]` (not sessions)

```bash
head -10 src/renderer/components/AgentPanel.tsx
# Should show: import ReactMarkdown from "react-markdown"; import remarkGfm...
wc -l src/renderer/components/AgentPanel.tsx
# Should be ~1046
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AgentPanel.tsx
git commit -m "revert(agent): restore EventTimeline rendering per owner feedback

Restores TextBlock (remarkGfm), ToolCallEvent (SQL highlighting),
SubAgentBlock (recursive nesting), ErrorBlock, and the full
EventTimeline-based agent panel that renders inline tool calls
and external agent calls properly."
```

---

### Task 2: Delete unused AgentPanel/ sub-components

**Files:**
- Delete: `src/renderer/components/AgentPanel/` (entire directory)

- [ ] **Step 1: Delete the directory**

```bash
rm -rf src/renderer/components/AgentPanel/
```

- [ ] **Step 2: Verify no remaining imports**

```bash
grep -r "AgentPanel/" src/renderer/ --include="*.tsx" --include="*.ts"
# Should return nothing (the restored AgentPanel.tsx doesn't import from AgentPanel/)
```

- [ ] **Step 3: Commit**

```bash
git add -A src/renderer/components/AgentPanel/
git commit -m "chore: remove unused chat bubble sub-components

These were part of the chat-bubble UI that is being reverted.
The restored EventTimeline renders everything inline."
```

---

### Task 3: Restore AgentsSidebar.tsx from merge base

**Files:**
- Restore: `src/renderer/components/AgentsSidebar.tsx`

- [ ] **Step 1: Restore the old file**

```bash
MERGE_BASE=$(git merge-base origin/main HEAD)
git show ${MERGE_BASE}:src/renderer/components/AgentsSidebar.tsx > src/renderer/components/AgentsSidebar.tsx
```

- [ ] **Step 2: Verify**

The restored file should use `TaskHistoryRow` and read from `agentTaskHistory` (not `sessionList` or `SessionRow`).

```bash
grep "TaskHistoryRow\|agentTaskHistory" src/renderer/components/AgentsSidebar.tsx
# Should find both
grep "SessionRow\|sessionList" src/renderer/components/AgentsSidebar.tsx
# Should find nothing
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AgentsSidebar.tsx
git commit -m "revert(agent): restore task history in AgentsSidebar"
```

---

### Task 4: Restore EmailPreviewSidebar.tsx from merge base

**Files:**
- Restore: `src/renderer/components/EmailPreviewSidebar.tsx`

- [ ] **Step 1: Restore the old file**

```bash
MERGE_BASE=$(git merge-base origin/main HEAD)
git show ${MERGE_BASE}:src/renderer/components/EmailPreviewSidebar.tsx > src/renderer/components/EmailPreviewSidebar.tsx
```

- [ ] **Step 2: Verify**

The restored file should NOT reference `createSession`, `setActiveSessionId`, or `sessionList`. It SHOULD have the tight email-agent binding with `frozenAgentKeyRef` and the agent trace replay logic.

```bash
grep "createSession\|setActiveSessionId\|sessionList" src/renderer/components/EmailPreviewSidebar.tsx
# Should find nothing
grep "frozenAgentKeyRef\|replayAgentTrace" src/renderer/components/EmailPreviewSidebar.tsx
# Should find both
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/EmailPreviewSidebar.tsx
git commit -m "revert(agent): restore tight email-agent binding in sidebar"
```

---

### Task 5: Fix store issues from review bots

**Files:**
- Modify: `src/renderer/store/index.ts`

Three fixes needed:
1. **cancelAgentTask doesn't update session status** (Devin P0) — When cancelling, also update the session in `agentSessions` and `sessionList`
2. **appendAgentEvent doesn't update sessionList** (Devin P0) — When session status changes, also update the corresponding entry in `sessionList`
3. **loadSessionList doesn't handle errors** (Greptile P2) — Add console.warn on failure

- [ ] **Step 1: Fix cancelAgentTask to update session status**

In `cancelAgentTask`, after updating `agentTasks`, also update the session if one exists:

```typescript
// In cancelAgentTask, after the existing return object, add session update:
cancelAgentTask: (taskId) =>
  set((state) => {
    const emailId = state.agentTaskIdMap[taskId];
    if (!emailId) return {};

    const task = state.agentTasks[emailId];
    if (!task || task.status === "cancelled" || task.status === "completed") return {};

    const entry: AgentTaskHistoryEntry = {
      taskId: task.taskId,
      providerIds: task.providerIds,
      prompt: task.prompt,
      timestamp: Date.now(),
      status: "cancelled",
    };

    // Also update session if one exists
    const session = state.agentSessions[taskId];
    const sessionUpdates = session
      ? {
          agentSessions: {
            ...state.agentSessions,
            [taskId]: { ...session, status: "cancelled" as const, updatedAt: Date.now() },
          },
          sessionList: state.sessionList.map((s) =>
            s.id === taskId ? { ...s, status: "cancelled" as const, updatedAt: Date.now() } : s,
          ),
        }
      : {};

    return {
      agentTasks: {
        ...state.agentTasks,
        [emailId]: { ...task, status: "cancelled" },
      },
      agentTaskHistory: [...state.agentTaskHistory, entry],
      ...sessionUpdates,
    };
  }),
```

- [ ] **Step 2: Fix appendAgentEvent to update sessionList**

At the end of the session update block in `appendAgentEvent`, include `sessionList` in the return:

```typescript
// In the session update return block, add sessionList sync:
return {
  ...newAgentTasksState,
  agentSessions: {
    ...state.agentSessions,
    [taskId]: {
      ...session,
      status: sessionStatus,
      runs: updatedSessionRuns,
      updatedAt: Date.now(),
    },
  },
  sessionList: state.sessionList.map((s) =>
    s.id === taskId
      ? { ...s, status: sessionStatus, updatedAt: Date.now() }
      : s,
  ),
};
```

- [ ] **Step 3: Fix loadSessionList error handling**

```typescript
loadSessionList: async (accountId) => {
  const result = await window.api.agent.listSessions(accountId);
  if (result && result.success && result.data) {
    set({ sessionList: result.data });
  } else if (result && !result.success) {
    console.warn("[store] Failed to load session list:", result.error);
  }
},
```

- [ ] **Step 4: Run type checker**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/index.ts
git commit -m "fix(agent): cancel updates session status, sessionList stays in sync

- cancelAgentTask now updates agentSessions and sessionList
- appendAgentEvent syncs sessionList when session status changes
- loadSessionList logs errors instead of silently failing"
```

---

### Task 6: Fix App.tsx blank lines

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Remove accidental blank lines**

The viewedThreadId removal left extra blank lines around line 678. Remove them so there's at most one blank line between the previous `useEffect` and the next one.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "style: remove accidental blank lines in App.tsx"
```

---

### Task 7: Type check and test

- [ ] **Step 1: Type check**

```bash
npx tsc --noEmit
```

Expected: Clean — no errors. If there are errors, they're likely:
- Missing imports in restored files (unlikely since they're from the same codebase)
- Store interface changes (the restored components use `agentTasks`/`agentTaskHistory` which still exist)

- [ ] **Step 2: Run unit tests**

```bash
npm run test:unit
```

If the better-sqlite3 rebuild fails (environment issue), verify that at minimum:
- `npx tsc --noEmit` passes
- No import errors
- The restored files match the merge base exactly (except for targeted fixes)

- [ ] **Step 3: Run lint and format check**

```bash
npm run lint
npm run format:check
```

Fix any issues before committing.

---

### Task 8: Push and update PR

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Post a comment on the PR summarizing the changes**

Use `gh pr comment` to explain:
- Restored EventTimeline rendering (TextBlock with remarkGfm, ToolCallEvent with SQL highlighting, SubAgentBlock with recursive nesting)
- Restored tight email-agent binding
- Restored task history in sidebar
- Kept backend session infrastructure for future non-email agent run improvements
- Fixed all review bot issues (cancel session sync, sessionList staleness, error handling)
