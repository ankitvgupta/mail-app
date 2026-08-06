import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Regression guard for the prod-config wipe (July 2026).
 *
 * `clean_test_dbs()` in scripts/run-tests.sh used to `rm -f` the
 * electron-store config from the GLOBAL per-user app dirs — including the
 * packaged app's real install dir — so every `npm test` deleted the user's
 * production API keys and settings. Dev/test state lives exclusively in the
 * project-local `.dev-data/` (src/main/data-dir.ts), so no script or test
 * has any business referencing global app-data locations — or constructing
 * paths from the home directory at all.
 *
 * Like data-dir.spec.ts, this guards at the file-content level: any mention
 * of a global app-data path in scripts/, tests/, or benchmarks/ is a bug
 * waiting to fire, regardless of how it's used.
 *
 * Scans TRACKED files only (git ls-files): untracked local scratch files
 * (agent run artifacts, incident notes) can't hurt CI and must not turn
 * this test into a machine-local flake.
 */

const SELF = "tests/unit/no-global-data-dirs.spec.ts";

// Fragments assembled by concatenation so this file doesn't flag itself.
const AS = "Application" + " " + "Support";
const FORBIDDEN: { pattern: RegExp; description: string }[] = [
  { pattern: new RegExp(`${AS}/exo`, "i"), description: "macOS prod data dir (exo)" },
  { pattern: new RegExp(`${AS}/Electron`), description: "macOS Electron default data dir" },
  // Shell-escaped space variant: Application\ Support/exo
  // (regex source `Application\\ Support/exo` — one literal backslash + space)
  { pattern: new RegExp("Application\\\\ Support/exo", "i"), description: "escaped macOS prod data dir" },
  { pattern: /\.config\/exo/i, description: "Linux prod data dir (exo)" },
  { pattern: /\.config\/Electron/, description: "Linux Electron default data dir" },
  { pattern: /AppData\/Roaming\/exo/i, description: "Windows prod data dir (exo)" },
  // Segment-wise construction: join(home, "Library", "Application Support", ...)
  { pattern: new RegExp(`"${AS}"\\s*,`), description: "segment-joined global data dir" },
  // The root cause: home-anchored path construction in cleanup-capable code.
  { pattern: /\bhomedir\s*\(/, description: "homedir() path construction" },
  { pattern: /\bos\.homedir\b/, description: "os.homedir path construction" },
  { pattern: /\$\{?HOME[}/]/, description: "$HOME path construction" },
];

// Files allowed to contain specific patterns (inert fixtures, not path code).
const ALLOWLIST: { file: string; description: string }[] = [
  // Bash-hook unit tests assert that the agent-sandbox hook DENIES commands
  // containing $HOME — the strings are adversarial fixtures, not paths.
  { file: "tests/unit/bash-hook.spec.ts", description: "$HOME path construction" },
];

const SCAN_ROOTS = ["scripts", "tests", "benchmarks"];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...SCAN_ROOTS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter((f) => f.length > 0 && f !== SELF);
}

// A pattern that matches nothing is a silently dead guard (this happened: the
// escaped-space variant shipped doubly-escaped and never matched anything).
// Prove every FORBIDDEN entry catches its canonical bad example.
test("every forbidden pattern matches its canonical bad example", () => {
  const BS = "\\";
  const samples: [string, string][] = [
    [`rm -f "$dir/${AS}/exo/exo-config.json"`, "macOS prod data dir (exo)"],
    [`"${AS}/Electron/data"`, "macOS Electron default data dir"],
    [`rm -rf $HOME/Library/Application${BS} Support/exo`, "escaped macOS prod data dir"],
    [`rm -f "$home/.config/exo/exo-config.json"`, "Linux prod data dir (exo)"],
    [`"$home/.config/Electron"`, "Linux Electron default data dir"],
    [`join(appData, "AppData/Roaming/exo")`, "Windows prod data dir (exo)"],
    [`join(home, "Library", "${AS}", "exo")`, "segment-joined global data dir"],
    [`const dir = join(homedir(), ".config")`, "homedir() path construction"],
    [`const dir = os.homedir()`, "os.homedir path construction"],
    [`rm -rf "$HOME/Library"`, "$HOME path construction"],
  ];
  for (const [sample, description] of samples) {
    const entry = FORBIDDEN.find((f) => f.description === description);
    expect(entry, `pattern registered: ${description}`).toBeDefined();
    expect(entry!.pattern.test(sample), `"${description}" must match: ${sample}`).toBe(true);
  }
});

test("scripts/, tests/, benchmarks/ never reference global per-user app-data dirs", () => {
  const files = trackedFiles();
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const { pattern, description } of FORBIDDEN) {
      if (!pattern.test(content)) continue;
      const allowed = ALLOWLIST.some((a) => a.file === file && a.description === description);
      if (!allowed) {
        violations.push(`${relative(REPO_ROOT, join(REPO_ROOT, file))} contains ${description} (${pattern})`);
      }
    }
  }
  expect(violations).toEqual([]);
});
