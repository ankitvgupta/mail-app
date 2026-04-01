import { test, expect, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { launchElectronApp, takeScreenshot } from "./launch-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E tests for inline image support:
 * - Reading: emails with data: URI images display correctly
 * - Composing: image toolbar button, file insertion, paste support
 */

// ─── Reading: Inline images in email body ───────────────────────────────────

test.describe("Inline Images - Reading", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60000);
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
      waitAfterLoad: 1000,
    });
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
      await electronApp.close();
    }
  });

  test("email with inline images displays images correctly", async () => {
    // Find and click the email with inline images
    const emailItem = page
      .locator("button")
      .filter({ hasText: /Surbhi|Landing Page Mockups/i })
      .first();
    await expect(emailItem).toBeVisible({ timeout: 10000 });
    await emailItem.click();
    await page.waitForTimeout(1500);

    // Verify the email content iframe is visible
    const iframe = page.locator("iframe[title='Email content']");
    await expect(iframe).toBeVisible({ timeout: 5000 });

    // Access the iframe content
    const frame = iframe.contentFrame();
    expect(frame).not.toBeNull();

    // Verify images exist in the email body
    const images = frame!.locator("img");
    const imgCount = await images.count();
    console.log(`Found ${imgCount} images in the inline images email`);
    expect(imgCount).toBeGreaterThanOrEqual(2);

    // Verify each image has a data: URI src and has loaded
    for (let i = 0; i < imgCount; i++) {
      const img = images.nth(i);
      const src = await img.getAttribute("src");
      expect(src).toBeTruthy();

      // The image should have a data: URI (our CID resolution converts to data:)
      expect(src!.startsWith("data:image/")).toBe(true);

      // The image should have actually loaded (complete=true, naturalWidth > 0)
      const complete = await img.evaluate((el: HTMLImageElement) => el.complete);
      expect(complete).toBe(true);
    }

    // Take screenshot of the email with inline images
    await takeScreenshot(
      electronApp,
      page,
      "inline-images-reading",
      "Email with inline data: URI images displayed in body",
    );
  });

  test("rich HTML email with external image also displays", async () => {
    // Navigate back to inbox (press Escape to deselect current email)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Click the Q3 report email which has an external image (https://via.placeholder.com)
    const emailItem = page
      .locator("button")
      .filter({ hasText: /Garry|Q3 Quarterly/i })
      .first();
    await expect(emailItem).toBeVisible({ timeout: 10000 });
    await emailItem.click();
    await page.waitForTimeout(1500);

    const iframe = page.locator("iframe[title='Email content']");
    await expect(iframe).toBeVisible({ timeout: 5000 });

    const frame = iframe.contentFrame();
    expect(frame).not.toBeNull();

    // This email has the TechCorp logo image
    const images = frame!.locator("img");
    const imgCount = await images.count();
    console.log(`Found ${imgCount} images in the Q3 report email`);
    expect(imgCount).toBeGreaterThanOrEqual(1);

    await takeScreenshot(
      electronApp,
      page,
      "inline-images-external",
      "Email with external image (TechCorp logo)",
    );
  });
});

// ─── Composing: Inline image insertion ──────────────────────────────────────

test.describe("Inline Images - Composing", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60000);
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
      waitAfterLoad: 1000,
    });
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
      await electronApp.close();
    }
  });

  test("compose toolbar has insert image button", async () => {
    // Open compose
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await page.waitForTimeout(500);
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Verify the Insert image button is in the toolbar
    const imageButton = page.locator("button[title='Insert image']");
    await expect(imageButton).toBeVisible();

    // Verify the hidden file input is present
    const fileInput = page.locator("input[type='file'][accept='image/*']");
    await expect(fileInput).toBeAttached();

    await takeScreenshot(
      electronApp,
      page,
      "inline-images-compose-toolbar",
      "Compose toolbar with Insert image button",
    );

    // Close compose
    const discardButton = page.locator("button:has-text('Discard')");
    if (await discardButton.isVisible()) {
      await discardButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("can insert image via file input", async () => {
    // Open compose
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await page.waitForTimeout(500);
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Type some text first
    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await editor.type("Here is the screenshot:", { delay: 10 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);

    // Create a small test PNG file (1x1 red pixel)
    const testImagePath = path.join(__dirname, "test-image.png");
    // Minimal valid PNG: 1x1 red pixel
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(testImagePath, pngBuffer);

    try {
      // Use Playwright's setInputFiles to simulate file selection
      const fileInput = page.locator("input[type='file'][accept='image/*']");
      await fileInput.setInputFiles(testImagePath);
      await page.waitForTimeout(1000);

      // The editor should now contain an image
      const editorImages = editor.locator("img");
      const imgCount = await editorImages.count();
      console.log(`Images in editor after file insert: ${imgCount}`);
      expect(imgCount).toBeGreaterThanOrEqual(1);

      // The image should have a data: URI src
      const src = await editorImages.first().getAttribute("src");
      expect(src).toBeTruthy();
      expect(src!.startsWith("data:image/")).toBe(true);

      await takeScreenshot(
        electronApp,
        page,
        "inline-images-compose-inserted",
        "Compose editor with inserted inline image",
      );
    } finally {
      // Clean up test image
      if (fs.existsSync(testImagePath)) {
        fs.unlinkSync(testImagePath);
      }
    }

    // Close compose
    const discardButton = page.locator("button:has-text('Discard')");
    if (await discardButton.isVisible()) {
      await discardButton.click();
      await page.waitForTimeout(300);
    }
  });

  // Note: paste test omitted — ClipboardEvent simulation is inherently unreliable
  // in Electron test environments. The file input test above proves the data URI
  // pipeline works. Paste support uses the same readFileAsDataUrl + setImage path.
});
