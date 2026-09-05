import { test, expect } from "@playwright/test";
import { useAppStore, selectThreadedEmails } from "../../src/renderer/store";
import { reconcileAccountEmails } from "../../src/renderer/utils/email-updates";
import {
  addOptimisticReads,
  applyOptimisticReads,
  confirmOptimisticReads,
} from "../../src/renderer/optimistic-reads";
import type { DashboardEmail } from "../../src/shared/types";

const email = (id: string, accountId = "a"): DashboardEmail => ({
  id,
  threadId: `thread-${id}`,
  accountId,
  from: "person@example.test",
  to: "me@example.test",
  subject: `Message ${id}`,
  date: "2026-01-01T12:00:00Z",
  body: "",
  labelIds: ["INBOX"],
});
const initialState = useAppStore.getState();
test.beforeEach(() => useAppStore.setState(initialState, true));

test("unchanged account refreshes preserve the whole snapshot and already loaded bodies", () => {
  const previous = [
    {
      ...email("one"),
      body: "Loaded HTML",
      analysis: { needsReply: true, reason: "Question", analyzedAt: 1 },
    },
    email("two", "b"),
  ];
  const incoming = structuredClone([previous[0]]).map((e) => ({ ...e, body: "" }));
  expect(reconcileAccountEmails(previous, "a", incoming)).toBe(previous);
  useAppStore.setState({ emails: previous });
  const before = useAppStore.getState();
  before.replaceEmailsForAccount("a", incoming);
  expect(useAppStore.getState()).toBe(before);
});

test("account snapshots remove stale messages, add new ones, and clear stale analysis", () => {
  const retained = email("other", "b");
  const previous = [
    { ...email("one"), analysis: { needsReply: true, reason: "Question", analyzedAt: 1 } },
    email("removed"),
    retained,
  ];
  const next = reconcileAccountEmails(previous, "a", [email("one"), email("new")]);
  expect(next.map((e) => e.id)).toEqual(["one", "other", "new"]);
  expect(next.find((e) => e.id === "one")?.analysis).toBeUndefined();
  expect(next.find((e) => e.id === "other")).toBe(retained);
});

test("empty, duplicate, and identical updates do not invalidate the inbox", () => {
  const emails = [email("one"), email("two")];
  useAppStore.setState({ emails });
  const before = useAppStore.getState();
  before.addEmails([]);
  before.addEmails(structuredClone(emails));
  before.updateEmail("missing", { body: "Missing" });
  before.updateEmail("one", { labelIds: ["INBOX"] });
  expect(useAppStore.getState()).toBe(before);
  before.addEmails([email("new"), { ...email("new"), subject: "Newest" }]);
  expect(useAppStore.getState().emails.filter((e) => e.id === "new")).toHaveLength(1);
  expect(useAppStore.getState().emails.at(-1)?.subject).toBe("Newest");
});

test("optimistic reads stay stable once applied and survive cloned metadata refreshes", () => {
  const emails = [email("one")];
  addOptimisticReads(["one"]);
  try {
    expect(applyOptimisticReads(emails)).toBe(emails);
    useAppStore.setState({ emails });
    useAppStore
      .getState()
      .replaceEmailsForAccount("a", [{ ...email("one"), labelIds: ["INBOX", "UNREAD"] }]);
    expect(useAppStore.getState().emails).toBe(emails);
  } finally {
    confirmOptimisticReads(["one"]);
  }
});

test("changing one message rebuilds only its thread, including bodies and moved messages", () => {
  const accounts = [{ id: "a", email: "me@example.test", isPrimary: true, isConnected: true }];
  const emails = [email("one"), email("two")];
  const snoozed = new Set<string>();
  const replied = new Map<string, number>();
  const first = selectThreadedEmails(emails, "a", accounts, snoozed, replied);
  const hydrated = [{ ...emails[0], body: "Hydrated body" }, emails[1]];
  const second = selectThreadedEmails(hydrated, "a", accounts, snoozed, replied);
  expect(second.threads.find((t) => t.threadId === "thread-two")).toBe(
    first.threads.find((t) => t.threadId === "thread-two"),
  );
  expect(second.threads.find((t) => t.threadId === "thread-one")?.latestEmail.body).toBe(
    "Hydrated body",
  );
  const snoozedResult = selectThreadedEmails(
    hydrated,
    "a",
    accounts,
    new Set(["thread-one"]),
    replied,
  );
  expect(snoozedResult.snoozed[0]).toBe(second.threads.find((t) => t.threadId === "thread-one"));
  const moved = [{ ...hydrated[0], threadId: "thread-two" }, hydrated[1]];
  const merged = selectThreadedEmails(moved, "a", accounts, snoozed, replied);
  expect(merged.threads).toHaveLength(1);
  expect(merged.threads[0].emails).toHaveLength(2);
  expect(
    selectThreadedEmails([moved[1]], "a", accounts, snoozed, replied).threads[0].emails,
  ).toEqual([moved[1]]);
});

test("switching accounts reuses conversations and inactive account updates leave the current inbox stable", () => {
  const accounts = ["a", "b"].map((id) => ({
    id,
    email: `${id}@example.test`,
    isPrimary: id === "a",
    isConnected: true,
  }));
  const emails = [email("one", "a"), email("two", "b")];
  const snoozed = new Set<string>();
  const replied = new Map<string, number>();
  const a = selectThreadedEmails(emails, "a", accounts, snoozed, replied);
  const b = selectThreadedEmails(emails, "b", accounts, snoozed, replied);
  expect(selectThreadedEmails(emails, "a", accounts, snoozed, replied).threads[0]).toBe(
    a.threads[0],
  );
  const changed = [emails[0], { ...emails[1], subject: "Updated in B" }];
  const before = selectThreadedEmails(emails, "a", accounts, snoozed, replied);
  const after = selectThreadedEmails(changed, "a", accounts, snoozed, replied);
  expect(after).toBe(before);
  const changedB = selectThreadedEmails(changed, "b", accounts, snoozed, replied);
  expect(changedB.threads[0]).not.toBe(b.threads[0]);
  expect(changedB.threads[0].subject).toBe("Updated in B");
  expect(selectThreadedEmails(changed, null, accounts, snoozed, replied).threads).toHaveLength(2);
  expect(
    selectThreadedEmails([changed[0]], null, accounts.slice(0, 1), snoozed, replied).threads,
  ).toHaveLength(1);
});
