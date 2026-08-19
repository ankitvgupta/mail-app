import { expect, test } from "@playwright/test";
import type { DashboardEmail } from "../../src/shared/types";
import { formatFileSize, isPreviewable } from "../../src/renderer/utils/attachments";
import { buildOpenables, itemMatches, type OpenableItem } from "../../src/renderer/utils/openables";

test.describe("attachment helpers", () => {
  test("formats byte sizes with stable units", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 1024 * 2.25)).toBe("2.3 MB");
  });

  test("detects previewable attachment MIME types", () => {
    expect(isPreviewable("application/pdf")).toBe(true);
    expect(isPreviewable("image/png")).toBe(true);
    expect(isPreviewable("application/vnd.ms-excel")).toBe(false);
  });
});

test.describe("openable item helpers", () => {
  test("filters attachments that cannot be opened", () => {
    const email: DashboardEmail = {
      id: "email-1",
      threadId: "thread-1",
      subject: "Attachments",
      from: "sender@example.com",
      to: "recipient@example.com",
      date: "2026-01-01T00:00:00.000Z",
      body: "",
      attachments: [
        {
          id: "missing-gmail-id",
          filename: "remote-placeholder.pdf",
          mimeType: "application/pdf",
          size: 1000,
        },
        {
          id: "downloadable",
          attachmentId: "gmail-attachment-id",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
      ],
    };

    expect(buildOpenables(email)).toEqual([
      {
        kind: "attachment",
        id: "attachment:downloadable",
        label: "invoice.pdf",
        metadata: "2.0 KB - application/pdf",
        attachment: email.attachments?.[1],
      },
    ]);
  });

  test("matches query tokens across labels, metadata, and link URLs", () => {
    const attachmentItem: OpenableItem = {
      kind: "attachment",
      id: "attachment:invoice",
      label: "January invoice",
      metadata: "20.0 KB - application/pdf",
      attachment: {
        id: "invoice",
        attachmentId: "gmail-attachment-id",
        filename: "January invoice",
        mimeType: "application/pdf",
        size: 20 * 1024,
      },
    };
    const linkItem: OpenableItem = {
      kind: "link",
      id: "link:https://billing.example.com/view?token=abc",
      label: "Billing portal",
      metadata: "billing.example.com/view?token=abc",
      url: "https://billing.example.com/view?token=abc",
    };

    expect(itemMatches(attachmentItem, "invoice pdf")).toBe(true);
    expect(itemMatches(attachmentItem, "invoice zip")).toBe(false);
    expect(itemMatches(linkItem, "billing token")).toBe(true);
  });
});
