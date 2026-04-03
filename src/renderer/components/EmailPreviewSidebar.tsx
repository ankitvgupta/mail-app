import { memo, useMemo, useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { useExtensionPanels, ExtensionPanelSlot } from "../extensions";
import { AgentTabContent } from "./AgentPanel";
import type { ScopedAgentEvent } from "../../shared/agent-types";

// SVG icon components for sidebar tabs
function PersonIcon({ active }: { active: boolean }) {
  const cls = active
    ? "text-blue-600 dark:text-blue-400"
    : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300";
  return (
    <svg
      className={`w-4 h-4 ${cls}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
      />
    </svg>
  );
}

function CalendarIcon({ active }: { active: boolean }) {
  const cls = active
    ? "text-blue-600 dark:text-blue-400"
    : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300";
  return (
    <svg
      className={`w-4 h-4 ${cls}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

function AgentIcon({ active }: { active: boolean }) {
  const cls = active
    ? "text-purple-600 dark:text-purple-400"
    : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300";
  return (
    <svg
      className={`w-4 h-4 ${cls}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 14.5M14.25 3.104c.251.023.501.05.75.082M19.8 14.5l-2.425 2.425a2.25 2.25 0 00-.659 1.591v2.234"
      />
    </svg>
  );
}

type SidebarTab = "sender" | "email" | "agent";

const TAB_ICONS: Record<SidebarTab, ({ active }: { active: boolean }) => React.ReactElement> = {
  sender: PersonIcon,
  email: CalendarIcon,
  agent: AgentIcon,
};

const TAB_LABELS: Record<SidebarTab, string> = {
  sender: "Sender",
  email: "Calendar",
  agent: "Agent",
};

// memo: prevents parent (App) re-renders from cascading into the sidebar.
// The sidebar reads all state from Zustand hooks, so parent-triggered re-renders
// are always wasted work — especially expensive when EventTimeline has hundreds of events.
export const EmailPreviewSidebar = memo(function EmailPreviewSidebar() {
  const emails = useAppStore((s) => s.emails);
  const selectedEmailId = useAppStore((s) => s.selectedEmailId);
  const selectedDraftId = useAppStore((s) => s.selectedDraftId);
  const focusedThreadEmailId = useAppStore((s) => s.focusedThreadEmailId);
  const sidebarTab = useAppStore((s) => s.sidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  const availableTabs = useAppStore((s) => s.availableSidebarTabs);
  const setAvailableTabs = useAppStore((s) => s.setAvailableSidebarTabs);
  const globalAgentTaskKey = useAppStore((s) => s.globalAgentTaskKey);
  // Draft task key for agent tab — drafts use `draft:${id}` as their task key
  const draftTaskKey = selectedDraftId ? `draft:${selectedDraftId}` : null;
  const selectedEmail = emails.find((e) => e.id === selectedEmailId);

  // Whether the selected email has a persisted agent trace (even if not yet loaded into memory)
  const hasPersistedTrace = Boolean(selectedEmail?.draft?.agentTaskId);

  // Determine which key to use for the agent tab:
  // - Email selected with its own agent task/trace → use that email's key
  // - Draft selected → use draft:${id} as key
  // - No email/draft selected (inbox view) → use globalAgentTaskKey (Cmd+J results)
  const agentTaskKey = selectedEmailId ? selectedEmailId : (draftTaskKey ?? globalAgentTaskKey);

  const hasAgentTask = useAppStore((s) => {
    if (!agentTaskKey) return false;
    return Boolean(s.agentTasks[agentTaskKey]);
  });

  // Freeze the agent tab's emailId when navigating away from an agent-trace email.
  // Only update the ref when the CURRENT email actually has agent content (task or
  // persisted trace). This prevents the ref from being overwritten during the
  // transitional render where selectedEmailId has changed but the auto-tab-switch
  // effect hasn't fired yet. Using useEffect ensures the ref is only mutated after
  // a committed render, avoiding issues with concurrent mode render retries.
  const frozenAgentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (agentTaskKey && (hasAgentTask || hasPersistedTrace)) {
      frozenAgentKeyRef.current = agentTaskKey;
    }
  }, [agentTaskKey, hasAgentTask, hasPersistedTrace]);
  // Compute eagerly during render when current email has agent content,
  // falling back to the frozen ref only when it doesn't. This avoids a
  // stale-frame bug when navigating between two emails that both have
  // agent tasks (the ref update fires post-render, but nothing would
  // trigger a re-render to pick up the new value).
  const displayAgentKey =
    agentTaskKey && (hasAgentTask || hasPersistedTrace) ? agentTaskKey : frozenAgentKeyRef.current;

  // Agent task existence check for the DISPLAYED key (frozen when hidden)
  const displayHasAgentTask = useAppStore((s) => {
    if (!displayAgentKey) return false;
    return Boolean(s.agentTasks[displayAgentKey]);
  });

  // Persisted trace check for the displayed key
  const displayHasPersistedTrace = useMemo(() => {
    if (!displayAgentKey) return false;
    const email = emails.find((e) => e.id === displayAgentKey);
    return Boolean(email?.draft?.agentTaskId);
  }, [displayAgentKey, emails]);

  // Get all emails in the same thread
  const threadEmails = useMemo(() => {
    if (!selectedEmail) return [];
    return emails
      .filter((e) => e.threadId === selectedEmail.threadId)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [emails, selectedEmail]);

  const latestEmail = threadEmails.length > 0 ? threadEmails[threadEmails.length - 1] : null;

  // For sender-scoped panels, show info about the last person who emailed the user
  const latestReceivedEmail = useMemo(() => {
    for (let i = threadEmails.length - 1; i >= 0; i--) {
      if (!threadEmails[i].labelIds?.includes("SENT")) return threadEmails[i];
    }
    return latestEmail;
  }, [threadEmails, latestEmail]);

  // When an individual email in the thread is focused, use it for the sidebar
  const focusedEmail = useMemo(() => {
    if (!focusedThreadEmailId) return null;
    return threadEmails.find((e) => e.id === focusedThreadEmailId) ?? null;
  }, [focusedThreadEmailId, threadEmails]);

  // The email the sidebar should reflect: focused email takes priority, then
  // falls back to the latest received email (previous default behavior).
  // Skip SENT emails — showing the user's own info in the sidebar isn't useful.
  const contextEmail =
    focusedEmail && !focusedEmail.labelIds?.includes("SENT") ? focusedEmail : latestReceivedEmail;

  // Get extension panels (all scopes)
  const { panels: extensionPanels } = useExtensionPanels(contextEmail, threadEmails);

  // Split panels by scope
  const senderPanels = extensionPanels.filter((p) => (p.panelInfo.scope ?? "sender") === "sender");
  const emailPanels = extensionPanels.filter((p) => p.panelInfo.scope === "email");

  // Update available tabs based on registered panels — agent tab is always available
  useEffect(() => {
    const tabs: SidebarTab[] = [];
    if (senderPanels.length > 0) tabs.push("sender");
    if (emailPanels.length > 0) tabs.push("email");
    tabs.push("agent");
    // Only update if the tabs have actually changed
    const current = availableTabs;
    if (tabs.length !== current.length || tabs.some((t, i) => t !== current[i])) {
      setAvailableTabs(tabs);
    }
  }, [senderPanels.length, emailPanels.length, availableTabs, setAvailableTabs]);

  // Ensure current tab is valid
  useEffect(() => {
    if (!availableTabs.includes(sidebarTab) && availableTabs.length > 0) {
      setSidebarTab(availableTabs[0]);
    }
  }, [availableTabs, sidebarTab, setSidebarTab]);

  // When switching emails (or returning to inbox), auto-select the agent tab
  // if the current key has an agent task/trace, or reset away if it doesn't.
  // Only reacts to key changes — NOT sidebarTab — so the user can freely
  // switch tabs via "b" key.
  const prevEmailKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = agentTaskKey ?? null;
    if (!key || key === prevEmailKeyRef.current) return;
    prevEmailKeyRef.current = key;
    if (hasAgentTask || hasPersistedTrace) {
      setSidebarTab("agent");
    } else if (useAppStore.getState().sidebarTab === "agent") {
      // Only reset away from agent tab — preserve user's manual choice of other tabs
      setSidebarTab(availableTabs.includes("sender") ? "sender" : availableTabs[0]);
    }
  }, [agentTaskKey, hasAgentTask, hasPersistedTrace, setSidebarTab, availableTabs]);

  // Load persisted agent trace from DB when the selected email has a draft
  // with an agentTaskId but no in-memory agent task (e.g. after app restart).
  // Debounced to avoid blocking j/k navigation — traces can be very large
  // (100MB+) and IPC deserialization blocks the main thread.
  const loadedTraceRef = useRef<string | null>(null);
  const replayAgentTrace = useAppStore((s) => s.replayAgentTrace);
  // Derive primitive values so the effect doesn't re-run on every store mutation
  const selectedEmailIdForTrace = selectedEmail?.id;
  const selectedEmailAgentTaskId = selectedEmail?.draft?.agentTaskId;
  useEffect(() => {
    if (!selectedEmailAgentTaskId) return;
    if (hasAgentTask) return; // Already loaded in memory
    const taskId = selectedEmailAgentTaskId;
    // Prevent re-loading the same trace
    if (loadedTraceRef.current === taskId) return;

    const api = window.api as unknown as {
      agent: {
        getTrace: (
          taskId: string,
        ) => Promise<{ success: boolean; data?: { events: ScopedAgentEvent[] } }>;
      };
    };

    // Snapshot email ID before async call — selectedEmail could change if user switches emails
    const emailIdSnapshot = selectedEmailIdForTrace!;

    // Debounce: only load if user stays on this email for 500ms.
    // Agent traces can be 100MB+ and IPC deserialization is synchronous on the main thread.
    const timeoutId = setTimeout(() => {
      api.agent
        .getTrace(taskId)
        .then((result) => {
          if (!result.success || !result.data?.events.length) return;
          // Guard: user may have switched emails during the async IPC call
          if (useAppStore.getState().selectedEmailId !== emailIdSnapshot) return;
          // Mark as loaded only after success — allows retry on failure
          loadedTraceRef.current = taskId;

          // Read fresh email data from the store for the synthetic task
          const email = useAppStore.getState().emails.find((e) => e.id === emailIdSnapshot);
          if (!email) return;

          // Replay entire trace in a single store update (avoids O(n²) from N appendAgentEvent calls)
          replayAgentTrace(
            taskId,
            email.id,
            ["claude"],
            "",
            {
              accountId: email.accountId || "",
              currentEmailId: email.id,
              currentThreadId: email.threadId,
              userEmail: "",
            },
            result.data.events,
          );
        })
        .catch((err: unknown) => {
          console.error("[EmailPreviewSidebar] Failed to load agent trace:", err);
        });
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [selectedEmailIdForTrace, selectedEmailAgentTaskId, hasAgentTask, replayAgentTrace]);

  // No email selected — show agent panel if a draft or global task is active, otherwise empty state
  if (!selectedEmail || !latestEmail) {
    if (agentTaskKey && hasAgentTask) {
      return (
        <div className="w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
          <AgentTabContent emailId={agentTaskKey} />
        </div>
      );
    }
    // Draft is selected but no agent task yet — show prompt hint
    if (selectedDraftId) {
      return (
        <div className="w-80 bg-gray-50 dark:bg-gray-800/50 border-l border-gray-200 dark:border-gray-700 flex items-center justify-center">
          <div className="text-center px-6">
            <p className="text-gray-400 dark:text-gray-500 text-sm">Draft selected</p>
            <p className="text-gray-300 dark:text-gray-500 text-xs mt-1">
              Press{" "}
              <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-400 font-mono text-xs">
                Cmd+J
              </kbd>{" "}
              to ask agent about this draft
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="w-80 bg-gray-50 dark:bg-gray-800/50 border-l border-gray-200 dark:border-gray-700 flex items-center justify-center">
        <div className="text-center px-6">
          <p className="text-gray-400 dark:text-gray-500 text-sm">Select an email to see details</p>
          <p className="text-gray-300 text-xs mt-1">Use j/k to navigate, Cmd+J for agent</p>
        </div>
      </div>
    );
  }

  // Select email based on current tab scope.
  // When an individual thread email is focused, use that for both tabs.
  const sidebarEmail =
    sidebarTab === "sender"
      ? contextEmail || latestEmail
      : focusedEmail || selectedEmail || latestEmail;

  const senderSource = contextEmail || latestEmail;
  const senderMatch = senderSource.from.match(/^([^<]+)/);
  const senderName = senderMatch ? senderMatch[1].trim() : senderSource.from;
  const senderEmail = senderSource.from.match(/<([^>]+)>/)?.[1] || senderSource.from;

  const activePanels = sidebarTab === "sender" ? senderPanels : emailPanels;

  return (
    <div className="w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
      {/* Tab bar — only show when multiple tabs available */}
      {availableTabs.length > 1 && (
        <div className="flex-shrink-0 h-10 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/80">
          <div className="flex h-full">
            {availableTabs.map((tab) => {
              const Icon = TAB_ICONS[tab];
              const isActive = sidebarTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setSidebarTab(tab)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                    isActive
                      ? tab === "agent"
                        ? "text-purple-600 dark:text-purple-400 border-b-2 border-purple-600 dark:border-purple-400 bg-white dark:bg-gray-800"
                        : "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-white dark:bg-gray-800"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                  }`}
                  title={`${TAB_LABELS[tab]} (press b to switch)`}
                >
                  {Icon && <Icon active={isActive} />}
                  <span>{TAB_LABELS[tab]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Agent tab content — kept mounted with FROZEN emailId when hidden.
         When j/k changes selectedEmailId, displayAgentKey stays the same so React
         sees identical props → skips reconciliation of 1000+ EventTimeline nodes.
         Without this, the DOM teardown blocks the main thread for ~1s. */}
      {displayAgentKey && (
        <div
          className="flex-1 flex flex-col overflow-hidden"
          style={{ display: sidebarTab === "agent" ? undefined : "none" }}
        >
          {displayHasAgentTask ? (
            <AgentTabContent emailId={displayAgentKey} />
          ) : displayHasPersistedTrace ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-sm text-gray-400 dark:text-gray-500">
                <div className="animate-spin w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-purple-500 rounded-full mx-auto mb-2" />
                Loading agent trace…
              </div>
            </div>
          ) : (
            <AgentTabContent emailId={displayAgentKey} />
          )}
        </div>
      )}

      {/* Sender / email panels */}
      <div
        className="flex-1 flex flex-col overflow-hidden"
        style={{ display: sidebarTab !== "agent" ? undefined : "none" }}
      >
        {/* Sender header — only in sender tab */}
        {sidebarTab === "sender" && (
          <div className="p-4 border-b border-gray-100 dark:border-gray-700/50 flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-blue-600 dark:text-blue-400 font-semibold text-lg flex-shrink-0">
                {senderName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  data-testid="sidebar-sender-name"
                  className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate"
                >
                  {senderName}
                </p>
                <p
                  data-testid="sidebar-sender-email"
                  className="text-xs text-gray-500 dark:text-gray-400 truncate"
                >
                  {senderEmail}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Extension panels for active tab */}
        <div className="flex-1 overflow-y-auto">
          {activePanels.length > 0 ? (
            activePanels.map((panelData, index) => (
              <ExtensionPanelSlot
                key={`${panelData.panelInfo.extensionId}:${panelData.panelInfo.id}`}
                extensionId={panelData.panelInfo.extensionId}
                panelId={panelData.panelInfo.id}
                title={panelData.panelInfo.title}
                email={sidebarEmail}
                threadEmails={threadEmails}
                enrichment={panelData.enrichment}
                isLoading={panelData.isLoading}
                isFirst={index === 0}
              />
            ))
          ) : (
            <div className="p-4 text-center text-gray-400 dark:text-gray-500 text-sm">
              <p>No additional info available</p>
            </div>
          )}
        </div>
      </div>

      {/* Hint bar — hidden when agent tab is active (it has its own input) */}
      {sidebarTab !== "agent" && (
        <div className="p-3 border-t border-gray-100 dark:border-gray-700/50 bg-gray-50 dark:bg-gray-800/50 flex-shrink-0">
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
            {availableTabs.length > 1 ? (
              <>
                Press{" "}
                <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-400 font-mono">
                  b
                </kbd>{" "}
                to switch tabs
              </>
            ) : (
              <>
                Press{" "}
                <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-400 font-mono">
                  Enter
                </kbd>{" "}
                to read email
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
});
