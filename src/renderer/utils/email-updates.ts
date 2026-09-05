import { dequal } from "dequal/lite";
import { replaceEqualDeep } from "@tanstack/react-query";
import type { DashboardEmail } from "../../shared/types";

/** Keep unchanged records stable across IPC's structured clones. Empty bodies
 * in a metadata refresh mean "not fetched", so retain bodies already loaded. */
export function shareEmail(previous: DashboardEmail, incoming: DashboardEmail): DashboardEmail {
  const next = !incoming.body && previous.body ? { ...incoming, body: previous.body } : incoming;
  return dequal(previous, next) ? previous : replaceEqualDeep(previous, next);
}

export function updateEmails(
  emails: DashboardEmail[],
  updates: ReadonlyMap<string, Partial<DashboardEmail>>,
): DashboardEmail[] {
  let result = emails;
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const changes = updates.get(email.id);
    if (!changes) continue;
    const next = replaceEqualDeep(email, { ...email, ...changes });
    if (next === email) continue;
    if (result === emails) result = emails.slice();
    result[i] = next;
  }
  return result;
}

/** Replace an authoritative account snapshot without disturbing other accounts
 * or changing the identity/order of unchanged records. Views sort separately. */
export function reconcileAccountEmails(
  previous: DashboardEmail[],
  accountId: string,
  incoming: DashboardEmail[],
): DashboardEmail[] {
  const remaining = new Map(incoming.map((email) => [email.id, email]));
  const result: DashboardEmail[] = [];
  let changed = false;
  for (const email of previous) {
    if (email.accountId !== accountId) {
      result.push(email);
      continue;
    }
    const fresh = remaining.get(email.id);
    remaining.delete(email.id);
    if (!fresh) {
      changed = true;
      continue;
    }
    const next = shareEmail(email, fresh);
    changed ||= next !== email;
    result.push(next);
  }
  if (remaining.size > 0) {
    changed = true;
    for (const email of remaining.values()) result.push(email);
  }
  return changed ? result : previous;
}
