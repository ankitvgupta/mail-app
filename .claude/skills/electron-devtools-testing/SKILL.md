---
name: electron-devtools-testing
description: Test the Electron app interactively using Chrome DevTools Protocol. Use when the user asks to test, verify, or interact with the running app via browser automation.
---

Test the Exo Electron app interactively using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP.

## Prerequisites

1. **chrome-devtools MCP must be configured** — add it to your MCP config:
   ```bash
   claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9223
   ```

   Port `9223` (not the chrome-devtools-mcp default of `9222`) avoids conflicting
   with the user's main Chrome browser, which on this machine already runs with
   `--remote-debugging-port=9222` for the browser-harness setup. The MCP is hard-wired
   to this port — it reads `--browser-url` once at subprocess startup and never re-reads
   it. If you have to launch Electron on a different port (see step 2), the MCP cannot
   reach it; use direct CDP instead (see **Fallback** below).

2. **Pick a free debug port, then launch the app headless on it**:

   ```bash
   PORT=9223
   while lsof -ti:$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done
   echo "Using CDP port $PORT"
   EXO_DEMO_MODE=true EXO_HEADLESS=true npm run dev -- --remote-debugging-port=$PORT
   ```

   - `EXO_HEADLESS=true` makes `createWindow` skip `mainWindow.show()` (see
     `src/main/window.ts`) and hides the macOS dock icon, so the app does not
     pop visibly or steal focus — the renderer is still fully alive and CDP-attachable.
     Always pass it; there is no reason to run this skill non-headlessly.
   - The port probe matters because **parallel sibling worktrees** (Conductor often has
     2–10 agents running at once) can already hold 9223. Without the probe, your
     `npm run dev` either fails to bind or, worse, your MCP attaches to the sibling's
     Electron — you'd be inspecting and "fixing" their renderer, not yours.
   - `npm run dev` is preferred over `npx electron-vite dev` directly because the
     `dev` script also runs `npm run build:worker` first — without that, the agent
     sidebar fails to start with "Agent worker failed to start" since the bundled
     utility-process worker file is missing.

## How It Works

- Electron exposes a CDP endpoint at `http://127.0.0.1:<PORT>` when launched with `--remote-debugging-port=<PORT>`
- If `<PORT>` is 9223, the `chrome-devtools` MCP connects and you can use its tools
- If `<PORT>` is anything else, the MCP can't reach it — use direct CDP from a small node script (see **Fallback**)
- Either way you can navigate, click, type, take screenshots, and inspect the DOM

## Workflow

1. **Start the app headless** on a free port (run in background so the terminal is free):
   ```bash
   PORT=9223
   while lsof -ti:$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done
   EXO_DEMO_MODE=true EXO_HEADLESS=true npm run dev -- --remote-debugging-port=$PORT
   ```
   Wait for CDP to come up before doing anything else (the dev-server log is unreliable
   — wait on the CDP endpoint itself):
   ```bash
   until curl -sf http://127.0.0.1:$PORT/json/version >/dev/null 2>&1; do sleep 1; done
   ```
   The renderer process runs normally and is reachable over CDP; only the visible
   window and dock icon are suppressed.

2. **List available pages**:
   Use `mcp__chrome-devtools__list_pages` to see Electron's renderer windows.

3. **Select the main window**:
   Use `mcp__chrome-devtools__select_page` with the page ID of the main app window (not DevTools or blank pages).

4. **Take a snapshot** to see the current UI state:
   Use `mcp__chrome-devtools__take_snapshot` to get an accessibility tree of the page.

5. **Interact with the app**:
   - `mcp__chrome-devtools__click` — click buttons, links, tabs
   - `mcp__chrome-devtools__fill` — type into inputs and textareas
   - `mcp__chrome-devtools__take_screenshot` — capture visual state
   - `mcp__chrome-devtools__evaluate_script` — run JS in the renderer context

6. **Stop the app** when done by killing the background process.

## Key UI Navigation

| Action | How |
|--------|-----|
| Open Settings | Click the gear icon in the top bar |
| Switch to Prompts tab | Click "Prompts" tab inside Settings |
| Edit a prompt | Click into the textarea and modify text |
| Save prompts | Click the "Save" button |
| Close Settings | Click "X" or press Escape |
| Switch accounts | Click account selector in the sidebar |

## Fallback: direct CDP when port ≠ 9223

The MCP only attaches to whatever port it was configured with at startup (9223 here).
If the port probe picked something else (9224, 9225, …) because a sibling worktree
already had 9223, the MCP tools won't work for this run. Drive CDP directly from a
small node script — no install needed, Node 22+ ships a global `WebSocket`:

```js
// /tmp/cdp.mjs — run with `CDP_PORT=<port> node /tmp/cdp.mjs`
import { writeFileSync } from "fs";
const PORT = process.env.CDP_PORT;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(p => p.type === "page");
if (!page) throw new Error(`No page target on port ${PORT} yet — /json/version can succeed before the renderer registers; retry in a moment`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.addEventListener("open", r, { once: true }));
await send("Runtime.enable");

// CDP comes up before React has painted. Poll for a known-rendered marker
// before doing anything — otherwise your first screenshot is a blank canvas.
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  const r = await send("Runtime.evaluate", {
    expression: `document.body && document.body.innerText.includes("Compose")`,
    returnByValue: true,
  });
  if (r.result?.result?.value === true) break;
  await new Promise(x => setTimeout(x, 250));
}

// example: click a button by visible text, then screenshot the result
await send("Runtime.evaluate", {
  expression: `Array.from(document.querySelectorAll('button')).find(b => /compose/i.test(b.textContent || ""))?.click()`,
});
await new Promise(r => setTimeout(r, 500));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(".context/shot.png", Buffer.from(shot.result.data, "base64"));
ws.close();
```

`Runtime.evaluate`, `Page.captureScreenshot`, `Input.dispatchKeyEvent`, and
`Input.dispatchMouseEvent` cover everything the MCP would have given you.
Do NOT `import { WebSocket } from "ws"` — the `ws` package isn't a project
dependency, and only resolves accidentally from random parent `node_modules`.

## Notes

- **Demo mode**: When launched with `EXO_DEMO_MODE=true`, the app uses mock data and makes no real Gmail API calls. Useful for testing UI without credentials.
- **Sanity-check which Electron you attached to**: before trusting any screenshot or
  click result, confirm the CDP endpoint actually belongs to this worktree.
  `lsof -ti:$PORT` gives the PID; `ps -p <pid> -o command=` should show a path under
  this worktree (e.g. `.../casablanca/node_modules/electron/...`). If it points at a
  sibling worktree, something raced past the port probe — pick the next port and relaunch.
- **Stale Electron processes**: `pkill -f "electron-vite dev"` doesn't always kill all
  child Electron processes from prior dev sessions. If you attach to a stale Electron
  whose source code is out of date with the disk, code changes will appear to silently
  no-op. Scope the kill to **this worktree's path and your chosen port** so you don't
  nuke sibling agents:
  ```bash
  WORKTREE=$(basename "$PWD")
  pkill -9 -f "$WORKTREE.*Electron.app" 2>/dev/null
  pkill -9 -f "$WORKTREE.*electron-vite dev.*--remote-debugging-port=$PORT" 2>/dev/null
  ```
  Then verify with `lsof -ti:$PORT` returning empty.
- **Multiple windows**: Electron may open multiple pages (main window, DevTools, etc). Always select the correct renderer page (`type === "page"`, not `"background_page"` or `"other"`) before interacting.
- **Hot reload**: `electron-vite dev` supports HMR for the renderer. After main-process code changes, you must restart the app — main-process code does NOT hot-reload.
- **Worker bundle is separate**: `src/main/agents/agent-worker.ts` and code it imports get bundled into `out/worker/agent-worker.cjs` by `npm run build:worker`. After changes to the agent worker, the bundle must rebuild — `npm run dev` does this automatically; `npx electron-vite dev` does NOT.

## Driving the agent directly via IPC

To trigger an agent task without simulating Cmd+J + typing in the palette:

```js
mcp__chrome-devtools__evaluate_script({
  function: `async () => {
    const taskId = "test-" + Date.now();
    return await window.api.agent.run(
      taskId,
      ["claude"],          // provider id is "claude" (not "claude-agent")
      "Reply with OK",
      { accountId: "default", userEmail: "me@example.com" }
    );
  }`,
})
```

Then poll the trace:
```js
mcp__chrome-devtools__evaluate_script({
  function: `async () => await window.api.agent.getTrace("<taskId>")`,
})
```

The trace returns `{ events: [...] }` with `state`, `tool_call_start`, `tool_call_end`, `text_delta`, and `done` events.
