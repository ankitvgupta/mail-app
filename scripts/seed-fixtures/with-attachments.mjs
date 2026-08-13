/**
 * Emails with attachments: small placeholder PDF + 1x1 PNG.
 * Exercises the attachment-handling paths through ingest, search, and
 * the renderer attachment chip.
 *
 * @type {import("./types.mjs").SeedFixture[]}
 */

// 67-byte minimal valid PDF — opens cleanly in any PDF viewer.
const TINY_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iaiA8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4gZW5kb2JqIDIgMCBvYmogPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFsgM" +
  "yAwIFIgXSAvQ291bnQgMSA+PiBlbmRvYmoKMyAwIG9iaiA8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDU5NSA4NDJdID4+IGV" +
  "uZG9iagp0cmFpbGVyIDw8L1Jvb3QgMSAwIFI+Pgo=";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const withAttachments = [
  {
    id: "att-1-contract-pdf",
    from: "Legal Team <legal@example.test>",
    subject: "Draft contract for review",
    body: [
      "Attached is the latest draft of the services contract.",
      "Please review and let me know if you have any feedback.",
      "",
      "Legal",
    ].join("\n"),
    attachments: [
      {
        filename: "draft-contract.pdf",
        mimeType: "application/pdf",
        contentBase64: TINY_PDF_BASE64,
      },
    ],
  },
  {
    id: "att-2-screenshot",
    from: "QA Team <qa@example.test>",
    subject: "Bug report: login screen layout",
    body: [
      "Repro: open the app, click login, observe layout. See attached screenshot.",
      "",
      "Steps:",
      "1. Open app",
      "2. Click 'Sign in'",
      "3. Notice the button overlap on viewports under 800px wide.",
    ].join("\n"),
    attachments: [
      {
        filename: "login-bug.png",
        mimeType: "image/png",
        contentBase64: TINY_PNG_BASE64,
      },
    ],
  },
  {
    id: "att-3-two-attachments",
    from: "Operations <ops@example.test>",
    subject: "Weekly report + slide deck",
    body: [
      "Attached: weekly report PDF and slide deck cover image (full deck linked below).",
      "Deck: https://example.test/deck",
    ].join("\n"),
    attachments: [
      {
        filename: "weekly-report.pdf",
        mimeType: "application/pdf",
        contentBase64: TINY_PDF_BASE64,
      },
      {
        filename: "deck-cover.png",
        mimeType: "image/png",
        contentBase64: TINY_PNG_BASE64,
      },
    ],
  },
];
