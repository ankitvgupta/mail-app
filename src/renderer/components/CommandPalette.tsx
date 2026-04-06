import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppStore, useThreadedEmails } from "../store";
import { splitAddressList, extractFirstName } from "../utils/address-parsing";
import type { DashboardEmail, IpcResponse } from "../../shared/types";

// --- Action types ---

type CommandAction = {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  icon?: string; // SVG path data for a 24x24 viewBox
  execute: () => void;
  /** Return false to hide the action from the palette */
  available?: () => boolean;
};

// --- Icon paths (24x24 viewBox, stroke-based) ---

const ICONS = {
  search: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  compose: "M12 4v16m8-8H4",
  reply: "M3 10l9-7 9 7M3 10v10a1 1 0 001 1h16a1 1 0 001-1V10",
  archive: "M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4",
  trash:
    "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
  star: "M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z",
  mail: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
  settings:
    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
  keyboard:
    "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707",
  sun: "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z",
  moon: "M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z",
  monitor:
    "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
  user: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  clock: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  eye: "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  arrowUp: "M5 10l7-7m0 0l7 7m-7-7v18",
  arrowDown: "M19 14l-7 7m0 0l-7-7m7 7V3",
  layout:
    "M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z",
  refresh:
    "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
  forward: "M13 7l5 5m0 0l-5 5m5-5H6",
};

function ActionIcon({ path }: { path?: string }) {
  if (!path) {
    return (
      <div className="w-5 h-5 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </div>
    );
  }
  return (
    <svg
      className="w-5 h-5 text-gray-400 dark:text-gray-500 flex-shrink-0"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

// --- Fuzzy match ---

function fuzzyMatch(text: string, query: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Check substring first (highest quality match)
  if (lowerText.includes(lowerQuery)) return true;

  // Check each query word appears in text
  const words = lowerQuery.split(/\s+/);
  return words.every((w) => lowerText.includes(w));
}

// --- Component ---

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    accounts,
    currentAccountId,
    selectedEmailId,
    selectedThreadId,
    viewMode,
    themePreference,
    inboxDensity,
    openSearch,
    openCompose,
    setShowSettings,
    setViewMode,
    setThemePreference,
    setInboxDensity,
    setCurrentAccountId,
    setSelectedEmailId,
    setSelectedThreadId,
    setShowSnoozeMenu,
    emails,
  } = useAppStore();

  const { threads } = useThreadedEmails();

  // Build action list dynamically based on current state
  const actions: CommandAction[] = useMemo(() => {
    const hasSelectedEmail = !!selectedEmailId;
    const hasSelectedThread = !!selectedThreadId;

    const allActions: CommandAction[] = [
      // --- Search & Navigation ---
      {
        id: "search",
        label: "Search emails",
        category: "Navigation",
        shortcut: "/",
        icon: ICONS.search,
        execute: () => openSearch(),
      },
      {
        id: "go-to-inbox",
        label: "Go to inbox",
        category: "Navigation",
        shortcut: "g i",
        icon: ICONS.mail,
        execute: () => {
          setViewMode("split");
          useAppStore.getState().clearActiveSearch();
        },
      },
      {
        id: "go-to-top",
        label: "Go to top of list",
        category: "Navigation",
        shortcut: "g g",
        icon: ICONS.arrowUp,
        execute: () => {
          if (threads.length > 0) {
            setSelectedThreadId(threads[0].threadId);
            setSelectedEmailId(threads[0].latestEmail.id);
          }
        },
      },

      // --- Compose ---
      {
        id: "compose-new",
        label: "Compose new email",
        category: "Compose",
        shortcut: "c",
        icon: ICONS.compose,
        execute: () => {
          setViewMode("full");
          openCompose("new");
        },
      },
      {
        id: "reply-all",
        label: "Reply all",
        category: "Compose",
        shortcut: "r",
        icon: ICONS.reply,
        available: () => hasSelectedEmail,
        execute: () => {
          if (selectedEmailId) {
            openCompose("reply-all", selectedEmailId);
          }
        },
      },
      {
        id: "reply",
        label: "Reply (single)",
        category: "Compose",
        shortcut: "R",
        icon: ICONS.reply,
        available: () => hasSelectedEmail,
        execute: () => {
          if (selectedEmailId) {
            openCompose("reply", selectedEmailId);
          }
        },
      },
      {
        id: "forward",
        label: "Forward email",
        category: "Compose",
        shortcut: "f",
        icon: ICONS.forward,
        available: () => hasSelectedEmail,
        execute: () => {
          if (selectedEmailId) {
            openCompose("forward", selectedEmailId);
          }
        },
      },

      // --- Email Actions ---
      {
        id: "archive",
        label: "Archive email",
        category: "Email Actions",
        shortcut: "e",
        icon: ICONS.archive,
        available: () => hasSelectedEmail,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedThreadId && state.currentAccountId) {
            const threadEmails = state.emails.filter((e) => e.threadId === state.selectedThreadId);
            state.removeEmailsAndAdvance(
              threadEmails.map((e) => e.id),
              null,
              null,
            );
            state.addUndoAction({
              id: `archive-${state.selectedThreadId}-${Date.now()}`,
              type: "archive",
              threadCount: 1,
              accountId: state.currentAccountId,
              emails: [...threadEmails],
              scheduledAt: Date.now(),
              delayMs: 5000,
            });
          }
        },
      },
      {
        id: "trash",
        label: "Delete email",
        category: "Email Actions",
        shortcut: "#",
        icon: ICONS.trash,
        available: () => hasSelectedEmail,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedThreadId && state.currentAccountId) {
            const threadEmails = state.emails.filter((e) => e.threadId === state.selectedThreadId);
            state.removeEmailsAndAdvance(
              threadEmails.map((e) => e.id),
              null,
              null,
            );
            state.addUndoAction({
              id: `trash-${state.selectedThreadId}-${Date.now()}`,
              type: "trash",
              threadCount: 1,
              accountId: state.currentAccountId,
              emails: [...threadEmails],
              scheduledAt: Date.now(),
              delayMs: 5000,
            });
          }
        },
      },
      {
        id: "discard-draft",
        label: "Discard draft",
        category: "Email Actions",
        shortcut: "#",
        icon: ICONS.trash,
        available: () => !!useAppStore.getState().selectedDraftId,
        execute: () => {
          const state = useAppStore.getState();
          const draftId = state.selectedDraftId;
          if (draftId) {
            state.removeLocalDraft(draftId);
            window.api.compose.deleteLocalDraft(draftId);
            state.setSelectedDraftId(null);
          }
        },
      },
      {
        id: "mark-unread",
        label: "Mark as unread",
        category: "Email Actions",
        shortcut: "u",
        icon: ICONS.eye,
        available: () => hasSelectedThread,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedThreadId && state.currentAccountId) {
            const threadEmails = state.emails.filter((e) => e.threadId === state.selectedThreadId);
            const latest = threadEmails.reduce(
              (a, b) => (new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b),
              threadEmails[0],
            );
            if (latest) {
              const labels = latest.labelIds || ["INBOX"];
              if (!labels.includes("UNREAD")) {
                const previousLabels: Record<string, string[]> = { [latest.id]: [...labels] };
                state.updateEmail(latest.id, { labelIds: [...labels, "UNREAD"] });
                state.addUndoAction({
                  id: `mark-unread-${state.selectedThreadId}-${Date.now()}`,
                  type: "mark-unread",
                  threadCount: 1,
                  accountId: state.currentAccountId,
                  emails: [latest],
                  scheduledAt: Date.now(),
                  delayMs: 5000,
                  previousLabels,
                });
              }
            }
          }
        },
      },
      {
        id: "snooze",
        label: "Snooze email",
        category: "Email Actions",
        shortcut: "h",
        icon: ICONS.clock,
        available: () => hasSelectedEmail,
        execute: () => {
          setShowSnoozeMenu(true);
        },
      },
      {
        id: "star",
        label: "Star / Unstar email",
        category: "Email Actions",
        icon: ICONS.star,
        available: () => hasSelectedEmail,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedEmailId && state.currentAccountId) {
            const email = state.emails.find((e) => e.id === state.selectedEmailId);
            if (email) {
              const currentLabels = email.labelIds || [];
              const isStarred = currentLabels.includes("STARRED");
              const previousLabels: Record<string, string[]> = { [email.id]: [...currentLabels] };
              const newLabels = isStarred
                ? currentLabels.filter((l) => l !== "STARRED")
                : [...currentLabels, "STARRED"];
              state.updateEmail(email.id, { labelIds: newLabels });
              state.addUndoAction({
                id: `${isStarred ? "unstar" : "star"}-${email.threadId}-${Date.now()}`,
                type: isStarred ? "unstar" : "star",
                threadCount: 1,
                accountId: state.currentAccountId,
                emails: [email],
                scheduledAt: Date.now(),
                delayMs: 5000,
                previousLabels,
              });
            }
          }
        },
      },

      // --- View ---
      {
        id: "toggle-view",
        label: viewMode === "split" ? "Switch to full view" : "Switch to split view",
        category: "View",
        icon: ICONS.layout,
        execute: () => {
          setViewMode(viewMode === "split" ? "full" : "split");
        },
      },
      {
        id: "refresh-inbox",
        label: "Refresh inbox",
        category: "View",
        icon: ICONS.refresh,
        execute: () => {
          const state = useAppStore.getState();
          if (state.currentAccountId) {
            window.api.sync.now(state.currentAccountId);
          }
        },
      },

      // --- Settings ---
      {
        id: "open-settings",
        label: "Open settings",
        category: "Settings",
        shortcut: "\u2318,",
        icon: ICONS.settings,
        execute: () => setShowSettings(true),
      },
      {
        id: "show-shortcuts",
        label: "Show keyboard shortcuts",
        category: "Settings",
        shortcut: "?",
        icon: ICONS.keyboard,
        execute: () => {
          // Dispatch a ? keypress to toggle shortcuts
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
        },
      },

      // --- Theme ---
      {
        id: "theme-light",
        label: "Switch to light theme",
        category: "Appearance",
        icon: ICONS.sun,
        available: () => themePreference !== "light",
        execute: () => {
          setThemePreference("light");
          window.api.theme.set("light");
        },
      },
      {
        id: "theme-dark",
        label: "Switch to dark theme",
        category: "Appearance",
        icon: ICONS.moon,
        available: () => themePreference !== "dark",
        execute: () => {
          setThemePreference("dark");
          window.api.theme.set("dark");
        },
      },
      {
        id: "theme-system",
        label: "Use system theme",
        category: "Appearance",
        icon: ICONS.monitor,
        available: () => themePreference !== "system",
        execute: () => {
          setThemePreference("system");
          window.api.theme.set("system");
        },
      },

      // --- Density ---
      {
        id: "density-default",
        label: "Default density",
        category: "Appearance",
        available: () => inboxDensity !== "default",
        execute: () => {
          setInboxDensity("default");
          window.api.settings.set({ inboxDensity: "default" });
        },
      },
      {
        id: "density-compact",
        label: "Compact density",
        category: "Appearance",
        available: () => inboxDensity !== "compact",
        execute: () => {
          setInboxDensity("compact");
          window.api.settings.set({ inboxDensity: "compact" });
        },
      },

      // --- Instant Intro ---
      {
        id: "instant-intro",
        label: "Instant Intro (move introducer to Bcc)",
        category: "Compose",
        icon: ICONS.forward,
        available: () => hasSelectedEmail,
        execute: () => {
          if (!selectedEmailId) return;
          const state = useAppStore.getState();
          const email = state.emails.find((e) => e.id === selectedEmailId);
          if (!email) return;

          const currentAccount = state.accounts.find((a) => a.id === state.currentAccountId);
          const userEmail = currentAccount?.email?.toLowerCase() ?? "";

          // Escape HTML special characters to prevent injection from email headers
          const escapeHtml = (s: string): string =>
            s
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;");

          // Parse email address from "Name <email>" or bare "email" format
          const parseEmail = (addr: string): string => {
            const match = addr.match(/<([^>]+)>/);
            return match ? match[1] : addr.trim();
          };

          // Parse display name from "Name <email>" format
          const parseName = (addr: string): string => {
            const match = addr.match(/^([^<]+?)\s*</);
            return match ? match[1].trim().replace(/"/g, "") : "";
          };

          // The introducer is the sender
          const introducerEmail = parseEmail(email.from);
          const introducerName = parseName(email.from) || introducerEmail.split("@")[0];
          const introducerFirst = extractFirstName(introducerName);

          // Other recipients (excluding user and introducer) are the introduced people
          const allRecipients = [
            ...splitAddressList(email.to ?? ""),
            ...splitAddressList(email.cc ?? ""),
          ];
          const introducedEmails = allRecipients.map(parseEmail).filter((e) => {
            const lower = e.toLowerCase();
            return lower !== userEmail && lower !== introducerEmail.toLowerCase();
          });
          // Deduplicate (preserve original casing of first occurrence)
          const seen = new Set<string>();
          const uniqueIntroduced = introducedEmails.filter((e) => {
            const lower = e.toLowerCase();
            if (seen.has(lower)) return false;
            seen.add(lower);
            return true;
          });

          // Build names for the greeting
          const introducedNames = uniqueIntroduced.map((addr) => {
            const original = allRecipients.find(
              (r) => parseEmail(r).toLowerCase() === addr.toLowerCase(),
            );
            const name = original ? parseName(original) : "";
            return name || addr.split("@")[0];
          });
          const introducedFirstNames = introducedNames.map(extractFirstName);
          const greeting =
            introducedFirstNames.length > 2
              ? `Hi ${introducedFirstNames.slice(0, -1).join(", ")} and ${introducedFirstNames[introducedFirstNames.length - 1]}`
              : introducedFirstNames.length === 2
                ? `Hi ${introducedFirstNames.join(" and ")}`
                : introducedFirstNames.length === 1
                  ? `Hi ${introducedFirstNames[0]}`
                  : "Hi";

          const bodyText = `${greeting},\n\nThanks for the intro, ${introducerFirst}! (Moving you to Bcc.)\n\n`;
          const bodyHtml = `<div>${escapeHtml(greeting)},<br><br>Thanks for the intro, ${escapeHtml(introducerFirst)}! (Moving you to Bcc.)<br><br></div>`;

          setViewMode("full");
          openCompose("reply-all", selectedEmailId, {
            bodyHtml,
            bodyText,
            to: uniqueIntroduced,
            cc: [],
            bcc: [introducerEmail],
          });
        },
      },

      // --- Agents ---
      {
        id: "open-agents-sidebar",
        label: "Open Agents Sidebar",
        category: "Agents",
        icon: ICONS.settings,
        execute: () => useAppStore.getState().toggleAgentsSidebar(),
      },
      {
        id: "run-with-agents",
        label: "Run with Selected Agents",
        category: "Agents",
        shortcut: "\u2318J",
        execute: () => useAppStore.getState().setAgentPaletteOpen(true),
      },

      // --- Account switching ---
      ...accounts.map((account) => ({
        id: `switch-account-${account.id}`,
        label: `Switch to ${account.email}`,
        category: "Accounts",
        icon: ICONS.user,
        available: () => account.id !== currentAccountId,
        execute: () => {
          setCurrentAccountId(account.id);
          window.api.sync.getEmails(account.id).then((result: IpcResponse<DashboardEmail[]>) => {
            if (result.success && result.data) {
              const otherEmails = useAppStore
                .getState()
                .emails.filter((e) => e.accountId !== account.id);
              useAppStore.getState().setEmails([...otherEmails, ...result.data]);
            }
          });
          window.api.sync.now(account.id).catch(console.error);
        },
      })),
    ];

    return allActions.filter((a) => a.available === undefined || a.available());
  }, [
    accounts,
    currentAccountId,
    selectedEmailId,
    selectedThreadId,
    viewMode,
    themePreference,
    inboxDensity,
    emails,
    threads,
    openSearch,
    openCompose,
    setShowSettings,
    setViewMode,
    setThemePreference,
    setInboxDensity,
    setCurrentAccountId,
    setSelectedEmailId,
    setSelectedThreadId,
    setShowSnoozeMenu,
  ]);

  // Filter actions by query
  const filteredActions = useMemo(() => {
    if (!query.trim()) return actions;
    return actions.filter((a) => fuzzyMatch(a.label, query) || fuzzyMatch(a.category, query));
  }, [actions, query]);

  // Group filtered actions by category
  const groupedActions = useMemo(() => {
    const groups: { category: string; actions: CommandAction[] }[] = [];
    const categoryOrder = [
      "Navigation",
      "Compose",
      "Email Actions",
      "View",
      "Agents",
      "Settings",
      "Appearance",
      "Accounts",
    ];

    for (const cat of categoryOrder) {
      const catActions = filteredActions.filter((a) => a.category === cat);
      if (catActions.length > 0) {
        groups.push({ category: cat, actions: catActions });
      }
    }
    return groups;
  }, [filteredActions]);

  // Flat list for keyboard navigation
  const flatList = useMemo(() => groupedActions.flatMap((g) => g.actions), [groupedActions]);

  // Reset state when opened/closed
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const executeAction = useCallback(
    (action: CommandAction) => {
      onClose();
      // Small delay to let the palette close before executing
      requestAnimationFrame(() => action.execute());
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, flatList.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (flatList[selectedIndex]) {
            executeAction(flatList[selectedIndex]);
          }
          break;
      }
    },
    [flatList, selectedIndex, executeAction, onClose],
  );

  if (!isOpen) return null;

  // Build a flat index counter for data-index attributes
  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Palette panel */}
      <div className="relative w-full max-w-xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl dark:shadow-black/40 overflow-hidden border border-gray-200 dark:border-gray-700">
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <svg
            className="w-5 h-5 text-gray-400 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 text-base outline-none placeholder-gray-400 dark:text-gray-100 dark:placeholder-gray-500 bg-transparent"
          />
          <kbd className="px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {groupedActions.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              No matching commands
            </div>
          ) : (
            groupedActions.map(({ category, actions: catActions }) => (
              <div key={category}>
                <div className="px-4 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                  {category}
                </div>
                {catActions.map((action) => {
                  const idx = flatIndex++;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={action.id}
                      data-index={idx}
                      onClick={() => executeAction(action)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full px-4 py-2 flex items-center gap-3 text-left text-sm transition-colors ${
                        isSelected
                          ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                          : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      }`}
                    >
                      <ActionIcon path={action.icon} />
                      <span className="flex-1">{action.label}</span>
                      {action.shortcut && (
                        <kbd className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded font-mono text-gray-500 dark:text-gray-400">
                          {action.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <span>
            <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">&uarr;&darr;</kbd>{" "}
            navigate
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Enter</kbd> execute
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
