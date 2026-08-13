/**
 * Unit tests for the OpenCode event mapper.
 *
 * The mapper translates OpenCode's SSE Event union into the mail-app's
 * AgentEvent shape. Important properties we test:
 *   - Text deltas are emitted (not full-snapshot rewrites) when OpenCode
 *     reports a `delta` field, or when the snapshot grows monotonically.
 *   - Tool start/end events fire exactly once per callID.
 *   - Events for other sessions are filtered out (the SSE endpoint is global).
 *   - session.idle and session.error are terminal for our session, not others.
 */
import { test, expect } from "@playwright/test";
import { createEventMapper } from "../../src/main/agents/providers/opencode/event-mapper";
import type { Event } from "@opencode-ai/sdk";

const SESSION_ID = "ses_abc";
const OTHER_SESSION_ID = "ses_xyz";

function textPartUpdate(text: string, delta: string | undefined, sessionID = SESSION_ID): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "p1",
        sessionID,
        messageID: "msg1",
        type: "text",
        text,
      },
      delta,
    },
  };
}

function toolPartUpdate(
  callID: string,
  status: "pending" | "running" | "completed" | "error",
  extras: Record<string, unknown> = {},
  sessionID = SESSION_ID,
): Event {
  const base = {
    id: `tp-${callID}`,
    sessionID,
    messageID: "msg1",
    type: "tool" as const,
    callID,
    tool: "read_email",
  };
  let state;
  if (status === "pending") {
    state = { status, input: { id: "1" }, raw: "" };
  } else if (status === "running") {
    state = { status, input: { id: "1" }, time: { start: 0 } };
  } else if (status === "completed") {
    state = {
      status,
      input: { id: "1" },
      output: "result-body",
      title: "Read email 1",
      metadata: {},
      time: { start: 0, end: 1 },
    };
  } else {
    state = { status, input: { id: "1" }, error: "boom", time: { start: 0, end: 1 } };
  }
  return {
    type: "message.part.updated",
    properties: {
      part: { ...base, state, ...extras },
    },
  };
}

test.describe("createEventMapper - text deltas", () => {
  test("emits delta when SSE provides one", () => {
    const m = createEventMapper(SESSION_ID);
    const out = m.next(textPartUpdate("Hello", "Hello", undefined));
    expect(out).toEqual([{ type: "text_delta", text: "Hello" }]);
  });

  test("filters out parts belonging to user messages", () => {
    const m = createEventMapper(SESSION_ID);
    // Server tells us a user message was created
    const userMsg: Event = {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-user-1",
          sessionID: SESSION_ID,
          role: "user",
        } as Event["properties"]["info"],
      },
    } as Event;
    m.next(userMsg);
    // Then a part.updated for the user's prompt — must NOT produce a text_delta
    const userPart: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          sessionID: SESSION_ID,
          messageID: "msg-user-1",
          type: "text",
          text: "user prompt",
        },
        delta: "user prompt",
      },
    };
    expect(m.next(userPart)).toEqual([]);
    // An assistant message in the same session should still flow through
    m.next({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-ast-1",
          sessionID: SESSION_ID,
          role: "assistant",
        } as Event["properties"]["info"],
      },
    } as Event);
    const astPart: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p2",
          sessionID: SESSION_ID,
          messageID: "msg-ast-1",
          type: "text",
          text: "assistant reply",
        },
        delta: "assistant reply",
      },
    };
    expect(m.next(astPart)).toEqual([{ type: "text_delta", text: "assistant reply" }]);
  });

  test("computes delta from snapshot when none provided", () => {
    const m = createEventMapper(SESSION_ID);
    const first = m.next(textPartUpdate("Hello", undefined));
    expect(first).toEqual([{ type: "text_delta", text: "Hello" }]);
    // Second update is a snapshot that includes the prior text + new content
    const second = m.next(textPartUpdate("Hello, world", undefined));
    expect(second).toEqual([{ type: "text_delta", text: ", world" }]);
  });

  test("drops events for other sessions", () => {
    const m = createEventMapper(SESSION_ID);
    const out = m.next(textPartUpdate("Hi", "Hi", OTHER_SESSION_ID));
    expect(out).toEqual([]);
  });

  test("does not re-emit when snapshot is unchanged", () => {
    const m = createEventMapper(SESSION_ID);
    m.next(textPartUpdate("Hi", undefined));
    const repeated = m.next(textPartUpdate("Hi", undefined));
    expect(repeated).toEqual([]);
  });
});

test.describe("createEventMapper - tool calls", () => {
  test("emits tool_call_start once on first sighting", () => {
    const m = createEventMapper(SESSION_ID);
    const out1 = m.next(toolPartUpdate("c1", "pending"));
    expect(out1).toHaveLength(1);
    expect(out1[0]).toMatchObject({
      type: "tool_call_start",
      toolCallId: "c1",
      toolName: "read_email",
    });
    // Going pending → running should NOT emit a second start
    const out2 = m.next(toolPartUpdate("c1", "running"));
    expect(out2).toEqual([]);
  });

  test("emits tool_call_end when state becomes completed", () => {
    const m = createEventMapper(SESSION_ID);
    m.next(toolPartUpdate("c1", "running"));
    const out = m.next(toolPartUpdate("c1", "completed"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "tool_call_end",
      toolCallId: "c1",
      result: "result-body",
    });
  });

  test("emits tool_call_end with error when state becomes error", () => {
    const m = createEventMapper(SESSION_ID);
    m.next(toolPartUpdate("c1", "running"));
    const out = m.next(toolPartUpdate("c1", "error"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "tool_call_end",
      toolCallId: "c1",
      result: { error: "boom" },
    });
  });

  test("emits start + end together when first sighting is already completed", () => {
    const m = createEventMapper(SESSION_ID);
    const out = m.next(toolPartUpdate("c1", "completed"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "tool_call_start", toolCallId: "c1" });
    expect(out[1]).toMatchObject({ type: "tool_call_end", toolCallId: "c1" });
  });
});

test.describe("createEventMapper - terminal detection", () => {
  test("session.idle for our session is terminal", () => {
    const m = createEventMapper(SESSION_ID);
    const idle: Event = {
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    };
    expect(m.isTerminal(idle)).toBe(true);
  });

  test("session.idle for other session is NOT terminal", () => {
    const m = createEventMapper(SESSION_ID);
    const idle: Event = {
      type: "session.idle",
      properties: { sessionID: OTHER_SESSION_ID },
    };
    expect(m.isTerminal(idle)).toBe(false);
  });

  test("session.error captures error message", () => {
    const m = createEventMapper(SESSION_ID);
    const err: Event = {
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: { name: "UnknownError", data: { message: "kaboom" } } as Event["properties"]["error"],
      },
    } as Event;
    const out = m.next(err);
    expect(m.isTerminal(err)).toBe(true);
    // Message extraction is best-effort; we just care that an `error` event surfaces
    expect(out.some((e) => e.type === "error")).toBe(true);
  });
});
