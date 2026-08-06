/**
 * Unit tests for the Hostler event mapper.
 *
 * The mapper translates Hostler's SessionEvent log into the mail-app's
 * AgentEvent shape. Important properties:
 *   - agent.message is deduped when message_deltas already streamed its text,
 *     but emitted when a turn segment arrives without deltas.
 *   - Tool use/result map to tool_call_start/end with error results wrapped.
 *   - Retryable session.errors are suppressed (the platform retries);
 *     non-retryable ones and error stop reasons surface as error events.
 *   - Span/status/user events are dropped.
 */
import { test, expect } from "@playwright/test";
import { createHostlerEventMapper } from "../../src/main/agents/providers/hostler/event-mapper";

let seq = 0;
/** EventBase fields; spread into a literal per call site so each event object
 *  structurally matches its SessionEvent union member without casts. */
function base(): { seq: number; id: string; ts: number } {
  seq += 1;
  return { seq, id: `sevt_${seq}`, ts: seq };
}

test.beforeEach(() => {
  seq = 0;
});

test("message deltas stream as text_delta and the full message is deduped", () => {
  const mapper = createHostlerEventMapper();

  expect(mapper.next({ ...base(), type: "agent.message_delta", text: "Hel" })).toEqual([
    { type: "text_delta", text: "Hel" },
  ]);
  expect(mapper.next({ ...base(), type: "agent.message_delta", text: "lo" })).toEqual([
    { type: "text_delta", text: "lo" },
  ]);
  // Full message arrives after its deltas — must not double-emit.
  expect(mapper.next({ ...base(), type: "agent.message", text: "Hello" })).toEqual([]);
  expect(mapper.lastMessage()).toBe("Hello");
});

test("a message without preceding deltas is emitted whole", () => {
  const mapper = createHostlerEventMapper();

  expect(mapper.next({ ...base(), type: "agent.message", text: "4" })).toEqual([
    { type: "text_delta", text: "4" },
  ]);
  expect(mapper.lastMessage()).toBe("4");
});

test("delta accounting resets at each message boundary", () => {
  const mapper = createHostlerEventMapper();

  mapper.next({ ...base(), type: "agent.message_delta", text: "first" });
  mapper.next({ ...base(), type: "agent.message", text: "first" });
  // Second message in the same turn arrives without deltas — emit it.
  expect(mapper.next({ ...base(), type: "agent.message", text: "second" })).toEqual([
    { type: "text_delta", text: "second" },
  ]);
  expect(mapper.lastMessage()).toBe("second");
});

test("thinking deltas are dropped", () => {
  const mapper = createHostlerEventMapper();
  expect(mapper.next({ ...base(), type: "agent.thinking_delta", text: "hmm" })).toEqual([]);
});

test("tool_use maps to tool_call_start for every locale", () => {
  const mapper = createHostlerEventMapper();

  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_use",
      toolCallId: "call_1",
      name: "read_email",
      input: { id: "e1" },
      locale: "client",
    }),
  ).toEqual([
    { type: "tool_call_start", toolName: "read_email", toolCallId: "call_1", input: { id: "e1" } },
  ]);

  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_use",
      toolCallId: "call_2",
      name: "webfetch",
      input: {},
      locale: "sandbox",
    }),
  ).toEqual([{ type: "tool_call_start", toolName: "webfetch", toolCallId: "call_2", input: {} }]);
});

test("duplicate tool events for one callId emit start/end exactly once", () => {
  // The live platform emits the same client-tool call twice: locale
  // "sandbox" (harness dispatch) then locale "client" (the park).
  const mapper = createHostlerEventMapper();

  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_use",
      toolCallId: "call_1",
      name: "read_email",
      input: { id: "e1" },
      locale: "sandbox",
    }),
  ).toHaveLength(1);
  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_use",
      toolCallId: "call_1",
      name: "read_email",
      input: { id: "e1" },
      locale: "client",
    }),
  ).toEqual([]);

  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_result",
      toolCallId: "call_1",
      name: "read_email",
      isError: false,
      content: [{ type: "text", text: "body" }],
    }),
  ).toHaveLength(1);
  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_result",
      toolCallId: "call_1",
      name: "read_email",
      isError: false,
      content: [{ type: "text", text: "body" }],
    }),
  ).toEqual([]);
});

test("tool_result maps to tool_call_end, wrapping errors", () => {
  const mapper = createHostlerEventMapper();

  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_result",
      toolCallId: "call_1",
      name: "read_email",
      isError: false,
      content: [{ type: "text", text: "body" }],
    }),
  ).toEqual([{ type: "tool_call_end", toolCallId: "call_1", result: "body" }]);

  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_result",
      toolCallId: "call_2",
      name: "read_email",
      isError: true,
      content: [{ type: "text", text: "not found" }],
    }),
  ).toEqual([{ type: "tool_call_end", toolCallId: "call_2", result: { error: "not found" } }]);
});

test("retryable session errors are suppressed; fatal ones surface", () => {
  const mapper = createHostlerEventMapper();

  expect(
    mapper.next({ ...base(), type: "session.error", message: "blip", retryable: true }),
  ).toEqual([]);
  expect(
    mapper.next({ ...base(), type: "session.error", message: "boom", retryable: false }),
  ).toEqual([{ type: "error", message: "boom" }]);
});

test("idle stop reasons: only error yields an event", () => {
  const mapper = createHostlerEventMapper();

  expect(
    mapper.next({ ...base(), type: "session.status_idle", stopReason: { type: "end_turn" } }),
  ).toEqual([]);
  expect(
    mapper.next({ ...base(), type: "session.status_idle", stopReason: { type: "interrupted" } }),
  ).toEqual([]);
  expect(
    mapper.next({
      ...base(),
      type: "session.status_idle",
      stopReason: { type: "error", message: "model exploded" },
    }),
  ).toEqual([{ type: "error", message: "model exploded" }]);
});

test("user echoes, spans, and status events are dropped", () => {
  const mapper = createHostlerEventMapper();

  expect(mapper.next({ ...base(), type: "user.message", text: "hi" })).toEqual([]);
  expect(mapper.next({ ...base(), type: "session.status_running" })).toEqual([]);
  expect(
    mapper.next({
      ...base(),
      type: "span.model_usage",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }),
  ).toEqual([]);
  expect(
    mapper.next({
      ...base(),
      type: "agent.tool_pending",
      toolCallId: "call_1",
      name: "read_email",
      pendingState: "async",
    }),
  ).toEqual([]);
});
