/**
 * Shared helpers for auto-draft agent task IDs.
 * Format: `auto-draft-{emailId}-{timestamp}`
 * Used by the prefetch service to create task IDs and by the DB layer to
 * identify completed auto-draft runs from agent_conversation_mirror.
 */

const AUTO_DRAFT_PREFIX = "auto-draft-";
const AUTO_DRAFT_TASK_ID_REGEX = /^auto-draft-(.+)-\d+$/;

export function buildAutoDraftTaskId(emailId: string): string {
  return `${AUTO_DRAFT_PREFIX}${emailId}-${Date.now()}`;
}

export function parseAutoDraftTaskId(taskId: string): string | null {
  const match = taskId.match(AUTO_DRAFT_TASK_ID_REGEX);
  return match ? match[1] : null;
}

export const AUTO_DRAFT_TASK_ID_LIKE_PATTERN = `${AUTO_DRAFT_PREFIX}%`;
