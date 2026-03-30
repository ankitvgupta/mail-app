# Exo

An open source, AI-native desktop email client. Built with Electron, React, TypeScript, and Tailwind CSS.

Exo treats AI as a first-class citizen — not a bolted-on feature. Every email gets analyzed, prioritized, and optionally drafted before you even open it. The goal is zero cognitive load: open your inbox and everything is already handled or ready to send.

## Features

### AI-Powered Email

- **Automatic triage** — Claude analyzes every incoming email and assigns a priority (high / medium / low / skip), so your inbox is pre-sorted by what actually matters
- **Smart draft generation** — AI-generated reply drafts that consider thread context, sender background, and your writing style. Drafts are generated in the background so they're ready when you open a thread
- **Draft refinement** — iteratively improve any draft with natural language feedback ("make this shorter", "more formal", "add the pricing details")
- **Writing style learning** — the system extracts style samples from your sent mail and uses few-shot examples so drafts sound like you, not a chatbot
- **Sender lookup** — automatic web search via Claude to surface sender context (role, company, LinkedIn) in a sidebar panel
- **Draft-edit learning** — when you edit an AI draft before sending, Exo extracts your preferences and applies them to future drafts
- **Archive-ready detection** — identifies threads that are conversationally complete and can be safely archived
- **Reminder detection** — recognizes Boomerang/reminder service emails and traces back to the original sender

### Agent System

- **Cmd+J agent palette** — ask Claude to do anything with the current email: draft a reply, look something up, forward with context. Agent traces are displayed in a sidebar tab
- **Agent tools** — the agent can read emails, read/update drafts, search Gmail, and forward messages
- **Per-email agent tasks** — each email can have its own running agent task, visible in the sidebar
- **Follow-up conversations** — continue talking to the agent about a specific email across multiple turns
- **Agent-to-agent communication** — Exo's built-in Claude agent can delegate to external agents you bring. Register a third-party agent (like [OpenClaw](https://openclaw.com)) or one internal to your company, and the Exo agent will automatically call out to it when it needs domain-specific information. For example, if you register your company's internal knowledge agent, the Exo agent can ask it "what's the status of the Acme deal?" while drafting a reply, without you having to switch tools

### Memory System

- **Priority memory** — learns from your classification overrides. Reclassify a sender as high priority and Exo remembers for all future emails from them
- **Persistent AI memories** — the AI accumulates memories about your preferences, contacts, and workflows that persist across app updates. Memories are scoped (per-sender, per-topic) with configurable caps
- **Steerable behavior** — add memories that direct the agent's behavior. For example: "for emails from Acme Corp, check the #acme-deals Slack channel for context", or "when drafting to investors, use a formal tone and always include our latest metrics from the dashboard"
- **Memories tab** — view, search, and manage all stored memories in Settings. Memories display their source (auto-learned from edits, priority overrides, or manually added)

### Extensions & Agent Providers

- **Bundled extensions** — ship with the app, statically imported at build time
- **Private extensions** — discovered at build time via `import.meta.glob`, auto-registered. Use this to add proprietary extensions for your team without forking
- **Runtime-installable extensions** — install/uninstall extensions without rebuilding the app
- **Custom agent providers** — extensions can register their own AI agent providers. Build an agent that talks to your company's internal APIs, knowledge bases, or tooling, package it as an extension, and it appears in the Cmd+J palette alongside the built-in Claude agent. The Exo agent can also sub-delegate to your agent provider, so your internal agents participate in the conversation automatically when relevant
- **Extension authentication** — extensions can require auth, with banner UI and onboarding integration
- **Sidebar panels** — extensions can add custom sidebar tabs scoped to specific emails (e.g., show CRM data, support ticket status, or deal context alongside the email)
- **MCP server support** — configure custom MCP servers that agents can use as tool providers

### Inbox Organization

- **Split inbox** — Priority, Other, and custom split tabs that categorize emails automatically
- **Split import** — import your existing inbox splits
- **Snoozed tab** — snooze emails to reappear later with natural language time input ("tomorrow morning", "next Monday")
- **Sent mail view** — dedicated view for sent emails
- **Archive-ready view** — one-click batch archive for threads the AI has determined are complete
- **Chronological sorting** with newest-first or oldest-first

### Email Composition

- **Rich text editor** — ProseMirror-based compose with formatting toolbar
- **`@`mention autocomplete** — type `@` or `+` in the compose body to mention someone and auto-add them as CC
- **CC/BCC fields** — collapsible, with full autocomplete from contact history
- **Email signatures** — create and manage multiple signatures, auto-appended to outgoing mail
- **Inline reply** — reply directly below any message in a thread, not just the latest one
- **Reply-all default** — reply-all is the default action, matching how most professional email works
- **Forward with threading** — forwards stay in the original thread via In-Reply-To header merging
- **Drag-and-drop recipients** — reorder recipient chips between To/CC/BCC
- **Instant Intro** — compose introductions between contacts with a single command
- **Scheduled send** — "send later" with time picker
- **Undo send** — configurable delay window to cancel outgoing messages (Cmd+Z)
- **Inline images** — paste, drag-and-drop, or attach images directly in the email body
- **Attachments** — download, preview, and forward attachments. Compose with file attachments

### Keyboard-Driven

- **Fast shortcuts** — j/k navigation, e to archive, # to trash, s to star, u to mark unread, g-prefix navigation (g+i inbox, g+d drafts, g+t trash, g+s starred)
- **Gmail bindings** — optional Gmail-standard keybindings, toggleable in settings
- **Arrow key navigation** — up/down to navigate, enter to open
- **Cmd+K command palette** — fuzzy search across all app actions
- **Tab cycling** — backtick/tilde to cycle through inbox split tabs
- **Batch selection** — Cmd+click, Shift+click, Shift+J/K for multi-select with bulk archive/trash/star

### Multi-Account

- **Multiple Gmail accounts** — OAuth authentication with per-account tokens
- **Instant account switching** — switch accounts without re-fetching from the API
- **Per-account sync state** — each account syncs independently with its own history ID
- **Cross-account isolation** — splits, snooze timers, and agent tasks are scoped per-account

### Sync & Performance

- **Background sync** — incremental sync via Gmail History API every 30 seconds
- **Offline support** — queue sends and actions when offline, execute when back online
- **Optimistic UI** — archive, trash, star, and mark-unread update instantly, roll back on failure
- **Undo for everything** — undo archive, trash, star, unstar, snooze, and mark-unread
- **LRU HTML cache** — sanitized email HTML is cached for instant thread navigation
- **Sync buffering** — background sync updates are batched to prevent UI jank during navigation
- **Image prefetching** — images in opened emails are prefetched for instant rendering

### Search

- **Hybrid search** — local FTS5 full-text search combined with Gmail API remote search for exhaustive results
- **Threaded results** — search results display as threads, not individual messages
- **Infinite scroll** — paginated search results with automatic loading

### Calendar

- **Calendar sidebar** — day view with events extracted from your Google Calendar
- **Multi-account calendars** — syncs calendars from all connected accounts
- **Per-calendar visibility** — toggle individual calendars on/off

### Executive Assistant Integration

- **Scheduling detection** — CalendaringAgent identifies emails that involve scheduling
- **Auto-CC** — automatically CC your EA on scheduling-related emails
- **Deferral language** — drafts include text deferring scheduling to your assistant
- **Configurable** in Settings → Executive Assistant tab

### Desktop Integration

- **Auto-update** — checks for updates daily with download progress, supports pre-release channels
- **Default mail app** — register as the system default mail handler (mailto: protocol)
- **macOS native** — hidden titlebar with traffic light buttons, code-signed and notarized
- **Dark mode** — class-based theme toggle with smart inversion for email content
- **Inbox density** — comfortable, default, and compact density settings
- **PostHog analytics** — opt-in analytics with session replay for debugging (no PII)
- **Bug reporting** — built-in bug report system

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set API Key

```bash
export ANTHROPIC_API_KEY=your_key_here
```

### 3. Run

```bash
npm run dev
```

### Demo Mode (no API keys needed)

```bash
npm run dev:demo
```

## Commands

```bash
npm run dev          # Start dev server
npm run dev:demo     # Demo mode with fake data
npm run build        # Production build
npm test             # Run all tests
npx tsc --noEmit     # Type check
```

## Configuration

All config lives under `~/Library/Application Support/exo/` on macOS.

See [CLAUDE.md](CLAUDE.md) for architecture details and data flows.
