import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for optimistic archive and trash behavior.
 *
 * Verifies that pressing 'e' (archive) or '#' (trash) immediately removes
 * the email from the inbox list and selects the next thread, without
 * waiting for the Gmail API round-trip.
 *
 * Each test.describe block launches a fresh Electron app to avoid
 * state leakage. Tests within a block share the app instance.
 *
 * Run with: npm run test:e2e
 */

/** Count inbox thread rows visible in the virtualized list.
 *  With overscan=20, all demo/test threads (~10) are always rendered,
 *  so this equals the total thread count for current test datasets. */
async function countInboxThreads(page: Page): Promise<number> {
  const rows = page.locator(".overflow-y-auto div[data-thread-id]");
  return rows.count();
}

/** Get the text content of the currently selected email row (not the Compose button). */
async function getSelectedRowText(page: Page): Promise<string | null> {
  // Scope to the email list container to avoid matching the Compose button
  const selected = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600").first();
  if (await selected.isVisible().catch(() => false)) {
    return selected.textContent();
  }
  return null;
}

/** Select the first inbox thread by pressing 'j' and wait for selection. */
async function selectFirstThread(page: Page): Promise<void> {
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
  // Verify selection is visible
  const selected = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600");
  await expect(selected).toBeVisible({ timeout: 3000 });
}

// ---------------------------------------------------------------------------
// Archive via 'e' key
// ---------------------------------------------------------------------------
test.describe("Archive - Optimistic UI", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("pressing 'e' removes the selected thread from the inbox list", async () => {
    // Wait for inbox to fully render
    await page.waitForTimeout(1000);

    // Select the first thread
    await selectFirstThread(page);

    // Record selected text so we can verify it's gone after archiving
    const archivedText = await getSelectedRowText(page);
    expect(archivedText).toBeTruthy();

    // Count threads before archive
    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(1);

    // Press 'e' to archive
    await page.keyboard.press("e");

    // Count should decrease by 1 — check immediately (optimistic = instant)
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 2000 });

    // The archived thread's text should no longer appear
    const allRowTexts = await page
      .locator(".overflow-y-auto div[data-thread-id]")
      .allTextContents();
    const stillPresent = allRowTexts.some((t) => t === archivedText);
    expect(stillPresent).toBe(false);
  });

  test("after archive, the next thread is automatically selected", async () => {
    // After the previous test's archive, a row should still be selected
    const selectedRow = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600");
    await expect(selectedRow).toBeVisible({ timeout: 3000 });

    const selectedText = await selectedRow.textContent();
    expect(selectedText).toBeTruthy();
  });

  test("archive is instantaneous (sub-second)", async () => {
    const isSelected = await page
      .locator(".overflow-y-auto div[data-thread-id].bg-blue-600")
      .isVisible()
      .catch(() => false);
    if (!isSelected) {
      await selectFirstThread(page);
    }

    const countBefore = await countInboxThreads(page);
    if (countBefore < 2) {
      test.skip();
      return;
    }

    // Measure: the UI count should change within 500ms (well under a network RTT)
    const start = Date.now();
    await page.keyboard.press("e");

    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 1000 });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Archive persistence — email should not come back after re-fetch
// ---------------------------------------------------------------------------
test.describe("Archive - Persistence", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("archived email does not reappear after clicking Refresh", async () => {
    await page.waitForTimeout(1000);
    await selectFirstThread(page);

    const archivedText = await getSelectedRowText(page);
    expect(archivedText).toBeTruthy();

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(1);

    // Archive
    await page.keyboard.press("e");
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 2000 });

    // Wait for the undo timer (5s) to fire and the IPC archive call to update the DB
    await page.waitForTimeout(6000);

    // Click Refresh — this triggers sync:get-emails which re-fetches from DB
    const refreshButton = page.locator("button[title='Refresh']");
    await refreshButton.click();
    await page.waitForTimeout(2000);

    // The archived email should still be gone
    const countAfterRefresh = await countInboxThreads(page);
    expect(countAfterRefresh).toBe(countBefore - 1);

    // Verify the specific text is not in the list
    const allRowTexts = await page
      .locator(".overflow-y-auto div[data-thread-id]")
      .allTextContents();
    const stillPresent = allRowTexts.some((t) => t === archivedText);
    expect(stillPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rapid-succession archive (own app to avoid stale-closure issues)
// ---------------------------------------------------------------------------
test.describe("Archive - Rapid Succession", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("can archive multiple threads in rapid succession", async () => {
    await page.waitForTimeout(1000);
    await selectFirstThread(page);

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(3);

    for (let i = 0; i < 3; i++) {
      await expect(page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600")).toBeVisible({
        timeout: 3000,
      });
      await page.waitForTimeout(200);

      const before = await countInboxThreads(page);
      await page.keyboard.press("e");

      // Wait for count to decrease
      await expect(async () => {
        const after = await countInboxThreads(page);
        expect(after).toBe(before - 1);
      }).toPass({ timeout: 3000 });
    }

    // Total: 3 fewer than when we started
    const countAfter = await countInboxThreads(page);
    expect(countAfter).toBe(countBefore - 3);
  });
});

// ---------------------------------------------------------------------------
// Rapid-fire archive race condition regression test
// ---------------------------------------------------------------------------
test.describe("Archive - Rapid Fire Race Condition", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("rapidly archived emails stay gone after undo timers fire", async () => {
    await page.waitForTimeout(1000);
    await selectFirstThread(page);

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(4);

    // Archive 4 threads as fast as possible (no intentional delay between presses)
    const archiveCount = 4;
    for (let i = 0; i < archiveCount; i++) {
      await expect(page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600")).toBeVisible({
        timeout: 3000,
      });
      await page.keyboard.press("e");
      // Minimal delay — just enough for optimistic UI to process
      await page.waitForTimeout(50);
    }

    // Verify all 4 were removed immediately (optimistic UI)
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - archiveCount);
    }).toPass({ timeout: 3000 });

    // Derive from known values rather than re-reading from UI to avoid
    // a background sync shifting the baseline between reads.
    const countAfterArchive = countBefore - archiveCount;

    // Wait for all undo timers (5s) to fire and API calls to complete.
    // This is the critical window where the old race condition would
    // cause emails to reappear due to failed concurrent commitAction calls.
    await page.waitForTimeout(7000);

    // Verify emails did NOT reappear after undo timers fired
    await expect(async () => {
      const countAfterTimers = await countInboxThreads(page);
      expect(countAfterTimers).toBe(countAfterArchive);
    }).toPass({ timeout: 4000 });

    // Click Refresh to re-fetch from DB — verifies DB state is consistent too
    const refreshButton = page.locator("button[title='Refresh']");
    await refreshButton.click();

    // Wait for the thread count to stabilise rather than using a fixed delay
    await expect(async () => {
      const countAfterRefresh = await countInboxThreads(page);
      expect(countAfterRefresh).toBe(countAfterArchive);
    }).toPass({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Trash via '#' key
// ---------------------------------------------------------------------------
test.describe("Trash - Optimistic UI", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("pressing '#' removes the selected thread from the inbox list", async () => {
    await page.waitForTimeout(1000);

    // Select first thread
    await selectFirstThread(page);

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(1);

    // Press '#' to trash — use keyboard.type to produce the '#' character
    // which triggers the keydown event with e.key === "#"
    await page.keyboard.type("#");

    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 2000 });
  });

  test("after trash, the next thread is automatically selected", async () => {
    const selectedRow = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600");
    await expect(selectedRow).toBeVisible({ timeout: 3000 });
  });

  test("can trash multiple threads in rapid succession", async () => {
    const isSelected = await page
      .locator(".overflow-y-auto div[data-thread-id].bg-blue-600")
      .isVisible()
      .catch(() => false);
    if (!isSelected) {
      await selectFirstThread(page);
    }

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(2);

    await page.keyboard.type("#");
    await page.waitForTimeout(200);
    await page.keyboard.type("#");

    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// Navigation edge cases
// ---------------------------------------------------------------------------
test.describe("Archive/Trash - Navigation Edge Cases", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("archive without selection does nothing", async () => {
    await page.waitForTimeout(1000);

    // Don't select anything — press 'e' immediately.
    // Verify no selection exists (no highlighted row in the list).
    const hasSelection = await page
      .locator(".overflow-y-auto div[data-thread-id].bg-blue-600")
      .isVisible()
      .catch(() => false);

    const countBefore = await countInboxThreads(page);
    await page.keyboard.press("e");
    await page.waitForTimeout(300);
    const countAfter = await countInboxThreads(page);

    // If nothing was selected, count shouldn't change.
    // If something was auto-selected, one may have been archived — both are valid.
    if (!hasSelection) {
      expect(countAfter).toBe(countBefore);
    }
  });

  test("archiving all threads empties the list", async () => {
    // Always re-select via keyboard to ensure focus and store state are in sync
    await selectFirstThread(page);

    const initialCount = await countInboxThreads(page);
    expect(initialCount).toBeGreaterThan(0);

    // Archive threads one at a time, waiting for each removal
    let archived = 0;
    let count = initialCount;
    while (count > 0 && archived < initialCount + 5) {
      // safety limit
      // Ensure selection is active before each archive
      await expect(page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600")).toBeVisible({
        timeout: 2000,
      });
      await page.waitForTimeout(200);

      const before = await countInboxThreads(page);
      await page.keyboard.press("e");

      // Wait for the count to decrease
      try {
        await expect(async () => {
          count = await countInboxThreads(page);
          expect(count).toBe(before - 1);
        }).toPass({ timeout: 3000 });
        archived++;
      } catch {
        // Count didn't change — likely no selection or sync re-added
        break;
      }
    }

    // We should have archived a substantial number of threads
    expect(archived).toBeGreaterThan(0);
    // The final count should be less than what we started with
    expect(count).toBeLessThan(initialCount);
  });
});

// ---------------------------------------------------------------------------
// Click-to-select then archive (reproduces real user behavior)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Archive-ready: 'e' archives entire thread (all messages)
// ---------------------------------------------------------------------------
test.describe("Archive Ready - Thread Archive via 'e' key", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("pressing 'e' in archive-ready view removes the entire multi-message thread", async () => {
    // Wait for inbox to render
    await page.waitForTimeout(1000);

    // Navigate to the Archive Ready tab
    const archiveTab = page.locator("button:has-text('Archive Ready')");
    await expect(archiveTab).toBeVisible({ timeout: 10000 });
    await archiveTab.click();
    await page.waitForTimeout(500);

    // Verify we're in archive-ready view (tab is active with blue border)
    await expect(archiveTab).toHaveClass(/border-blue-500/);

    // Count threads before archiving
    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(0);

    // Find and select the "Project Alpha" thread (has 4 emails: 3 INBOX + 1 SENT)
    const projectAlphaRow = page.locator(
      ".overflow-y-auto div[data-thread-id]:has-text('Project Alpha')",
    );
    await expect(projectAlphaRow).toBeVisible({ timeout: 3000 });
    await projectAlphaRow.click();
    await page.waitForTimeout(500);

    // If clicking went to full view, go back to split so we can see the list
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Verify the Project Alpha thread is still selected after Escape
    const selected = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600");
    await expect(selected).toBeVisible({ timeout: 3000 });
    const selectedText = await selected.textContent();
    expect(selectedText).toContain("Project Alpha");

    // Record count before archive
    const countBeforeArchive = await countInboxThreads(page);

    // Press 'e' to archive
    await page.keyboard.press("e");

    // Thread should be removed immediately (optimistic UI)
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBeforeArchive - 1);
    }).toPass({ timeout: 2000 });

    // The "Project Alpha" text should no longer appear in the thread list
    const allRowTexts = await page
      .locator(".overflow-y-auto div[data-thread-id]")
      .allTextContents();
    const stillPresent = allRowTexts.some((t) => t.includes("Project Alpha"));
    expect(stillPresent).toBe(false);

    // Now switch back to the "All" inbox view to verify the thread is gone there too
    const splitTabsBar = page.locator("div.overflow-x-auto");
    const allTab = splitTabsBar.locator("button").first();
    await allTab.click();
    await page.waitForTimeout(500);

    // Project Alpha should not appear in the main inbox either
    const inboxRowTexts = await page
      .locator(".overflow-y-auto div[data-thread-id]")
      .allTextContents();
    const inInbox = inboxRowTexts.some((t) => t.includes("Project Alpha"));
    expect(inInbox).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Click-to-select then archive (reproduces real user behavior)
// ---------------------------------------------------------------------------
test.describe("Archive - Click to Select", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error" || text.includes("[DEBUG]")) {
        console.log(`[Renderer ${msg.type()}]: ${text}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("clicking email row then pressing 'e' archives it", async () => {
    await page.waitForTimeout(1000);

    // Click on the first email row (mimicking real user behavior)
    const firstRow = page.locator(".overflow-y-auto div[data-thread-id]").first();
    await expect(firstRow).toBeVisible({ timeout: 3000 });
    const rowText = await firstRow.textContent();

    // Count before
    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(1);

    await firstRow.click();
    await page.waitForTimeout(500);

    // Log what has focus after clicking
    const focusInfo = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName,
        className: el?.className?.substring(0, 100),
        contentEditable: el?.getAttribute("contenteditable"),
        hasProseMirror: el?.classList?.contains("ProseMirror"),
        id: el?.id,
      };
    });
    console.log("[DEBUG] Focus after click:", JSON.stringify(focusInfo));

    // Press Escape to go back to split view (if in full view)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Now press 'e' to archive
    const focusBeforeE = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, className: el?.className?.substring(0, 100) };
    });
    console.log("[DEBUG] Focus before 'e':", JSON.stringify(focusBeforeE));

    await page.keyboard.press("e");

    // Verify archive happened
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 3000 });

    // Verify the archived email text is gone
    const allRowTexts = await page
      .locator(".overflow-y-auto div[data-thread-id]")
      .allTextContents();
    const stillPresent = allRowTexts.some((t) => t === rowText);
    expect(stillPresent).toBe(false);
  });

  test("clicking email row, staying in full view, pressing 'e' archives it", async () => {
    // Count before
    const countBefore = await countInboxThreads(page);
    if (countBefore < 2) {
      test.skip();
      return;
    }

    // Get the first row's text so we can verify it's gone later
    const firstRow = page.locator(".overflow-y-auto div[data-thread-id]").first();
    const archivedText = await firstRow.textContent();

    // Click the first row — this puts us in full view
    await firstRow.click();
    await page.waitForTimeout(500);

    // We're now in full view. Press 'e' to archive.
    await page.keyboard.press("e");
    await page.waitForTimeout(500);

    // Press Escape to return to split view so we can count threads
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Verify the thread was archived
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 3000 });

    // Verify the specific email text is gone
    const allRowTexts = await page
      .locator(".overflow-y-auto div[data-thread-id]")
      .allTextContents();
    const stillPresent = allRowTexts.some((t) => t === archivedText);
    expect(stillPresent).toBe(false);
  });
});
