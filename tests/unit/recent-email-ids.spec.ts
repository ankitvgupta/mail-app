import { test, expect } from "@playwright/test";
import { getRecentEmailIds } from "../../src/renderer/utils/recent-email-ids";

test("recent warmup uses parsed dates from unordered snapshots without mutating them", () => {
  const emails = Object.freeze([
    { id: "old", date: "Tue, 06 Jan 2026 12:00:00 +0000" },
    { id: "invalid", date: "unknown" },
    { id: "middle", date: "2026-01-07T12:00:00Z" },
    { id: "newest", date: "Thu, 08 Jan 2026 08:00:00 -0800" },
  ]);
  expect(getRecentEmailIds(emails, 2)).toEqual(["newest", "middle"]);
  expect(getRecentEmailIds(emails)).toEqual(["newest", "middle", "old", "invalid"]);
  expect(getRecentEmailIds(emails, 0)).toEqual([]);
  expect(getRecentEmailIds([])).toEqual([]);
});

test("equal and malformed dates have deterministic account and message tie-breaks", () => {
  const emails = [
    { id: "b-two", accountId: "b", date: "2026-01-01" },
    { id: "a-two", accountId: "a", date: "2026-01-01" },
    { id: "a-one", accountId: "a", date: "2026-01-01" },
    { id: "invalid-two", accountId: "a", date: "unknown" },
    { id: "invalid-one", accountId: "a", date: "unknown" },
  ];
  const expected = ["a-one", "a-two", "b-two", "invalid-one", "invalid-two"];
  expect(getRecentEmailIds(emails)).toEqual(expected);
  expect(getRecentEmailIds([...emails].reverse())).toEqual(expected);
  expect(getRecentEmailIds(emails.filter((email) => email.accountId === "b"))).toEqual(["b-two"]);
});

test("large multi-account warmup stays capped at 60 and parses each date only once", () => {
  const emails = Array.from({ length: 30_000 }, (_, index) => {
    // Coprime permutation keeps the newest messages scattered throughout the
    // snapshot instead of accidentally testing already sorted database rows.
    const minute = (index * 7919) % 30_000;
    return {
      id: `email-${minute}`,
      accountId: `account-${minute % 3}`,
      date: new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString(),
    };
  });
  const originalParse = Date.parse;
  let parsedDates = 0;
  Date.parse = (date) => {
    parsedDates++;
    return originalParse(date);
  };
  let ids: string[];
  try {
    ids = getRecentEmailIds(emails);
  } finally {
    Date.parse = originalParse;
  }
  expect(ids).toEqual(Array.from({ length: 60 }, (_, index) => `email-${29_999 - index}`));
  expect(parsedDates).toBe(emails.length);
});
