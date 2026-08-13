import React from "react";
import type { DashboardEmail } from "../../../shared/types";
import type { ExtensionEnrichmentResult } from "../../../shared/extension-types";
import { useAppStore } from "../../store";

// Types for the enrichment data from web-search extension
interface SenderProfileData {
  email: string;
  name: string;
  summary: string;
  linkedinUrl?: string;
  company?: string;
  title?: string;
  lookupAt: number;
  isReminder: boolean;
}

interface SenderProfilePanelProps {
  email: DashboardEmail;
  threadEmails: DashboardEmail[];
  enrichment: ExtensionEnrichmentResult | null;
  isLoading: boolean;
}

/**
 * Sender Profile Panel - displays information about the email sender
 */
export function SenderProfilePanel({
  email,
  threadEmails,
  enrichment,
  isLoading,
}: SenderProfilePanelProps): React.ReactElement {
  const profile = enrichment?.data as SenderProfileData | undefined;
  const isReminder = profile?.isReminder ?? false;
  const linkedInUrl =
    typeof profile?.linkedinUrl === "string" ? parseProfileLink(profile.linkedinUrl) : undefined;

  // Fallback values if no enrichment
  const senderName = profile?.name || extractDisplayName(email.from);
  const senderEmail = profile?.email || extractEmailAddress(email.from);

  const addUndoAction = useAppStore((s) => s.addUndoAction);
  const removeEmails = useAppStore((s) => s.removeEmails);

  // Hide the block button on reminder emails — the visible sender is the
  // original-sender (e.g. someone you bcc'd via Boomerang), and blocking
  // them via the reminder service header would do the wrong thing.
  const canBlock = !isReminder && !!email.accountId && !!senderEmail && senderEmail.includes("@");

  // Deferred commit: optimistically remove the thread from view and queue an
  // undo. The IPC (create Gmail filter + trash existing messages) only fires
  // when the undo timer elapses; clicking Undo within 5s restores the view
  // and the server-side action never happens.
  const handleBlock = () => {
    if (!canBlock || !email.accountId) return;
    const accountId = email.accountId;
    const normalized = senderEmail.toLowerCase();

    const threadIds = threadEmails.map((e) => e.id);
    removeEmails(threadIds);

    addUndoAction({
      id: `block-${normalized}-${Date.now()}`,
      type: "block",
      threadCount: 1,
      accountId,
      emails: [...threadEmails],
      scheduledAt: Date.now(),
      delayMs: 5000,
      blockedSender: normalized,
    });
  };

  return (
    <div className="p-4">
      {/* Reminder indicator */}
      {isReminder && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs px-2 py-1 rounded mb-3">
          Returned via reminder - showing original sender
        </div>
      )}

      {/* Sender Avatar & Name */}
      <div className="flex items-center space-x-3 mb-3">
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-lg font-semibold text-white">
          {senderName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{senderName}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{senderEmail}</p>
        </div>
      </div>

      {/* Block sender — single click, undoable via toast */}
      {canBlock && (
        <button
          type="button"
          onClick={handleBlock}
          className="mb-4 text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:underline"
          title="Create a Gmail filter that routes this sender to Trash"
        >
          Block sender
        </button>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center space-x-2 text-gray-500 dark:text-gray-400">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span className="text-sm">Looking up...</span>
          </div>
        </div>
      )}

      {/* Profile Info */}
      {!isLoading && profile && (
        <div className="space-y-4">
          {/* Company & Title */}
          {(profile.company || profile.title) && (
            <div className="bg-gray-50 dark:bg-gray-800/50 p-3 rounded-lg">
              {profile.title && (
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {profile.title}
                </p>
              )}
              {profile.company && (
                <p className="text-sm text-gray-600 dark:text-gray-400">{profile.company}</p>
              )}
            </div>
          )}

          {/* Summary */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              About
            </h4>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
              {profile.summary}
            </p>
          </div>

          {/* LinkedIn Link */}
          {linkedInUrl && (
            <a
              href={linkedInUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
              </svg>
              <span>View LinkedIn</span>
            </a>
          )}

          {/* Last updated */}
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Last updated: {new Date(profile.lookupAt).toLocaleDateString()}
          </p>
        </div>
      )}

      {/* No profile available */}
      {!isLoading && !profile && (
        <div className="text-center py-8">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No profile information available
          </p>
        </div>
      )}
    </div>
  );
}

function parseProfileLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function extractDisplayName(from: string): string {
  const match = from.match(/^\s*([^<]+?)\s*(?:<|$)/);
  return match ? match[1].trim() : from.trim();
}

function extractEmailAddress(from: string): string {
  const match = from.match(/<\s*([^>]+?)\s*>/);
  return (match ? match[1] : from).trim().toLowerCase();
}
