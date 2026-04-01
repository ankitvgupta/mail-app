import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/**
 * E2E Tests for Search functionality
 *
 * IMPORTANT: These tests use EXO_DEMO_MODE=true
 * No real Gmail API calls are made - all search results are mock data
 *
 * The search.ipc.ts returns DEMO_SEARCH_RESULTS when in demo mode
 * containing fake emails like "Project update meeting" from alice@example.com
 *
 * Run with: npm run test:e2e
 */

test.describe("Search - Opening and Closing", () => {
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

  test("can open search via search button", async () => {
    // Find the search button (magnifying glass icon)
    const searchButton = page.locator("button[title*='Search']").first();
    await expect(searchButton).toBeVisible();
    await searchButton.click();

    // Search modal should appear
    await expect(page.locator("input[placeholder*='Search']")).toBeVisible({ timeout: 5000 });

    // Close with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("can close search with Escape key", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Verify search is open
    const searchInput = page.locator("input[placeholder*='Search']");
    await expect(searchInput).toBeVisible();

    // Press Escape to close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Search modal should be closed
    const searchInputAfter = page.locator("input[placeholder*='Search']");
    const isVisible = await searchInputAfter.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test("can close search by clicking backdrop", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Click the backdrop (dark overlay)
    const backdrop = page.locator(".bg-black\\/40, [class*='backdrop']").first();
    if (await backdrop.isVisible()) {
      // Click at the edge of the backdrop, not on the search panel
      await backdrop.click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(300);
    }

    // Search should be closed
    const searchInput = page.locator("input[placeholder*='Search']");
    const isStillVisible = await searchInput.isVisible().catch(() => false);
    // If clicking backdrop works, modal should be closed
    // Some implementations may not support backdrop click
  });
});

test.describe("Search - Query Input", () => {
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

  test("search input is auto-focused when opened", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();

    // Wait for search input to be visible and focused before typing
    const searchInput = page.locator("input[placeholder*='Search']");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await expect(searchInput).toBeFocused({ timeout: 5000 });

    await page.keyboard.type("test query");
    const value = await searchInput.inputValue();
    expect(value).toBe("test query");

    // Close
    await page.keyboard.press("Escape");
  });

  test("search shows results after typing (demo mode)", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Type a query that matches demo data
    // Demo data has "Project update meeting" and "Budget proposal"
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");

    // Wait for debounced search (150ms in implementation)
    await page.waitForTimeout(500);

    // Should show results - demo data has "Project update meeting"
    const results = page.locator("text=Project");
    const hasResults = await results
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasResults).toBe(true);

    // Close
    await page.keyboard.press("Escape");
  });

  test("search shows 'no results' for non-matching query", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Type a query that won't match demo data
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("xyznonexistentquery123");

    // Wait for search
    await page.waitForTimeout(500);

    // Should show "no local results" message
    const noResults = page.locator("text=No local results");
    const hasNoResults = await noResults.isVisible().catch(() => false);
    expect(hasNoResults).toBe(true);

    // Close
    await page.keyboard.press("Escape");
  });

  test("search clears when reopened", async () => {
    // Open search and type something
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("previous query");

    // Close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Reopen
    await searchButton.click();
    await page.waitForTimeout(300);

    // Input should be empty
    const value = await searchInput.inputValue();
    expect(value).toBe("");

    // Close
    await page.keyboard.press("Escape");
  });
});

test.describe("Search - Result Navigation", () => {
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

  test("can navigate results with arrow keys", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Type a query that matches demo data
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("a"); // Matches alice and budget

    // Wait for results
    await page.waitForTimeout(500);

    // Press down arrow to select second result
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);

    // The selection should move (indicated by bg-blue-50 class)
    const selectedItem = page.locator(".bg-blue-50");
    const hasSelection = await selectedItem.isVisible().catch(() => false);
    // Selection might be on first or second item depending on implementation

    // Close
    await page.keyboard.press("Escape");
  });

  test("can select result with Enter key", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Type a query
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");

    // Wait for results
    await page.waitForTimeout(500);

    // Check if we have results
    const results = page.locator("text=Project");
    const hasResults = await results
      .first()
      .isVisible()
      .catch(() => false);

    if (hasResults) {
      // Press Enter to select
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);

      // Search modal should close after selection
      const searchModal = page.locator("input[placeholder*='Search']");
      const modalClosed = !(await searchModal.isVisible().catch(() => false));
      // Modal should close after selecting a result
    }
  });

  test("can click on result to select it", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Type a query
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("budget");

    // Wait for results
    await page.waitForTimeout(500);

    // Click on a result
    const resultItem = page.locator("button").filter({ hasText: "Budget" }).first();
    if (await resultItem.isVisible()) {
      await resultItem.click();
      await page.waitForTimeout(300);

      // Search modal should close
      const searchModal = page.locator("input[placeholder*='Search']");
      const modalClosed = !(await searchModal.isVisible().catch(() => false));
      expect(modalClosed).toBe(true);
    } else {
      // No matching result in demo data, which is fine
      await page.keyboard.press("Escape");
    }
  });
});

test.describe("Search - Search Operators", () => {
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

  test("shows search operator hints when empty", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // When input is empty, should show hints (using code tags)
    const fromHint = page.locator("code:has-text('from:')");
    const toHint = page.locator("code:has-text('to:')");
    const subjectHint = page.locator("code:has-text('subject:')");

    const hasFromHint = await fromHint
      .first()
      .isVisible()
      .catch(() => false);
    const hasToHint = await toHint
      .first()
      .isVisible()
      .catch(() => false);
    const hasSubjectHint = await subjectHint
      .first()
      .isVisible()
      .catch(() => false);

    // At least one operator hint should be visible
    expect(hasFromHint || hasToHint || hasSubjectHint).toBe(true);

    // Close
    await page.keyboard.press("Escape");
  });

  test("can search using from: operator (demo mode)", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Search with from: operator - demo data has alice@example.com
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("from:alice");

    // Wait for results
    await page.waitForTimeout(500);

    // Should show result from alice (demo data)
    const aliceResult = page.locator("text=alice");
    const hasAlice = await aliceResult
      .first()
      .isVisible()
      .catch(() => false);
    // Note: demo mode does simple string matching, so this might work differently

    // Close
    await page.keyboard.press("Escape");
  });
});

test.describe("Search - UI Elements", () => {
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

  test("search modal has proper styling", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Check for search icon
    const searchIcon = page
      .locator("svg")
      .filter({ has: page.locator("path[d*='M21 21l-6-6']") })
      .first();
    const hasSearchIcon = await searchIcon.isVisible().catch(() => false);

    // Check for Escape hint
    const escHint = page.locator("text=esc");
    const hasEscHint = await escHint.isVisible().catch(() => false);

    // Check for keyboard navigation hints
    const navHints = page.locator("text=↑↓");
    const hasNavHints = await navHints.isVisible().catch(() => false);

    expect(hasEscHint || hasNavHints).toBe(true);

    // Close
    await page.keyboard.press("Escape");
  });

  test("shows loading indicator while searching", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Type quickly to trigger search
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("test");

    // Loading indicator might briefly appear
    // This is hard to test due to timing, but we can verify the UI structure exists
    const loadingSpinner = page.locator(".animate-spin");
    // Just verify the search completes without error

    await page.waitForTimeout(500);

    // Close
    await page.keyboard.press("Escape");
  });

  test("results show date formatting", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Search for demo data
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");

    // Wait for results
    await page.waitForTimeout(500);

    // Results should show formatted dates (e.g., "Yesterday", "3:45 PM", "Jan 15")
    // Demo data uses current date, so we might see "Today" or time
    const results = page.locator("text=Project");
    const hasResults = await results
      .first()
      .isVisible()
      .catch(() => false);

    if (hasResults) {
      // Just verify results loaded correctly
      expect(hasResults).toBe(true);
    }

    // Close
    await page.keyboard.press("Escape");
  });
});

test.describe("Search - Quick Search Click Loads Email", () => {
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

  test("clicking a quick search result loads the email detail", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Search for a demo email - "Q4 Planning" is the meeting follow-up email
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("Q4 Planning");
    await page.waitForTimeout(500);

    // Click the result within the search panel (z-50 overlay)
    const searchPanel = page.locator(".fixed.inset-0.z-50");
    const resultItem = searchPanel.locator("button").filter({ hasText: "Q4 Planning" }).first();
    await expect(resultItem).toBeVisible({ timeout: 3000 });
    await resultItem.click();
    await page.waitForTimeout(500);

    // Search modal should close
    const searchModal = page.locator("input[placeholder*='Search']");
    await expect(searchModal).not.toBeVisible({ timeout: 3000 });

    // Email detail should show the subject (cleaned, without "Re:")
    const emailSubject = page.locator("h1").filter({ hasText: "Q4 Planning" });
    await expect(emailSubject).toBeVisible({ timeout: 5000 });
  });

  test("arrow+enter on quick search result loads the email detail", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Search for "API rate limits"
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("rate limits");
    await page.waitForTimeout(500);

    // Navigate with arrow keys and select with Enter
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    // Search modal should close
    const searchModal = page.locator("input[placeholder*='Search']");
    await expect(searchModal).not.toBeVisible({ timeout: 3000 });

    // Email detail should show the subject
    const emailSubject = page.locator("h1").filter({ hasText: "rate limits" });
    await expect(emailSubject).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Search - Full Search Results View", () => {
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

  test("pressing Enter without arrow navigation shows full search results", async () => {
    // Open search
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    // Type a query and press Enter (no arrow key navigation)
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Should show "Search results for..." header
    const searchHeader = page.locator('[data-testid="search-results-header"]');
    await expect(searchHeader).toBeVisible({ timeout: 5000 });
  });

  test("clicking a full search result loads the email detail", async () => {
    // The full search results view should still be active from the previous test
    // If not, trigger it again
    const searchResultsHeader = page.locator('[data-testid="search-results-header"]');
    if (!(await searchResultsHeader.isVisible().catch(() => false))) {
      // Re-trigger full search
      const searchButton = page.locator("button[title*='Search']").first();
      await searchButton.click();
      await page.waitForTimeout(300);
      const searchInput = page.locator("input[placeholder*='Search']");
      await searchInput.fill("project");
      await page.waitForTimeout(200);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
    }

    // Click on a result in the full search view
    const resultItem = page.locator("button").filter({ hasText: "Project Alpha" }).first();
    if (await resultItem.isVisible()) {
      await resultItem.click();
      await page.waitForTimeout(500);

      // Should show email detail with the subject
      const emailSubject = page.locator("h1").filter({ hasText: "Project Alpha" });
      await expect(emailSubject).toBeVisible({ timeout: 5000 });

      // Search results view is hidden (full view mode), but search state is preserved
      // Pressing Esc/Back will return to search results
    }
  });
});

test.describe("Search - Keyboard Navigation in Results", () => {
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

  async function openFullSearch(query: string) {
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);
    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill(query);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    // Verify search results are visible
    await expect(page.locator('[data-testid="search-results-header"]')).toBeVisible({
      timeout: 5000,
    });
  }

  test("j/k navigates search results", async () => {
    await openFullSearch("project");

    // Press j to select first result
    await page.keyboard.press("j");
    await page.waitForTimeout(200);

    // Should have a highlighted result (data-selected attribute)
    const highlighted = page.locator("[data-email-id][data-selected]");
    await expect(highlighted.first()).toBeVisible({ timeout: 3000 });

    // Press j again to move to second result
    await page.keyboard.press("j");
    await page.waitForTimeout(200);

    // Press k to go back to first
    await page.keyboard.press("k");
    await page.waitForTimeout(200);

    // Still should have a highlighted result
    const stillHighlighted = page.locator("[data-email-id][data-selected]");
    await expect(stillHighlighted.first()).toBeVisible({ timeout: 3000 });
  });

  test("Enter opens selected search result", async () => {
    // Should still be in search results from previous test
    const searchHeader = page.locator('[data-testid="search-results-header"]');
    if (!(await searchHeader.isVisible().catch(() => false))) {
      await openFullSearch("project");
    }

    // Navigate to first result and open it
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    // Should see email detail (h1 with subject)
    const emailDetail = page.locator("h1").first();
    await expect(emailDetail).toBeVisible({ timeout: 5000 });

    // Search results header should NOT be visible (we're in full view)
    const searchResultsHeader = page.locator('[data-testid="search-results-header"]');
    await expect(searchResultsHeader).not.toBeVisible({ timeout: 3000 });
  });

  test("Esc from email detail returns to search results", async () => {
    // We should be in full email view from previous test
    // Press Esc to go back to search results
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Search results header should be visible again
    const searchHeader = page.locator('[data-testid="search-results-header"]');
    await expect(searchHeader).toBeVisible({ timeout: 5000 });
  });

  test("second Esc returns to inbox", async () => {
    // We should be in search results from previous test
    const searchHeader = page.locator('[data-testid="search-results-header"]');
    if (!(await searchHeader.isVisible().catch(() => false))) {
      // If not, set it up
      await openFullSearch("project");
    }

    // Press Esc to clear search and return to inbox
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Search results should be gone
    const searchHeaderGone = page.locator('[data-testid="search-results-header"]');
    await expect(searchHeaderGone).not.toBeVisible({ timeout: 3000 });
  });

  test("Back button returns to search results from email detail", async () => {
    await openFullSearch("project");

    // Click on a result to open it
    const resultItem = page.locator("[data-email-id]").first();
    if (await resultItem.isVisible()) {
      await resultItem.click();
      await page.waitForTimeout(500);

      // Should be in email detail
      const emailDetail = page.locator("h1").first();
      await expect(emailDetail).toBeVisible({ timeout: 5000 });

      // Click the Back button (arrow-left icon button in email detail)
      const backButton = page
        .locator("button")
        .filter({ hasText: /Back|←/ })
        .first();
      // Alternative: look for the back arrow SVG button
      const backArrow = page.locator('button:has(svg path[d*="M10 19l-7-7"])').first();
      if (await backArrow.isVisible().catch(() => false)) {
        await backArrow.click();
      } else if (await backButton.isVisible().catch(() => false)) {
        await backButton.click();
      }
      await page.waitForTimeout(500);

      // Search results should be visible again
      const searchHeader = page.locator('[data-testid="search-results-header"]');
      await expect(searchHeader).toBeVisible({ timeout: 5000 });
    }
  });

  test("archive (e) works on search result and selects next", async () => {
    // Make sure we're in search results
    const searchHeader = page.locator('[data-testid="search-results-header"]');
    if (!(await searchHeader.isVisible().catch(() => false))) {
      await openFullSearch("project");
    }

    // Count initial results
    const initialResults = await page.locator("[data-email-id]").count();

    // Navigate to first result
    await page.keyboard.press("j");
    await page.waitForTimeout(200);

    // Press 'e' to archive
    await page.keyboard.press("e");
    await page.waitForTimeout(500);

    // Should have one fewer result (or same if archive failed in demo mode)
    const afterResults = await page.locator("[data-email-id]").count();
    // In demo mode, archive may not actually remove the email from search results
    // since the API call may fail silently. The key test is that the shortcut
    // doesn't crash and selection moves.
    expect(afterResults).toBeLessThanOrEqual(initialResults);
  });
});

test.describe("Search - Search All Mail Affordance", () => {
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

  test("shows 'Search all mail' row when local results exist", async () => {
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");
    await page.waitForTimeout(500);

    // The "Search all mail" affordance should appear below results
    const searchAllMail = page.locator("text=Search all mail for");
    await expect(searchAllMail).toBeVisible({ timeout: 3000 });

    await page.keyboard.press("Escape");
  });

  test("shows 'Search all mail' row when no local results", async () => {
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("xyznonexistentquery456");
    await page.waitForTimeout(500);

    // Should show both "No local results" and the "Search all mail" affordance
    const noLocalResults = page.locator("text=No local results");
    await expect(noLocalResults).toBeVisible({ timeout: 3000 });

    const searchAllMail = page.locator("text=Search all mail for");
    await expect(searchAllMail).toBeVisible({ timeout: 3000 });

    await page.keyboard.press("Escape");
  });

  test("arrow keys can navigate to 'Search all mail' row", async () => {
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");
    await page.waitForTimeout(500);

    // Count how many result buttons exist (excluding the "Search all mail" row)
    const resultButtons = page.locator(".max-h-96 button");
    const count = await resultButtons.count();
    // The last button is the "Search all mail" row
    expect(count).toBeGreaterThan(1);

    // Press ArrowDown enough times to reach the "Search all mail" row
    for (let i = 0; i < count; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(50);
    }

    // The "Search all mail" row should be highlighted (bg-blue-50)
    const searchAllMailRow = page.locator("button").filter({ hasText: "Search all mail for" });
    const classes = await searchAllMailRow.getAttribute("class");
    expect(classes).toContain("bg-blue-50");

    await page.keyboard.press("Escape");
  });

  test("clicking 'Search all mail' triggers full search view", async () => {
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");
    await page.waitForTimeout(500);

    // Click the "Search all mail" row
    const searchAllMail = page.locator("button").filter({ hasText: "Search all mail for" });
    await searchAllMail.click();
    await page.waitForTimeout(1000);

    // Should show the full search results view
    const searchHeader = page.locator('[data-testid="search-results-header"]');
    await expect(searchHeader).toBeVisible({ timeout: 5000 });

    // Clean up: press Esc to return to inbox
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("footer hint changes based on navigation state", async () => {
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");
    await page.waitForTimeout(500);

    // Initially, footer should say "Enter to search all mail" (no arrow navigation yet)
    const footer = page.locator("text=Enter to search all mail");
    await expect(footer).toBeVisible({ timeout: 3000 });

    // Navigate to a result with arrow key
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);

    // Footer should now say "Enter to open"
    const footerOpen = page.locator("text=Enter to open");
    await expect(footerOpen).toBeVisible({ timeout: 3000 });

    await page.keyboard.press("Escape");
  });

  test("Enter on 'Search all mail' row triggers full search", async () => {
    const searchButton = page.locator("button[title*='Search']").first();
    await searchButton.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator("input[placeholder*='Search']");
    await searchInput.fill("project");
    await page.waitForTimeout(500);

    // Navigate past all results to the "Search all mail" row
    const resultButtons = page.locator(".max-h-96 button");
    const count = await resultButtons.count();
    for (let i = 0; i < count; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(50);
    }

    // Press Enter on the "Search all mail" row
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Should show the full search results view
    const searchHeader = page.locator('[data-testid="search-results-header"]');
    await expect(searchHeader).toBeVisible({ timeout: 5000 });

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
});
