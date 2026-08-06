/**
 * Centralized data directory resolution.
 *
 * Resolution order:
 * 1. `EXO_USER_DATA_DIR` (absolute path) — explicit override, honored in ALL
 *    modes including packaged builds. Used by the packaged smoke tests so a
 *    locally-built .app (same productName as the real install) never shares
 *    the production data dir. See user-data-override.ts.
 * 2. Non-packaged runs (`!app.isPackaged`) use a project-local `.dev-data/`
 *    directory so development never touches production data in
 *    `~/Library/Application Support/exo/`.
 * 3. Only packaged (released) builds use `app.getPath("userData")`.
 *
 * As of 2026-05-20, dev runs start with an empty `.dev-data/` and
 * authenticate fresh against the dedicated test Gmail account (set via
 * `EXOEMAILTEST_EMAIL` in `.env.local`).
 * Real-account state is never copied into dev — the prior bootstrap that
 * pulled tokens/db from the production directory has been removed.
 *
 * Electron is **lazy-required** so this module can be imported in
 * non-Electron contexts (e.g. eval runners under tsx) without crashing.
 * When Electron isn't available, getDataDir() returns a tmpdir-based
 * path scoped by EXO_NON_ELECTRON_DATA_DIR if set, or a default scratch
 * directory. Tests / eval runners SHOULD set EXO_NON_ELECTRON_DATA_DIR
 * if they want isolation, but the default path is safe (separate from
 * .dev-data/, so production-mode dev runs aren't affected).
 */
import { join, dirname } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { createRequire } from "module";
import { getUserDataOverride } from "./user-data-override";

const requireFromHere = createRequire(import.meta.url);

let _devDataDir: string | null = null;

interface ElectronShape {
  app: { isPackaged: boolean; getPath: (k: string) => string; getAppPath: () => string };
  is?: { dev: boolean };
}

function tryLoadElectron(): ElectronShape | null {
  try {
    const electron = requireFromHere("electron") as Partial<ElectronShape>;
    if (!electron.app || typeof electron.app.getPath !== "function") {
      // Electron's "main" module returns a string (the binary path) when
      // imported in a non-Electron Node process. Detect and treat as
      // unavailable.
      return null;
    }
    return electron as ElectronShape;
  } catch {
    return null;
  }
}

function tryLoadElectronToolkit(): { is: { dev: boolean } } | null {
  try {
    return requireFromHere("@electron-toolkit/utils") as { is: { dev: boolean } };
  } catch {
    return null;
  }
}

/**
 * Walk up from `start` until we find a directory containing
 * `package.json` (or run out of parents). Returns null if not found.
 *
 * Anchoring `.dev-data/` to the project root makes the path stable
 * across launch methods: `npm run dev` gives app.getAppPath()=project,
 * but Playwright's `_electron.launch({ args: [out/main/index.js] })`
 * gives app.getAppPath()=out/main. Both should resolve to the same
 * `.dev-data/`.
 */
function findProjectRoot(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, "package.json"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function getDataDir(): string {
  const override = getUserDataOverride();
  if (override) return override;

  const electron = tryLoadElectron();
  if (!electron) {
    // Non-Electron caller (eval runner, unit test under tsx, etc.).
    return process.env.EXO_NON_ELECTRON_DATA_DIR ?? join(tmpdir(), "exo-non-electron-data");
  }

  const toolkit = tryLoadElectronToolkit();
  const isDev = toolkit ? toolkit.is.dev : !electron.app.isPackaged;

  if (!isDev) return electron.app.getPath("userData");

  if (!_devDataDir) {
    const appPath = electron.app.getAppPath();
    const projectRoot = findProjectRoot(appPath) ?? appPath;
    _devDataDir = join(projectRoot, ".dev-data");
  }
  return _devDataDir;
}
