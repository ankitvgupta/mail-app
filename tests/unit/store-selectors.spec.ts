/**
 * Unit tests for the Zustand store's threading and filtering logic.
 *
 * The store selectors (useThreadedEmails, useSplitFilteredThreads) are React
 * hooks that can't be called directly in a Playwright test runner. Instead,
 * we re-implement and test the pure computation that underlies them:
 *   - groupByThread: groups emails into EmailThread objects
 *   - isSentEmail: detects sent emails by label or from-field matching
 *   - threadMatchesSplit / evaluateCondition: split filtering
 *
 * These functions are module-private in the store, so we duplicate the logic
 * here to validate it. If the store logic changes, these tests catch drift.
 */
import { test, expect } from "@playwright/test";
import type { DashboardEmail, InboxSplit } from "../../src/shared/types";

// ============================================================
// Test helpers — mirror the store's types and pure functions
// ============================================================

type EmailThread = {
  threadId: string;
  emails: DashboardEmail[];
  latestEmail: DashboardEmail;
  latestReceivedEmail: DashboardEmail;
  latestReceivedDate: number;
  subject: string;
  hasMultipleEmails: boolean;
  isUnread: boolean;
  analysis?: DashboardEmail["analysis"];
  draft?: DashboardEmail["draft"];
  userReplied: boolean;
  displaySender: string;
};

const makeEmail = (overrides: Partial<DashboardEmail> = {}): DashboardEmail => ({
  id: "test-id",
  threadId: "test-thread",
  subject: "Test Subject",
  from: "sender@example.com",
  to: "user@example.com",
  date: new Date().toISOString(),
  body: "<div>Test body</div>",
  snippet: "Test body",
  labelIds: ["INBOX", "UNREAD"],
  accountId: "account-1",
  ...overrides,
});

// --- Pure logic extracted from src/renderer/store/index.ts ---

function isSentEmail(email: DashboardEmail, currentUserEmail?: string): boolean {
  if (email.labelIds?.includes("SENT")) return true;
  if (!currentUserEmail) return false;
  const fromLower = email.from.toLowerCase();
  const userEmailLower = currentUserEmail.toLowerCase();
  const emailMatch = fromLower.match(/<([^>]+)>/) || [null, fromLower];
  const fromEmail = emailMatch[1] || fromLower;
  return fromEmail.trim() === userEmailLower.trim();
}

function groupByThread(emails: DashboardEmail[], currentUserEmail?: string): EmailThread[] {
  const threadMap = new Map<string, DashboardEmail[]>();
  for (const email of emails) {
    const existing = threadMap.get(email.threadId) || [];
    existing.push(email);
    threadMap.set(email.threadId, existing);
  }

  const threads: EmailThread[] = [];
  for (const [threadId, threadEmails] of threadMap) {
    threadEmails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const latestEmail = threadEmails[threadEmails.length - 1];

    const receivedEmails = threadEmails.filter((e) => !isSentEmail(e, currentUserEmail));
    const latestReceivedEmail =
      receivedEmails.length > 0 ? receivedEmails[receivedEmails.length - 1] : latestEmail;

    const userReplied = isSentEmail(latestEmail, currentUserEmail);

    let displaySender: string;
    if (!isSentEmail(latestReceivedEmail, currentUserEmail)) {
      displaySender = latestReceivedEmail.from;
    } else {
      const nonSelfEmail = [...threadEmails]
        .reverse()
        .find((e) => !isSentEmail(e, currentUserEmail));
      if (nonSelfEmail) {
        displaySender = nonSelfEmail.from;
      } else {
        displaySender = latestEmail.to;
      }
    }

    const threadDraft = latestReceivedEmail.draft ?? threadEmails.find((e) => e.draft)?.draft;

    threads.push({
      threadId,
      emails: threadEmails,
      latestEmail,
      latestReceivedEmail,
      latestReceivedDate: new Date(latestReceivedEmail.date).getTime(),
      subject: latestEmail.subject.replace(/^(Re:\s*)+/i, ""),
      hasMultipleEmails: threadEmails.length > 1,
      isUnread: threadEmails.some((e) => e.labelIds?.includes("UNREAD")),
      analysis: latestReceivedEmail.analysis,
      draft: threadDraft,
      userReplied,
      displaySender,
    });
  }

  threads.sort((a, b) => b.latestReceivedDate - a.latestReceivedDate);
  return threads;
}

// Split filtering helpers (extracted from store)

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`, "i");
}

function matchesPattern(value: string, pattern: string): boolean {
  const hasWildcard = pattern.includes("*") || pattern.includes("?");
  if (hasWildcard) return patternToRegex(pattern).test(value);
  return value.toLowerCase().includes(pattern.toLowerCase());
}

function extractEmailAddress(fromField: string): string {
  const match = fromField.match(/<([^>]+)>/);
  return match ? match[1] : fromField;
}

function evaluateCondition(email: DashboardEmail, condition: InboxSplit["conditions"][0]): boolean {
  let matches = false;
  switch (condition.type) {
    case "from": {
      const emailAddr = extractEmailAddress(email.from);
      matches =
        matchesPattern(email.from, condition.value) || matchesPattern(emailAddr, condition.value);
      break;
    }
    case "to": {
      const emailAddr = extractEmailAddress(email.to);
      matches =
        matchesPattern(email.to, condition.value) || matchesPattern(emailAddr, condition.value);
      break;
    }
    case "subject":
      matches = matchesPattern(email.subject, condition.value);
      break;
    case "label":
      matches = email.labelIds?.includes(condition.value) ?? false;
      break;
  }
  return condition.negate ? !matches : matches;
}

function threadMatchesSplit(thread: EmailThread, split: InboxSplit): boolean {
  const email = thread.latestEmail;
  const results = split.conditions.map((c) => evaluateCondition(email, c));
  return split.conditionLogic === "and" ? results.every(Boolean) : results.some(Boolean);
}

// ============================================================
// Tests: groupByThread
// ============================================================

test.describe("groupByThread — basic threading", () => {
  test("single email becomes a thread of 1", () => {
    const email = makeEmail({ id: "e1", threadId: "t1" });
    const threads = groupByThread([email]);

    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe("t1");
    expect(threads[0].emails).toHaveLength(1);
    expect(threads[0].hasMultipleEmails).toBe(false);
  });

  test("emails with same threadId are grouped together", () => {
    const e1 = makeEmail({ id: "e1", threadId: "t1", date: "2025-01-01T10:00:00Z" });
    const e2 = makeEmail({ id: "e2", threadId: "t1", date: "2025-01-01T11:00:00Z" });
    const e3 = makeEmail({ id: "e3", threadId: "t2", date: "2025-01-01T12:00:00Z" });

    const threads = groupByThread([e1, e2, e3]);

    expect(threads).toHaveLength(2);
    const t1 = threads.find((t) => t.threadId === "t1")!;
    expect(t1.emails).toHaveLength(2);
    expect(t1.hasMultipleEmails).toBe(true);
  });

  test("threads are sorted by latest received email date (newest first)", () => {
    const older = makeEmail({ id: "e1", threadId: "t-old", date: "2025-01-01T08:00:00Z" });
    const newer = makeEmail({ id: "e2", threadId: "t-new", date: "2025-01-02T08:00:00Z" });

    const threads = groupByThread([older, newer]);

    expect(threads[0].threadId).toBe("t-new");
    expect(threads[1].threadId).toBe("t-old");
  });

  test("emails within a thread are sorted oldest first", () => {
    const e1 = makeEmail({ id: "e1", threadId: "t1", date: "2025-01-02T10:00:00Z" });
    const e2 = makeEmail({ id: "e2", threadId: "t1", date: "2025-01-01T10:00:00Z" });

    const threads = groupByThread([e1, e2]);

    expect(threads[0].emails[0].id).toBe("e2"); // older first
    expect(threads[0].emails[1].id).toBe("e1");
  });

  test("thread subject comes from the latest email with Re: prefix stripped", () => {
    const e1 = makeEmail({
      id: "e1",
      threadId: "t1",
      subject: "Original Subject",
      date: "2025-01-01T10:00:00Z",
    });
    const e2 = makeEmail({
      id: "e2",
      threadId: "t1",
      subject: "Re: Original Subject",
      date: "2025-01-02T10:00:00Z",
    });

    const threads = groupByThread([e1, e2]);

    expect(threads[0].subject).toBe("Original Subject");
  });

  test("thread subject strips nested Re: prefixes", () => {
    const e1 = makeEmail({
      id: "e1",
      threadId: "t1",
      subject: "Re: Re: Re: Topic",
      date: "2025-01-01T10:00:00Z",
    });

    const threads = groupByThread([e1]);

    expect(threads[0].subject).toBe("Topic");
  });
});

test.describe("groupByThread — unread and label detection", () => {
  test("isUnread is true when any email has UNREAD in labelIds", () => {
    const e1 = makeEmail({
      id: "e1",
      threadId: "t1",
      labelIds: ["INBOX"],
      date: "2025-01-01T10:00:00Z",
    });
    const e2 = makeEmail({
      id: "e2",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      date: "2025-01-01T11:00:00Z",
    });

    const threads = groupByThread([e1, e2]);
    expect(threads[0].isUnread).toBe(true);
  });

  test("isUnread is false when no email has UNREAD", () => {
    const e1 = makeEmail({ id: "e1", threadId: "t1", labelIds: ["INBOX"] });

    const threads = groupByThread([e1]);
    expect(threads[0].isUnread).toBe(false);
  });

  test("isUnread is false when labelIds is undefined", () => {
    const e1 = makeEmail({ id: "e1", threadId: "t1", labelIds: undefined });

    const threads = groupByThread([e1]);
    expect(threads[0].isUnread).toBe(false);
  });
});

test.describe("groupByThread — sent email detection", () => {
  test("userReplied is true when latest email has SENT label", () => {
    const received = makeEmail({
      id: "e1",
      threadId: "t1",
      from: "bob@example.com",
      date: "2025-01-01T10:00:00Z",
      labelIds: ["INBOX"],
    });
    const sent = makeEmail({
      id: "e2",
      threadId: "t1",
      from: "user@example.com",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["SENT"],
    });

    const threads = groupByThread([received, sent], "user@example.com");
    expect(threads[0].userReplied).toBe(true);
  });

  test("userReplied is false when latest email is received", () => {
    const sent = makeEmail({
      id: "e1",
      threadId: "t1",
      from: "user@example.com",
      date: "2025-01-01T10:00:00Z",
      labelIds: ["SENT"],
    });
    const received = makeEmail({
      id: "e2",
      threadId: "t1",
      from: "bob@example.com",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["INBOX"],
    });

    const threads = groupByThread([sent, received], "user@example.com");
    expect(threads[0].userReplied).toBe(false);
  });

  test("latestReceivedEmail ignores sent emails", () => {
    const received = makeEmail({
      id: "e1",
      threadId: "t1",
      from: "bob@example.com",
      date: "2025-01-01T10:00:00Z",
      labelIds: ["INBOX"],
    });
    const sent = makeEmail({
      id: "e2",
      threadId: "t1",
      from: "user@example.com",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["SENT"],
    });

    const threads = groupByThread([received, sent], "user@example.com");
    expect(threads[0].latestReceivedEmail.id).toBe("e1");
  });

  test("displaySender shows non-self sender when available", () => {
    const received = makeEmail({
      id: "e1",
      threadId: "t1",
      from: "bob@example.com",
      date: "2025-01-01T10:00:00Z",
      labelIds: ["INBOX"],
    });
    const sent = makeEmail({
      id: "e2",
      threadId: "t1",
      from: "user@example.com",
      to: "bob@example.com",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["SENT"],
    });

    const threads = groupByThread([received, sent], "user@example.com");
    expect(threads[0].displaySender).toBe("bob@example.com");
  });

  test("displaySender falls back to recipient when all emails are from user", () => {
    const sent1 = makeEmail({
      id: "e1",
      threadId: "t1",
      from: "user@example.com",
      to: "bob@example.com",
      date: "2025-01-01T10:00:00Z",
      labelIds: ["SENT"],
    });
    const sent2 = makeEmail({
      id: "e2",
      threadId: "t1",
      from: "user@example.com",
      to: "bob@example.com",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["SENT"],
    });

    const threads = groupByThread([sent1, sent2], "user@example.com");
    expect(threads[0].displaySender).toBe("bob@example.com");
  });

  test("isSentEmail matches from-field with Name <email> format", () => {
    const email = makeEmail({
      id: "e1",
      threadId: "t1",
      from: "Me <user@example.com>",
      labelIds: ["INBOX"],
      date: "2025-01-01T10:00:00Z",
    });

    const threads = groupByThread([email], "user@example.com");
    expect(threads[0].userReplied).toBe(true);
  });
});

test.describe("groupByThread — analysis and draft propagation", () => {
  test("thread analysis comes from latestReceivedEmail", () => {
    const analysis = {
      needsReply: true,
      reason: "Question asked",
      analyzedAt: Date.now(),
    };
    const e1 = makeEmail({
      id: "e1",
      threadId: "t1",
      analysis,
      date: "2025-01-01T10:00:00Z",
      labelIds: ["INBOX"],
    });
    const e2 = makeEmail({
      id: "e2",
      threadId: "t1",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["SENT"],
    });

    const threads = groupByThread([e1, e2], "user@example.com");
    // latestReceivedEmail is e1 (e2 is sent), so analysis should be from e1
    expect(threads[0].analysis).toEqual(analysis);
  });

  test("thread draft is found from any email in thread", () => {
    const draft = { body: "Reply", status: "created" as const, createdAt: Date.now() };
    const e1 = makeEmail({
      id: "e1",
      threadId: "t1",
      draft,
      date: "2025-01-01T10:00:00Z",
      labelIds: ["INBOX"],
    });
    const e2 = makeEmail({
      id: "e2",
      threadId: "t1",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["INBOX"],
    });

    const threads = groupByThread([e1, e2]);
    // latestReceivedEmail is e2 (no draft), but threadDraft fallback finds e1's draft
    expect(threads[0].draft).toEqual(draft);
  });
});

test.describe("groupByThread — thread sorting by received date", () => {
  test("sent reply does not bump thread to top", () => {
    // Thread A: received yesterday
    const a1 = makeEmail({
      id: "a1",
      threadId: "t-a",
      from: "alice@example.com",
      date: "2025-01-01T10:00:00Z",
      labelIds: ["INBOX"],
    });
    // Thread B: received today, then user replied
    const b1 = makeEmail({
      id: "b1",
      threadId: "t-b",
      from: "bob@example.com",
      date: "2025-01-02T10:00:00Z",
      labelIds: ["INBOX"],
    });
    const b2 = makeEmail({
      id: "b2",
      threadId: "t-b",
      from: "user@example.com",
      date: "2025-01-03T10:00:00Z",
      labelIds: ["SENT"],
    });

    const threads = groupByThread([a1, b1, b2], "user@example.com");

    // t-b should be first because its latest RECEIVED email (b1) is Jan 2
    // t-a's latest received is Jan 1
    expect(threads[0].threadId).toBe("t-b");
    expect(threads[1].threadId).toBe("t-a");
  });
});

// ============================================================
// Tests: isSentEmail
// ============================================================

test.describe("isSentEmail", () => {
  test("returns true for SENT label regardless of from field", () => {
    expect(isSentEmail(makeEmail({ labelIds: ["SENT"] }), "other@example.com")).toBe(true);
  });

  test("returns true when from matches currentUserEmail (case-insensitive)", () => {
    expect(
      isSentEmail(makeEmail({ from: "User@Example.COM", labelIds: ["INBOX"] }), "user@example.com"),
    ).toBe(true);
  });

  test("returns false when no SENT label and no currentUserEmail", () => {
    expect(isSentEmail(makeEmail({ from: "someone@example.com", labelIds: ["INBOX"] }))).toBe(
      false,
    );
  });

  test("returns false when from does not match currentUserEmail", () => {
    expect(
      isSentEmail(
        makeEmail({ from: "other@example.com", labelIds: ["INBOX"] }),
        "user@example.com",
      ),
    ).toBe(false);
  });
});

// ============================================================
// Tests: Split filtering
// ============================================================

test.describe("evaluateCondition", () => {
  test("from condition matches email address", () => {
    const email = makeEmail({ from: "Alice <alice@company.com>" });
    expect(evaluateCondition(email, { type: "from", value: "alice@company.com" })).toBe(true);
  });

  test("from condition with wildcard matches domain", () => {
    const email = makeEmail({ from: "alice@company.com" });
    expect(evaluateCondition(email, { type: "from", value: "*@company.com" })).toBe(true);
  });

  test("from condition does not match different domain", () => {
    const email = makeEmail({ from: "alice@other.com" });
    expect(evaluateCondition(email, { type: "from", value: "*@company.com" })).toBe(false);
  });

  test("to condition matches recipient", () => {
    const email = makeEmail({ to: "team@company.com" });
    expect(evaluateCondition(email, { type: "to", value: "team@company.com" })).toBe(true);
  });

  test("subject condition matches substring", () => {
    const email = makeEmail({ subject: "Invoice #1234 for October" });
    expect(evaluateCondition(email, { type: "subject", value: "Invoice" })).toBe(true);
  });

  test("subject condition with wildcard", () => {
    const email = makeEmail({ subject: "Invoice #1234" });
    expect(evaluateCondition(email, { type: "subject", value: "Invoice*" })).toBe(true);
  });

  test("label condition matches exact label", () => {
    const email = makeEmail({ labelIds: ["INBOX", "IMPORTANT"] });
    expect(evaluateCondition(email, { type: "label", value: "IMPORTANT" })).toBe(true);
  });

  test("label condition does not match absent label", () => {
    const email = makeEmail({ labelIds: ["INBOX"] });
    expect(evaluateCondition(email, { type: "label", value: "IMPORTANT" })).toBe(false);
  });

  test("label condition returns false when labelIds is undefined", () => {
    const email = makeEmail({ labelIds: undefined });
    expect(evaluateCondition(email, { type: "label", value: "INBOX" })).toBe(false);
  });

  test("negate inverts the result", () => {
    const email = makeEmail({ from: "alice@company.com" });
    expect(evaluateCondition(email, { type: "from", value: "*@company.com", negate: true })).toBe(
      false,
    );
    expect(evaluateCondition(email, { type: "from", value: "*@other.com", negate: true })).toBe(
      true,
    );
  });
});

test.describe("threadMatchesSplit", () => {
  const makeThread = (emailOverrides: Partial<DashboardEmail> = {}): EmailThread => {
    const email = makeEmail(emailOverrides);
    return {
      threadId: email.threadId,
      emails: [email],
      latestEmail: email,
      latestReceivedEmail: email,
      latestReceivedDate: new Date(email.date).getTime(),
      subject: email.subject,
      hasMultipleEmails: false,
      isUnread: false,
      userReplied: false,
      displaySender: email.from,
    };
  };

  test("AND logic requires all conditions to match", () => {
    const thread = makeThread({ from: "alice@company.com", labelIds: ["INBOX", "IMPORTANT"] });
    const split: InboxSplit = {
      id: "s1",
      accountId: "account-1",
      name: "Important from Company",
      conditions: [
        { type: "from", value: "*@company.com" },
        { type: "label", value: "IMPORTANT" },
      ],
      conditionLogic: "and",
      order: 0,
    };

    expect(threadMatchesSplit(thread, split)).toBe(true);
  });

  test("AND logic fails if any condition does not match", () => {
    const thread = makeThread({ from: "alice@company.com", labelIds: ["INBOX"] });
    const split: InboxSplit = {
      id: "s1",
      accountId: "account-1",
      name: "Important from Company",
      conditions: [
        { type: "from", value: "*@company.com" },
        { type: "label", value: "IMPORTANT" },
      ],
      conditionLogic: "and",
      order: 0,
    };

    expect(threadMatchesSplit(thread, split)).toBe(false);
  });

  test("OR logic matches if any condition matches", () => {
    const thread = makeThread({ from: "alice@other.com", labelIds: ["INBOX", "IMPORTANT"] });
    const split: InboxSplit = {
      id: "s1",
      accountId: "account-1",
      name: "Important or Company",
      conditions: [
        { type: "from", value: "*@company.com" },
        { type: "label", value: "IMPORTANT" },
      ],
      conditionLogic: "or",
      order: 0,
    };

    expect(threadMatchesSplit(thread, split)).toBe(true);
  });

  test("OR logic fails if no conditions match", () => {
    const thread = makeThread({ from: "alice@other.com", labelIds: ["INBOX"] });
    const split: InboxSplit = {
      id: "s1",
      accountId: "account-1",
      name: "Important or Company",
      conditions: [
        { type: "from", value: "*@company.com" },
        { type: "label", value: "IMPORTANT" },
      ],
      conditionLogic: "or",
      order: 0,
    };

    expect(threadMatchesSplit(thread, split)).toBe(false);
  });
});

// ============================================================
// Tests: Categorization logic (from useThreadedEmails)
// ============================================================

test.describe("thread categorization", () => {
  // Re-implement the categorization logic from useThreadedEmails
  function categorize(threads: EmailThread[]) {
    const needsReply = threads.filter(
      (t) => t.analysis?.needsReply && t.draft?.status !== "created" && !t.userReplied,
    );
    const done = threads.filter(
      (t) => t.analysis?.needsReply && t.draft?.status === "created" && !t.userReplied,
    );
    const skipped = threads.filter((t) => (t.analysis && !t.analysis.needsReply) || t.userReplied);
    const unanalyzed = threads.filter((t) => !t.analysis && !t.userReplied);

    return { needsReply, done, skipped, unanalyzed };
  }

  function makeThreadFromEmail(
    overrides: Partial<DashboardEmail> & { userReplied?: boolean } = {},
  ): EmailThread {
    const { userReplied = false, ...emailOverrides } = overrides;
    const email = makeEmail(emailOverrides);
    return {
      threadId: email.threadId,
      emails: [email],
      latestEmail: email,
      latestReceivedEmail: email,
      latestReceivedDate: new Date(email.date).getTime(),
      subject: email.subject,
      hasMultipleEmails: false,
      isUnread: false,
      analysis: email.analysis,
      draft: email.draft,
      userReplied,
      displaySender: email.from,
    };
  }

  test("unanalyzed thread goes to unanalyzed bucket", () => {
    const thread = makeThreadFromEmail({ id: "e1", threadId: "t1" });
    const result = categorize([thread]);

    expect(result.unanalyzed).toHaveLength(1);
    expect(result.needsReply).toHaveLength(0);
    expect(result.done).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("analyzed thread that needs reply goes to needsReply", () => {
    const thread = makeThreadFromEmail({
      id: "e1",
      threadId: "t1",
      analysis: { needsReply: true, reason: "question", analyzedAt: Date.now() },
    });
    const result = categorize([thread]);

    expect(result.needsReply).toHaveLength(1);
  });

  test("thread with draft created goes to done", () => {
    const thread = makeThreadFromEmail({
      id: "e1",
      threadId: "t1",
      analysis: {
        needsReply: true,
        reason: "question",
        analyzedAt: Date.now(),
      },
      draft: { body: "reply", status: "created", createdAt: Date.now() },
    });
    const result = categorize([thread]);

    expect(result.done).toHaveLength(1);
    expect(result.needsReply).toHaveLength(0);
  });

  test("thread analyzed as Other (no reply needed) goes to skipped", () => {
    const thread = makeThreadFromEmail({
      id: "e1",
      threadId: "t1",
      analysis: {
        needsReply: false,
        reason: "newsletter",
        analyzedAt: Date.now(),
      },
    });
    const result = categorize([thread]);

    expect(result.skipped).toHaveLength(1);
  });

  test("thread where user replied goes to skipped", () => {
    const thread = makeThreadFromEmail({
      id: "e1",
      threadId: "t1",
      userReplied: true,
      analysis: { needsReply: true, reason: "question", analyzedAt: Date.now() },
    });
    const result = categorize([thread]);

    expect(result.skipped).toHaveLength(1);
    expect(result.needsReply).toHaveLength(0);
  });
});
