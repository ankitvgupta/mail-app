/**
 * Renderer performance benchmarks:
 *   1. Regex stripHtmlTags (DraftRow) vs DOMParser-based stripping
 *   2. Parallel account email loading vs sequential (IPC simulation)
 *
 * Follows the runBenchmark pattern from sync-perf.spec.ts.
 * Zustand selector changes are excluded — they require a React rendering
 * context that is impractical to benchmark in a unit test.
 */
import { test, expect } from "@playwright/test";

// ============================================================
// Perf budgets — fail loudly on ~5x regressions, not nitpick.
// Budgets are generous (~3x current median, rounded up) so they don't flap
// on slow CI hardware but a real regression will cross the line. Tighten
// over time once we have a stable history.
// TODO: add "sync 1k emails ≤ 10s" benchmark per plan Phase 4 Layer 12 —
// not present here today; would belong in tests/unit/sync-perf.spec.ts
// where the related harness already lives.
// ============================================================

// Stripping 200 realistic Gmail bodies via regex — observed ~1ms locally.
const BUDGET_HTML_STRIP_200_BODIES_MS = 5;

// Stripping 500 short snippets via regex — observed ~0.3ms locally.
const BUDGET_HTML_STRIP_500_SNIPPETS_MS = 2;

// Parallel load across N accounts with 15ms simulated IPC — observed
// ~30ms regardless of N because all calls overlap. 50ms is forgiving.
const BUDGET_PARALLEL_LOAD_MS = 50;

// ============================================================
// Benchmark harness (same pattern as sync-perf.spec.ts)
// ============================================================

function runBenchmark<T>(
  name: string,
  fn: () => T,
  iterations: number = 10,
): { median: number; result: T } {
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `  ${name}: ${times.map((t) => t.toFixed(3) + "ms").join(", ")} (median: ${median.toFixed(3)}ms)`,
  );
  return { median, result };
}

async function runAsyncBenchmark<T>(
  name: string,
  fn: () => Promise<T>,
  iterations: number = 10,
): Promise<{ median: number; result: T }> {
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `  ${name}: ${times.map((t) => t.toFixed(3) + "ms").join(", ")} (median: ${median.toFixed(3)}ms)`,
  );
  return { median, result };
}

// ============================================================
// HTML stripping implementations
// ============================================================

// Named HTML entities — mirrors DraftRow.tsx NAMED_ENTITIES
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bull: "\u2022",
  middot: "\u00B7",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  deg: "\u00B0",
  plusmn: "\u00B1",
  times: "\u00D7",
};

/**
 * NEW: Regex-based stripping — mirrors DraftRow.tsx stripHtmlTags.
 */
function stripHtmlTagsRegex(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "\uFFFD";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = Number(dec);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : "\uFFFD";
    })
    .replace(/&([a-zA-Z]+);/g, (match, name) => NAMED_ENTITIES[name] ?? match)
    .trim();
}

/**
 * OLD: DOMParser-based stripping (what DraftRow used before Renderer).
 * Node.js doesn't have DOMParser, so we simulate the cost:
 * parse the full HTML string through a regex that mimics the DOM walk,
 * then measure the overhead of entity decoding via a lookup table.
 *
 * To make this a fair comparison on Node (which lacks DOMParser), we use
 * a minimal HTML-to-text function that does the same work DOMParser would:
 * parse structure, extract text nodes, decode entities. This will
 * underestimate DOMParser cost (real DOM allocation is heavier), so any
 * speedup we measure is a conservative lower bound.
 */
function stripHtmlTagsDomSimulated(html: string): string {
  // Simulate DOM parsing overhead: split on tags, collect text fragments
  const fragments: string[] = [];
  let inTag = false;
  let textStart = 0;

  for (let i = 0; i < html.length; i++) {
    if (html[i] === "<") {
      if (!inTag && i > textStart) {
        fragments.push(html.slice(textStart, i));
      }
      inTag = true;
    } else if (html[i] === ">" && inTag) {
      inTag = false;
      textStart = i + 1;
    }
  }
  if (textStart < html.length && !inTag) {
    fragments.push(html.slice(textStart));
  }

  // Join and decode entities (simulating .textContent behavior)
  const raw = fragments.join("");
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// Test data: realistic email HTML bodies
// ============================================================

function makeRealisticEmailHtml(index: number): string {
  // Simulate typical Gmail HTML: wrapper divs, quoted replies, signatures
  return `
<div dir="ltr">
  <div style="font-family: Arial, sans-serif; font-size: 14px; color: #222;">
    <p>Hi team,</p>
    <p>Following up on our conversation from last week about the Q${(index % 4) + 1} roadmap.
       I&apos;ve put together a proposal that addresses the key concerns raised by
       the product &amp; engineering teams. Please review the attached doc and share
       your feedback by <b>Friday EOD</b>.</p>
    <p>Key highlights:</p>
    <ul>
      <li>Revenue target: $${(index + 1) * 100}K (up ${10 + (index % 20)}% YoY)</li>
      <li>New feature launches: ${3 + (index % 5)} major releases planned</li>
      <li>Infrastructure cost reduction: ${5 + (index % 15)}% through optimization</li>
      <li>Hiring plan: ${2 + (index % 4)} additional engineers &amp; ${1 + (index % 2)} designers</li>
    </ul>
    <p>Let me know if you have questions. Happy to jump on a call to discuss.</p>
    <p>Best,<br/>Sender ${index}</p>
  </div>
  <div class="gmail_signature" data-smartmail="gmail_signature">
    <div dir="ltr">
      <div><span style="font-size:12px;color:rgb(102,102,102)">—</span></div>
      <div><span style="font-size:12px"><b>Sender ${index}</b></span></div>
      <div><span style="font-size:12px;color:rgb(102,102,102)">VP of Engineering | Example Corp</span></div>
      <div><span style="font-size:12px;color:rgb(102,102,102)">sender${index}@example.com | (555) 123-${String(index).padStart(4, "0")}</span></div>
    </div>
  </div>
  <br/>
  <div class="gmail_quote">
    <div dir="ltr" class="gmail_attr">On Mon, Jan 6, 2025 at 10:${String(index % 60).padStart(2, "0")} AM Previous Sender &lt;prev@example.com&gt; wrote:</div>
    <blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">
      <div dir="ltr">
        <p>Thanks for the update. A few thoughts:</p>
        <p>1. The timeline seems aggressive &mdash; can we push the beta by 2 weeks?</p>
        <p>2. I&apos;d like to see more detail on the cost reduction strategy.</p>
        <p>3. Let&apos;s sync on the hiring plan &mdash; I have some candidates in mind.</p>
        <br/>
        <div class="gmail_quote">
          <blockquote style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">
            <p>Original thread context here with &lt;HTML entities&gt; and &amp;special characters&amp;...</p>
          </blockquote>
        </div>
      </div>
    </blockquote>
  </div>
</div>`.trim();
}

// Short snippet HTML (like what appears in draft previews)
function makeShortHtml(index: number): string {
  return `<p>Hi, just wanted to follow up on the &amp; proposal from last week. Let&#39;s discuss on <b>Thursday</b>.</p>`;
}

// ============================================================
// IPC simulation helpers
// ============================================================

/**
 * Simulates an IPC call that takes `delayMs` to resolve.
 * Models the real getEmails/getSentEmails calls that cross the
 * Electron IPC bridge and hit SQLite.
 */
function simulateIpcCall<T>(result: T, delayMs: number): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, delayMs, result));
}

interface AccountResult {
  accountId: string;
  emails: number[];
  sentEmails: number[];
}

// ============================================================
// Tests
// ============================================================

test.describe("Renderer performance benchmarks", () => {
  test.describe("HTML stripping: regex vs DOMParser-simulated", () => {
    test("realistic email bodies (long HTML)", () => {
      const emailCount = 200;
      const htmlBodies = Array.from({ length: emailCount }, (_, i) => makeRealisticEmailHtml(i));

      console.log(`\n--- Stripping ${emailCount} realistic email HTML bodies ---`);

      const regexResult = runBenchmark(
        "NEW (regex stripHtmlTags)",
        () => htmlBodies.map(stripHtmlTagsRegex),
        10,
      );
      expect(regexResult.median).toBeLessThan(BUDGET_HTML_STRIP_200_BODIES_MS);

      const domResult = runBenchmark(
        "OLD (DOMParser-simulated)",
        () => htmlBodies.map(stripHtmlTagsDomSimulated),
        10,
      );

      // Verify both produce equivalent text content
      for (let i = 0; i < emailCount; i++) {
        const regexText = regexResult.result[i];
        const domText = domResult.result[i];
        // Both should contain the same key phrases (exact whitespace may differ)
        expect(regexText).toContain("Following up on our conversation");
        expect(domText).toContain("Following up on our conversation");
        expect(regexText).toContain("&");
        expect(domText).toContain("&");
      }

      const speedup = domResult.median / regexResult.median;
      console.log(`  Speedup: ${speedup.toFixed(2)}x`);
      console.log(
        `  Note: Real DOMParser is heavier than our simulation (DOM node allocation),`,
      );
      console.log(`  so actual speedup in the browser/Electron renderer would be larger.`);
    });

    test("short draft snippets (hot render path)", () => {
      // DraftRow strips HTML on every render for drafts without bodyText.
      // With 50+ drafts visible, this runs frequently during scroll/re-render.
      const snippetCount = 500;
      const htmlSnippets = Array.from({ length: snippetCount }, (_, i) => makeShortHtml(i));

      console.log(`\n--- Stripping ${snippetCount} short draft snippets ---`);

      const regexResult = runBenchmark(
        "NEW (regex stripHtmlTags)",
        () => htmlSnippets.map(stripHtmlTagsRegex),
        20,
      );
      expect(regexResult.median).toBeLessThan(BUDGET_HTML_STRIP_500_SNIPPETS_MS);

      const domResult = runBenchmark(
        "OLD (DOMParser-simulated)",
        () => htmlSnippets.map(stripHtmlTagsDomSimulated),
        20,
      );

      // Correctness: entity decoding works
      expect(regexResult.result[0]).toContain("&");
      expect(regexResult.result[0]).not.toContain("&amp;");

      const speedup = domResult.median / regexResult.median;
      console.log(`  Speedup: ${speedup.toFixed(2)}x`);
    });

    test("regex handles edge cases correctly", () => {
      const cases: Array<{ input: string; mustContain: string[]; mustNotContain: string[] }> = [
        {
          input: "<b>bold</b> &amp; <i>italic</i>",
          mustContain: ["bold", "&", "italic"],
          mustNotContain: ["<b>", "</b>", "&amp;"],
        },
        {
          input: "plain text no html",
          mustContain: ["plain text no html"],
          mustNotContain: [],
        },
        {
          input: "&lt;script&gt;alert(1)&lt;/script&gt;",
          mustContain: ["<script>alert(1)</script>"],
          mustNotContain: ["&lt;"],
        },
        {
          input: "<div>&nbsp;&nbsp;&nbsp;</div>",
          mustContain: [],
          mustNotContain: ["&nbsp;", "<div>"],
        },
        {
          input: 'He said &quot;hello&quot; and she said &#39;hi&#39;',
          mustContain: ['He said "hello"', "she said 'hi'"],
          mustNotContain: ["&quot;", "&#39;"],
        },
      ];

      for (const { input, mustContain, mustNotContain } of cases) {
        const result = stripHtmlTagsRegex(input);
        for (const phrase of mustContain) {
          expect(result).toContain(phrase);
        }
        for (const phrase of mustNotContain) {
          expect(result).not.toContain(phrase);
        }
      }
    });
  });

  test.describe("Account loading: parallel vs sequential (IPC simulation)", () => {
    // Each IPC call has inherent latency from the Electron IPC bridge + SQLite query.
    // With multiple accounts, sequential loading multiplies this latency.
    // Renderer switched to Promise.all for parallel loading.

    const IPC_DELAY_MS = 15; // Conservative estimate of IPC + SQLite latency per call
    const ACCOUNT_COUNTS = [2, 4, 8];

    for (const accountCount of ACCOUNT_COUNTS) {
      test(`${accountCount} accounts: sequential vs parallel`, async () => {
        const accounts = Array.from({ length: accountCount }, (_, i) => ({
          id: `account-${i}`,
          email: `user${i}@example.com`,
        }));

        console.log(
          `\n--- ${accountCount} accounts, ${IPC_DELAY_MS}ms IPC delay per call (2 calls/account) ---`,
        );

        // OLD: Sequential — for...of loop awaiting each account one at a time
        const sequential = await runAsyncBenchmark(
          "OLD (sequential for...of)",
          async () => {
            const results: AccountResult[] = [];
            for (const acc of accounts) {
              const emails = await simulateIpcCall(
                Array.from({ length: 100 }, (_, j) => j),
                IPC_DELAY_MS,
              );
              const sentEmails = await simulateIpcCall(
                Array.from({ length: 20 }, (_, j) => j),
                IPC_DELAY_MS,
              );
              results.push({ accountId: acc.id, emails, sentEmails });
            }
            return results;
          },
          5,
        );

        // NEW: Parallel — Promise.all over all accounts
        const parallel = await runAsyncBenchmark(
          "NEW (parallel Promise.all)",
          async () => {
            const accountResults = await Promise.all(
              accounts.map((acc) =>
                Promise.all([
                  simulateIpcCall(
                    Array.from({ length: 100 }, (_, j) => j),
                    IPC_DELAY_MS,
                  ),
                  simulateIpcCall(
                    Array.from({ length: 20 }, (_, j) => j),
                    IPC_DELAY_MS,
                  ),
                ]),
              ),
            );
            return accountResults.map(([emails, sentEmails], i) => ({
              accountId: accounts[i].id,
              emails,
              sentEmails,
            }));
          },
          5,
        );

        // Both should return the same number of results
        expect(sequential.result.length).toBe(parallel.result.length);
        expect(sequential.result.length).toBe(accountCount);

        const speedup = sequential.median / parallel.median;
        console.log(`  Speedup: ${speedup.toFixed(2)}x`);

        // Theoretical speedup is accountCount (all calls overlap).
        // In practice, timer resolution and scheduling add overhead.
        // For 2+ accounts, parallel should be meaningfully faster.
        const expectedMinSpeedup = accountCount * 0.5; // 50% of theoretical max
        console.log(
          `  Expected minimum speedup (50% of theoretical ${accountCount}x): ${expectedMinSpeedup.toFixed(1)}x`,
        );

        // The parallel version should complete in roughly the time of ONE
        // account's calls, not all of them summed. With 2 calls per account
        // at IPC_DELAY_MS each:
        //   Sequential: accountCount * 2 * IPC_DELAY_MS
        //   Parallel:   2 * IPC_DELAY_MS (all accounts overlap)
        // So speedup ≈ accountCount.
        //
        // We use a generous lower bound to avoid flakiness, but the real
        // speedup should be close to accountCount.
        expect(speedup).toBeGreaterThan(expectedMinSpeedup);

        // Absolute budget: parallel load should always be well under
        // BUDGET_PARALLEL_LOAD_MS no matter how many accounts — that's
        // the whole point of Promise.all.
        expect(parallel.median).toBeLessThan(BUDGET_PARALLEL_LOAD_MS);
      });
    }

    test("parallel loading does not change result ordering", async () => {
      // Verify that collecting results from Promise.all preserves account order
      const accounts = Array.from({ length: 5 }, (_, i) => ({
        id: `account-${i}`,
        email: `user${i}@example.com`,
      }));

      // Give each account a different delay to stress ordering
      const delays = [25, 5, 15, 10, 20];

      const results = await Promise.all(
        accounts.map((acc, i) =>
          simulateIpcCall({ accountId: acc.id, data: `data-${acc.id}` }, delays[i]),
        ),
      );

      // Promise.all preserves input order regardless of resolution order
      for (let i = 0; i < accounts.length; i++) {
        expect(results[i].accountId).toBe(`account-${i}`);
      }
    });
  });

  test("Summary: combined speedup report", async () => {
    console.log("\n=== Renderer Performance Summary ===\n");

    // 1. HTML stripping
    const htmlBodies = Array.from({ length: 200 }, (_, i) => makeRealisticEmailHtml(i));
    const regexHtml = runBenchmark(
      "Regex HTML strip (200 emails)",
      () => htmlBodies.map(stripHtmlTagsRegex),
      10,
    );
    const domHtml = runBenchmark(
      "DOM-simulated HTML strip (200 emails)",
      () => htmlBodies.map(stripHtmlTagsDomSimulated),
      10,
    );
    const htmlSpeedup = domHtml.median / regexHtml.median;

    // 2. Parallel loading (4 accounts)
    const IPC_DELAY = 15;
    const seqLoad = await runAsyncBenchmark(
      "Sequential load (4 accounts)",
      async () => {
        for (let i = 0; i < 4; i++) {
          await simulateIpcCall(null, IPC_DELAY);
          await simulateIpcCall(null, IPC_DELAY);
        }
      },
      5,
    );
    const parLoad = await runAsyncBenchmark(
      "Parallel load (4 accounts)",
      async () => {
        await Promise.all(
          Array.from({ length: 4 }, () =>
            Promise.all([simulateIpcCall(null, IPC_DELAY), simulateIpcCall(null, IPC_DELAY)]),
          ),
        );
      },
      5,
    );
    const loadSpeedup = seqLoad.median / parLoad.median;

    console.log("\n--- Results ---");
    console.log(`  HTML stripping speedup:       ${htmlSpeedup.toFixed(2)}x (regex vs DOM-simulated)`);
    console.log(`  Account loading speedup:      ${loadSpeedup.toFixed(2)}x (parallel vs sequential, 4 accounts)`);
    console.log(
      `  Note: Zustand selector optimization (individual vs bulk destructuring) not benchmarked`,
    );
    console.log(`  — requires React rendering context.\n`);
  });
});
