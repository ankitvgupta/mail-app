import { test, expect } from "@playwright/test";
import { htmlToPlainText } from "../../src/main/util/html-to-text";

/**
 * Unit tests for htmlToPlainText — the HTML-to-text converter used when
 * sending email bodies to AI agents. Preserves paragraph structure and
 * decodes numeric HTML entities so text is usable for LLM comprehension.
 */

test.describe("htmlToPlainText", () => {
  test.describe("tag stripping", () => {
    test("strips inline tags", () => {
      expect(htmlToPlainText("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
    });

    test("removes style blocks entirely", () => {
      expect(htmlToPlainText("<style>.x { color: red; }</style><p>Hello</p>")).toBe("Hello");
    });

    test("removes script blocks entirely", () => {
      expect(htmlToPlainText("<script>alert('hi')</script><p>Hello</p>")).toBe("Hello");
    });

    test("strips attributes along with tags", () => {
      expect(htmlToPlainText('<a href="https://example.com" class="foo">link</a>')).toBe("link");
    });
  });

  test.describe("structure preservation", () => {
    test("<br> becomes newline", () => {
      expect(htmlToPlainText("line 1<br>line 2")).toBe("line 1\nline 2");
    });

    test("<br/> and <br /> both become newline", () => {
      expect(htmlToPlainText("a<br/>b<br />c")).toBe("a\nb\nc");
    });

    test("paragraphs separated by newline", () => {
      expect(htmlToPlainText("<p>one</p><p>two</p>")).toBe("one\ntwo");
    });

    test("list items on separate lines", () => {
      expect(htmlToPlainText("<ul><li>a</li><li>b</li><li>c</li></ul>")).toBe("a\nb\nc");
    });

    test("headings on their own line", () => {
      expect(htmlToPlainText("<h1>Title</h1><p>body</p>")).toBe("Title\nbody");
    });

    test("blockquote separated", () => {
      expect(htmlToPlainText("<p>Reply:</p><blockquote>original</blockquote><p>more</p>")).toBe(
        "Reply:\noriginal\nmore",
      );
    });

    test("<hr> becomes separator", () => {
      expect(htmlToPlainText("<p>above</p><hr><p>below</p>")).toBe("above\n\n---\nbelow");
    });

    test("collapses 3+ consecutive newlines to 2", () => {
      expect(htmlToPlainText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
    });

    test("preserves single newlines inside paragraphs", () => {
      // <br> inside <p> should keep the newline but not double it
      expect(htmlToPlainText("<p>line 1<br>line 2</p>")).toBe("line 1\nline 2");
    });
  });

  test.describe("entity decoding", () => {
    test("decodes common named entities", () => {
      expect(htmlToPlainText("&amp; &lt; &gt; &quot; &#39;")).toBe("& < > \" '");
    });

    test("decodes nbsp as space", () => {
      expect(htmlToPlainText("hello&nbsp;world")).toBe("hello world");
    });

    test("decodes numeric decimal entity for right single quote", () => {
      // &#8217; is the right single quote — common in contractions like "don't"
      // This is the exact bug the review caught: don't → don t when not decoded
      expect(htmlToPlainText("don&#8217;t")).toBe("don\u2019t");
    });

    test("decodes numeric hex entity", () => {
      // &#x2014; is em dash
      expect(htmlToPlainText("a&#x2014;b")).toBe("a\u2014b");
    });

    test("decodes numeric entities for emoji", () => {
      // &#128512; is 😀
      expect(htmlToPlainText("hi &#128512;")).toBe("hi \u{1F600}");
    });

    test("out-of-range hex entity returns replacement char (no RangeError)", () => {
      // This was the Devin fix — without bounds check, throws RangeError
      expect(htmlToPlainText("&#xFFFFFFFF;")).toBe("\uFFFD");
    });

    test("out-of-range decimal entity returns replacement char (no RangeError)", () => {
      expect(htmlToPlainText("&#99999999;")).toBe("\uFFFD");
    });

    test("unknown entity becomes space", () => {
      expect(htmlToPlainText("a&unknownthing;b")).toBe("a b");
    });
  });

  test.describe("whitespace handling", () => {
    test("collapses horizontal whitespace but keeps newlines", () => {
      expect(htmlToPlainText("<p>a    b</p><p>c</p>")).toBe("a b\nc");
    });

    test("trims leading and trailing whitespace", () => {
      expect(htmlToPlainText("  <p>hello</p>  ")).toBe("hello");
    });

    test("trims spaces adjacent to newlines", () => {
      expect(htmlToPlainText("<p>a </p><p> b</p>")).toBe("a\nb");
    });
  });

  test.describe("realistic email cases", () => {
    test("Gmail-style reply with quoted content preserves structure", () => {
      const html = `<div dir="ltr">Hi Ankit,<div><br></div><div>Looking forward to it.</div></div>
<br>
<div class="gmail_quote"><blockquote>On Wed, Ankit wrote:<br>Can you make it?</blockquote></div>`;
      const result = htmlToPlainText(html);
      expect(result).toContain("Hi Ankit,");
      expect(result).toContain("Looking forward to it.");
      expect(result).toContain("On Wed, Ankit wrote:");
      expect(result).toContain("Can you make it?");
      expect(result).not.toContain("<div");
      expect(result).not.toContain("gmail_quote");
      // Structure preserved: paragraphs separated by newlines
      expect(result.split("\n").length).toBeGreaterThan(2);
    });

    test("contractions survive entity decoding", () => {
      // This is the specific comprehension bug: without numeric decoding,
      // "don't" becomes "don t" and confuses the agent
      const html = "<p>We don&#8217;t have a meeting, won&#8217;t confirm.</p>";
      const result = htmlToPlainText(html);
      expect(result).toContain("don\u2019t");
      expect(result).toContain("won\u2019t");
      expect(result).not.toContain("don t");
    });

    test("signature block flattens cleanly", () => {
      const html = `<p>Thanks,</p>
<div><span>Scott Stephenson</span><br><span>CEO</span><br><a href="mailto:s@ex.com">s@ex.com</a></div>`;
      const result = htmlToPlainText(html);
      expect(result).toContain("Thanks,");
      expect(result).toContain("Scott Stephenson");
      expect(result).toContain("CEO");
      expect(result).toContain("s@ex.com");
      expect(result).not.toContain("mailto:");
      expect(result).not.toContain("<span");
    });

    test("token reduction vs raw HTML", () => {
      // Demonstrates the core value: stripped text is substantially shorter
      const html = `<div dir="ltr" style="font-family: Arial; color: #333;">
        <p style="margin: 0 0 10px 0;"><span style="font-weight: bold;">Hi there,</span></p>
        <p style="margin: 0 0 10px 0;">This is a test.</p>
      </div>`;
      const plain = htmlToPlainText(html);
      expect(plain.length).toBeLessThan(html.length / 2);
      expect(plain).toContain("Hi there,");
      expect(plain).toContain("This is a test.");
    });
  });

  test.describe("edge cases", () => {
    test("empty string returns empty string", () => {
      expect(htmlToPlainText("")).toBe("");
    });

    test("plain text with no HTML passes through", () => {
      expect(htmlToPlainText("just plain text")).toBe("just plain text");
    });

    test("only tags returns empty string", () => {
      expect(htmlToPlainText("<div></div><p></p><br>")).toBe("");
    });

    test("nested block tags produce correct structure", () => {
      expect(htmlToPlainText("<div><div><p>deep</p></div></div>")).toBe("deep");
    });

    test("case-insensitive tag matching", () => {
      // </P> → \n, <Br> → \n, so upper\n\nmixed (collapsed from 3+)
      expect(htmlToPlainText("<P>upper</P><Br><DIV>mixed</DIV>")).toBe("upper\n\nmixed");
    });
  });
});
