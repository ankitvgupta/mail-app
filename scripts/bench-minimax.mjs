#!/usr/bin/env node
/**
 * Quality + speed benchmark for the new MiniMax model on Ollama Cloud, measured
 * on BOTH harness transports the app uses:
 *   - "anthropic"  -> https://ollama.com           (the Claude Agent SDK path)
 *   - "openai"     -> https://ollama.com/v1         (the OpenCode path)
 *
 * For each (model, transport) it streams a realistic email-drafting task and
 * records:
 *   - ttft_ms          : wall time to the FIRST streamed token (incl. reasoning)
 *   - ttfv_ms          : wall time to the first VISIBLE answer token (the draft;
 *                        reasoning is hidden in the real app, so this is what a
 *                        user actually waits for)
 *   - total_ms         : wall time to completion
 *   - completion_tokens: from the provider's usage (incl. reasoning tokens)
 *   - tok_s            : completion_tokens / generation time
 *   - reasoning?       : whether the model emitted a chain-of-thought
 * and prints the full draft so quality can be judged by eye.
 *
 * Usage:
 *   node scripts/bench-minimax.mjs
 *   node scripts/bench-minimax.mjs --models minimax-m3:cloud,kimi-k2.6:cloud
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/load-env.mjs";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv(join(__dirname, "..", ".env"));
loadEnv(join(__dirname, "..", ".env.local"));

const KEY = process.env.OLLAMA_API_KEY;
if (!KEY) {
  console.error("FAIL: OLLAMA_API_KEY required");
  process.exit(1);
}

const argModels = process.argv.indexOf("--models");
const MODELS =
  argModels !== -1 && process.argv[argModels + 1]
    ? process.argv[argModels + 1].split(",")
    : [
        "minimax-m3:cloud", // the new model under test
        "minimax-m2.7:cloud", // prior MiniMax for a within-family comparison
        "kimi-k2.6:cloud", // the app's CURRENT default (baseline)
      ];

// A realistic inbound thread + drafting instruction. No tools — this isolates
// pure generation quality and speed, which is what draft-generator.ts exercises.
const SYSTEM =
  "You are an executive's email assistant. Write concise, warm, professional replies in the executive's voice. " +
  "Return ONLY the reply body — no subject line, no preamble, no sign-off placeholders like [Name].";
const USER = `Reply to this email. Decline the speaking slot politely but offer to send a short written Q&A instead, and ask for their deadline.

From: Priya Nadar <priya@devsummit.io>
Subject: Keynote invite — DevSummit 2026 (June 18, Lisbon)

Hi Ankit,

We'd love to have you keynote DevSummit 2026 in Lisbon on June 18. The slot is 45 minutes plus 15 of Q&A, audience ~1,200 engineers. We can cover travel and two nights' hotel. Could you let us know by next Friday if you're able to join?

Thanks so much,
Priya`;

// Mirror the app: llm-service.ts floors Ollama max_tokens at 4096 so reasoning
// models can finish their hidden chain-of-thought AND still emit the answer.
// (Cost is $0 on the Ollama subscription, so the ceiling is free.)
const MAX_TOKENS = 4096;
const argTrials = process.argv.indexOf("--trials");
const TRIALS = argTrials !== -1 && process.argv[argTrials + 1] ? Number(process.argv[argTrials + 1]) : 3;

function median(arr) {
  const v = arr.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// --- Anthropic-compatible transport (Claude Agent SDK harness path) ---
async function runAnthropic(model, t0) {
  const client = new Anthropic({ baseURL: "https://ollama.com", authToken: KEY });
  let ttft = null;
  let ttfv = null;
  let answer = "";
  let reasoning = "";
  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: "user", content: USER }],
  });
  stream.on("streamEvent", (ev) => {
    if (ev.type === "content_block_delta") {
      if (ttft === null) ttft = performance.now() - t0;
      const d = ev.delta;
      if (d.type === "text_delta") {
        if (ttfv === null) ttfv = performance.now() - t0;
        answer += d.text;
      } else if (d.type === "thinking_delta") {
        reasoning += d.thinking ?? "";
      }
    }
  });
  const final = await stream.finalMessage();
  const total = performance.now() - t0;
  const completion = final.usage?.output_tokens ?? 0;
  return { ttft, ttfv, total, completion, answer, reasoning };
}

// --- OpenAI-compatible transport (OpenCode harness path) ---
async function runOpenAI(model, t0) {
  let ttft = null;
  let ttfv = null;
  let answer = "";
  let reasoning = "";
  let completion = 0;
  const res = await fetch("https://ollama.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage?.completion_tokens != null) completion = json.usage.completion_tokens;
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      const r = delta.reasoning ?? delta.reasoning_content;
      if (r) {
        if (ttft === null) ttft = performance.now() - t0;
        reasoning += r;
      }
      if (delta.content) {
        if (ttft === null) ttft = performance.now() - t0;
        if (ttfv === null) ttfv = performance.now() - t0;
        answer += delta.content;
      }
    }
  }
  const total = performance.now() - t0;
  return { ttft, ttfv, total, completion, answer, reasoning };
}

async function bench(model, transport) {
  const t0 = performance.now();
  const fn = transport === "anthropic" ? runAnthropic : runOpenAI;
  const r = await fn(model, t0);
  // Throughput over the FULL generation window (first token -> done), since
  // completion_tokens counts reasoning + answer alike.
  const genMs = r.ttft != null ? r.total - r.ttft : r.total;
  const tokS = r.completion && genMs > 0 ? r.completion / (genMs / 1000) : 0;
  // Hidden "thinking" latency = gap between first token and first visible answer.
  const thinkMs = r.ttft != null && r.ttfv != null ? r.ttfv - r.ttft : null;
  return { model, transport, ...r, tokS, thinkMs };
}

async function benchTrials(model, transport) {
  const trials = [];
  let lastDraft = null;
  for (let i = 0; i < TRIALS; i++) {
    try {
      const r = await bench(model, transport);
      trials.push(r);
      if (r.answer?.trim()) lastDraft = r;
      else if (!lastDraft) lastDraft = r;
    } catch (e) {
      trials.push({ model, transport, error: e.message });
    }
  }
  const ok = trials.filter((t) => !t.error);
  const agg = {
    model,
    transport,
    n: ok.length,
    errors: trials.filter((t) => t.error).map((t) => t.error),
    ttft: median(ok.map((t) => t.ttft)),
    ttfv: median(ok.map((t) => t.ttfv)),
    thinkMs: median(ok.map((t) => t.thinkMs)),
    total: median(ok.map((t) => t.total)),
    completion: median(ok.map((t) => t.completion)),
    tokS: median(ok.map((t) => t.tokS)),
    reasoning: ok.some((t) => t.reasoning),
    answeredEvery: ok.length > 0 && ok.every((t) => t.answer?.trim()),
    draft: lastDraft,
  };
  return agg;
}

function fmt(n, d = 0) {
  return n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

async function main() {
  console.log("=== MiniMax quality + speed benchmark (Ollama Cloud) ===");
  console.log(`task: realistic email reply (decline keynote, offer Q&A)`);
  console.log(`max_tokens=${MAX_TOKENS} (app floor)  trials=${TRIALS} (median reported)`);
  console.log(`models: ${MODELS.join(", ")}`);
  console.log("");

  const rows = [];

  // Primary comparison: all models on the Anthropic transport (Claude SDK path).
  for (const model of MODELS) {
    process.stdout.write(`[anthropic] ${model} ×${TRIALS} … `);
    const r = await benchTrials(model, "anthropic");
    rows.push(r);
    console.log(
      `ttft=${fmt(r.ttft)} think=${fmt(r.thinkMs)} total=${fmt(r.total)} tok=${fmt(r.completion)} tok/s=${fmt(r.tokS, 1)}` +
        `${r.answeredEvery ? "" : "  ⚠ incomplete"}${r.errors.length ? `  ERR:${r.errors[0]}` : ""}`,
    );
  }

  // Transport parity: the new model on the OpenCode (OpenAI-compat) transport.
  process.stdout.write(`[openai   ] minimax-m3:cloud ×${TRIALS} … `);
  const oc = await benchTrials("minimax-m3:cloud", "openai");
  rows.push(oc);
  console.log(
    `ttft=${fmt(oc.ttft)} think=${fmt(oc.thinkMs)} total=${fmt(oc.total)} tok=${fmt(oc.completion)} tok/s=${fmt(oc.tokS, 1)}` +
      `${oc.answeredEvery ? "" : "  ⚠ incomplete"}${oc.errors.length ? `  ERR:${oc.errors[0]}` : ""}`,
  );

  console.log("\n================= SPEED (median of " + TRIALS + ") =================");
  const H = (s, w) => s.padStart(w);
  console.log(
    "model".padEnd(20) +
      "transport".padEnd(11) +
      H("ttft(ms)", 10) +
      H("think(ms)", 11) +
      H("total(ms)", 11) +
      H("out_tok", 9) +
      H("tok/s", 8),
  );
  for (const r of rows) {
    console.log(
      r.model.padEnd(20) +
        r.transport.padEnd(11) +
        fmt(r.ttft).padStart(10) +
        fmt(r.thinkMs).padStart(11) +
        fmt(r.total).padStart(11) +
        fmt(r.completion).padStart(9) +
        fmt(r.tokS, 1).padStart(8),
    );
  }
  console.log("ttft=time to 1st token · think=1st token→1st visible answer · total=full draft ready");

  console.log("\n================= DRAFTS (quality) =================");
  for (const r of rows) {
    const d = r.draft;
    console.log(`\n----- ${r.model}  [${r.transport}]${r.reasoning ? "  (reasoning emitted)" : ""} -----`);
    console.log(d?.answer?.trim() || "(no visible answer produced within token budget)");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
