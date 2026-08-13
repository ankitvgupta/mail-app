/**
 * Unit tests for scripts/lib/agentic-helpers.mjs.
 *
 * Covers the pure logic in the agentic-verify driver: JSON extraction
 * from messy agent output, tool-call summarization, and markdown
 * report rendering.
 *
 * These tests intentionally don't run the agent itself — that requires
 * Electron + an Anthropic key. End-to-end self-test of the driver
 * lifecycle lives in driver-behavior.spec.ts.
 */
import { test, expect } from "@playwright/test";
import {
  extractFinalJson,
  summarizeToolCalls,
  renderReportMd,
  isNoUiSurfaceDiff,
  // @ts-expect-error — .mjs without type declarations; helpers are pure JS.
} from "../../scripts/lib/agentic-helpers.mjs";

test.describe("extractFinalJson", () => {
  test("finds a clean trailing JSON object", () => {
    const text = `I did the steps. Here's the result:
{"verdict":"pass","summary":"all good","anomalies":[],"actions_taken":5}`;
    const r = extractFinalJson(text);
    expect(r.verdict).toBe("pass");
    expect(r.actions_taken).toBe(5);
  });

  test("ignores JSON that doesn't have a verdict field", () => {
    const text = `{"foo":"bar"} some text {"verdict":"fail","summary":"x","anomalies":[]}`;
    const r = extractFinalJson(text);
    expect(r.verdict).toBe("fail");
  });

  test("picks the LAST verdict-bearing JSON if multiple", () => {
    const text =
      `{"verdict":"pass","summary":"early","anomalies":[]} ` +
      `more text ` +
      `{"verdict":"fail","summary":"final","anomalies":[]}`;
    const r = extractFinalJson(text);
    expect(r.summary).toBe("final");
  });

  test("returns null when no verdict-bearing JSON present", () => {
    expect(extractFinalJson("no json here")).toBeNull();
    expect(extractFinalJson("{not valid json}")).toBeNull();
    expect(extractFinalJson('{"some": "object"}')).toBeNull();
  });

  test("handles nested objects in the same blob", () => {
    const text = `{"verdict":"pass","summary":"x","anomalies":[{"type":"layout","description":"d"}],"actions_taken":2}`;
    const r = extractFinalJson(text);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0].type).toBe("layout");
  });

  // Regression: a live run in the managed-agents repo produced anomaly
  // descriptions quoting API bodies — braces inside string values broke the
  // old regex-based scanner, so a 6-anomaly "anomalies_found" verdict was
  // silently read as inconclusive with 0 anomalies.
  test("handles braces inside string values", () => {
    const text =
      `Found issues.\n` +
      `{"verdict":"anomalies_found","summary":"x","anomalies":[` +
      `{"type":"stuck_state","description":"dialog shows {error: 'failed'} and never closes",` +
      `"repro":"click Send → observe {\\"error\\":\\"...\\"} toast"}],"actions_taken":12}`;
    const r = extractFinalJson(text);
    expect(r.verdict).toBe("anomalies_found");
    expect(r.anomalies).toHaveLength(1);
  });

  test("handles pretty-printed (multi-line) JSON", () => {
    const text = `prose first\n{\n  "verdict": "pass",\n  "summary": "ok",\n  "anomalies": []\n}`;
    const r = extractFinalJson(text);
    expect(r.verdict).toBe("pass");
  });

  test("handles JSON inside a markdown fence", () => {
    const text = '```json\n{"verdict":"fail","summary":"x","anomalies":[]}\n```';
    const r = extractFinalJson(text);
    expect(r.verdict).toBe("fail");
  });
});

test.describe("isNoUiSurfaceDiff", () => {
  test("empty diff is not soft-passable", () => {
    // An empty changed-file list must not be treated as "no UI surface" —
    // there's nothing to verify either way, and a real run always has a diff.
    expect(isNoUiSurfaceDiff([])).toBe(false);
    expect(isNoUiSurfaceDiff(null)).toBe(false);
  });

  test("pure lockfile bump → true (the security-audit-fix case)", () => {
    expect(isNoUiSurfaceDiff(["package-lock.json"])).toBe(true);
  });

  test("package.json alone → false (it carries scripts / main / build config)", () => {
    // package.json is deliberately NOT in the no-UI-surface set: from the
    // filename alone we can't tell a dependency-range bump from an edit to
    // npm scripts, the `main` entry point, or the electron-builder `build`
    // config — all behavioral. So a package.json change always stays on the
    // real-verification path, including a direct-dep bump (package.json + lock).
    expect(isNoUiSurfaceDiff(["package.json"])).toBe(false);
    expect(isNoUiSurfaceDiff(["package.json", "package-lock.json"])).toBe(false);
  });

  test("infra paths (tests/scripts/docs/.github) → true", () => {
    expect(
      isNoUiSurfaceDiff([
        "tests/unit/foo.spec.ts",
        "scripts/pre-pr.mjs",
        "docs/EVALS.md",
        ".github/workflows/ci.yml",
      ]),
    ).toBe(true);
  });

  test("lockfile mixed with infra paths → true", () => {
    expect(isNoUiSurfaceDiff(["package-lock.json", "scripts/lib/agentic-helpers.mjs"])).toBe(true);
  });

  test("repo-metadata files → true", () => {
    expect(isNoUiSurfaceDiff([".gitignore", "CLAUDE.md", "README.md"])).toBe(true);
  });

  test("any src/ file present → false (a used dependency change has a surface)", () => {
    // The safety property: if a bumped dependency is actually exercised by
    // new behavior, the consuming src/ file is in the diff too, which takes
    // it off the soft-pass path and routes it to real verification.
    expect(isNoUiSurfaceDiff(["package-lock.json", "src/main/index.ts"])).toBe(false);
    expect(isNoUiSurfaceDiff(["src/renderer/App.tsx"])).toBe(false);
  });

  test("build/config and type-only changes are NOT soft-passed", () => {
    // Deliberately excluded — these can alter runtime/build output, so they
    // stay on the real-verification path (mirrors the doc comment).
    expect(isNoUiSurfaceDiff(["electron.vite.config.ts"])).toBe(false);
    expect(isNoUiSurfaceDiff(["src/shared/types.ts"])).toBe(false);
    expect(isNoUiSurfaceDiff(["tsconfig.json"])).toBe(false);
  });
});

test.describe("summarizeToolCalls", () => {
  test("counts and joins tool calls", () => {
    const calls = [
      { name: "mcp__chrome-devtools__list_pages" },
      { name: "mcp__chrome-devtools__select_page" },
      { name: "mcp__chrome-devtools__click" },
      { name: "mcp__chrome-devtools__click" },
      { name: "mcp__chrome-devtools__take_snapshot" },
    ];
    const s = summarizeToolCalls(calls);
    expect(s).toContain("mcp__chrome-devtools__click×2");
    expect(s).toContain("mcp__chrome-devtools__list_pages×1");
  });

  test("empty input → empty string", () => {
    expect(summarizeToolCalls([])).toBe("");
  });
});

test.describe("renderReportMd", () => {
  test("renders a pass report with no anomalies", () => {
    const md = renderReportMd({
      mode: "verify-diff",
      sha: "abc1234",
      verdict: "pass",
      anomalies: [],
      actions: 8,
      tool_calls_summary: "list_pages×1, click×3",
      cost_usd: 0.0823,
      turns: 4,
      summary: "Verified the affected flow — nothing broken.",
    });
    expect(md).toContain("# Agentic verification — verify-diff");
    expect(md).toContain("**SHA**: `abc1234`");
    expect(md).toContain("**Verdict**: pass");
    expect(md).toContain("**Anomalies**: 0");
    expect(md).toContain("$0.0823");
    expect(md).toContain("**Turns**: 4");
    expect(md).toContain("Verified the affected flow");
    expect(md).not.toContain("## Anomalies");
  });

  test("includes Anomalies section when anomalies present", () => {
    const md = renderReportMd({
      mode: "explore",
      sha: "def5678",
      verdict: "anomalies_found",
      anomalies: [
        {
          type: "stuck_state",
          severity: "high",
          description: "Generate Draft button does nothing on high-priority emails",
          repro: "1. Click any HIGH-tagged email. 2. Click Generate Draft.",
        },
        {
          type: "ux",
          severity: "low",
          description: "Settings panel close button is misaligned",
        },
      ],
      actions: 47,
      tool_calls_summary: "list_pages×1, click×20, take_screenshot×8",
      cost_usd: 1.42,
      turns: 22,
      summary: "Found 2 issues during exploration.",
    });
    expect(md).toContain("## Anomalies");
    expect(md).toContain("[high]");
    expect(md).toContain("Generate Draft button");
    expect(md).toContain("- Repro: 1. Click any HIGH-tagged email");
    expect(md).toContain("[low]");
    expect(md).toContain("Settings panel close button");
  });

  test("handles missing optional fields gracefully", () => {
    const md = renderReportMd({
      mode: "verify-diff",
      sha: "0000000",
      verdict: "inconclusive",
      anomalies: [],
      actions: 0,
      summary: "",
    });
    expect(md).toContain("**Verdict**: inconclusive");
    expect(md).toContain("(no summary)");
    expect(md).not.toContain("**Cost**");
    expect(md).not.toContain("**Turns**");
  });
});
