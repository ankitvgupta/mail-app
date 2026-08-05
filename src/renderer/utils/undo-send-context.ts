import { z } from "zod";
import type { UndoSendItem } from "../store";

/**
 * The compose state needed to reopen the editor when a user undoes a send.
 *
 * This crosses the IPC boundary as an opaque JSON string — main persists it
 * without interpreting it — so it gets parsed and validated on the way back in
 * rather than trusted.
 */
const ComposeContextSchema = z.object({
  mode: z.enum(["new", "reply", "reply-all", "forward"]),
  replyToEmailId: z.string().optional(),
  threadId: z.string().optional(),
  bodyHtml: z.string(),
  bodyText: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  optimisticEmailId: z.string().optional(),
});

export type UndoSendComposeContext = z.infer<typeof ComposeContextSchema>;

export function serializeComposeContext(
  context: UndoSendItem["composeContext"],
): string | undefined {
  if (!context) return undefined;
  return JSON.stringify(context);
}

export function parseComposeContext(raw: string | undefined): UndoSendComposeContext | undefined {
  if (!raw) return undefined;
  try {
    const parsed = ComposeContextSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Malformed JSON means we can't restore the editor, but the send itself is
    // unaffected — degrade to "no context" rather than breaking the toast.
    return undefined;
  }
}

/** Convenience for the sent-broadcast reconciliation path. */
export function parseOptimisticEmailId(raw: string | undefined): string | undefined {
  return parseComposeContext(raw)?.optimisticEmailId;
}
