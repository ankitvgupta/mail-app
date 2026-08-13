import type { gmail_v1 } from "googleapis";

// Pure helpers for the block-sender Gmail filter. Kept free of Electron
// imports so unit tests can exercise the real googleapis/gaxios retry stack
// (gmail-client.ts transitively imports Electron and can't be loaded in tests).

/**
 * HTTP status carried on a gaxios error, or null for non-HTTP errors.
 * Checks `.status` first (always set by gaxios 7 for HTTP errors) but also
 * accepts a numeric `.code`, matching the defensive pattern used elsewhere in
 * gmail-client.ts (older google-api clients put the HTTP status there).
 */
export function httpErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  if ("status" in err && typeof err.status === "number") return err.status;
  if ("code" in err && typeof err.code === "number") return err.code;
  return null;
}

function isDuplicateFilterError(err: unknown): boolean {
  return (
    httpErrorStatus(err) === 400 &&
    err instanceof Error &&
    /filter already exists/i.test(err.message)
  );
}

async function findBlockFilterId(
  gmail: gmail_v1.Gmail,
  senderEmail: string,
): Promise<string | null> {
  const response = await gmail.users.settings.filters.list({ userId: "me" });
  const match = (response.data.filter ?? []).find(
    (f) =>
      f.criteria?.from?.toLowerCase() === senderEmail.toLowerCase() &&
      (f.action?.addLabelIds ?? []).includes("TRASH"),
  );
  return match?.id ?? null;
}

/**
 * Create a Gmail filter that routes all future mail from `senderEmail` to Trash
 * (mirrors Gmail's native "Block sender"). Why Trash and not Spam: the Filters
 * API rejects "SPAM" in addLabelIds — only TRASH/IMPORTANT/STARRED/UNREAD plus
 * user labels are allowed there. TRASH matches the user intent ("make this go
 * away") and Gmail's UI block flow uses the same approach. Returns the
 * filter's ID so we can delete it on unblock.
 */
export async function createBlockFilter(
  gmail: gmail_v1.Gmail,
  senderEmail: string,
): Promise<string> {
  try {
    const response = await gmail.users.settings.filters.create(
      {
        userId: "me",
        requestBody: {
          criteria: { from: senderEmail },
          action: {
            addLabelIds: ["TRASH"],
            removeLabelIds: ["INBOX", "UNREAD"],
          },
        },
      },
      {
        // Gmail's settings backend intermittently 500s ("backendError") when
        // filter creates land in quick succession — e.g. blocking several
        // senders back-to-back, where each undo-toast commit fires its own
        // filters.create. gaxios only retries idempotent methods by default,
        // so POSTs need an explicit opt-in. gaxios 7 waits
        // retryDelay(100ms, first retry only) + ((2^attempt − 1)/2)s between
        // attempts → delays of 0.1s, 0.5s, 1.5s, 3.5s, so the 4th retry lands
        // ~5.6s after the first attempt, past the ~1.5s collision window seen
        // in production.
        retryConfig: {
          retry: 4,
          httpMethodsToRetry: ["POST"],
          statusCodesToRetry: [
            [429, 429],
            [500, 599],
          ],
        },
      },
    );
    if (!response.data.id) {
      throw new Error("Gmail filter creation did not return an ID");
    }
    return response.data.id;
  } catch (err) {
    // A Gmail 500 doesn't guarantee the write failed — a retried create can
    // land after an attempt that actually succeeded server-side, which Gmail
    // rejects with 400 "Filter already exists". Resolve to the existing
    // filter's ID instead of failing the block. If the lookup itself fails,
    // surface the original duplicate error, not the lookup's.
    if (isDuplicateFilterError(err)) {
      let existingId: string | null = null;
      try {
        existingId = await findBlockFilterId(gmail, senderEmail);
      } catch {
        // fall through to throw the original err
      }
      if (existingId) return existingId;
    }
    throw err;
  }
}
