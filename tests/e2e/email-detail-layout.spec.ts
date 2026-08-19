import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { closeApp, launchElectronApp } from "./launch-helpers";

async function openEmail(page: Page, subject: string) {
  const email = page.locator("button").filter({ hasText: subject }).first();
  await expect(email).toBeVisible({ timeout: 10000 });
  await email.click();
  await expect(page.getByTestId("email-detail-scroll")).toBeVisible({ timeout: 5000 });
}

test.describe("Email detail layout", () => {
  test.describe.configure({ mode: "serial" });

  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const launched = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = launched.app;
    page = launched.page;
    await page.locator("[data-thread-id]").first().waitFor({ timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) await closeApp(electronApp);
  });

  test("a short email fills the pane and keeps classification at the bottom", async () => {
    await openEmail(page, "CI workflow failed on main");

    const scroller = page.getByTestId("email-detail-scroll");
    const messages = page.getByTestId("email-thread-messages");
    const message = page.locator('[data-email-id="demo-006"] .group\\/msg');
    const analysis = page.getByTestId("analysis-priority-section");

    await expect(analysis).toBeVisible();

    const [scrollerBox, messagesBox, messageBox, analysisBox] = await Promise.all([
      scroller.boundingBox(),
      messages.boundingBox(),
      message.boundingBox(),
      analysis.boundingBox(),
    ]);

    expect(scrollerBox).not.toBeNull();
    expect(messagesBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    expect(analysisBox).not.toBeNull();

    const scrollerBottom = scrollerBox!.y + scrollerBox!.height;
    const analysisBottom = analysisBox!.y + analysisBox!.height;
    const messageBottom = messageBox!.y + messageBox!.height;

    expect(Math.abs(scrollerBottom - analysisBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(messageBottom - analysisBox!.y)).toBeLessThanOrEqual(1);
    expect(messagesBox!.height).toBeGreaterThan(messageBox!.height - 1);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight))
      .toBe(await scroller.evaluate((element) => element.clientHeight));
  });

  test("a long email still scrolls to the classification row", async () => {
    await page.getByRole("button", { name: "Back" }).click();
    await openEmail(page, "Weekly Product Update");

    const scroller = page.getByTestId("email-detail-scroll");
    const analysis = page.getByTestId("analysis-priority-section");
    const iframe = page.locator('iframe[title="Email content"]').first();

    await expect(iframe).toBeVisible();
    await expect.poll(async () => (await iframe.boundingBox())?.height ?? 0).toBeGreaterThan(400);

    const dimensions = await scroller.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

    await expect
      .poll(() =>
        scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          const analysisSection = element.querySelector(
            '[data-testid="analysis-priority-section"]',
          );
          if (!analysisSection) return Number.POSITIVE_INFINITY;
          const scrollerBox = element.getBoundingClientRect();
          const analysisBox = analysisSection.getBoundingClientRect();
          return Math.abs(scrollerBox.bottom - analysisBox.bottom);
        }),
      )
      .toBeLessThanOrEqual(1);
    await expect(analysis).toBeVisible();
  });
});
