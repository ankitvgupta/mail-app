/**
 * Unit tests for shared/body-sanitizer.ts — the write-boundary strip of
 * oversized inline data: URIs from email bodies (see migration 8 for the prod
 * numbers that motivated it).
 */
import { test, expect } from "@playwright/test";
import {
  stripLargeDataUris,
  inlineImagePlaceholder,
  DATA_URI_STRIP_THRESHOLD,
} from "../../src/shared/body-sanitizer";

function dataUriOfLength(totalLength: number, scheme = "data:image/png;base64,"): string {
  return scheme + "A".repeat(totalLength - scheme.length);
}

test.describe("stripLargeDataUris", () => {
  test("replaces an oversized img data URI with a placeholder", () => {
    const big = dataUriOfLength(DATA_URI_STRIP_THRESHOLD);
    const body = `<html><body><p>hi</p><img src="${big}" alt="x"></body></html>`;
    const stripped = stripLargeDataUris(body);

    expect(stripped).not.toContain(big);
    expect(stripped).toContain("data:image/svg+xml");
    expect(stripped).toContain("too%20large%20to%20display%20inline");
    // Surrounding HTML is untouched
    expect(stripped).toContain("<p>hi</p>");
    expect(stripped).toContain('alt="x"');
    expect(stripped.length).toBeLessThan(body.length / 10);
  });

  test("keeps data URIs under the threshold (signatures, logos)", () => {
    const small = dataUriOfLength(1_000);
    // Pad the body over the threshold so the early-return doesn't mask the check
    const body = `<img src="${small}">` + "x".repeat(DATA_URI_STRIP_THRESHOLD);
    expect(stripLargeDataUris(body)).toContain(small);
  });

  test("strips only the oversized URI when sizes are mixed", () => {
    const small = dataUriOfLength(1_000);
    const big = dataUriOfLength(DATA_URI_STRIP_THRESHOLD + 1);
    const body = `<img src="${small}"><img src="${big}">`;
    const stripped = stripLargeDataUris(body);
    expect(stripped).toContain(small);
    expect(stripped).not.toContain(big);
  });

  test("strips multiple oversized URIs in one body", () => {
    const a = dataUriOfLength(DATA_URI_STRIP_THRESHOLD, "data:image/png;base64,");
    const b = dataUriOfLength(DATA_URI_STRIP_THRESHOLD, "data:image/gif;base64,");
    const stripped = stripLargeDataUris(`<img src="${a}"><img src="${b}">`);
    expect(stripped).not.toContain(a);
    expect(stripped).not.toContain(b);
    expect(stripped.match(/data:image\/svg\+xml/g)?.length).toBe(2);
  });

  test("strips single-quoted, uppercase IMG tags (case-insensitive)", () => {
    const big = dataUriOfLength(DATA_URI_STRIP_THRESHOLD);
    const stripped = stripLargeDataUris(`<IMG SRC='${big}'>`);
    expect(stripped).not.toContain(big);
    expect(stripped).toContain("data:image/svg+xml");
  });

  test("strips an uppercase DATA: scheme (RFC 2397 case-insensitive) — no bypass", () => {
    const big = dataUriOfLength(DATA_URI_STRIP_THRESHOLD, "DATA:image/png;base64,");
    const stripped = stripLargeDataUris(`<img src="${big}">`);
    expect(stripped).not.toContain(big);
    expect(stripped).toContain("data:image/svg+xml");
  });

  test("strips oversized data URIs on non-img elements (video/source)", () => {
    const big = dataUriOfLength(DATA_URI_STRIP_THRESHOLD, "data:video/mp4;base64,");
    const stripped = stripLargeDataUris(`<video src="${big}"></video>`);
    expect(stripped).not.toContain(big);
    expect(stripped).toContain("data:image/svg+xml");
  });

  test("is linear-time on adversarial input (many <img with no closing >)", () => {
    // A quadratic matcher hangs for seconds here; the linear one returns fast.
    const body = "data:x" + "<img aaaaaaaaaa ".repeat(200_000);
    const start = Date.now();
    stripLargeDataUris(body);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test("sanitizes an injected mime type in the placeholder", () => {
    const evil =
      "data:image/png</text><script>x</script>;base64," + "A".repeat(DATA_URI_STRIP_THRESHOLD);
    const stripped = stripLargeDataUris(`<img src="${evil}">`);
    // mime failed validation → fell back to "image"; no raw markup leaked
    expect(stripped).not.toContain("<script>");
    expect(stripped).toContain("Inline%20image");
  });

  test("returns bodies without data: URIs unchanged", () => {
    const body = "<p>plain old email</p>".repeat(5_000);
    expect(stripLargeDataUris(body)).toBe(body);
  });

  test("placeholder reports the mime type and human-readable size", () => {
    const uri = inlineImagePlaceholder("image/jpeg", 4 * 1024 * 1024);
    const decoded = decodeURIComponent(uri.replace("data:image/svg+xml,", ""));
    expect(decoded).toContain("image/jpeg");
    expect(decoded).toContain("3.0 MB"); // 4M base64 chars ≈ 3MB decoded
  });

  test("empty body is a no-op", () => {
    expect(stripLargeDataUris("")).toBe("");
  });
});
