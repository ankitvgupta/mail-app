import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

/** Best-effort screenshot */
async function screenshot(page: Page, name: string) {
  const { mkdirSync } = await import("fs");
  mkdirSync("tests/screenshots", { recursive: true });
  await page.screenshot({ path: `tests/screenshots/${name}.png`, timeout: 5000 }).catch(() => {
    console.log(`Screenshot '${name}' timed out, skipping`);
  });
}

/** Get the data-thread-id of the currently selected (highlighted) row */
async function getSelectedThreadId(page: Page): Promise<string | null> {
  const selected = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600").first();
  if (await selected.isVisible().catch(() => false)) {
    return selected.getAttribute("data-thread-id");
  }
  return null;
}

test.describe("Arrow Key Navigation", () => {
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

  test("ArrowDown selects first email, same as j", async () => {
    await page.waitForTimeout(500);
    await screenshot(page, "arrow-nav-01-initial");

    // Press ArrowDown to select the first thread
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);

    const selectedAfterArrow = await getSelectedThreadId(page);
    expect(selectedAfterArrow).not.toBeNull();

    await screenshot(page, "arrow-nav-02-after-arrow-down");
  });

  test("ArrowDown and j navigate to the same positions", async () => {
    // Start fresh: press Escape to deselect
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Navigate down with j
    await page.keyboard.press("j");
    await page.waitForTimeout(300);
    const afterJ1 = await getSelectedThreadId(page);

    await page.keyboard.press("j");
    await page.waitForTimeout(300);
    const afterJ2 = await getSelectedThreadId(page);

    // Go back up to the first position with k
    await page.keyboard.press("k");
    await page.waitForTimeout(300);

    // Now navigate with ArrowDown from the same start position
    const backToFirst = await getSelectedThreadId(page);
    expect(backToFirst).toBe(afterJ1);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    const afterArrow = await getSelectedThreadId(page);

    // ArrowDown should land on the same thread as the second j press
    expect(afterArrow).toBe(afterJ2);

    await screenshot(page, "arrow-nav-03-arrow-matches-j");
  });

  test("ArrowUp navigates up, same as k", async () => {
    // Navigate down a couple times first
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    const thirdPosition = await getSelectedThreadId(page);

    // Go up with k
    await page.keyboard.press("k");
    await page.waitForTimeout(300);
    const afterK = await getSelectedThreadId(page);

    // Go back down to third position
    await page.keyboard.press("j");
    await page.waitForTimeout(300);
    expect(await getSelectedThreadId(page)).toBe(thirdPosition);

    // Go up with ArrowUp
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);
    const afterArrowUp = await getSelectedThreadId(page);

    // Should match the k result
    expect(afterArrowUp).toBe(afterK);

    await screenshot(page, "arrow-nav-04-arrow-up-matches-k");
  });

  test("mixed arrow and j/k navigation works together", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // j → ArrowDown → k → ArrowUp should return to start
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    const start = await getSelectedThreadId(page);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);

    await page.keyboard.press("k");
    await page.waitForTimeout(200);
    expect(await getSelectedThreadId(page)).toBe(start);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);

    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(200);
    expect(await getSelectedThreadId(page)).toBe(start);

    await screenshot(page, "arrow-nav-05-mixed-navigation");
  });
});
