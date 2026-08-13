import { test, expect, _electron as electron, Page, ElectronApplication } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

function createTestExtensionZip(dir: string, version: string): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "mail-ext-test-reinstall",
      version,
      mailExtension: {
        id: "test-reinstall",
        displayName: "Test Reinstall v" + version,
        description: "Test extension version " + version,
        builtIn: false,
        version,
        activationEvents: ["onEmail"],
      },
    }),
  );
  writeFileSync(
    join(dir, "dist", "main.js"),
    [
      '"use strict";',
      "module.exports = {",
      '  VERSION: "' + version + '",',
      "  activate: function() {},",
      "  deactivate: function() {},",
      "};",
    ].join("\n"),
  );
  const zipPath = join(dir, "ext-v" + version + ".zip");
  execFileSync("zip", ["-r", zipPath, "package.json", "dist/"], { cwd: dir });
  return zipPath;
}

test.describe("Extension reinstall E2E", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;
  const testDir = join(tmpdir(), "exo-ext-e2e-" + Date.now());
  let zipV1: string;
  let zipV2: string;

  test.beforeAll(async () => {
    mkdirSync(join(testDir, "v1"), { recursive: true });
    mkdirSync(join(testDir, "v2"), { recursive: true });
    zipV1 = createTestExtensionZip(join(testDir, "v1"), "1.0.0");
    zipV2 = createTestExtensionZip(join(testDir, "v2"), "2.0.0");

    electronApp = await electron.launch({
      args: [join(__dirname, "../../out/main/index.js")],
      env: {
        ...process.env,
        NODE_ENV: "test",
        EXO_DEMO_MODE: "true",
      },
    });
    page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Exo", { timeout: 15000 });
  });

  test.afterAll(async () => {
    try {
      await page.evaluate(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).electronAPI.extensions.uninstall("test-reinstall"),
      );
    } catch {
      /* may not be installed */
    }
    if (electronApp) {
      const pid = electronApp.process().pid;
      try {
        if (pid) process.kill(pid, "SIGTERM");
      } catch { /* already exited */ }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch { /* already exited */ }
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("install v1, then v2 over it, verify v2 loads", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1: any = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (z) => (window as any).electronAPI.extensions.install(z),
      zipV1,
    );
    expect(r1.success).toBe(true);
    expect(r1.data.id).toBe("test-reinstall");
    expect(r1.data.version).toBe("1.0.0");
    expect(r1.data.isActive).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list1: any = await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI.extensions.listInstalled(),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext1 = list1.data.find((e: any) => e.id === "test-reinstall");
    expect(ext1).toBeTruthy();
    expect(ext1.version).toBe("1.0.0");

    // Install v2 over v1 (no restart)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2: any = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (z) => (window as any).electronAPI.extensions.install(z),
      zipV2,
    );
    expect(r2.success).toBe(true);
    expect(r2.data.id).toBe("test-reinstall");
    expect(r2.data.version).toBe("2.0.0");
    expect(r2.data.isActive).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list2: any = await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI.extensions.listInstalled(),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext2 = list2.data.find((e: any) => e.id === "test-reinstall");
    expect(ext2).toBeTruthy();
    expect(ext2.version).toBe("2.0.0");
  });
});
