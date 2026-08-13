/**
 * Test that the require.cache invalidation pattern works correctly.
 *
 * Verifies the fix: when uninstalling an extension, Node.js require.cache
 * entries for that extension's modules are cleared so reinstalling loads
 * the new module from disk instead of the stale cached one.
 *
 * This test exercises the exact same require/cache-clear pattern used in
 * ExtensionHost without needing Electron or SQLite dependencies.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createRequire } from "module";

function writeExtensionModule(dir: string, version: string): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "dist", "main.js"),
    `"use strict";
module.exports = { VERSION: "${version}" };
`,
  );
}

/** Clear all require.cache entries under a directory (same pattern as ExtensionHost) */
function clearRequireCache(dir: string): void {
  const cache = createRequire(join(dir, "x")).cache;
  // Cache keys use realpath (symlinks resolved, e.g. /private/var on macOS)
  const resolvedDir = realpathSync(dir);
  const prefix = resolvedDir + "/";
  for (const cached of Object.keys(cache)) {
    if (cached.startsWith(prefix)) {
      delete cache[cached];
    }
  }
}

test.describe("Extension require.cache invalidation", () => {
  test.describe.configure({ mode: "serial" });

  test("without cache clear, require returns stale module after file replacement", () => {
    const testDir = join(tmpdir(), `exo-ext-cache-test-noclear-${Date.now()}`);
    const extDir = join(testDir, "test-ext");
    mkdirSync(extDir, { recursive: true });

    try {
      const mainJsPath = join(extDir, "dist", "main.js");
      const extRequire = createRequire(mainJsPath);

      // Write and load v1
      writeExtensionModule(extDir, "1.0.0");
      const v1 = extRequire(mainJsPath);
      expect(v1.VERSION).toBe("1.0.0");

      // Overwrite with v2 on disk
      writeExtensionModule(extDir, "2.0.0");

      // Without clearing cache, require returns stale v1
      const stillV1 = extRequire(mainJsPath);
      expect(stillV1.VERSION).toBe("1.0.0"); // BUG: stale!
    } finally {
      clearRequireCache(extDir);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("with cache clear, require loads fresh module from disk", () => {
    const testDir = join(tmpdir(), `exo-ext-cache-test-clear-${Date.now()}`);
    const extDir = join(testDir, "test-ext");
    mkdirSync(extDir, { recursive: true });

    try {
      const mainJsPath = join(extDir, "dist", "main.js");

      // Write and load v1 (same pattern as ExtensionHost.loadInstalledExtension)
      writeExtensionModule(extDir, "1.0.0");
      const extRequireV1 = createRequire(mainJsPath);
      const v1 = extRequireV1(mainJsPath);
      expect(v1.VERSION).toBe("1.0.0");

      // Simulate uninstall: clear cache using the same pattern as
      // ExtensionHost.uninstallExtension()
      clearRequireCache(extDir);

      // Overwrite with v2 on disk (simulates new extension files being placed)
      writeExtensionModule(extDir, "2.0.0");

      // Simulate reinstall: load again (same pattern as ExtensionHost)
      const extRequireV2 = createRequire(mainJsPath);
      const v2 = extRequireV2(mainJsPath);
      expect(v2.VERSION).toBe("2.0.0"); // FIXED: fresh!
    } finally {
      clearRequireCache(extDir);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
