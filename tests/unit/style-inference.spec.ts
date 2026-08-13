/**
 * Unit tests for the style inference metaprompting feature.
 *
 * Since style-profiler.ts imports from ../db which transitively imports electron,
 * we re-implement the prompt construction logic here for testing in system Node.
 */
import { test, expect } from "@playwright/test";

// Re-implement the pure functions used in inferStyleFromSentEmails
function stripHtmlForSearch(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncateBody(bodyText: string, maxWords: number = 300): string {
  const words = bodyText.split(/\s+/);
  if (words.length <= maxWords) return bodyText;
  return words.slice(0, maxWords).join(" ") + "...";
}

type SentEmailRow = {
  id: string;
  subject: string;
  body_text: string | null;
  body: string;
  date: string;
  is_reply: number;
  to_address?: string;
};

const STYLE_INFERENCE_PROMPT = `You are analyzing a user's email writing style. Below are their most recent sent emails.
Study these emails carefully and produce a concise style guide that captures how this person writes.

Focus on:
- Tone and formality level (casual, professional, mixed)
- Greeting patterns (do they say "Hi", "Hey", nothing?)
- Sign-off patterns (do they use "Best", "Thanks", just their name, nothing?)
- Sentence structure (short and punchy? long and detailed? mixed?)
- Vocabulary level (simple, technical, colloquial)
- Use of punctuation (exclamation marks, ellipses, em dashes)
- Capitalization habits (proper case, all lowercase, etc.)
- How they handle different contexts (replies vs new emails, quick responses vs longer ones)
- Any distinctive quirks or patterns

Output a 6-10 sentence style description written as instructions to an AI drafting emails
on their behalf. Write in second person ("You write..."). Be specific and concrete —
reference actual patterns you observed rather than generic descriptions. Cover how the
style varies by context (quick replies vs longer emails, familiar vs unfamiliar recipients).

Do NOT include example phrases or quoted text from the emails.`;

/**
 * Build the email samples portion of the prompt, mirroring the logic
 * in inferStyleFromSentEmails.
 */
// Simplified version of stripQuotedContent for plain text
// (matches the production code path: body_text → stripQuotedContent → truncateBody)
function stripQuotedContent(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // "On ... wrote:" header
    if (/^on\s.+wrote:\s*$/i.test(line)) {
      return lines.slice(0, i).join("\n").trimEnd();
    }
    // Block of ">" quoted lines
    if (line.startsWith(">")) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above && !above.split("\n").every((l) => l.trim().startsWith(">"))) {
        return above;
      }
    }
  }
  return text;
}

function buildEmailSamples(emails: SentEmailRow[]): string {
  return emails
    .map((e) => {
      const plainText = e.body_text ?? stripHtmlForSearch(e.body);
      const text = stripQuotedContent(plainText);
      const truncated = truncateBody(text, 300);
      const type = e.is_reply ? "reply" : "new";
      return `---\nTo: ${e.to_address ?? "unknown"}\nSubject: ${e.subject}\nDate: ${e.date}\nType: ${type}\n\n${truncated}\n---`;
    })
    .join("\n\n");
}

function makeEmail(overrides: Partial<SentEmailRow> = {}): SentEmailRow {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    subject: "Test subject",
    body_text: "Hey, just wanted to check in on the project. Let me know if you need anything. Thanks",
    body: "<p>Hey, just wanted to check in on the project.</p>",
    date: "2026-04-01",
    is_reply: 0,
    to_address: "alice@example.com",
    ...overrides,
  };
}

// ============================================================
// Prompt construction
// ============================================================

test.describe("style inference prompt construction", () => {
  test("builds prompt with correct email format", () => {
    const email = makeEmail({
      to_address: "bob@company.com",
      subject: "Re: Q4 planning",
      date: "2026-03-15",
      is_reply: 1,
      body_text: "Sounds good, let's sync tomorrow.",
    });

    const samples = buildEmailSamples([email]);

    expect(samples).toContain("To: bob@company.com");
    expect(samples).toContain("Subject: Re: Q4 planning");
    expect(samples).toContain("Date: 2026-03-15");
    expect(samples).toContain("Type: reply");
    expect(samples).toContain("Sounds good, let's sync tomorrow.");
  });

  test("marks new emails as type 'new'", () => {
    const email = makeEmail({ is_reply: 0 });
    const samples = buildEmailSamples([email]);
    expect(samples).toContain("Type: new");
  });

  test("uses body_text when available, falls back to stripped HTML", () => {
    const emailWithText = makeEmail({
      body_text: "Plain text body",
      body: "<p>HTML body</p>",
    });
    const emailWithoutText = makeEmail({
      body_text: null,
      body: "<p>HTML body content</p>",
    });

    const samplesWithText = buildEmailSamples([emailWithText]);
    const samplesWithoutText = buildEmailSamples([emailWithoutText]);

    expect(samplesWithText).toContain("Plain text body");
    expect(samplesWithoutText).toContain("HTML body content");
    expect(samplesWithoutText).not.toContain("<p>");
  });

  test("truncates long emails to 300 words", () => {
    const longBody = Array(400).fill("word").join(" ");
    const email = makeEmail({ body_text: longBody });
    const samples = buildEmailSamples([email]);

    // 300 words + "..." suffix
    const bodyInSamples = samples.split("\n\n").slice(1).join("\n\n").split("\n---")[0];
    const wordCount = bodyInSamples.trim().split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(301); // 300 words + "..."
    expect(samples).toContain("...");
  });

  test("handles missing to_address", () => {
    const email = makeEmail({ to_address: undefined });
    const samples = buildEmailSamples([email]);
    expect(samples).toContain("To: unknown");
  });

  test("handles multiple emails", () => {
    const emails = [
      makeEmail({ subject: "First email", to_address: "a@b.com" }),
      makeEmail({ subject: "Second email", to_address: "c@d.com" }),
      makeEmail({ subject: "Third email", to_address: "e@f.com" }),
    ];
    const samples = buildEmailSamples(emails);

    expect(samples).toContain("Subject: First email");
    expect(samples).toContain("Subject: Second email");
    expect(samples).toContain("Subject: Third email");
    // Emails are separated by double newline
    expect(samples.split("---\n\n---").length).toBe(3);
  });
});

// ============================================================
// System prompt content
// ============================================================

test.describe("style inference system prompt", () => {
  test("instructs second-person output", () => {
    expect(STYLE_INFERENCE_PROMPT).toContain('Write in second person ("You write...")');
  });

  test("prohibits quoting email content", () => {
    expect(STYLE_INFERENCE_PROMPT).toContain(
      "Do NOT include example phrases or quoted text from the emails",
    );
  });

  test("requests 6-10 sentence output", () => {
    expect(STYLE_INFERENCE_PROMPT).toContain("6-10 sentence style description");
  });

  test("covers key style dimensions", () => {
    expect(STYLE_INFERENCE_PROMPT).toContain("Greeting patterns");
    expect(STYLE_INFERENCE_PROMPT).toContain("Sign-off patterns");
    expect(STYLE_INFERENCE_PROMPT).toContain("Sentence structure");
    expect(STYLE_INFERENCE_PROMPT).toContain("Capitalization");
  });
});
