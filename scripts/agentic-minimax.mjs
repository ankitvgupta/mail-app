#!/usr/bin/env node
/**
 * Multi-step agentic test for minimax-m3:cloud through BOTH harnesses
 * (Claude Agent SDK + Ollama, OpenCode + Ollama).
 *
 * Unlike the smoke tests (one tool, one shot), this gives the model a small
 * toolbox over a fixture calendar + mailbox and a task that REQUIRES chaining:
 *   "check if I'm free this Friday and respond with a time"
 *     -> resolve "this Friday" -> list_calendar_events(date) -> find a free
 *        slot -> send_email_reply(proposed time)
 *
 * Every tool call routes through one shared executor that logs
 * `→ name(args)` / `← result`, so the multi-step chain is visible and is
 * identical across both harnesses. A per-scenario checker then verifies the
 * model used the right tools in a sensible order and produced a correct reply.
 *
 * Usage:
 *   node scripts/agentic-minimax.mjs                 # both backends, both scenarios
 *   node scripts/agentic-minimax.mjs --backend claude
 *   node scripts/agentic-minimax.mjs --backend opencode --scenario friday
 *   node scripts/agentic-minimax.mjs --model minimax-m2.7:cloud
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/load-env.mjs";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv(join(__dirname, "..", ".env"));
loadEnv(join(__dirname, "..", ".env.local"));

const OLLAMA_KEY = process.env.OLLAMA_API_KEY;
if (!OLLAMA_KEY) {
  console.error("FAIL: OLLAMA_API_KEY required");
  process.exit(1);
}

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const modelsArg = arg("--models", null);
const singleModel = arg("--model", null);
// null → main() uses its default 3-model head-to-head set.
const MODELS_OVERRIDE = modelsArg
  ? modelsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : singleModel
    ? [singleModel]
    : null;
const ONLY_BACKEND = arg("--backend", null); // claude | opencode | null(both)
const ONLY_SCENARIO = arg("--scenario", null); // friday | invoice | null(both)
const TRIALS = Number(arg("--trials", "1"));

function median(a) {
  const v = a.filter((x) => x != null).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const TODAY = "Sunday, 2026-05-31";

// ---------------------------------------------------------------------------
// Fixture world: a calendar and a mailbox the tools read from.
// ---------------------------------------------------------------------------
const CALENDAR = {
  // "this Friday" from 2026-05-31
  "2026-06-05": {
    workingHours: "09:00-17:00",
    events: [
      { start: "09:00", end: "09:30", title: "Team standup" },
      { start: "11:00", end: "12:00", title: "Design review" },
      { start: "14:00", end: "15:00", title: "1:1 with Sam" },
    ],
  },
};
// Free windows on 2026-06-05: 09:30-11:00, 12:00-14:00, 15:00-17:00.
const FRIDAY = "2026-06-05";
const BUSY_FRIDAY = [
  ["09:00", "09:30"],
  ["11:00", "12:00"],
  ["14:00", "15:00"],
];

const MAILBOX = {
  "inv-88": {
    from: "billing@acme.com",
    subject: "Invoice #88 — March services",
    date: "2026-05-28",
    body: "Hi, please find Invoice #88 attached. Amount due: $4,250.00. Due date: 2026-06-15. Remit to billing@acme.com. Thanks.",
  },
  "inv-77": {
    from: "billing@acme.com",
    subject: "Invoice #77 — February services",
    date: "2026-04-28",
    body: "Invoice #77. Amount due: $3,900.00. Due date: 2026-05-15. (This invoice was paid on 2026-05-10.)",
  },
};

// ---------------------------------------------------------------------------
// Shared tool specs — one executor, used by both harnesses.
// ---------------------------------------------------------------------------
function makeTools(state) {
  const log = (line) => {
    console.log(line);
    state.trace.push(line);
  };
  const record = (name, args, result) => {
    const t = state.t0 ? performance.now() - state.t0 : 0;
    state.calls.push({ name, args, t });
    log(`   [+${(t / 1000).toFixed(1)}s] → ${name}(${JSON.stringify(args)})`);
    log(`           ← ${JSON.stringify(result).slice(0, 220)}`);
    return result;
  };
  return [
    {
      name: "list_calendar_events",
      description:
        "List the user's calendar events for a given day. date must be ISO format YYYY-MM-DD.",
      shape: { date: z.string() },
      run: (a) => {
        const day = CALENDAR[a.date];
        const result = day
          ? { date: a.date, workingHours: day.workingHours, events: day.events }
          : { date: a.date, workingHours: "09:00-17:00", events: [] };
        return record("list_calendar_events", a, result);
      },
    },
    {
      name: "search_emails",
      description: "Search the mailbox. Returns matching messages (id, from, subject, date), newest first.",
      shape: { query: z.string() },
      run: (a) => {
        // Query-driven: a message matches if its subject or sender contains any
        // term from the query. Newest first.
        const terms = a.query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = Object.entries(MAILBOX)
          .filter(([, m]) => {
            const hay = (m.subject + " " + m.from).toLowerCase();
            return terms.some((t) => hay.includes(t));
          })
          .map(([id, m]) => ({ id, from: m.from, subject: m.subject, date: m.date }))
          .sort((x, y) => (x.date < y.date ? 1 : -1));
        return record("search_emails", a, { results: hits });
      },
    },
    {
      name: "get_email",
      description: "Fetch the full body of an email by id.",
      shape: { id: z.string() },
      run: (a) => {
        const m = MAILBOX[a.id];
        const result = m ? { id: a.id, ...m } : { id: a.id, error: "not found" };
        return record("get_email", a, result);
      },
    },
    {
      name: "send_email_reply",
      description: "Send a reply email. Provide the recipient and the full plain-text body.",
      shape: { to: z.string(), body: z.string() },
      run: (a) => {
        state.sentReply = { to: a.to, body: a.body };
        return record("send_email_reply", { to: a.to, body: a.body.slice(0, 80) + "…" }, { status: "sent" });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const SCENARIOS = {
  friday: {
    title: "Check if I'm free this Friday and respond with a time",
    system:
      `You are an executive's email assistant. Today is ${TODAY}. ` +
      "Use the available tools to do real work — check the calendar before proposing any time, " +
      "and actually send the reply with send_email_reply. Propose a specific time that is genuinely free. " +
      "Keep the reply concise and warm.",
    prompt:
      "New email from Marcus Lee <marcus@northwind.co>:\n" +
      "Subject: Quick call this Friday?\n\n" +
      "Hi — could we grab 30 minutes this Friday afternoon for a quick call about the Q3 plan? " +
      "Let me know what time works.\n\n" +
      "Task: check if I'm free this Friday afternoon and reply to Marcus proposing a specific time.",
    check: (state) => {
      const notes = [];
      const calVals = state.calls.filter((c) => c.name === "list_calendar_events");
      const calledRightDay = calVals.some((c) => c.args.date === FRIDAY);
      notes.push(`${calledRightDay ? "✓" : "✗"} queried calendar for ${FRIDAY} (got: ${calVals.map((c) => c.args.date).join(",") || "none"})`);
      const calledBeforeReply =
        state.calls.findIndex((c) => c.name === "list_calendar_events") <
        state.calls.findIndex((c) => c.name === "send_email_reply");
      const sent = !!state.sentReply;
      notes.push(`${sent ? "✓" : "✗"} sent a reply via send_email_reply`);
      notes.push(`${calledBeforeReply ? "✓" : "✗"} checked calendar BEFORE replying`);

      // Did the proposed time land in a genuinely free window?
      // A good reply often *also* lists existing commitments for transparency,
      // written as ranges ("11:00–12:00"). The actual proposal is a standalone
      // time. So strip ranges first, then judge the remaining standalone times.
      let timeOk = null;
      if (sent) {
        // Strip commitment ranges ("11:00–12:00") the model lists for context.
        const proposalText = state.sentReply.body.replace(
          /\d{1,2}:\d{2}\s*[–\-—]\s*\d{1,2}:\d{2}/g,
          " ",
        );
        // A reply may transparently name an existing commitment ("I've got
        // something at 2:00 but I'm free after"). Exclude any standalone time
        // immediately preceded by a busy-cue so it isn't misread as a proposal.
        const BUSY_CUE = /(got|have|having|something|booked|busy|blocked|books|meeting|conflict|already|1:1|standup|review)\b[^\d]{0,14}$/i;
        const times = [...proposalText.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?/g)]
          .filter((m) => !BUSY_CUE.test(proposalText.slice(Math.max(0, m.index - 26), m.index)))
          .map((m) => {
            let h = Number(m[1]);
            const min = Number(m[2] ?? 0);
            const ap = (m[3] ?? "").toLowerCase();
            if (ap === "pm" && h < 12) h += 12;
            if (ap === "am" && h === 12) h = 0;
            if (!ap && h >= 1 && h <= 6) h += 12; // bare 1-6 → afternoon
            return h * 60 + min;
          })
          .filter((t) => t >= 9 * 60 && t <= 17 * 60);
        const inBusy = (t) =>
          BUSY_FRIDAY.some(([s, e]) => {
            const ms = Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
            const me = Number(e.slice(0, 2)) * 60 + Number(e.slice(3));
            return t >= ms && t < me;
          });
        const proposedFree = times.filter((t) => !inBusy(t));
        const proposedBusy = times.filter((t) => inBusy(t));
        // PASS if a standalone proposed time exists and none collide with a
        // meeting. null (undetermined) if the reply only used ranges.
        timeOk = times.length === 0 ? null : proposedBusy.length === 0;
        notes.push(
          `${timeOk === true ? "✓" : timeOk === null ? "·" : "✗"} proposed free time: [${proposedFree.map(min2s).join(", ") || "none parsed (ranges only)"}]` +
            (proposedBusy.length ? `  CONFLICTS: [${proposedBusy.map(min2s).join(", ")}]` : ""),
        );
      }
      const pass = calledRightDay && sent && calledBeforeReply && timeOk !== false;
      return { pass, notes };
    },
  },
  invoice: {
    title: "Find Acme's latest invoice and confirm we'll pay by the due date",
    system:
      `You are an executive's email assistant. Today is ${TODAY}. ` +
      "Use the tools to find the relevant email and read it before answering. " +
      "When done, send a reply confirming payment, citing the exact amount and due date.",
    prompt:
      "Task: find the latest invoice from Acme (billing@acme.com), then reply to them confirming " +
      "we will pay the amount due by the due date. Mention the exact amount and due date in the reply.",
    check: (state) => {
      const notes = [];
      const searched = state.calls.some((c) => c.name === "search_emails");
      const gotLatest = state.calls.some((c) => c.name === "get_email" && c.args.id === "inv-88");
      const sent = !!state.sentReply;
      notes.push(`${searched ? "✓" : "✗"} searched the mailbox`);
      notes.push(`${gotLatest ? "✓" : "✗"} opened the LATEST invoice (inv-88, 2026-05-28)`);
      notes.push(`${sent ? "✓" : "✗"} sent a confirmation reply`);
      let amountOk = null;
      let dueOk = null;
      if (sent) {
        const b = state.sentReply.body.replace(/,/g, "");
        amountOk = /4250(\.00)?/.test(b) || /\$4250/.test(b) || state.sentReply.body.includes("4,250");
        dueOk = /2026-06-15/.test(state.sentReply.body) || /june\s*15/i.test(state.sentReply.body);
        notes.push(`${amountOk ? "✓" : "✗"} reply cites amount $4,250`);
        notes.push(`${dueOk ? "✓" : "✗"} reply cites due date 2026-06-15`);
      }
      const pass = searched && gotLatest && sent && amountOk === true && dueOk === true;
      return { pass, notes };
    },
  },
};

function min2s(m) {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ap = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm}${ap}`;
}

// ---------------------------------------------------------------------------
// Backend: Claude Agent SDK + Ollama (mirrors ClaudeAgentProvider)
// ---------------------------------------------------------------------------
const MODEL_ENV_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_CUSTOM_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

async function runClaude(scenario, state, model) {
  const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const tools = makeTools(state);
  const childEnv = { ...process.env };
  childEnv.ANTHROPIC_BASE_URL = "https://ollama.com";
  childEnv.ANTHROPIC_AUTH_TOKEN = OLLAMA_KEY;
  childEnv.ANTHROPIC_API_KEY = OLLAMA_KEY;
  for (const k of MODEL_ENV_VARS) childEnv[k] = model;
  childEnv.DISABLE_TELEMETRY = "1";
  childEnv.DISABLE_ERROR_REPORTING = "1";
  childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  delete childEnv.CLAUDECODE;

  const mcpServer = createSdkMcpServer({
    name: "mail-app-tools",
    version: "1.0.0",
    tools: tools.map((t) =>
      tool(t.name, t.description, t.shape, async (args) => ({
        content: [{ type: "text", text: JSON.stringify(t.run(args)) }],
      })),
    ),
  });

  state.t0 = performance.now();
  const q = query({
    prompt: scenario.prompt,
    options: {
      model,
      systemPrompt: scenario.system,
      mcpServers: { "mail-app-tools": mcpServer },
      allowedTools: tools.map((t) => `mcp__mail-app-tools__${t.name}`),
      maxTurns: 16,
      permissionMode: "bypassPermissions",
      settingSources: [],
      persistSession: false,
      env: childEnv,
      stderr: () => {},
    },
  });

  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content ?? []) {
        if (block.type === "text" && block.text.trim()) {
          state.assistantText = (state.assistantText ?? "") + block.text;
        }
      }
    }
  }
  state.elapsedMs = performance.now() - state.t0;
}

// ---------------------------------------------------------------------------
// Backend: OpenCode + Ollama (mirrors OpenCodeAgentProvider)
// ---------------------------------------------------------------------------
async function runOpencode(scenario, state, model) {
  const binDir = join(__dirname, "..", "node_modules", ".bin");
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  const { createOpencodeServer } = await import("@opencode-ai/sdk");
  const { createOpencodeClient } = await import("@opencode-ai/sdk/client");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");

  const tools = makeTools(state);
  const mcp = new McpServer({ name: "mail-app-tools", version: "1.0.0" });
  for (const t of tools) {
    mcp.registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(t.run(args)) }] }),
    );
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);
  const httpServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = s ? JSON.parse(s) : undefined;
      } catch {
        /* ignore */
      }
      transport.handleRequest(req, res, body).catch(() => {});
    });
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const bridgeUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;

  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 60_000,
    config: {
      logLevel: "WARN",
      mcp: { "mail-app-tools": { type: "remote", url: bridgeUrl, enabled: true } },
      permission: { edit: "allow", bash: "allow", webfetch: "allow" },
      disabled_providers: ["github-copilot", "openrouter", "google", "groq", "deepseek", "anthropic"],
      provider: {
        "ollama-cloud": {
          name: "Ollama Cloud",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://ollama.com/v1", apiKey: OLLAMA_KEY },
          models: { [model]: { id: model, name: model, tool_call: true } },
        },
      },
    },
  });
  const client = createOpencodeClient({ baseUrl: server.url });
  const session = await client.session.create({ body: { title: "agentic-minimax" } });
  const sessionId = session.data.id;

  const abort = new AbortController();
  const evs = (await client.event.subscribe({ signal: abort.signal })).stream[Symbol.asyncIterator]();
  state.t0 = performance.now();
  const promptPromise = client.session
    .promptAsync({
      path: { id: sessionId },
      body: {
        model: { providerID: "ollama-cloud", modelID: model },
        system: scenario.system,
        tools: { write: false, edit: false, read: false, glob: false, grep: false, bash: false },
        parts: [{ type: "text", text: scenario.prompt }],
      },
    })
    .catch((e) => {
      state.error = e?.message ?? String(e);
      abort.abort();
    });

  const timeout = setTimeout(() => {
    state.error = "150s timeout";
    abort.abort();
  }, 150_000);
  while (true) {
    const step = await evs.next();
    if (step.done) break;
    const ev = step.value;
    if (ev.type === "message.part.updated") {
      const part = ev.properties.part;
      if (part.type === "text" && part.sessionID === sessionId && part.text) {
        state.assistantText = part.text;
      }
    }
    if (ev.type === "session.idle" && ev.properties.sessionID === sessionId) break;
    if (ev.type === "session.error" && ev.properties.sessionID === sessionId) {
      state.error = JSON.stringify(ev.properties.error);
      break;
    }
  }
  clearTimeout(timeout);
  state.elapsedMs = performance.now() - state.t0;
  abort.abort();
  await promptPromise;
  server.close();
  httpServer.close();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
function fmtTimeline(state) {
  const parts = state.calls.map((c) => `+${(c.t / 1000).toFixed(1)}s ${c.name}`);
  parts.push(`${(state.elapsedMs / 1000).toFixed(1)}s done`);
  return parts.join("  ·  ");
}

async function runOne(model, backend, scenarioKey) {
  const scenario = SCENARIOS[scenarioKey];
  const state = { calls: [], trace: [], sentReply: null, assistantText: "", error: null, t0: 0 };
  console.log(`\n${"━".repeat(78)}`);
  console.log(`▶ ${model}  [${backend}]  ${scenario.title}`);
  console.log(`${"━".repeat(78)}`);
  console.log("  tool trace (with elapsed-since-prompt):");
  try {
    if (backend === "claude") await runClaude(scenario, state, model);
    else await runOpencode(scenario, state, model);
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  if (state.error) console.log(`  ⚠ run error: ${state.error}`);

  const { pass, notes } = scenario.check(state);
  console.log(`\n  checks:`);
  for (const n of notes) console.log(`    ${n}`);
  console.log(`  timeline: ${fmtTimeline(state)}`);
  console.log(`  reply:`);
  console.log(
    (state.sentReply?.body ?? state.assistantText ?? "(none)")
      .trim()
      .split("\n")
      .map((l) => "    | " + l)
      .join("\n"),
  );
  const verdict = pass && !state.error;
  const firstToolMs = state.calls[0]?.t ?? null;
  console.log(
    `\n  steps=${state.calls.length}  1st-action=${firstToolMs != null ? (firstToolMs / 1000).toFixed(1) + "s" : "—"}  total=${(state.elapsedMs / 1000).toFixed(1)}s  VERDICT: ${verdict ? "PASS ✅" : "FAIL ❌"}`,
  );
  return {
    model,
    backend,
    scenarioKey,
    pass: verdict,
    steps: state.calls.length,
    ms: state.elapsedMs,
    firstToolMs,
  };
}

async function main() {
  // Default to a head-to-head: the new model vs the current default vs prior MiniMax.
  const models = MODELS_OVERRIDE ?? ["minimax-m3:cloud", "kimi-k2.6:cloud", "minimax-m2.7:cloud"];
  const backends = ONLY_BACKEND ? [ONLY_BACKEND] : ["claude", "opencode"];
  const scenarios = ONLY_SCENARIO ? [ONLY_SCENARIO] : ["friday", "invoice"];
  console.log(`=== Multi-step SPEED comparison · today=${TODAY} ===`);
  console.log(`models: ${models.join(", ")}`);
  console.log(`backends: ${backends.join(", ")}  scenarios: ${scenarios.join(", ")}`);

  console.log(`trials: ${TRIALS} per cell (median reported)`);
  const rows = [];
  for (const m of models) {
    for (const s of scenarios) {
      for (const b of backends) {
        for (let i = 0; i < TRIALS; i++) rows.push(await runOne(m, b, s));
      }
    }
  }

  // Aggregate by (model, backend, scenario) over trials.
  const cells = [];
  for (const m of models) {
    for (const s of scenarios) {
      for (const b of backends) {
        const g = rows.filter((r) => r.model === m && r.backend === b && r.scenarioKey === s);
        if (!g.length) continue;
        cells.push({
          model: m,
          backend: b,
          scenario: s,
          n: g.length,
          steps: median(g.map((r) => r.steps)),
          firstMs: median(g.map((r) => r.firstToolMs)),
          totalMs: median(g.map((r) => r.ms)),
          passes: g.filter((r) => r.pass).length,
        });
      }
    }
  }

  const S = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(1) + "s");
  console.log(`\n${"═".repeat(78)}`);
  console.log(`SPEED COMPARISON (multi-step wall-clock, median of ${TRIALS})`);
  console.log(
    "model".padEnd(20) +
      "backend".padEnd(10) +
      "scenario".padEnd(9) +
      "steps".padStart(6) +
      "1st-act".padStart(9) +
      "total".padStart(9) +
      "  pass",
  );
  for (const c of cells) {
    console.log(
      c.model.padEnd(20) +
        c.backend.padEnd(10) +
        c.scenario.padEnd(9) +
        String(c.steps).padStart(6) +
        S(c.firstMs).padStart(9) +
        S(c.totalMs).padStart(9) +
        `  ${c.passes}/${c.n}`,
    );
  }

  console.log("\nPer-model median total (across scenarios/backends):");
  for (const m of models) {
    const mine = cells.filter((c) => c.model === m);
    console.log(
      `  ${m.padEnd(20)} median total=${S(median(mine.map((c) => c.totalMs)))}  median 1st-action=${S(median(mine.map((c) => c.firstMs)))}`,
    );
  }
  console.log(`${"═".repeat(78)}`);
  process.exit(rows.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
