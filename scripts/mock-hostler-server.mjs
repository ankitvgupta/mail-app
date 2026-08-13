#!/usr/bin/env node
/**
 * Mock Hostler control plane for local end-to-end verification of the
 * Hostler agent provider — exercises the full client-tools loop (agent sync,
 * session lifecycle, SSE event log with replay, park-and-post tool results)
 * without a hostler.dev subscription or a real sandbox.
 *
 * Usage:
 *   node scripts/mock-hostler-server.mjs [port]     # default 7431
 *
 * Then point the app at it: Settings → Extensions → Hostler (enable, any
 * API key), and set "baseUrl": "http://127.0.0.1:7431" in the hostler block
 * of the dev config (.dev-data/config.json).
 *
 * Scripted "model" behavior per user message:
 *   - If the agent has a read_email client tool and the message mentions
 *     "email ID: <id>", it calls read_email({emailId}) — parked as a client
 *     tool call — then summarizes the result it got back.
 *   - Otherwise it replies with a canned message.
 * Both paths end with agent.message + session.status_idle(end_turn).
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.argv[2] ?? 7431);

/** @type {Map<string, {id: string, versions: {version: number, config: unknown}[], createdAt: string}>} */
const agents = new Map();
/** @type {Map<string, MockSession>} */
const sessions = new Map();

class MockSession {
  constructor(agentId, agentVersion, title) {
    this.id = `ses_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.agentId = agentId;
    this.agentVersion = agentVersion;
    this.title = title ?? null;
    this.status = "starting";
    this.createdAt = new Date().toISOString();
    this.terminatedAt = null;
    this.seq = 0;
    /** @type {object[]} */
    this.events = [];
    /** @type {Set<import("node:http").ServerResponse>} */
    this.subscribers = new Set();
    /** @type {Map<string, (result: {content?: string, error?: string}) => void>} */
    this.parkedTools = new Map();
  }

  row() {
    return {
      id: this.id,
      agentId: this.agentId,
      agentVersion: this.agentVersion,
      status: this.status,
      title: this.title,
      createdAt: this.createdAt,
      terminatedAt: this.terminatedAt,
      environmentId: null,
      vaultIds: [],
      deploymentId: null,
    };
  }

  append(event) {
    this.seq += 1;
    const full = { seq: this.seq, id: `sevt_${randomUUID().slice(0, 8)}`, ts: Date.now(), ...event };
    this.events.push(full);
    for (const res of this.subscribers) {
      res.write(`id: ${full.seq}\ndata: ${JSON.stringify(full)}\n\n`);
    }
    return full;
  }

  terminate(reason) {
    if (this.status === "terminated") return;
    this.status = "terminated";
    this.terminatedAt = new Date().toISOString();
    this.append({ type: "session.status_terminated", reason });
    for (const res of this.subscribers) res.end();
    this.subscribers.clear();
  }

  /** The scripted "model": one turn per user message. */
  async runTurn(text) {
    this.status = "running";
    this.append({ type: "user.message", text });
    this.append({ type: "session.status_running" });
    this.append({ type: "agent.thinking_delta", text: "Considering the request…" });

    const agent = agents.get(this.agentId);
    const config = agent?.versions.find((v) => v.version === this.agentVersion)?.config;
    const hasReadEmail = (config?.clientTools ?? []).some((t) => t.name === "read_email");
    const emailIdMatch = text.match(/email ID: (\S+)/);

    if (hasReadEmail && emailIdMatch) {
      const emailId = emailIdMatch[1];
      const toolCallId = `call_${randomUUID().slice(0, 8)}`;
      for (const chunk of ["Let me ", "read that email."]) {
        this.append({ type: "agent.message_delta", text: chunk });
      }
      this.append({ type: "agent.message", text: "Let me read that email." });
      this.append({
        type: "agent.tool_use",
        toolCallId,
        name: "read_email",
        input: { emailId },
        locale: "client",
        evaluatedPermission: "allow",
      });
      this.append({ type: "agent.tool_pending", toolCallId, name: "read_email", pendingState: "async" });

      const result = await new Promise((resolve) => this.parkedTools.set(toolCallId, resolve));
      this.append({
        type: "agent.tool_result",
        toolCallId,
        name: "read_email",
        isError: Boolean(result.error),
        content: [{ type: "text", text: result.error ?? result.content ?? "" }],
      });

      const summary = result.error
        ? `The read_email tool failed: ${result.error}`
        : `Here is what I found (via the local read_email tool): ${String(result.content).slice(0, 200)}`;
      for (const chunk of chunkText(summary)) {
        this.append({ type: "agent.message_delta", text: chunk });
      }
      this.append({ type: "agent.message", text: summary });
    } else {
      const reply = `Mock Hostler agent reply. I received your message (${text.length} chars) and have ${
        (config?.clientTools ?? []).length
      } client tools available.`;
      for (const chunk of chunkText(reply)) {
        this.append({ type: "agent.message_delta", text: chunk });
      }
      this.append({ type: "agent.message", text: reply });
    }

    this.status = "idle";
    this.append({ type: "session.status_idle", stopReason: { type: "end_turn" } });
  }
}

function chunkText(text, size = 24) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "invalid credentials" });

  try {
    // --- Agents ---
    if (req.method === "POST" && path === "/v1/agents") {
      const config = await readBody(req);
      const id = `agt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const agent = { id, versions: [{ version: 1, config }], createdAt: new Date().toISOString() };
      agents.set(id, agent);
      console.log(`[mock-hostler] agent created: ${id} (${config.name}), harness=${config.harness}`);
      return json(res, 201, { id, version: 1, config, createdAt: agent.createdAt });
    }
    if (req.method === "GET" && path === "/v1/agents") {
      const list = [...agents.values()].map((a) => {
        const latest = a.versions[a.versions.length - 1];
        return { id: a.id, version: latest.version, config: latest.config, createdAt: a.createdAt };
      });
      return json(res, 200, { agents: list });
    }
    let m = path.match(/^\/v1\/agents\/([^/]+)\/versions$/);
    if (req.method === "POST" && m) {
      const agent = agents.get(m[1]);
      if (!agent) return json(res, 404, { error: `unknown agent "${m[1]}"` });
      const config = await readBody(req);
      const version = agent.versions[agent.versions.length - 1].version + 1;
      agent.versions.push({ version, config });
      console.log(`[mock-hostler] agent ${m[1]} → v${version}`);
      return json(res, 200, { id: agent.id, version, config, createdAt: agent.createdAt });
    }
    m = path.match(/^\/v1\/agents\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const agent = agents.get(m[1]);
      if (!agent) return json(res, 404, { error: `unknown agent "${m[1]}"` });
      const latest = agent.versions[agent.versions.length - 1];
      return json(res, 200, { id: agent.id, version: latest.version, config: latest.config, createdAt: agent.createdAt });
    }

    // --- Sessions ---
    if (req.method === "POST" && path === "/v1/sessions") {
      const body = await readBody(req);
      const agent = agents.get(body.agentId);
      if (!agent) return json(res, 404, { error: `unknown agent "${body.agentId}"` });
      const version = body.agentVersion ?? agent.versions[agent.versions.length - 1].version;
      const session = new MockSession(body.agentId, version, body.title);
      sessions.set(session.id, session);
      console.log(`[mock-hostler] session created: ${session.id} (agent v${version})`);
      return json(res, 201, session.row());
    }
    if (req.method === "GET" && path === "/v1/sessions") {
      return json(res, 200, { sessions: [...sessions.values()].map((s) => s.row()) });
    }
    m = path.match(/^\/v1\/sessions\/([^/]+)$/);
    if (m) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: `unknown session "${m[1]}"` });
      if (req.method === "GET") return json(res, 200, session.row());
      if (req.method === "DELETE") {
        session.terminate("deleted by client");
        console.log(`[mock-hostler] session terminated: ${session.id}`);
        return json(res, 200, session.row());
      }
    }
    m = path.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (req.method === "POST" && m) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: `unknown session "${m[1]}"` });
      if (session.status === "terminated") return json(res, 409, { error: "session is not live" });
      const body = await readBody(req);
      void session.runTurn(String(body.text ?? ""));
      return json(res, 202, { accepted: true });
    }
    m = path.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (req.method === "GET" && m) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: `unknown session "${m[1]}"` });
      const since = Number(url.searchParams.get("since") ?? req.headers["last-event-id"] ?? 0);
      const backlog = session.events.filter((e) => e.seq > since);
      if ((req.headers.accept ?? "").includes("text/event-stream")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        for (const e of backlog) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        if (session.status === "terminated") return res.end();
        session.subscribers.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(ping);
          session.subscribers.delete(res);
        });
        return;
      }
      return json(res, 200, { events: backlog });
    }
    m = path.match(/^\/v1\/sessions\/([^/]+)\/tool_results$/);
    if (req.method === "POST" && m) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: `unknown session "${m[1]}"` });
      const body = await readBody(req);
      const resolve = session.parkedTools.get(body.toolCallId);
      if (!resolve) return json(res, 404, { error: `no parked tool call "${body.toolCallId}"` });
      session.parkedTools.delete(body.toolCallId);
      resolve(body);
      return json(res, 200, { resolved: true });
    }
    m = path.match(/^\/v1\/sessions\/([^/]+)\/tool_confirmations$/);
    if (req.method === "POST" && m) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: `unknown session "${m[1]}"` });
      await readBody(req);
      return json(res, 200, { confirmed: true });
    }
    m = path.match(/^\/v1\/sessions\/([^/]+)\/interrupt$/);
    if (req.method === "POST" && m) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: `unknown session "${m[1]}"` });
      session.status = "idle";
      session.append({ type: "session.status_idle", stopReason: { type: "interrupted" } });
      return json(res, 202, { accepted: true });
    }

    return json(res, 404, { error: `no route for ${req.method} ${path}` });
  } catch (err) {
    console.error(`[mock-hostler] ${req.method} ${path} failed:`, err);
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-hostler] listening at http://127.0.0.1:${PORT}`);
});
