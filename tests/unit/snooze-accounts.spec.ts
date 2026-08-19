import { test, expect } from "@playwright/test";
import {
  buildSnoozeThreadAccounts,
  type ThreadAccountLookup,
} from "../../src/renderer/utils/snooze-accounts";

function lookupFrom(map: Record<string, string | undefined>) {
  return (threadId: string): ThreadAccountLookup | undefined =>
    threadId in map ? { threadId, accountId: map[threadId] } : undefined;
}

test.describe("buildSnoozeThreadAccounts", () => {
  test("maps each thread to its own account across accounts", () => {
    const result = buildSnoozeThreadAccounts(
      ["t1", "t2", "t3"],
      lookupFrom({ t1: "account-a", t2: "account-b", t3: "account-c" }),
      "t1",
      "account-a",
      "fallback",
    );

    expect(result).toEqual({ t1: "account-a", t2: "account-b", t3: "account-c" });
  });

  test("uses the trigger account for the triggering thread even if lookup differs", () => {
    // The triggering thread's account is already known (from the snoozed email),
    // so it must win over a (possibly stale) lookup value.
    const result = buildSnoozeThreadAccounts(
      ["t1", "t2"],
      lookupFrom({ t1: "stale", t2: "account-b" }),
      "t1",
      "account-a",
      "fallback",
    );

    expect(result.t1).toBe("account-a");
    expect(result.t2).toBe("account-b");
  });

  test("falls back when a thread's account can't be resolved", () => {
    const result = buildSnoozeThreadAccounts(
      ["t1", "t2"],
      lookupFrom({ t1: undefined, t2: undefined }), // present but no accountId
      "t0",
      "account-a",
      "fallback",
    );

    expect(result).toEqual({ t0: "account-a", t1: "fallback", t2: "fallback" });
  });

  test("falls back when a thread is missing from the lookup entirely", () => {
    const result = buildSnoozeThreadAccounts(
      ["t1"],
      lookupFrom({}), // no threads known
      "t0",
      "account-a",
      "fallback",
    );

    expect(result).toEqual({ t0: "account-a", t1: "fallback" });
  });

  test("uses the fallback for the trigger thread when its account is empty", () => {
    const result = buildSnoozeThreadAccounts(
      [],
      lookupFrom({}),
      "t0",
      "",
      "fallback",
    );

    expect(result).toEqual({ t0: "fallback" });
  });
});
