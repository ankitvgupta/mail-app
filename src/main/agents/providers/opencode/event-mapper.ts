import type { Event, Part } from "@opencode-ai/sdk";
import type { AgentEvent } from "../../types";

/**
 * Translate the OpenCode SSE event stream into our internal AgentEvent shape.
 *
 * The stream is global to the server (across all sessions). The mapper filters
 * to events for one session and tracks running state so it can emit our
 * delta-style events (text_delta, tool_call_start/end) from OpenCode's
 * full-snapshot Part updates.
 *
 * Mapping shape:
 *   message.part.updated (text part + delta)       → text_delta
 *   message.part.updated (tool part, state pending/running, new) → tool_call_start
 *   message.part.updated (tool part, state completed/error)      → tool_call_end
 *   permission.updated                              → confirmation_required (rare path)
 *   session.error                                   → error
 *   session.idle                                    → terminal (provider emits `done`)
 */
export interface EventMapper {
  next(e: Event): AgentEvent[];
  /** True once the session has reached a terminal state (idle or error). */
  isTerminal(e: Event): boolean;
  /** Returns the last error message seen on the stream, if any. */
  lastError(): string | null;
}

interface MapState {
  sessionId: string;
  /** callIDs we've already emitted `tool_call_start` for. */
  startedTools: Set<string>;
  /** callIDs we've already emitted `tool_call_end` for. Guards double-emit on idempotent updates. */
  endedTools: Set<string>;
  /** Last text we emitted per text-part ID; used to compute deltas if OpenCode didn't supply one. */
  lastTextByPart: Map<string, string>;
  /** messageID → role, learned from message.updated. Parts whose messageID maps to "user"
   *  are dropped — OpenCode emits part.updated for the user's own prompt too. */
  messageRoles: Map<string, "user" | "assistant">;
  lastError: string | null;
}

export function createEventMapper(sessionId: string): EventMapper {
  const state: MapState = {
    sessionId,
    startedTools: new Set(),
    endedTools: new Set(),
    lastTextByPart: new Map(),
    messageRoles: new Map(),
    lastError: null,
  };

  return {
    next: (e) => mapEvent(e, state),
    isTerminal: (e) => isTerminalEvent(e, state.sessionId),
    lastError: () => state.lastError,
  };
}

function isTerminalEvent(e: Event, sessionId: string): boolean {
  if (e.type === "session.idle") return e.properties.sessionID === sessionId;
  if (e.type === "session.error") return e.properties.sessionID === sessionId;
  return false;
}

function mapEvent(e: Event, s: MapState): AgentEvent[] {
  switch (e.type) {
    case "message.updated": {
      // Record the role so part.updated events can be filtered to assistant-only.
      // Without this, the user's own prompt arrives as a text_delta event and
      // gets echoed into the conversation trace.
      const info = e.properties.info;
      if ("sessionID" in info && info.sessionID === s.sessionId) {
        s.messageRoles.set(info.id, info.role);
      }
      return [];
    }
    case "message.part.updated":
      return mapPartUpdated(e.properties.part, e.properties.delta, s);
    case "session.error": {
      if (e.properties.sessionID !== s.sessionId) return [];
      const err = e.properties.error;
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Session error";
      s.lastError = message;
      return [{ type: "error", message }];
    }
    case "permission.updated": {
      if (e.properties.sessionID !== s.sessionId) return [];
      // OpenCode requested user permission for a tool. Forward as
      // confirmation_required; the provider will translate into the
      // orchestrator's confirmation flow and POST a response back to OpenCode.
      return [
        {
          type: "confirmation_required",
          toolCallId: e.properties.callID ?? e.properties.id,
          toolName: e.properties.type,
          input: e.properties.metadata,
          description: e.properties.title,
        },
      ];
    }
    default:
      return [];
  }
}

function mapPartUpdated(part: Part, delta: string | undefined, s: MapState): AgentEvent[] {
  // Filter to this session only — the SSE stream is global.
  if ("sessionID" in part && part.sessionID !== s.sessionId) return [];

  // Filter out parts belonging to user messages. message.updated arrives
  // before message.part.updated for the same message, so the role is
  // typically already in the map; if it isn't (race / missed event), treat
  // unknown as assistant — better to over-emit than to silently drop the
  // assistant's reply.
  if ("messageID" in part) {
    const role = s.messageRoles.get(part.messageID);
    if (role === "user") return [];
  }

  switch (part.type) {
    case "text": {
      // Prefer OpenCode's delta when available. Otherwise compute one from the
      // last seen snapshot for this part — message.part.updated arrives on every
      // tick during streaming, so without a delta calc we'd echo the whole
      // prefix on each event.
      if (delta && delta.length > 0) {
        const prev = s.lastTextByPart.get(part.id) ?? "";
        s.lastTextByPart.set(part.id, prev + delta);
        return [{ type: "text_delta", text: delta }];
      }
      const prev = s.lastTextByPart.get(part.id) ?? "";
      if (part.text.length > prev.length && part.text.startsWith(prev)) {
        const computed = part.text.slice(prev.length);
        s.lastTextByPart.set(part.id, part.text);
        if (computed.length > 0) return [{ type: "text_delta", text: computed }];
        return [];
      }
      // Non-monotonic update (rewrite) — emit the whole thing as a single delta.
      // This is rare and only happens on retry/edit; better to over-emit than drop.
      if (part.text !== prev) {
        s.lastTextByPart.set(part.id, part.text);
        return [{ type: "text_delta", text: part.text }];
      }
      return [];
    }

    case "tool": {
      const callId = part.callID;
      const state = part.state;
      const events: AgentEvent[] = [];
      // Emit start the first time we see this tool, regardless of whether the
      // first update is pending/running/completed — orchestrator's UI tracks
      // tool_call_start as the moment a tool appears in the timeline.
      if (!s.startedTools.has(callId)) {
        s.startedTools.add(callId);
        events.push({
          type: "tool_call_start",
          toolName: part.tool,
          toolCallId: callId,
          input: "input" in state ? state.input : {},
        });
      }
      if (state.status === "completed" && !s.endedTools.has(callId)) {
        s.endedTools.add(callId);
        events.push({
          type: "tool_call_end",
          toolCallId: callId,
          result: state.output,
        });
      } else if (state.status === "error" && !s.endedTools.has(callId)) {
        s.endedTools.add(callId);
        events.push({
          type: "tool_call_end",
          toolCallId: callId,
          result: { error: state.error },
        });
      }
      return events;
    }

    case "reasoning":
      // OpenCode exposes reasoning as plaintext (vs Claude SDK's encrypted blobs).
      // The mail-app doesn't surface reasoning in the UI; drop it.
      return [];

    default:
      return [];
  }
}
