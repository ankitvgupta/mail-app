/**
 * Unit tests for send-as alias detection and selection logic.
 */
import { test, expect } from "@playwright/test";
import { detectAliasFromThread } from "../../src/renderer/hooks/useSendAsAliases";
import type { SendAsAlias } from "../../src/shared/types";

const aliases: SendAsAlias[] = [
  { email: "primary@example.com", displayName: "Primary", isPrimary: true, treatAsAlias: false },
  { email: "alias@company.com", displayName: "Work Alias", isPrimary: false, treatAsAlias: true },
  { email: "other@domain.org", displayName: null, isPrimary: false, treatAsAlias: true },
];

test.describe("detectAliasFromThread", () => {
  test("returns undefined when only one alias exists", () => {
    const singleAlias = [aliases[0]];
    const threadEmails = [{ to: "primary@example.com", cc: undefined }];
    expect(detectAliasFromThread(singleAlias, threadEmails)).toBeUndefined();
  });

  test("returns undefined when no aliases match thread", () => {
    const threadEmails = [
      { to: "stranger@elsewhere.com" },
      { to: "nobody@nowhere.com", cc: "random@test.com" },
    ];
    expect(detectAliasFromThread(aliases, threadEmails)).toBeUndefined();
  });

  test("returns undefined for empty thread", () => {
    expect(detectAliasFromThread(aliases, [])).toBeUndefined();
  });

  test("matches alias in To header of most recent email", () => {
    const threadEmails = [
      { to: "stranger@elsewhere.com" },
      { to: "alias@company.com" },
    ];
    // Most recent email (last in array) has the alias in To
    expect(detectAliasFromThread(aliases, threadEmails)).toBe("alias@company.com");
  });

  test("matches alias in CC header", () => {
    const threadEmails = [
      { to: "stranger@elsewhere.com", cc: "other@domain.org" },
    ];
    expect(detectAliasFromThread(aliases, threadEmails)).toBe("other@domain.org");
  });

  test("prefers most recent email match over older", () => {
    const threadEmails = [
      { to: "other@domain.org" },       // older email matches other@
      { to: "alias@company.com" },       // newer email matches alias@
    ];
    // Should return the match from the most recent email (last in array)
    expect(detectAliasFromThread(aliases, threadEmails)).toBe("alias@company.com");
  });

  test("prefers To over CC in the same email", () => {
    const threadEmails = [
      { to: "alias@company.com", cc: "other@domain.org" },
    ];
    expect(detectAliasFromThread(aliases, threadEmails)).toBe("alias@company.com");
  });

  test("handles formatted addresses with display names", () => {
    const threadEmails = [
      { to: "Stranger <stranger@elsewhere.com>, Work Alias <alias@company.com>" },
    ];
    expect(detectAliasFromThread(aliases, threadEmails)).toBe("alias@company.com");
  });

  test("handles case-insensitive matching", () => {
    const threadEmails = [
      { to: "ALIAS@COMPANY.COM" },
    ];
    expect(detectAliasFromThread(aliases, threadEmails)).toBe("alias@company.com");
  });
});
