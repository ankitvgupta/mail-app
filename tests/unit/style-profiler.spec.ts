/**
 * Unit tests for pure functions in style-profiler.ts
 *
 * The style profiler imports from ../db which transitively imports electron,
 * so we re-implement the pure functions here for testing in system Node.
 */
import { test, expect } from "@playwright/test";

// Re-implement the pure functions from style-profiler.ts to avoid electron import
type EmailSignals = {
  greeting: string;
  signoff: string;
  wordCount: number;
};

function detectGreeting(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const lower = firstLine.toLowerCase().trim();

  if (/^dear\b/.test(lower)) return "dear";
  if (/^hello\b/.test(lower)) return "hello";
  if (/^hi\b/.test(lower)) return "hi";
  if (/^hey\b/.test(lower)) return "hey";
  return "none";
}

function detectSignoff(text: string): string {
  const words = text.split(/\s+/);
  const tail = words.slice(-50).join(" ").toLowerCase();

  if (/\bregards\b/.test(tail)) return "regards";
  if (/\bbest\b/.test(tail)) return "best";
  if (/\bcheers\b/.test(tail)) return "cheers";
  if (/\bthanks\b/.test(tail) || /\bthank you\b/.test(tail)) return "thanks";
  return "none";
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Strip the standard email signature delimiter (-- ) and everything after it */
function stripPlainTextSignature(text: string): string {
  const sigIndex = text.search(/\n-- ?\n/);
  if (sigIndex !== -1) return text.slice(0, sigIndex).trim();
  return text.replace(/\n*Sent (?:by|from) Exo\s*$/i, "").trim();
}

function extractEmailSignals(bodyText: string): EmailSignals {
  const cleaned = stripPlainTextSignature(bodyText);
  return {
    greeting: detectGreeting(cleaned),
    signoff: detectSignoff(cleaned),
    wordCount: countWords(cleaned),
  };
}

// ============================================================
// detectGreeting (via extractEmailSignals)
// ============================================================

test.describe("greeting detection", () => {
  test("detects 'hey' greeting", () => {
    const signals = extractEmailSignals("Hey team, just checking in on the project.");
    expect(signals.greeting).toBe("hey");
  });

  test("detects 'hi' greeting", () => {
    const signals = extractEmailSignals("Hi John,\nHope you're doing well.");
    expect(signals.greeting).toBe("hi");
  });

  test("detects 'hello' greeting", () => {
    const signals = extractEmailSignals("Hello everyone,\nPlease review the document.");
    expect(signals.greeting).toBe("hello");
  });

  test("detects 'dear' greeting", () => {
    const signals = extractEmailSignals("Dear Mr. Smith,\nI am writing to inquire about...");
    expect(signals.greeting).toBe("dear");
  });

  test("detects no greeting", () => {
    const signals = extractEmailSignals("The report is attached. Please review by Friday.");
    expect(signals.greeting).toBe("none");
  });

  test("ignores greeting-like words mid-sentence", () => {
    const signals = extractEmailSignals("Please say hello to the team for me.");
    expect(signals.greeting).toBe("none");
  });
});

// ============================================================
// detectSignoff (via extractEmailSignals)
// ============================================================

test.describe("signoff detection", () => {
  test("detects 'thanks' signoff", () => {
    const signals = extractEmailSignals("Can you review this?\n\nThanks,\nJohn");
    expect(signals.signoff).toBe("thanks");
  });

  test("detects 'thank you' signoff", () => {
    const signals = extractEmailSignals("Here's the update.\n\nThank you,\nAlice");
    expect(signals.signoff).toBe("thanks");
  });

  test("detects 'best' signoff", () => {
    const signals = extractEmailSignals("Looking forward to hearing from you.\n\nBest,\nBob");
    expect(signals.signoff).toBe("best");
  });

  test("detects 'regards' signoff", () => {
    const signals = extractEmailSignals(
      "Please let me know if you have questions.\n\nKind regards,\nCarol",
    );
    expect(signals.signoff).toBe("regards");
  });

  test("detects 'cheers' signoff", () => {
    const signals = extractEmailSignals("See you at the meeting!\n\nCheers,\nDave");
    expect(signals.signoff).toBe("cheers");
  });

  test("detects no signoff", () => {
    const signals = extractEmailSignals("The build is ready for deployment.");
    expect(signals.signoff).toBe("none");
  });
});

// ============================================================
// Word count (via extractEmailSignals)
// ============================================================

test.describe("word count", () => {
  test("counts words correctly", () => {
    const signals = extractEmailSignals("one two three four five");
    expect(signals.wordCount).toBe(5);
  });

  test("handles empty string", () => {
    const signals = extractEmailSignals("");
    expect(signals.wordCount).toBe(0);
  });

  test("handles multiple spaces", () => {
    const signals = extractEmailSignals("hello   world   test");
    expect(signals.wordCount).toBe(3);
  });

  test("handles newlines", () => {
    const signals = extractEmailSignals("line one\nline two\nline three");
    expect(signals.wordCount).toBe(6);
  });
});

// ============================================================
// Combined signal extraction
// ============================================================

test.describe("extractEmailSignals — combined", () => {
  test("extracts all signals from a formal email", () => {
    const email = `Dear Ms. Johnson,

I am writing to follow up on our previous conversation regarding the Q4 budget allocation. Could you please share the updated projections at your earliest convenience?

Kind regards,
Robert Chen`;

    const signals = extractEmailSignals(email);
    expect(signals.greeting).toBe("dear");
    expect(signals.signoff).toBe("regards");
    expect(signals.wordCount).toBeGreaterThan(20);
  });

  test("extracts all signals from an informal email", () => {
    const email = `Hey!

Quick q — can you review my PR when you get a sec?

Cheers`;

    const signals = extractEmailSignals(email);
    expect(signals.greeting).toBe("hey");
    expect(signals.signoff).toBe("cheers");
    expect(signals.wordCount).toBeLessThan(20);
  });
});

// ============================================================
// Signature stripping
// ============================================================

test.describe("signature stripping", () => {
  test("strips standard -- signature delimiter", () => {
    const email = `Hey team,

Here's the update.

Best,
John

--
Sent by Exo`;

    const signals = extractEmailSignals(email);
    expect(signals.signoff).toBe("best");
    // "Sent by Exo" should not be counted in word count
    expect(signals.wordCount).toBeLessThan(10);
  });

  test("strips 'Sent by Exo' without -- delimiter", () => {
    const email = `Sounds good!

Thanks
Sent by Exo`;

    const signals = extractEmailSignals(email);
    expect(signals.signoff).toBe("thanks");
    // "Sent by Exo" should be stripped
    expect(signals.wordCount).toBe(3); // "Sounds good! Thanks"
  });

  test("strips 'Sent from Exo' variant", () => {
    const email = `Got it, will do.
Sent from Exo`;

    const signals = extractEmailSignals(email);
    expect(signals.wordCount).toBe(4); // "Got it, will do."
  });

  test("preserves sign-off above -- delimiter", () => {
    const email = `Thanks for the update.

Cheers,
Alice

--
Alice Smith
Engineering Lead`;

    const signals = extractEmailSignals(email);
    expect(signals.signoff).toBe("cheers");
    expect(signals.greeting).toBe("none");
  });

  test("handles email with no signature", () => {
    const email = `Just checking in on the project status.

Best,
Bob`;

    const signals = extractEmailSignals(email);
    expect(signals.signoff).toBe("best");
    expect(signals.wordCount).toBe(9);
  });
});
