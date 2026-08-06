import type { SessionEvent } from "@hostler/sdk";
import type { AgentEvent } from "../../types";

/**
 * Translate the Hostler session event log into the mail-app's AgentEvent shape.
 *
 * Unlike the OpenCode mapper, no session filtering is needed — Hostler's
 * events endpoint is per-session. The mapper is purely presentational: the
 * provider handles control flow (client-tool execution, idle/terminated
 * handling) by switching on the raw event alongside this mapper.
 *
 * Mapping shape:
 *   agent.message_delta            → text_delta
 *   agent.message                  → text_delta only if no deltas streamed for
 *                                    this message (some turns arrive without
 *                                    deltas); otherwise dedup-dropped
 *   agent.thinking_delta           → dropped (the mail-app doesn't surface
 *                                    reasoning in the UI; matches OpenCode)
 *   agent.tool_use                 → tool_call_start (all locales — sandbox
 *                                    and mcp tool activity is timeline-worthy)
 *   agent.tool_result              → tool_call_end
 *   session.error (retryable)      → dropped (the platform retries; surfacing
 *                                    it would flash transient noise in the UI)
 *   session.error (non-retryable)  → error
 *   session.status_idle (error)    → error (terminal message from stopReason)
 *   everything else                → dropped (user echoes, spans, status) —
 *                                    including unknown future event types,
 *                                    which Hostler documents as an open union
 *
 * The event stream is remote input: text sizes are capped (a hostile or
 * runaway control plane must not be able to balloon worker/renderer memory
 * through unbounded deltas or tool results), and content shapes are guarded
 * rather than trusted.
 */
export interface HostlerEventMapper {
  next(e: SessionEvent): AgentEvent[];
  /** Full text of the last agent.message seen — used for the `done` summary. */
  lastMessage(): string | null;
}

/** Cumulative text budget per message segment (deltas + full message). A
 *  sidebar reply is a few KB; 1M chars is far beyond any legitimate turn. */
const MAX_MESSAGE_CHARS = 1_000_000;
/** Tool results echo back through the timeline UI; cap what one call can pin
 *  in renderer memory. The full result still went to the model. */
const MAX_TOOL_RESULT_CHARS = 262_144;

const TRUNCATION_NOTICE = "\n…[truncated by size cap]";

export function createHostlerEventMapper(): HostlerEventMapper {
  // Characters of message_delta emitted since the last agent.message boundary.
  // agent.message carries the full message text that the deltas already
  // streamed — emit it only when no deltas preceded it.
  let deltaChars = 0;
  let deltaCapNotified = false;
  let lastMessage: string | null = null;
  // Early platform builds emitted one client-tool call twice — locale
  // "sandbox" (harness dispatch) then locale "client" (the park), same
  // toolCallId. Fixed platform-side (July 2026); kept as cheap defense so a
  // regression can't render duplicate tool cards (mirrors the OpenCode
  // mapper's start/end dedup).
  const startedTools = new Set<string>();
  const endedTools = new Set<string>();

  return {
    next(e: SessionEvent): AgentEvent[] {
      switch (e.type) {
        case "agent.message_delta": {
          const text = typeof e.text === "string" ? e.text : "";
          if (deltaChars >= MAX_MESSAGE_CHARS) {
            if (deltaCapNotified) return [];
            deltaCapNotified = true;
            return [{ type: "text_delta", text: TRUNCATION_NOTICE }];
          }
          deltaChars += text.length;
          return text.length > 0 ? [{ type: "text_delta", text }] : [];
        }

        case "agent.message": {
          const text = typeof e.text === "string" ? e.text : "";
          lastMessage = text.slice(0, MAX_MESSAGE_CHARS);
          const emitted = deltaChars > 0;
          deltaChars = 0;
          deltaCapNotified = false;
          if (emitted) return [];
          return text.length > 0 ? [{ type: "text_delta", text: lastMessage }] : [];
        }

        case "agent.tool_use": {
          if (startedTools.has(e.toolCallId)) return [];
          startedTools.add(e.toolCallId);
          return [
            {
              type: "tool_call_start",
              toolName: e.name,
              toolCallId: e.toolCallId,
              input: e.input,
            },
          ];
        }

        case "agent.tool_result": {
          if (endedTools.has(e.toolCallId)) return [];
          endedTools.add(e.toolCallId);
          const parts = Array.isArray(e.content) ? e.content : [];
          let text = parts.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
          if (text.length > MAX_TOOL_RESULT_CHARS) {
            text = text.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATION_NOTICE;
          }
          return [
            {
              type: "tool_call_end",
              toolCallId: e.toolCallId,
              result: e.isError ? { error: text } : text,
            },
          ];
        }

        case "session.error":
          return e.retryable ? [] : [{ type: "error", message: e.message }];

        case "session.status_idle":
          if (e.stopReason.type === "error") {
            return [{ type: "error", message: e.stopReason.message }];
          }
          return [];

        default:
          return [];
      }
    },
    lastMessage: () => lastMessage,
  };
}
