import { test, expect } from "@playwright/test";
import { selectThreadedEmails, type Account } from "../../src/renderer/store";
import type { DashboardEmail } from "../../src/shared/types";

test("thread consumers share results and recompute when inbox inputs change", () => {
  const accounts: Account[] = [
    { id: "a", email: "me@example.test", isPrimary: true, isConnected: true },
  ];
  const email: DashboardEmail = {
    id: "one",
    threadId: "thread",
    accountId: "a",
    from: "other@example.test",
    to: "me@example.test",
    subject: "Project",
    date: "2026-01-01T00:00:00Z",
    body: "",
    labelIds: ["INBOX", "UNREAD"],
  };
  const emails = [email];
  const snoozed = new Set<string>();
  const replied = new Map<string, number>();
  const first = selectThreadedEmails(emails, "a", accounts, snoozed, replied);
  expect(first.threads).toHaveLength(1);
  expect(first.threads[0].isUnread).toBe(true);
  for (let i = 0; i < 6; i++) {
    expect(selectThreadedEmails(emails, "a", accounts, snoozed, replied)).toBe(first);
  }
  const read = selectThreadedEmails(
    [{ ...email, labelIds: ["INBOX"] }],
    "a",
    accounts,
    snoozed,
    replied,
  );
  expect(read.threads[0].isUnread).toBe(false);
  const snoozedResult = selectThreadedEmails(emails, "a", accounts, new Set(["thread"]), replied);
  expect(snoozedResult.threads).toHaveLength(0);
  expect(snoozedResult.snoozed).toHaveLength(1);
  expect(selectThreadedEmails(emails, "b", accounts, snoozed, replied).threads).toHaveLength(0);
  expect(selectThreadedEmails(emails, null, accounts, snoozed, replied).threads).toHaveLength(1);
});
