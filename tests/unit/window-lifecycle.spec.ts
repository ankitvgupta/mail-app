import { test, expect } from "@playwright/test";
import { shouldHideWindowOnClose } from "../../src/main/window-lifecycle";

test.describe("window close lifecycle", () => {
  test("normal macOS window close preserves the renderer", () => {
    expect(shouldHideWindowOnClose("darwin", false)).toBe(true);
  });

  test("intentional macOS app quit destroys the window", () => {
    expect(shouldHideWindowOnClose("darwin", true)).toBe(false);
  });

  test("non-macOS window close keeps the native close behavior", () => {
    expect(shouldHideWindowOnClose("win32", false)).toBe(false);
    expect(shouldHideWindowOnClose("linux", false)).toBe(false);
  });
});
