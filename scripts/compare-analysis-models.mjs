#!/usr/bin/env node
/**
 * Benchmark email analysis latency + output quality across LLM models.
 *
 * Pulls 50 recent inbox emails from .dev-data, runs the same analysis prompt
 * through each (model, thinking) combination, and produces a table comparing:
 *   - p50/p95 latency
 *   - JSON validity rate
 *   - needs_reply agreement vs Claude Sonnet baseline
 *   - per-email disagreement examples
 *
 * Robust to flakes: persists after every combo, skips combos already in the
 * results file, retries transient network errors, and uses concurrency=3 +
 * 4-minute per-request timeouts so long-running combos don't drop sockets.
 *
 * Resume support:
 *   - Re-running this script picks up where it left off.
 *   - Delete analysis-benchmark-results.json to start fresh.
 *
 * Usage:
 *   OLLAMA_API_KEY=... ANTHROPIC_API_KEY=... node scripts/compare-analysis-models.mjs
 */

import Database from "better-sqlite3";
import { default as Anthropic } from "@anthropic-ai/sdk";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", ".dev-data", "data", "exo.db");
const RESULTS_PATH = join(__dirname, "..", "analysis-benchmark-results.json");

const OLLAMA_KEY = process.env.OLLAMA_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!OLLAMA_KEY) {
  console.error("OLLAMA_API_KEY env var is required");
  process.exit(1);
}

const ANALYSIS_SYSTEM_PROMPT = `Analyze this email and decide if it requires a reply from me.

NEEDS REPLY (Priority):
- Direct questions addressed to me
- Requests requiring my response or decision
- Meeting coordination needing my input
- Business/personal emails expecting a reply
- Action items assigned to me
- Anything that requires me to do external work (update a doc, send an invite, etc.)

OTHER (no reply needed):
- Newsletters, marketing, promotions
- Automated notifications (GitHub, CI/CD, receipts, shipping, alerts)
- Calendar invites (handled by calendar app)
- CC'd emails where I'm not the primary recipient
- FYI-only messages with no question or action
- Transactional emails (order confirmations, password resets, etc.)
- Social media notifications
- Mailing list digests

RESPOND WITH ONLY VALID JSON (no markdown, no code blocks):
{
  "needs_reply": true or false,
  "reason": "brief explanation"
}`;

const MODELS = [
  // Anthropic baseline — what the user was on before
  { id: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4.5", provider: "anthropic", thinkingModes: [null] },

  // 5 Ollama models, different architectures / sizes
  { id: "kimi-k2.6:cloud", label: "kimi-k2.6", provider: "ollama", thinkingModes: [false, true] },
  { id: "deepseek-v4-pro:cloud", label: "deepseek-v4-pro", provider: "ollama", thinkingModes: [false, true] },
  { id: "qwen3.5:397b", label: "qwen3.5:397b", provider: "ollama", thinkingModes: [false, true] },
  { id: "gpt-oss:120b", label: "gpt-oss:120b", provider: "ollama", thinkingModes: [false, "low", "high"] },
  { id: "glm-5", label: "glm-5", provider: "ollama", thinkingModes: [false, true] },
];

const N_EMAILS = 50;
const CONCURRENCY = 3;
const PER_REQUEST_RETRIES = 2;
const PER_REQUEST_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes per request

// ---------------------------------------------------------------------------

function fetchEmails() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT e.id, e.subject, e.from_address as "from", e.to_address as "to",
              e.date, e.body, e.snippet
       FROM emails e
       WHERE e.label_ids LIKE '%"INBOX"%'
         AND e.body IS NOT NULL AND length(e.body) > 0
       ORDER BY e.date DESC
       LIMIT ?`,
    )
    .all(N_EMAILS);
  db.close();
  return rows;
}

function buildUserMessage(email) {
  const body = email.body.length > 4000 ? email.body.slice(0, 4000) + "\n[...truncated]" : email.body;
  return `<untrusted-email>
From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date}

${body}
</untrusted-email>`;
}

function tryParseJson(text) {
  try {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

async function callOllamaWithRetry(modelId, think, userMessage) {
  let lastErr = null;
  for (let attempt = 0; attempt <= PER_REQUEST_RETRIES; attempt++) {
    const body = {
      model: modelId,
      stream: false,
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      options: { num_predict: 4096 },
    };
    if (think !== false && think !== null) body.think = think;
    else if (think === false) body.think = false;

    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
      const res = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OLLAMA_KEY}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      const elapsed = Date.now() - t0;
      const text = await res.text();
      if (res.status === 503 || res.status >= 500) {
        lastErr = `HTTP ${res.status}: ${text.slice(0, 100)}`;
        if (attempt < PER_REQUEST_RETRIES) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        return { ok: false, error: lastErr, elapsedMs: elapsed };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, elapsedMs: elapsed };
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { ok: false, error: "invalid response JSON", elapsedMs: elapsed }; }
      const content = parsed.message?.content ?? "";
      const thinking = parsed.message?.thinking ?? "";
      const json = tryParseJson(content);
      return { ok: true, elapsedMs: elapsed, contentChars: content.length, thinkingChars: thinking.length, parsed: json, rawContent: content.slice(0, 300), retries: attempt };
    } catch (err) {
      lastErr = err.name === "AbortError" ? "timeout" : err.message ?? String(err);
      if (attempt < PER_REQUEST_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return { ok: false, error: lastErr, elapsedMs: Date.now() - t0 };
    }
  }
  return { ok: false, error: lastErr ?? "unknown", elapsedMs: 0 };
}

async function callAnthropic(modelId, userMessage) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const t0 = Date.now();
  try {
    const res = await client.messages.create({
      model: modelId,
      max_tokens: 256,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const elapsed = Date.now() - t0;
    const textBlock = res.content.find((b) => b.type === "text");
    const content = textBlock?.text ?? "";
    return { ok: true, elapsedMs: elapsed, contentChars: content.length, thinkingChars: 0, parsed: tryParseJson(content), rawContent: content.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err), elapsedMs: Date.now() - t0 };
  }
}

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      done++;
      if (done % 10 === 0 || done === items.length) {
        process.stdout.write(`  progress ${done}/${items.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

// ---------------------------------------------------------------------------

async function runCombo(model, thinkMode, emails) {
  const userMessages = emails.map(buildUserMessage);
  const label = `${model.label}${thinkMode === null ? "" : ` think=${thinkMode}`}`;
  console.log(`\n[${new Date().toISOString().slice(11, 19)}] running ${label} (n=${emails.length}, conc=${CONCURRENCY})`);

  const startedAt = Date.now();
  const results = await runWithConcurrency(
    userMessages.map((m, i) => ({ msg: m, emailId: emails[i].id })),
    async (item) => {
      if (model.provider === "anthropic") return callAnthropic(model.id, item.msg);
      return callOllamaWithRetry(model.id, thinkMode, item.msg);
    },
    CONCURRENCY,
  );
  const wallClockMs = Date.now() - startedAt;

  const oks = results.filter((r) => r.ok);
  const errs = results.filter((r) => !r.ok);
  const validJson = oks.filter((r) => r.parsed && typeof r.parsed.needs_reply === "boolean");
  const latencies = oks.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const thinkingChars = oks.map((r) => r.thinkingChars ?? 0).sort((a, b) => a - b);

  return {
    label, model: model.label, thinkMode,
    n: results.length, successes: oks.length, errors: errs.length,
    errorSamples: errs.slice(0, 3).map((e) => e.error?.slice(0, 100)),
    validJson: validJson.length,
    p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95),
    meanMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    wallClockMs,
    medianThinkingChars: percentile(thinkingChars, 0.5),
    perEmail: results.map((r, i) => ({
      emailId: emails[i].id,
      subject: emails[i].subject?.slice(0, 80),
      from: emails[i].from?.slice(0, 60),
      needs_reply: r.ok ? r.parsed?.needs_reply ?? null : null,
      reason: r.ok ? r.parsed?.reason?.slice(0, 120) : null,
      latencyMs: r.elapsedMs,
      error: r.ok ? null : r.error,
      thinkingChars: r.thinkingChars ?? 0,
    })),
  };
}

function loadResults() {
  if (!existsSync(RESULTS_PATH)) return { ranAt: new Date().toISOString(), runs: [] };
  try { return JSON.parse(readFileSync(RESULTS_PATH, "utf-8")); } catch { return { ranAt: new Date().toISOString(), runs: [] }; }
}

function saveResults(data) {
  writeFileSync(RESULTS_PATH, JSON.stringify(data, null, 2));
}

function comboAlreadyDone(data, modelLabel, thinkMode) {
  return (data.runs ?? []).some(
    (r) => r.model === modelLabel && r.thinkMode === thinkMode && r.successes && r.successes >= N_EMAILS * 0.8,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  if (!ANTHROPIC_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY required for the Claude baseline.");
    process.exit(1);
  }

  console.log(`Fetching ${N_EMAILS} recent inbox emails from ${DB_PATH}...`);
  const emails = fetchEmails();
  console.log(`Got ${emails.length} emails.`);

  const data = loadResults();
  data.nEmails = emails.length;
  console.log(`Loaded ${data.runs?.length ?? 0} existing runs from ${RESULTS_PATH}`);

  for (const model of MODELS) {
    for (const think of model.thinkingModes) {
      if (comboAlreadyDone(data, model.label, think)) {
        console.log(`\n[${new Date().toISOString().slice(11, 19)}] SKIP ${model.label} think=${think} — already done`);
        continue;
      }
      try {
        const run = await runCombo(model, think, emails);
        // Replace any prior partial result for this combo and append the fresh one
        data.runs = (data.runs ?? []).filter((r) => !(r.model === model.label && r.thinkMode === think));
        data.runs.push(run);
        saveResults(data);
        console.log(
          `  → ${run.successes}/${run.n} ok, ${run.errors} errors, p50=${run.p50Ms}ms p95=${run.p95Ms}ms median_thinking=${run.medianThinkingChars}c [persisted]`,
        );
      } catch (err) {
        console.error(`  ✗ ${model.label} think=${think} crashed:`, err.message);
      }
    }
  }

  // --- Cross-model agreement vs Claude baseline ---
  const baseline = data.runs.find((r) => r.model === "claude-sonnet-4.5");
  if (baseline) {
    for (const run of data.runs) {
      if (run === baseline) { run.agreementWithClaude = 1.0; run.disagreements = []; continue; }
      let matches = 0, comparable = 0;
      const disagreements = [];
      for (let i = 0; i < baseline.perEmail.length; i++) {
        const b = baseline.perEmail[i].needs_reply;
        const r = run.perEmail[i]?.needs_reply;
        if (b === null || r === null) continue;
        comparable++;
        if (b === r) matches++;
        else disagreements.push({
          subject: baseline.perEmail[i].subject,
          claude_needs_reply: b, claude_reason: baseline.perEmail[i].reason,
          model_needs_reply: r, model_reason: run.perEmail[i].reason,
        });
      }
      run.agreementWithClaude = comparable > 0 ? matches / comparable : 0;
      run.comparableCount = comparable;
      run.disagreements = disagreements.slice(0, 5);
    }
    saveResults(data);
  }

  // --- Summary table ---
  console.log("\n\n========== SUMMARY ==========\n");
  const fmt = (n, w = 8) => String(n).padStart(w);
  console.log(
    fmt("model", 24) + " | " + fmt("think", 8) + " | " + fmt("p50 ms", 8) + " | " +
    fmt("p95 ms", 8) + " | " + fmt("mean ms", 8) + " | " + fmt("ok/n", 8) + " | " +
    fmt("jsonOk", 8) + " | " + fmt("thinkC", 8) + " | " + fmt("agree%", 8),
  );
  console.log("-".repeat(110));
  for (const run of data.runs) {
    const t = String(run.thinkMode ?? "—");
    const okStr = `${run.successes}/${run.n}`;
    const agree = run.agreementWithClaude !== undefined ? (run.agreementWithClaude * 100).toFixed(0) + "%" : "—";
    console.log(
      fmt(run.model, 24) + " | " + fmt(t, 8) + " | " + fmt(run.p50Ms, 8) + " | " +
      fmt(run.p95Ms, 8) + " | " + fmt(run.meanMs, 8) + " | " + fmt(okStr, 8) + " | " +
      fmt(run.validJson, 8) + " | " + fmt(run.medianThinkingChars, 8) + " | " + fmt(agree, 8),
    );
  }

  console.log("\n\n========== DISAGREEMENT SAMPLES (vs Claude Sonnet) ==========");
  for (const run of data.runs) {
    if (!run.disagreements || run.disagreements.length === 0) continue;
    console.log(`\n${run.label}: showing ${run.disagreements.length} disagreement(s)`);
    for (const d of run.disagreements) {
      console.log(`  • "${d.subject}"`);
      console.log(`    Claude: needs_reply=${d.claude_needs_reply} — ${d.claude_reason}`);
      console.log(`    ${run.label}: needs_reply=${d.model_needs_reply} — ${d.model_reason}`);
    }
  }

  console.log(`\nRaw data → ${RESULTS_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
