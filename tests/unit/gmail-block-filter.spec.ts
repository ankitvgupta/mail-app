/**
 * Tests for the block-sender filter creation (gmail-block-filter.ts).
 *
 * These drive the REAL googleapis/gaxios stack through MSW — the point is to
 * verify our per-request retryConfig actually makes gaxios retry POSTs on
 * transient Gmail 500s (its defaults never retry POST), and that the
 * duplicate-filter fallback resolves the existing filter's ID. Production
 * incident: rapid back-to-back filters.create calls got 500 "backendError"
 * from Gmail and surfaced straight to the user as a failed block.
 */
import { test, expect } from "@playwright/test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { google } from "googleapis";
import { createBlockFilter, httpErrorStatus } from "../../src/main/services/gmail-block-filter";

const FILTERS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters";

const server = setupServer();
const gmail = google.gmail({ version: "v1" });

function gmailError(code: number, message: string) {
  return HttpResponse.json(
    { error: { code, message, errors: [{ message, domain: "global" }] } },
    { status: code },
  );
}

test.beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
test.afterEach(() => server.resetHandlers());
test.afterAll(() => server.close());

test.describe("createBlockFilter", () => {
  test("returns filter ID on clean create without retrying", async () => {
    let calls = 0;
    server.use(
      http.post(FILTERS_URL, async ({ request }) => {
        calls++;
        const body = await request.json();
        expect(body).toEqual({
          criteria: { from: "spam@example.com" },
          action: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] },
        });
        return HttpResponse.json({ id: "filter-123" });
      }),
    );

    const id = await createBlockFilter(gmail, "spam@example.com");
    expect(id).toBe("filter-123");
    expect(calls).toBe(1);
  });

  test("retries transient 500s and succeeds", async () => {
    let calls = 0;
    server.use(
      http.post(FILTERS_URL, () => {
        calls++;
        if (calls <= 2) return gmailError(500, "Internal error encountered.");
        return HttpResponse.json({ id: "filter-456" });
      }),
    );

    const id = await createBlockFilter(gmail, "spam@example.com");
    expect(id).toBe("filter-456");
    expect(calls).toBe(3);
  });

  test("rejects with the 5xx after exhausting all retries", async () => {
    // 1 initial attempt + 4 retries = 5 POSTs. This is the path that reaches
    // sync.ipc.ts and triggers the "Gmail temporary server error" toast.
    let calls = 0;
    server.use(
      http.post(FILTERS_URL, () => {
        calls++;
        return gmailError(500, "Internal error encountered.");
      }),
    );

    const err = await createBlockFilter(gmail, "spam@example.com").then(
      () => null,
      (e: unknown) => e,
    );
    expect(httpErrorStatus(err)).toBe(500);
    expect(calls).toBe(5);
  });

  test("does not retry a non-duplicate 400", async () => {
    let calls = 0;
    server.use(
      http.post(FILTERS_URL, () => {
        calls++;
        return gmailError(400, "Invalid from address");
      }),
    );

    await expect(createBlockFilter(gmail, "not-an-address")).rejects.toThrow(/Invalid from/);
    expect(calls).toBe(1);
  });

  test("resolves existing filter ID when a retried create hits 'Filter already exists'", async () => {
    // Simulates the ambiguous-500 case: the first attempt 500s but actually
    // created the filter server-side, so the retry is rejected as a duplicate.
    let calls = 0;
    server.use(
      http.post(FILTERS_URL, () => {
        calls++;
        if (calls === 1) return gmailError(500, "Internal error encountered.");
        return gmailError(400, "Filter already exists");
      }),
      http.get(FILTERS_URL, () =>
        HttpResponse.json({
          filter: [
            {
              id: "unrelated",
              criteria: { from: "other@x.com" },
              action: { addLabelIds: ["TRASH"] },
            },
            {
              id: "filter-existing",
              criteria: { from: "Spam@Example.com" },
              action: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] },
            },
          ],
        }),
      ),
    );

    const id = await createBlockFilter(gmail, "spam@example.com");
    expect(id).toBe("filter-existing");
  });

  test("rethrows duplicate error if no matching filter is found", async () => {
    server.use(
      http.post(FILTERS_URL, () => gmailError(400, "Filter already exists")),
      http.get(FILTERS_URL, () => HttpResponse.json({ filter: [] })),
    );

    await expect(createBlockFilter(gmail, "spam@example.com")).rejects.toThrow(/already exists/i);
  });

  test("rethrows duplicate error (not lookup error) if the filters.list fallback fails", async () => {
    server.use(
      http.post(FILTERS_URL, () => gmailError(400, "Filter already exists")),
      http.get(FILTERS_URL, () => gmailError(503, "Service unavailable")),
    );

    await expect(createBlockFilter(gmail, "spam@example.com")).rejects.toThrow(/already exists/i);
  });
});

test.describe("httpErrorStatus", () => {
  test("extracts status from HTTP-shaped errors, null otherwise", async () => {
    server.use(http.post(FILTERS_URL, () => gmailError(403, "Insufficient Permission")));
    const err = await createBlockFilter(gmail, "spam@example.com").then(
      () => null,
      (e: unknown) => e,
    );
    expect(httpErrorStatus(err)).toBe(403);
    expect(httpErrorStatus(new Error("plain"))).toBeNull();
    expect(httpErrorStatus(null)).toBeNull();
    expect(httpErrorStatus("string")).toBeNull();
  });
});
