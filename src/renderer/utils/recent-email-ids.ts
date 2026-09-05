import type { DashboardEmail } from "../../shared/types";

type EmailMetadata = Pick<DashboardEmail, "id" | "accountId" | "date">;
type Candidate = { email: EmailMetadata; timestamp: number };

function compareNewest(a: Candidate, b: Candidate): number {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? -1 : 1;
  const accountA = a.email.accountId ?? "";
  const accountB = b.email.accountId ?? "";
  if (accountA !== accountB) return accountA < accountB ? -1 : 1;
  if (a.email.id === b.email.id) return 0;
  return a.email.id < b.email.id ? -1 : 1;
}

/** Select a bounded recent window from unordered inbox snapshots. Parse each
 * date once and keep at most limit candidates, avoiding a full mailbox sort. */
export function getRecentEmailIds(emails: readonly EmailMetadata[], limit = 60): string[] {
  if (limit <= 0) return [];
  const recent: Candidate[] = [];
  for (const email of emails) {
    const timestamp = Date.parse(email.date);
    const candidate = { email, timestamp: Number.isNaN(timestamp) ? -Infinity : timestamp };
    if (recent.length === limit && compareNewest(candidate, recent[limit - 1]) >= 0) continue;

    let start = 0;
    let end = recent.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (compareNewest(candidate, recent[middle]) < 0) end = middle;
      else start = middle + 1;
    }
    recent.splice(start, 0, candidate);
    if (recent.length > limit) recent.pop();
  }
  return recent.map(({ email }) => email.id);
}
