/**
 * Read → splice → write helper for injecting/updating a marker block
 * inside a PR body via `gh pr` CLI. NEVER overwrites the user's PR
 * description — only replaces content between the START and END marker
 * lines, or appends a fresh block on the first run.
 *
 * Markers:
 *
 *   <!-- {NAME}-START SHA=<sha> mode=<mode> -->
 *   ...replaceable content...
 *   <!-- {NAME}-END -->
 *
 * Default NAME is PRE-PR-REPORT.
 *
 * Why this exists: `gh pr edit --body-file <f>` REPLACES the entire PR
 * body. Using this helper preserves the rest.
 */

import { execSync } from "node:child_process";

const DEFAULT_NAME = "PRE-PR-REPORT";

/**
 * Compose the marker block. `meta` is a flat object whose keys/values
 * become space-separated `key=value` pairs on the START marker, so a
 * consumer (e.g. the CI verify-prepr-report job) can parse out the
 * SHA and mode without reading the body content.
 */
export function makeBlock(content, meta = {}, name = DEFAULT_NAME) {
  const metaPairs = Object.entries(meta)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const startMarker = metaPairs
    ? `<!-- ${name}-START ${metaPairs} -->`
    : `<!-- ${name}-START -->`;
  const endMarker = `<!-- ${name}-END -->`;
  return `${startMarker}\n${content}\n${endMarker}`;
}

/**
 * Splice `block` into `body`. If the named block exists already,
 * replace its contents (start and end markers preserved with new meta).
 * Otherwise append the block to the bottom of the body with a blank
 * line separator.
 */
export function spliceBody(body, block, name = DEFAULT_NAME) {
  // Tolerate both spacing styles in old marker lines.
  const startRe = new RegExp(`<!-- ${name}-START[^>]*-->`);
  const endMarker = `<!-- ${name}-END -->`;

  const startMatch = body.match(startRe);
  if (!startMatch) {
    // First run — append.
    const sep = body.length > 0 && !body.endsWith("\n") ? "\n\n" : "\n";
    return body + sep + block + "\n";
  }

  const startIdx = startMatch.index ?? 0;
  const endIdx = body.indexOf(endMarker, startIdx);
  if (endIdx < 0) {
    // Malformed: start marker without end. Treat the rest of body from
    // startIdx as the stale block and replace it.
    return body.slice(0, startIdx).trimEnd() + "\n\n" + block + "\n";
  }

  const before = body.slice(0, startIdx).trimEnd();
  const after = body.slice(endIdx + endMarker.length).trimStart();
  const sep = before.length > 0 ? "\n\n" : "";
  const trailer = after.length > 0 ? "\n\n" + after : "\n";
  return before + sep + block + trailer;
}

/**
 * gh CLI wrappers. These shell out to `gh` so they pick up the user's
 * existing auth — never require additional secrets, never run in CI
 * with creds (CI uses its own GITHUB_TOKEN via gh).
 */
export function getPrNumberForCurrentBranch() {
  try {
    const out = execSync('gh pr view --json number --jq .number', {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString().trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function readPrBody(prNumber) {
  const arg = prNumber ? String(prNumber) : "";
  const cmd = `gh pr view ${arg} --json body --jq .body`;
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

export function writePrBody(prNumber, newBody) {
  // Pipe via stdin to avoid arg-length limits and shell-quoting issues
  // for bodies with backticks / dollar signs / newlines.
  const arg = prNumber ? String(prNumber) : "";
  const cmd = `gh pr edit ${arg} --body-file -`;
  execSync(cmd, { input: newBody, stdio: ["pipe", "inherit", "inherit"] });
}

/**
 * High-level: update or append a marker block in the current branch's
 * PR body. Returns one of:
 *   - "updated"     — block was already present, replaced contents
 *   - "appended"    — first run, appended block
 *   - "no-pr"       — no PR open for the current branch; caller can
 *                     keep the local report and re-run after opening
 *                     a PR
 */
export function injectIntoPrBody({ content, meta, name = DEFAULT_NAME }) {
  const prNumber = getPrNumberForCurrentBranch();
  if (!prNumber) return "no-pr";

  const block = makeBlock(content, meta, name);
  const currentBody = readPrBody(prNumber);
  const startRe = new RegExp(`<!-- ${name}-START[^>]*-->`);
  const already = startRe.test(currentBody);
  const newBody = spliceBody(currentBody, block, name);
  writePrBody(prNumber, newBody);
  return already ? "updated" : "appended";
}
