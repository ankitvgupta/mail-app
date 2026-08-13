#!/usr/bin/env node
/**
 * Retry failed combos from compare-analysis-models.mjs with lower concurrency
 * and per-request retry. Reads existing results, runs just the failed combos,
 * merges into the same output file.
 *
 * Usage:
 *   OLLAMA_API_KEY=... node scripts/compare-analysis-models-retry.mjs
 *
 * Concurrency=2 (vs 5 in the main script) and 2 retries on transient
 * errors (network failures, 503, 5xx).
 */

import Database from "better-sqlite3";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", ".dev-data", "data", "exo.db");
const RESULTS_PATH = join(__dirname, "..", "analysis-benchmark-results.json");

const OLLAMA_KEY = process.env.OLLAMA_API_KEY;

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

// Only the combos that failed in the main run
const RETRY_COMBOS = [
  { id: "deepseek-v4-pro:cloud", label: "deepseek-v4-pro", thinkMode: true },
  { id: "qwen3.5:397b", label: "qwen3.5:397b", thinkMode: false },
  { id: "qwen3.5:397b", label: "qwen3.5:397b", thinkMode: true },
];

const N_EMAILS = 50;
const CONCURRENCY = 2;
const PER_REQUEST_RETRIES = 2;
const PER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per request

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
  const body =
    email.body.length > 4000 ? email.body.slice(0, 4000) + "\n[...truncated]" : email.body;
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
      if (!res.ok)
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, elapsedMs: elapsed };
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, error: "invalid response JSON", elapsedMs: elapsed };
      }
      const content = parsed.message?.content ?? "";
      const thinking = parsed.message?.thinking ?? "";
      const json = tryParseJson(content);
      return {
        ok: true,
        elapsedMs: elapsed,
        contentChars: content.length,
        thinkingChars: thinking.length,
        parsed: json,
        rawContent: content.slice(0, 300),
        retries: attempt,
      };
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

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker(workerId) {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      done++;
      if (done % 5 === 0 || done === items.length) {
        process.stdout.write(`  [worker ${workerId}] done ${done}/${items.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i + 1)));
  return results;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

async function runCombo(combo, emails) {
  const userMessages = emails.map(buildUserMessage);
  const label = `${combo.label}${combo.thinkMode === null ? "" : ` think=${combo.thinkMode}`}`;
  console.log(
    `\n[${new Date().toISOString().slice(11, 19)}] retrying ${label} (n=${emails.length}, conc=${CONCURRENCY}, retries=${PER_REQUEST_RETRIES})`,
  );

  const startedAt = Date.now();
  const results = await runWithConcurrency(
    userMessages.map((m, i) => ({ msg: m, emailId: emails[i].id })),
    async (item) => callOllamaWithRetry(combo.id, combo.thinkMode, item.msg),
    CONCURRENCY,
  );
  const wallClockMs = Date.now() - startedAt;

  const oks = results.filter((r) => r.ok);
  const errs = results.filter((r) => !r.ok);
  const validJson = oks.filter((r) => r.parsed && typeof r.parsed.needs_reply === "boolean");
  const latencies = oks.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const thinkingChars = oks.map((r) => r.thinkingChars ?? 0).sort((a, b) => a - b);

  return {
    label,
    model: combo.label,
    thinkMode: combo.thinkMode,
    n: results.length,
    successes: oks.length,
    errors: errs.length,
    errorSamples: errs.slice(0, 3).map((e) => e.error?.slice(0, 100)),
    validJson: validJson.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    meanMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    wallClockMs,
    medianThinkingChars: percentile(thinkingChars, 0.5),
    retriesUsed: oks.reduce((sum, r) => sum + (r.retries ?? 0), 0),
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

async function main() {
  const emails = fetchEmails();
  console.log(`Got ${emails.length} emails.`);

  // Load existing results so we can merge
  let existing = { ranAt: null, nEmails: emails.length, runs: [] };
  if (existsSync(RESULTS_PATH)) {
    existing = JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));
    console.log(`Loaded ${existing.runs?.length ?? 0} existing runs from ${RESULTS_PATH}`);
  } else {
    console.log("No existing results file — will write a fresh one.");
  }

  const newRuns = [];
  for (const combo of RETRY_COMBOS) {
    try {
      const run = await runCombo(combo, emails);
      newRuns.push(run);
      console.log(
        `  → ${run.successes}/${run.n} ok, ${run.errors} errors, p50=${run.p50Ms}ms p95=${run.p95Ms}ms median_thinking=${run.medianThinkingChars}c retries=${run.retriesUsed}`,
      );
    } catch (err) {
      console.error(`  ✗ ${combo.label} think=${combo.thinkMode} crashed:`, err.message);
      newRuns.push({
        label: `${combo.label} think=${combo.thinkMode}`,
        model: combo.label,
        thinkMode: combo.thinkMode,
        crashed: true,
        crashError: err.message,
      });
    }
  }

  // Merge: replace any existing runs that match (same model + thinkMode) with the new ones,
  // append the rest.
  const existingRuns = existing.runs ?? [];
  const merged = existingRuns.filter(
    (r) => !newRuns.some((n) => n.model === r.model && n.thinkMode === r.thinkMode),
  );
  merged.push(...newRuns);

  writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        ranAt: existing.ranAt,
        retryRanAt: new Date().toISOString(),
        nEmails: emails.length,
        runs: merged,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote merged results to ${RESULTS_PATH} (${merged.length} total runs).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
