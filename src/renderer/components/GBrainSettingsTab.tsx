import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_GBRAIN_CONFIG,
  type Config,
  type GBrainConfig,
  type IpcResponse,
} from "../../shared/types";
import { useAppStore } from "../store";

type ConnectionState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function GBrainSettingsTab() {
  const queryClient = useQueryClient();
  const accounts = useAppStore((state) => state.accounts);
  const [settings, setSettings] = useState<GBrainConfig>(DEFAULT_GBRAIN_CONFIG);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [connection, setConnection] = useState<ConnectionState>({ status: "idle" });
  const settingsInitialized = useRef(false);
  const connectionRequest = useRef(0);

  const {
    data: config,
    isLoading,
    isError: configLoadError,
    isFetchedAfterMount: configFresh,
  } = useQuery({
    queryKey: ["general-config"],
    queryFn: async () => {
      const result = (await window.api.settings.get()) as IpcResponse<Config>;
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (!config || !configFresh || configLoadError || settingsInitialized.current) return;
    settingsInitialized.current = true;
    setSettings({ ...DEFAULT_GBRAIN_CONFIG, ...config.gbrain });
  }, [config, configFresh, configLoadError]);

  useEffect(
    () => () => {
      connectionRequest.current += 1;
    },
    [],
  );

  const update = <Key extends keyof GBrainConfig>(key: Key, value: GBrainConfig[Key]) => {
    connectionRequest.current += 1;
    setSettings((current) => ({ ...current, [key]: value }));
    setSaveMessage("");
    setConnection({ status: "idle" });
  };

  const updateEnabled = (enabled: boolean) => {
    connectionRequest.current += 1;
    setSettings((current) => ({
      ...current,
      enabled,
      accountIds:
        enabled && current.accountIds.length === 0
          ? accounts.filter((account) => account.isConnected).map((account) => account.id)
          : current.accountIds,
    }));
    setSaveMessage("");
    setConnection({ status: "idle" });
  };

  const updateAccount = (accountId: string, included: boolean) => {
    const next = included
      ? [...new Set([...settings.accountIds, accountId])]
      : settings.accountIds.filter((id) => id !== accountId);
    update("accountIds", next);
  };

  const save = async () => {
    if (!configFresh || configLoadError) {
      setSaveMessage("Could not load current settings. Close and reopen Settings to retry.");
      return;
    }
    if (settings.enabled && settings.accountIds.length === 0) {
      setSaveMessage("Select at least one mailbox before enabling GBrain.");
      return;
    }
    setIsSaving(true);
    setSaveMessage("");
    try {
      const result = (await window.api.settings.set({ gbrain: settings })) as IpcResponse<void>;
      if (!result.success) {
        setSaveMessage(result.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["general-config"] });
      setSaveMessage("Saved");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Could not save GBrain settings");
    } finally {
      setIsSaving(false);
    }
  };

  const testConnection = async () => {
    const requestId = ++connectionRequest.current;
    setConnection({ status: "testing" });
    try {
      const result = (await window.api.settings.testGBrain(
        settings.endpoint,
        settings.token,
      )) as IpcResponse<void>;
      if (requestId !== connectionRequest.current) return;
      setConnection(
        result.success
          ? { status: "success", message: "Connected. The read-only recall tool is available." }
          : { status: "error", message: result.error },
      );
    } catch (error) {
      if (requestId !== connectionRequest.current) return;
      setConnection({
        status: "error",
        message: error instanceof Error ? error.message : "Could not connect to GBrain",
      });
    }
  };

  if (isLoading || (!configFresh && !configLoadError)) {
    return (
      <div className="max-w-3xl mx-auto" aria-busy="true">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading personal brain settings…</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid="gbrain-settings">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Personal Brain
        </h3>
        <p className="text-gray-600 dark:text-gray-400">
          Let Exo retrieve relevant people, company, project, and conversation context from your
          GBrain before it writes. GBrain stays separate from Exo Memories.
        </p>
      </div>

      <section className="bg-white dark:bg-gray-800 p-5 rounded-lg border border-gray-200 dark:border-gray-600">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Enable GBrain</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Exo uses read-only recall. It never writes, updates, or deletes GBrain knowledge.
            </p>
          </div>
          <Switch
            checked={settings.enabled}
            onChange={updateEnabled}
            label="Enable GBrain"
            testId="gbrain-enabled"
            disabled={isSaving}
          />
        </div>
      </section>

      <section className="bg-white dark:bg-gray-800 p-5 rounded-lg border border-gray-200 dark:border-gray-600">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">Setup</h3>
        <ol className="mt-4 space-y-4 text-sm text-gray-700 dark:text-gray-300">
          <li className="flex gap-3">
            <StepNumber number={1} />
            <div className="min-w-0 flex-1">
              <p>Start an HTTP server on the computer that hosts GBrain.</p>
              <CodeLine>gbrain serve --http --surface verbs --port 3131 --bind 127.0.0.1</CodeLine>
            </div>
          </li>
          <li className="flex gap-3">
            <StepNumber number={2} />
            <div className="min-w-0 flex-1">
              <p>Create a token restricted to read access.</p>
              <CodeLine>gbrain auth create exo --scopes read</CodeLine>
            </div>
          </li>
          <li className="flex gap-3">
            <StepNumber number={3} />
            <p className="pt-0.5">
              Enter the complete MCP endpoint ending in <code>/mcp</code> and the token below. A
              Tailscale Serve URL also works when the server is reached over your tailnet.
            </p>
          </li>
        </ol>
      </section>

      <section className="bg-white dark:bg-gray-800 p-5 rounded-lg border border-gray-200 dark:border-gray-600 space-y-4">
        <div>
          <label
            htmlFor="gbrain-endpoint"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
          >
            MCP endpoint
          </label>
          <input
            id="gbrain-endpoint"
            data-testid="gbrain-endpoint"
            type="url"
            inputMode="url"
            spellCheck={false}
            value={settings.endpoint}
            onChange={(event) => update("endpoint", event.target.value)}
            disabled={isSaving}
            placeholder="http://127.0.0.1:3131/mcp"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-500 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
            Exo safely adds <code>/mcp</code> when a bare server URL is saved.
          </p>
        </div>

        <div>
          <label
            htmlFor="gbrain-token"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
          >
            Bearer token
          </label>
          <input
            id="gbrain-token"
            data-testid="gbrain-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={settings.token}
            onChange={(event) => update("token", event.target.value)}
            disabled={isSaving}
            placeholder="Read-only GBrain token"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-500 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div className="flex items-start justify-between gap-6 pt-1">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Use in AI drafts</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Enrich replies, new messages, forwards, and refinements. Interactive Agent requests
              use GBrain whenever the integration itself is enabled.
            </p>
          </div>
          <Switch
            checked={settings.includeInDrafts}
            onChange={(checked) => update("includeInDrafts", checked)}
            label="Use GBrain in AI drafts"
            testId="gbrain-use-in-drafts"
            disabled={!settings.enabled || isSaving}
          />
        </div>

        <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Mailboxes</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Choose which mailboxes may send bounded email context to this GBrain. Newly connected
            mailboxes stay off until you select them here.
          </p>
          {accounts.length > 0 ? (
            <div className="mt-3 space-y-2">
              {accounts.map((account) => (
                <label
                  key={account.id}
                  className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                >
                  <input
                    type="checkbox"
                    checked={settings.accountIds.includes(account.id)}
                    onChange={(event) => updateAccount(account.id, event.target.checked)}
                    disabled={!settings.enabled || isSaving || !account.isConnected}
                    data-testid={`gbrain-account-${account.id}`}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span>{account.displayName ? `${account.displayName} — ` : ""}</span>
                  <span>{account.email}</span>
                  {!account.isConnected && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">Disconnected</span>
                  )}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
              Connect an email account before enabling GBrain recall for drafting.
            </p>
          )}
        </div>

        <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 p-3 text-xs text-blue-800 dark:text-blue-300">
          For a selected mailbox, each request sends GBrain the mailbox identity, relevant sender or
          recipients, subject, and a short current-message excerpt or instruction. Exo includes
          matching snippets in its normal AI writing request, keeps at most six, limits their size,
          and marks them as reference data that must never be followed as instructions.
        </div>

        {connection.status === "success" && (
          <p role="status" className="text-sm text-green-700 dark:text-green-400">
            {connection.message}
          </p>
        )}
        {connection.status === "error" && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {connection.message}
          </p>
        )}
        {configLoadError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            Could not load current settings. Saving is disabled so stored GBrain credentials are not
            overwritten. Close and reopen Settings to retry.
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={
              isSaving ||
              !configFresh ||
              configLoadError ||
              (settings.enabled && settings.accountIds.length === 0)
            }
            className="px-4 py-2 bg-blue-600 dark:bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            {isSaving ? "Saving…" : "Save settings"}
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={
              connection.status === "testing" ||
              !settings.endpoint.trim() ||
              !settings.token.trim() ||
              isSaving
            }
            className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors"
          >
            {connection.status === "testing" ? "Testing…" : "Test connection"}
          </button>
          {saveMessage && (
            <span
              role="status"
              className={`text-sm ${saveMessage === "Saved" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
            >
              {saveMessage}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function StepNumber({ number }: { number: number }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/50 text-xs font-semibold text-blue-700 dark:text-blue-300">
      {number}
    </span>
  );
}

function CodeLine({ children }: { children: string }) {
  return (
    <code className="block mt-2 px-3 py-2 rounded-md bg-gray-100 dark:bg-gray-900 text-xs text-gray-800 dark:text-gray-200 overflow-x-auto select-all">
      {children}
    </code>
  );
}

function Switch({
  checked,
  onChange,
  label,
  testId,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-blue-600 dark:bg-blue-500" : "bg-gray-200 dark:bg-gray-700"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}
