import { _electron as electron } from "@playwright/test";

async function main() {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, EXO_DEMO_MODE: "true", NODE_ENV: "test" },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("text=Inbox", { timeout: 10000 });
  console.log("✓ Inbox loaded");

  // Click on an email first to ensure something is visible
  await page.locator('[data-testid="email-list-item"]').first().click();
  await page.waitForTimeout(300);

  // Open find bar directly via renderer store
  await page.evaluate(() => {
    // Access Zustand store from the window
    const el = document.querySelector('[data-testid="find-bar-input"]');
    if (el) return; // already open
    // Dispatch Cmd+F keyboard event
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  });
  await page.waitForTimeout(500);

  // Check if find bar opened
  const findBarVisible = await page.locator('[data-testid="find-bar"]').isVisible();
  if (!findBarVisible) {
    console.log("Find bar not visible, trying keyboard...");
    await page.keyboard.press("Meta+f");
    await page.waitForTimeout(500);
  }

  const stillNotVisible = !(await page.locator('[data-testid="find-bar"]').isVisible());
  if (stillNotVisible) {
    console.log("FAIL: Cannot open find bar by any method");
    // Debug: check what keys useKeyboardShortcuts sees
    await page.evaluate(() => {
      window.addEventListener("keydown", (e) => {
        console.log("keydown:", e.key, "meta:", e.metaKey);
      });
    });
    await page.keyboard.press("Meta+f");
    await page.waitForTimeout(200);

    // Check if openFindBar exists in store
    const hasStore = await page.evaluate(() => {
      return typeof (window as any).__ZUSTAND_DEVTOOLS_STORE !== "undefined";
    });
    console.log("Has zustand devtools: " + hasStore);

    // Try direct API
    const hasApi = await page.evaluate(() => typeof (window as any).api?.find);
    console.log("Has find API: " + hasApi);

    await app.close();
    return;
  }

  console.log("✓ Find bar opened");

  const findInput = page.locator('[data-testid="find-bar-input"]');

  // Type and trigger initial search
  await findInput.pressSequentially("the", { delay: 30 });
  await page.evaluate(() => {
    (window as any).api.find.find("the", { findNext: true, forward: true });
  });
  await page.waitForTimeout(500);

  let countText = await page.locator('[data-testid="find-bar-count"]').innerText().catch(() => "");
  console.log("Initial: " + (countText || "(empty)"));

  // Cycle via IPC
  const ordinals: string[] = [];
  for (let i = 1; i <= 6; i++) {
    await page.evaluate(() => {
      (window as any).api.find.find("the", { findNext: true, forward: true });
    });
    await page.waitForTimeout(200);
    countText = await page.locator('[data-testid="find-bar-count"]').innerText().catch(() => "");
    ordinals.push(countText);
  }
  console.log("Forward: " + ordinals.join(" → "));

  // Verify
  const nums = ordinals.map((s) => {
    const m = s.match(/^(\d+)/);
    return m ? parseInt(m[1]) : 0;
  });
  const advancing = nums.every((n, i) => i === 0 || n !== nums[i - 1]);
  console.log(`Cycling: ${advancing ? "✓ WORKS" : "✗ BROKEN"} (${nums.join(",")})`);

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
