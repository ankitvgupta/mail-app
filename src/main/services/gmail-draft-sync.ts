/**
 * Syncs local drafts to Gmail so they're accessible from other email clients.
 * All operations are best-effort — failures are logged but never thrown,
 * so the local draft flow is never blocked by Gmail API issues.
 */
import {
  getEmail,
  getEmailMessageIdHeader,
  updateDraftGmailId,
  getThreadDrafts,
  deleteDraft,
  saveDraft,
} from "../db";
import { getClient } from "../ipc/gmail.ipc";
import { getConfig } from "../ipc/settings.ipc";
import { createLogger } from "./logger";

const log = createLogger("gmail-draft-sync");

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

/**
 * Create (or replace) a Gmail draft for the given email.
 * If oldGmailDraftId is provided, that draft is deleted first.
 * Updates only the gmail_draft_id in the DB — does not change draft status.
 *
 * @param oldGmailDraftId - The previous Gmail draft ID to delete. Must be
 *   read by the caller BEFORE calling saveDraft(), which clears gmail_draft_id.
 *
 * Fire-and-forget safe — never throws.
 */
export async function syncDraftToGmail(
  emailId: string,
  body: string,
  cc?: string[],
  bcc?: string[],
  oldGmailDraftId?: string,
  composeMode?: string,
  forwardTo?: string[],
): Promise<void> {
  if (useFakeData) return;

  try {
    const syncEnabled = getConfig().syncDraftsToGmail;

    // If sync is disabled and there's no old draft to clean up, skip entirely.
    if (!syncEnabled && !oldGmailDraftId) return;

    const email = getEmail(emailId);
    if (!email) {
      log.warn(`[GmailDraftSync] Email not found: ${emailId}`);
      return;
    }

    const accountId = email.accountId || "default";
    const client = await getClient(accountId);

    // Delete old Gmail draft if caller provided the ID (best-effort).
    // Do NOT fall back to email.draft?.gmailDraftId — a concurrent sync
    // may have already written a newer ID there.
    if (oldGmailDraftId) {
      try {
        await client.deleteDraft(oldGmailDraftId);
      } catch {
        // Draft may have been deleted externally — that's fine
      }
    }

    // Stop here if sync is disabled — old draft was cleaned up above,
    // but we don't create a new Gmail draft.
    if (!syncEnabled) return;

    const isForward = composeMode === "forward";

    // Build recipient + subject based on compose mode
    let to: string;
    let subject: string;
    if (isForward) {
      to = forwardTo?.join(", ") || "";
      const bare = email.subject.replace(/^(?:Re|Fwd|Fw):\s*/i, "");
      subject = `Fwd: ${bare}`;
    } else {
      const fromMatch = email.from.match(/<([^>]+)>/);
      to = fromMatch ? fromMatch[1] : email.from;
      subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
    }

    // Reply threading headers — only for replies, not forwards.
    // In-Reply-To + References tell Gmail this is a reply. Without them,
    // Gmail treats the draft as a forward.
    const parentMessageId = !isForward ? getEmailMessageIdHeader(emailId) : undefined;
    const inReplyTo = parentMessageId || undefined;
    const references = parentMessageId || undefined;

    const result = await client.createDraft({
      to,
      subject,
      body,
      threadId: email.threadId,
      cc,
      bcc,
      inReplyTo,
      references,
    });

    // Only store the Gmail draft ID — preserve whatever status the caller set
    updateDraftGmailId(emailId, result.id);
    log.info(
      `[GmailDraftSync] Synced ${isForward ? "forward" : "reply"} draft to Gmail for ${emailId} (gmailDraftId=${result.id})`,
    );
  } catch (err) {
    log.error({ err: err }, `[GmailDraftSync] Failed to sync draft for ${emailId}`);
  }
}

/**
 * Single entry point for saving a draft and syncing it to Gmail.
 * Reads the old Gmail draft ID, saves to local DB, then fires off the Gmail
 * sync in the background. All code paths that save drafts should use this
 * instead of calling saveDraft() + syncDraftToGmail() separately.
 *
 * Never throws — local save is synchronous; Gmail sync is best-effort.
 */
export function saveDraftAndSync(
  emailId: string,
  body: string,
  status: string,
  cc?: string[],
  bcc?: string[],
  composeMode?: string,
  to?: string[],
): void {
  // Read old Gmail draft ID BEFORE saveDraft clears it
  const oldGmailDraftId = getEmail(emailId)?.draft?.gmailDraftId;

  // Build options with only explicitly provided fields so that saveDraft's
  // COALESCE logic preserves DB values for omitted fields (e.g. cc/bcc when
  // only composeMode/to are provided).
  const hasOptions =
    to !== undefined || cc !== undefined || bcc !== undefined || composeMode !== undefined;
  const draftOptions = hasOptions
    ? {
        ...(to !== undefined ? { to } : {}),
        ...(cc !== undefined ? { cc } : {}),
        ...(bcc !== undefined ? { bcc } : {}),
        ...(composeMode !== undefined ? { composeMode } : {}),
      }
    : undefined;
  saveDraft(emailId, body, status, undefined, draftOptions);

  // Re-read from DB to catch COALESCE-preserved values (e.g. on refine/edit
  // where composeMode/to/cc/bcc aren't passed but exist in the DB)
  const savedDraft = getEmail(emailId)?.draft;
  const syncCc = cc ?? savedDraft?.cc;
  const syncBcc = bcc ?? savedDraft?.bcc;
  const syncComposeMode = composeMode ?? savedDraft?.composeMode;
  const syncTo = to ?? savedDraft?.to;

  // Fire-and-forget Gmail sync
  syncDraftToGmail(emailId, body, syncCc, syncBcc, oldGmailDraftId, syncComposeMode, syncTo).catch(
    () => {},
  );
}

/**
 * Delete a Gmail draft by its ID directly.
 * Use this instead of deleteGmailDraft when you already have the IDs
 * (avoids race conditions when the local DB record is about to be deleted).
 *
 * Fire-and-forget safe — never throws.
 */
export async function deleteGmailDraftById(accountId: string, gmailDraftId: string): Promise<void> {
  if (useFakeData) return;

  try {
    const client = await getClient(accountId || "default");
    await client.deleteDraft(gmailDraftId);
    log.info(`[GmailDraftSync] Deleted Gmail draft ${gmailDraftId}`);
  } catch (err) {
    log.error({ err: err }, `[GmailDraftSync] Failed to delete Gmail draft ${gmailDraftId}`);
  }
}

/**
 * Delete Gmail drafts for a list of pre-fetched draft records (best-effort, in parallel).
 * Accepts pre-read data so callers can delete local records immediately after.
 */
export async function deleteGmailDraftsBatch(
  drafts: Array<{ gmailDraftId: string; accountId: string }>,
): Promise<void> {
  if (useFakeData) return;

  await Promise.allSettled(drafts.map((d) => deleteGmailDraftById(d.accountId, d.gmailDraftId)));
}

/**
 * Delete all stale drafts in a thread when new messages arrive.
 * Handles both "user replied from another client" and "third-party reply".
 *
 * @param threadId - The thread that received new messages
 * @param accountId - The account the thread belongs to
 * @param excludeEmailIds - Email IDs to skip (the new messages themselves)
 * @param reason - Log label for why the drafts are being removed
 * @returns Email IDs whose drafts were deleted (empty if none)
 */
export function cleanupStaleDraftsForThread(
  threadId: string,
  accountId: string,
  excludeEmailIds: Set<string>,
  reason: string,
  userReplied: boolean,
): string[] {
  const threadDrafts = getThreadDrafts(threadId, accountId);
  // Only clean up AI-generated drafts (status='pending'), not user-edited ones.
  // This matches the convention in clearInboxPendingDrafts.
  const staleDrafts = threadDrafts.filter(
    (d) => !excludeEmailIds.has(d.emailId) && d.status === "pending",
  );
  if (staleDrafts.length === 0) return [];

  const removedIds: string[] = [];
  for (const stale of staleDrafts) {
    if (stale.gmailDraftId && !userReplied) {
      // Only delete from Gmail when someone ELSE replied (draft is truly stale).
      // When the USER replied from another client, the draft was likely sent
      // (consumed by Gmail) — calling drafts.delete on a sent draft's ID
      // can delete the sent message itself.
      deleteGmailDraftById(accountId, stale.gmailDraftId).catch(() => {});
    }
    deleteDraft(stale.emailId);
    removedIds.push(stale.emailId);
    log.info(
      `[DraftSync] Deleted stale draft for ${stale.emailId} — ${reason} (thread ${threadId})`,
    );
  }
  return removedIds;
}
