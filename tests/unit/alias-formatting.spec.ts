import { expect, test } from "@playwright/test";
import { excludeEmailAddress, formatAlias } from "../../src/renderer/utils/alias-formatting";

test.describe("formatAlias", () => {
  test("uses the account display name for a default alias without one", () => {
    expect(
      formatAlias(
        { email: "primary@example.com", displayName: "", isDefault: true },
        "Account Name",
      ),
    ).toBe("Account Name <primary@example.com>");
  });
});

test.describe("excludeEmailAddress", () => {
  test("removes the selected From alias from reply-all CC recipients", () => {
    const cc = ["Alias Name <alias@example.com>", "teammate@example.com"];

    expect(excludeEmailAddress(cc, "Sender Name <ALIAS@example.com>")).toEqual([
      "teammate@example.com",
    ]);
  });

  test("keeps other aliases in CC", () => {
    const cc = ["other-alias@example.com", "teammate@example.com"];

    expect(excludeEmailAddress(cc, "selected-alias@example.com")).toBe(cc);
  });
});
