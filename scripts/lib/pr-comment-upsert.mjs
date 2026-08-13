/**
 * Upsert a PR issue comment identified by an invisible HTML marker.
 *
 * The marker is the first thing in the comment body:
 *
 *   <!-- {NAME} -->
 *   ... rest of comment ...
 *
 * On repeated runs we find the existing comment by scanning for the
 * marker and PATCH it instead of POSTing a new one. This keeps the PR
 * thread clean — one living comment that always reflects the latest
 * pre-pr run.
 *
 * Separate from pr-body-splice.mjs on purpose: the body splice is the
 * CI gate (must be present, must say PASS), and this comment is the
 * human-readable artifact (full report, collapsible). Don't merge them.
 */

import { execSync } from "node:child_process";

const DEFAULT_NAME = "AGENTIC-VERIFY-COMMENT";

function ghJson(args, opts = {}) {
  const out = execSync(`gh ${args}`, {
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).toString();
  return out.trim() ? JSON.parse(out) : null;
}

function repoSlug() {
  // Returns "owner/repo" for the current checkout's default remote.
  // We can't go through ghJson here: `--jq .nameWithOwner` emits a raw
  // unquoted string ("owner/repo\n"), which JSON.parse rejects. Parse
  // the JSON object instead and pick the field ourselves.
  const obj = ghJson("repo view --json nameWithOwner");
  const slug = obj?.nameWithOwner;
  if (typeof slug !== "string" || !slug.includes("/")) {
    throw new Error("Could not determine repo slug from `gh repo view`");
  }
  return slug;
}

function findExistingCommentId(prNumber, marker, slug) {
  // We deliberately do NOT use `--paginate`: gh emits one JSON document
  // per page when paginating + --jq, which breaks JSON.parse. 100 is
  // GitHub's max page size and is plenty for the bot-written +
  // human-review comments a typical PR accrues. If a PR ever exceeds
  // 100 comments and the upsert misses an old marker, the worst case
  // is one duplicate comment — not a correctness break.
  const comments = ghJson(
    `api repos/${slug}/issues/${prNumber}/comments?per_page=100 --jq '[.[] | {id, body}]'`,
  );
  if (!Array.isArray(comments)) return null;
  for (const c of comments) {
    if (typeof c?.body === "string" && c.body.includes(marker)) {
      return c.id;
    }
  }
  return null;
}

/**
 * Find PR number for the current branch. Returns null if no PR is open.
 */
export function getPrNumber() {
  try {
    const out = execSync("gh pr view --json number --jq .number", {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Upsert the comment.
 *
 *   content : full body (markdown). The marker is prepended automatically.
 *   prNumber: PR to comment on. Defaults to current branch's PR.
 *   name    : marker name; default AGENTIC-VERIFY-COMMENT.
 *
 * Returns one of:
 *   { status: "updated",  id, url }
 *   { status: "created",  id, url }
 *   { status: "no-pr" }
 */
export function upsertPrComment({ content, prNumber, name = DEFAULT_NAME }) {
  const pr = prNumber ?? getPrNumber();
  if (!pr) return { status: "no-pr" };

  const marker = `<!-- ${name} -->`;
  const body = `${marker}\n${content}`;
  const slug = repoSlug();
  const existingId = findExistingCommentId(pr, marker, slug);

  if (existingId) {
    // PATCH via gh api. --field reads from stdin when value is "-@" but
    // gh has no first-class stdin flag for --field; the safest path is
    // to write the body to a temp file via `--input -` JSON form.
    const payload = JSON.stringify({ body });
    const out = execSync(
      `gh api --method PATCH repos/${slug}/issues/comments/${existingId} --input -`,
      { input: payload, stdio: ["pipe", "pipe", "pipe"] },
    ).toString();
    const parsed = JSON.parse(out);
    return { status: "updated", id: parsed.id, url: parsed.html_url };
  }

  const payload = JSON.stringify({ body });
  const out = execSync(
    `gh api --method POST repos/${slug}/issues/${pr}/comments --input -`,
    { input: payload, stdio: ["pipe", "pipe", "pipe"] },
  ).toString();
  const parsed = JSON.parse(out);
  return { status: "created", id: parsed.id, url: parsed.html_url };
}
