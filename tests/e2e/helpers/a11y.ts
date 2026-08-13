import type { Page } from "@playwright/test";
import axe from "axe-core";

export type A11yImpact = "minor" | "moderate" | "serious" | "critical";

export type CheckA11yOptions = {
  failOn?: "critical" | "serious";
  /**
   * CSS selectors to exclude from analysis. Useful for transient regions
   * (toasts, focus-trap sentinels, animated elements) where axe sees
   * intermediate states.
   */
  exclude?: string[];
  /**
   * axe rule IDs to disable. Use to opt out of rules that surface real
   * product debt we haven't fixed yet, with a comment in the spec
   * explaining the tracking issue.
   */
  disableRules?: string[];
};

const IMPACT_RANK: Record<A11yImpact, number> = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Run axe-core against the current page and throw if any violations meet
 * the configured impact threshold. Default threshold is "serious" (also
 * fails on "critical"). Minor/moderate violations are silent — capture
 * those separately when you care.
 *
 * Why we inject axe-core's source ourselves instead of using
 * `@axe-core/playwright`: AxeBuilder.analyze() opens an isolated page via
 * `BrowserContext.newPage()` to evaluate the rules, but Electron's
 * `_electron.launch()` exposes a single-window context that rejects
 * `Target.createTarget` with "Not supported". Injecting `axe.source`
 * inline avoids the second target entirely and works in both Chromium
 * and Electron driven by Playwright.
 */
export async function checkA11y(page: Page, options: CheckA11yOptions = {}): Promise<void> {
  const failOn = options.failOn ?? "serious";
  const threshold = IMPACT_RANK[failOn];

  await page.evaluate(axe.source);

  const results = await page.evaluate(
    ({ tags, exclude, disableRules }) => {
      const excludeSelectors = exclude.map((sel) => [sel]);
      const context =
        excludeSelectors.length > 0
          ? { exclude: excludeSelectors, include: [["html"]] }
          : "html";
      const rules = Object.fromEntries(disableRules.map((id) => [id, { enabled: false }]));
      return window.axe.run(context, {
        runOnly: { type: "tag", values: tags },
        rules,
      });
    },
    {
      tags: WCAG_TAGS,
      exclude: options.exclude ?? [],
      disableRules: options.disableRules ?? [],
    },
  );

  const blocking = results.violations.filter((v) => {
    const impact = (v.impact ?? "minor") as A11yImpact;
    return IMPACT_RANK[impact] >= threshold;
  });

  if (blocking.length === 0) return;

  const summary = blocking
    .map(
      (v) =>
        `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes.map((n) => `      • ${n.target.join(" ")}`).join("\n"),
    )
    .join("\n");
  throw new Error(
    `Accessibility violations (>= ${failOn}) detected:\n${summary}\n` +
      `See https://dequeuniversity.com/rules/axe/ for rule details.`,
  );
}

declare global {
  interface Window {
    axe: typeof axe;
  }
}
