/**
 * Pure helpers used by scripts/agentic-verify.mjs. Extracted into a
 * separate module so they can be unit-tested without spinning up
 * Electron or hitting the Anthropic API.
 */

/**
 * Find the LAST JSON object in `text` that has a `verdict` field.
 * Agents often prefix their final answer with prose; we want the
 * structured tail. Returns null if no valid match.
 *
 * Candidates are found with a string-aware brace scanner, not a regex: the
 * agent's anomaly descriptions routinely quote UI text or API bodies
 * containing braces (`{error: ...}`), and braces inside JSON string values
 * break any regex-counted nesting — the whole final JSON then silently
 * fails to match and a real fail verdict is read as "inconclusive". That
 * is a silent false-negative in the safety harness itself, since pre-pr
 * soft-passes some inconclusive-with-0-anomalies runs (live evidence:
 * managed-agents PR #7, a 6-anomaly verdict misread as inconclusive).
 */
export function extractFinalJson(text) {
  let last = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = findMatchingBrace(text, i);
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      if (parsed && typeof parsed === "object" && "verdict" in parsed) {
        last = parsed;
        i = end; // don't re-scan inside an object we already accepted
      }
    } catch {
      // not valid JSON from this position — keep scanning
    }
  }
  return last;
}

/** Index of the `}` closing the `{` at `start`, honoring JSON string
 *  literals (braces and escaped quotes inside strings don't count). -1 if
 *  unbalanced. */
function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Compress a list of tool-call records into `"name1×3, name2×1"` form
 * for the report header.
 */
export function summarizeToolCalls(calls) {
  const counts = new Map();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(", ");
}

/**
 * Files whose changes have no UI-reachable surface for the agentic
 * verifier to exercise: test scaffolding, build/CI scripts, docs, repo
 * metadata, and the generated dependency lockfile.
 *
 * When the ENTIRE diff is within this set, `agentic-verify` correctly
 * returns `inconclusive` (exit 3) — there's no user-visible flow to
 * drive — and `pre-pr` accepts that as a soft pass instead of a hard
 * failure (otherwise these PRs can never go green).
 *
 * Why `package-lock.json` belongs here but `package.json` does NOT:
 * `package-lock.json` is generated and records *resolved dependency
 * versions only* — it never carries first-party behavior. A lockfile-only
 * diff (e.g. a transitive `npm audit fix`) is a pure dependency-resolution
 * change whose regression coverage comes from the unit / integration / e2e
 * suites and the build, not from driving the UI. `package.json`, by
 * contrast, also holds npm `scripts`, the `main` entry point, and the
 * electron-builder `build` config — a `package.json`-only edit to any of
 * those is behavioral, so it stays on the real-verification path. (A
 * dependency bump that's actually *used* also changes a `src/` file, which
 * takes the diff out of this set regardless.) This mirrors
 * `DATA_DEMO_SAFE_PATTERNS` in agentic-verify.mjs, which routes
 * lockfile-only diffs to demo mode.
 *
 * Build-config and type-only changes are likewise NOT included: they can
 * alter runtime/build output, so they stay on the real-verification path.
 */
const NO_UI_SURFACE_PREFIXES = ["tests/", "scripts/", "docs/", ".github/"];
const NO_UI_SURFACE_FILES = new Set([".gitignore", "CLAUDE.md", "README.md", "package-lock.json"]);

export function isNoUiSurfaceDiff(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  return changedFiles.every(
    (f) => NO_UI_SURFACE_PREFIXES.some((p) => f.startsWith(p)) || NO_UI_SURFACE_FILES.has(f),
  );
}

/**
 * Render a report object to markdown for PR-body injection.
 */
export function renderReportMd(report) {
  const lines = [];
  lines.push(`# Agentic verification — ${report.mode}`);
  lines.push("");
  lines.push(`- **SHA**: \`${report.sha}\``);
  lines.push(`- **Verdict**: ${report.verdict}`);
  lines.push(`- **Anomalies**: ${report.anomalies.length}`);
  lines.push(`- **Actions**: ${report.actions} (${report.tool_calls_summary ?? "—"})`);
  if (report.cost_usd !== null && report.cost_usd !== undefined) {
    lines.push(`- **Cost**: $${Number(report.cost_usd).toFixed(4)}`);
  }
  if (report.turns !== null && report.turns !== undefined) {
    lines.push(`- **Turns**: ${report.turns}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(report.summary || "(no summary)");
  lines.push("");
  if (report.anomalies.length > 0) {
    lines.push("## Anomalies");
    lines.push("");
    for (const a of report.anomalies) {
      const sev = a.severity ? `[${a.severity}] ` : "";
      lines.push(`- **${sev}${a.type ?? "unknown"}** — ${a.description ?? "(no description)"}`);
      if (a.repro) lines.push(`  - Repro: ${a.repro}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
