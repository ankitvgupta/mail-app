import type { AttachmentMeta } from "../../shared/types";

export type AttachmentWithId = AttachmentMeta & { attachmentId: string };

export function hasAttachmentId(attachment: AttachmentMeta): attachment is AttachmentWithId {
  return typeof attachment.attachmentId === "string" && attachment.attachmentId.length > 0;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);

  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function isPreviewable(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}
