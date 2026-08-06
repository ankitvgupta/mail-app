import { test, expect } from "@playwright/test";
import type { DashboardEmail, NavigationStateSnapshot } from "../../src/shared/types";
import {
  resolveInitialAccountId,
  sanitizeNavigationState,
} from "../../src/renderer/navigation-persistence";

const accounts = [
  { id: "account-a", isPrimary: true },
  { id: "account-b", isPrimary: false },
];

const snapshot: NavigationStateSnapshot = {
  accountId: null,
  currentSplitId: "__priority__",
  selectedEmailId: "message-1",
  selectedThreadId: "thread-1",
  focusedThreadEmailId: "message-1",
  viewMode: "full",
};

const emails = [
  {
    id: "message-1",
    threadId: "thread-1",
    accountId: "account-b",
    subject: "Selected message",
    from: "sender@example.com",
    to: ["me@example.com"],
    date: "2026-08-05T12:00:00.000Z",
    snippet: "Selected",
    labelIds: ["INBOX"],
  },
] as DashboardEmail[];

test.describe("navigation persistence", () => {
  test("the navigation snapshot restores All Inboxes", () => {
    expect(resolveInitialAccountId(accounts, "account-a", snapshot)).toBeNull();
  });

  test("a removed persisted account falls back to the primary account", () => {
    expect(
      resolveInitialAccountId(accounts, "account-b", {
        ...snapshot,
        accountId: "removed-account",
      }),
    ).toBe("account-a");
  });

  test("restores a valid selected message and full-thread view", () => {
    expect(sanitizeNavigationState(snapshot, null, emails)).toEqual({
      currentSplitId: "__priority__",
      selectedEmailId: "message-1",
      selectedThreadId: "thread-1",
      focusedThreadEmailId: "message-1",
      viewMode: "full",
    });
  });

  test("falls back to split view when the selected thread no longer exists", () => {
    expect(sanitizeNavigationState(snapshot, null, [])).toEqual({
      currentSplitId: "__priority__",
      selectedEmailId: null,
      selectedThreadId: null,
      focusedThreadEmailId: null,
      viewMode: "split",
    });
  });

  test("resets account-scoped custom splits when restoring a snapshot", () => {
    const restored = sanitizeNavigationState(
      {
        accountId: "account-a",
        currentSplitId: "custom-account-a",
        selectedEmailId: null,
        selectedThreadId: null,
        focusedThreadEmailId: null,
        viewMode: "split",
      },
      "account-b",
      [],
    );

    expect(restored?.currentSplitId).toBe("__priority__");
  });
});
