import React, { useState } from "react";
import type { AttachmentMeta, IpcResponse } from "../../shared/types";
import { formatFileSize, isPreviewable } from "../utils/attachments";

declare global {
  interface Window {
    api: {
      attachments: {
        download: (
          emailId: string,
          attachmentId: string,
          filename: string,
          accountId: string,
        ) => Promise<IpcResponse<{ filePath: string }>>;
        preview: (
          emailId: string,
          attachmentId: string,
          accountId: string,
        ) => Promise<IpcResponse<{ data: string }>>;
        pickFiles: () => Promise<
          IpcResponse<Array<{ filename: string; path: string; mimeType: string; size: number }>>
        >;
        getForForward: (
          emailId: string,
          accountId: string,
        ) => Promise<IpcResponse<Array<{ filename: string; mimeType: string; content: string }>>>;
      };
    };
  }
}

function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("word") || mimeType.includes("document")) return "doc";
  if (mimeType.includes("sheet") || mimeType.includes("excel")) return "sheet";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "slides";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("zip") || mimeType.includes("compress") || mimeType.includes("archive"))
    return "archive";
  return "file";
}

function FileIcon({ type }: { type: string }) {
  const colorClass =
    {
      image: "text-purple-500",
      pdf: "text-red-500",
      doc: "text-blue-500",
      sheet: "text-green-500",
      slides: "text-orange-500",
      text: "text-gray-500",
      archive: "text-yellow-600",
      file: "text-gray-400",
    }[type] || "text-gray-400";

  return (
    <svg
      className={`w-4 h-4 ${colorClass} flex-shrink-0`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

/**
 * Shows attachment list for an email message (in thread view).
 * Supports download and preview.
 */
export function EmailAttachmentList({
  attachments,
  emailId,
  accountId,
  onPreview,
}: {
  attachments: AttachmentMeta[];
  emailId: string;
  accountId: string;
  onPreview: (attachment: AttachmentMeta, data: string) => void;
}) {
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [previewingIds, setPreviewingIds] = useState<Set<string>>(new Set());

  const handleDownload = async (att: AttachmentMeta) => {
    if (!att.attachmentId || downloadingIds.has(att.id)) return;
    setDownloadingIds((prev) => new Set(prev).add(att.id));
    try {
      await window.api.attachments.download(emailId, att.attachmentId, att.filename, accountId);
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(att.id);
        return next;
      });
    }
  };

  const handlePreview = async (att: AttachmentMeta) => {
    if (!att.attachmentId || previewingIds.has(att.id)) return;
    setPreviewingIds((prev) => new Set(prev).add(att.id));
    try {
      const result = await window.api.attachments.preview(emailId, att.attachmentId, accountId);
      if (result.success && result.data) {
        onPreview(att, result.data.data);
      }
    } catch (err) {
      console.error("Preview failed:", err);
    } finally {
      setPreviewingIds((prev) => {
        const next = new Set(prev);
        next.delete(att.id);
        return next;
      });
    }
  };

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2 mb-1">
      {attachments.map((att) => {
        const iconType = getFileIcon(att.mimeType);
        const canPreview = isPreviewable(att.mimeType) && !!att.attachmentId;
        const isDownloading = downloadingIds.has(att.id);
        const isPreviewing = previewingIds.has(att.id);

        return (
          <div
            key={att.id}
            className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-xs"
          >
            <FileIcon type={iconType} />
            <button
              onClick={() => (canPreview ? handlePreview(att) : handleDownload(att))}
              disabled={isPreviewing || isDownloading}
              className="flex-1 min-w-0 text-left cursor-pointer"
              title={canPreview ? "Click to preview" : att.filename}
            >
              <div className="text-sm text-gray-700 dark:text-gray-300 truncate">
                {att.filename}
              </div>
              <div className="text-xs text-gray-400 dark:text-gray-500">
                {formatFileSize(att.size)}
              </div>
            </button>
            <div className="flex items-center gap-1 flex-shrink-0">
              {canPreview && (
                <button
                  onClick={() => handlePreview(att)}
                  disabled={isPreviewing}
                  className="p-1 text-gray-400 hover:text-blue-500 transition-colors"
                  title="Preview"
                >
                  {isPreviewing ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="2"
                        opacity="0.25"
                      />
                      <path
                        d="M4 12a8 8 0 018-8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                  )}
                </button>
              )}
              {att.attachmentId && (
                <button
                  onClick={() => handleDownload(att)}
                  disabled={isDownloading}
                  className="p-1 text-gray-400 hover:text-blue-500 transition-colors"
                  title="Download"
                >
                  {isDownloading ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="2"
                        opacity="0.25"
                      />
                      <path
                        d="M4 12a8 8 0 018-8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                      />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Compose attachment item - shows attached files with remove button.
 */
export interface ComposeAttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path?: string; // local file
  content?: string; // base64 content (forwarded)
}

export function ComposeAttachmentList({
  attachments,
  onRemove,
}: {
  attachments: ComposeAttachmentItem[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 py-2">
      {attachments.map((att) => {
        const iconType = getFileIcon(att.mimeType);
        return (
          <div
            key={att.id}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 max-w-xs"
          >
            <FileIcon type={iconType} />
            <div className="flex-1 min-w-0">
              <div
                className="text-sm text-gray-700 dark:text-gray-300 truncate"
                title={att.filename}
              >
                {att.filename}
              </div>
              <div className="text-xs text-gray-400 dark:text-gray-500">
                {formatFileSize(att.size)}
              </div>
            </div>
            <button
              onClick={() => onRemove(att.id)}
              className="p-0.5 text-gray-400 hover:text-red-500 transition-colors"
              title="Remove"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Attachment preview modal for images and PDFs.
 */
export function AttachmentPreviewModal({
  attachment,
  data,
  onClose,
}: {
  attachment: AttachmentMeta;
  data: string; // base64 data
  onClose: () => void;
}) {
  const isImage = attachment.mimeType.startsWith("image/");
  const isPdf = attachment.mimeType === "application/pdf";
  const dataUrl = `data:${attachment.mimeType};base64,${data}`;

  // Close on Escape
  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-w-4xl max-h-[90vh] w-full mx-4 bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {attachment.filename}
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center min-h-[300px]">
          {isImage && (
            <img
              src={dataUrl}
              alt={attachment.filename}
              className="max-w-full max-h-[75vh] object-contain"
            />
          )}
          {isPdf && (
            <iframe
              src={dataUrl}
              title={attachment.filename}
              className="w-full h-[75vh] border-none"
            />
          )}
          {!isImage && !isPdf && (
            <p className="text-gray-500 dark:text-gray-400">
              Preview not available for this file type
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
