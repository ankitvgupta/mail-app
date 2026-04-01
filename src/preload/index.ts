/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

// Expose a limited API to the renderer
const api = {
  // Temporary debug logger — renderer → main process stdout
  _debugLog: (msg: string): void => {
    ipcRenderer.send("debug:log", msg);
  },
  // Gmail operations
  gmail: {
    fetchUnread: (maxResults?: number, accountId?: string): Promise<unknown> =>
      ipcRenderer.invoke("gmail:fetch-unread", { maxResults, accountId }),
    createDraft: (
      emailId: string,
      body: string,
      cc?: string[],
      bcc?: string[],
      accountId?: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke("gmail:create-draft", { emailId, body, cc, bcc, accountId }),
    getEmail: (emailId: string): Promise<unknown> =>
      ipcRenderer.invoke("gmail:get-email", { emailId }),
    checkAuth: (): Promise<unknown> => ipcRenderer.invoke("gmail:check-auth"),
    saveCredentials: (clientId: string, clientSecret: string): Promise<unknown> =>
      ipcRenderer.invoke("gmail:save-credentials", { clientId, clientSecret }),
    startOAuth: (): Promise<unknown> => ipcRenderer.invoke("gmail:start-oauth"),
  },

  // Analysis operations
  analysis: {
    analyze: (emailId: string): Promise<unknown> =>
      ipcRenderer.invoke("analysis:analyze", { emailId }),
    analyzeBatch: (emailIds: string[]): Promise<unknown> =>
      ipcRenderer.invoke("analysis:analyze-batch", { emailIds }),
    overridePriority: (
      emailId: string,
      newNeedsReply: boolean,
      newPriority: string | null,
      reason?: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke("analysis:override-priority", {
        emailId,
        newNeedsReply,
        newPriority,
        reason,
      }),
  },

  // Draft operations (for AI-generated reply drafts)
  drafts: {
    save: (
      emailId: string,
      body: string,
      composeMode?: string,
      to?: string[],
      cc?: string[],
      bcc?: string[],
    ): Promise<unknown> =>
      ipcRenderer.invoke("drafts:save", { emailId, body, composeMode, to, cc, bcc }),
    refine: (emailId: string, currentDraft: string, critique: string): Promise<unknown> =>
      ipcRenderer.invoke("drafts:refine", { emailId, currentDraft, critique }),
    rerunAgent: (emailId: string): Promise<unknown> =>
      ipcRenderer.invoke("drafts:rerun-agent", { emailId }),
    rerunAllAgents: (): Promise<unknown> => ipcRenderer.invoke("drafts:rerun-all-agents"),
  },

  // Compose operations (for sending and managing drafts)
  compose: {
    // Send a new message
    send: (options: {
      accountId: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText?: string;
      bodyHtml?: string;
      threadId?: string;
      inReplyTo?: string;
      references?: string;
      attachments?: Array<{
        filename: string;
        path?: string;
        content?: string;
        mimeType: string;
        size?: number;
      }>;
      recipientNames?: Record<string, string>;
    }): Promise<unknown> => ipcRenderer.invoke("compose:send", options),

    // Local drafts (stored in SQLite)
    saveLocalDraft: (draft: {
      accountId: string;
      gmailDraftId?: string;
      threadId?: string;
      inReplyTo?: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyHtml: string;
      bodyText?: string;
      isReply?: boolean;
      isForward?: boolean;
    }): Promise<unknown> => ipcRenderer.invoke("compose:save-local-draft", draft),

    updateLocalDraft: (draftId: string, updates: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke("compose:update-local-draft", { draftId, updates }),

    getLocalDraft: (draftId: string): Promise<unknown> =>
      ipcRenderer.invoke("compose:get-local-draft", { draftId }),

    listLocalDrafts: (accountId?: string): Promise<unknown> =>
      ipcRenderer.invoke("compose:list-local-drafts", { accountId }),

    deleteLocalDraft: (draftId: string): Promise<unknown> =>
      ipcRenderer.invoke("compose:delete-local-draft", { draftId }),

    // Gmail drafts
    saveGmailDraft: (localDraftId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("compose:save-gmail-draft", { localDraftId, accountId }),

    sendGmailDraft: (gmailDraftId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("compose:send-gmail-draft", { gmailDraftId, accountId }),

    listGmailDrafts: (accountId: string, maxResults?: number): Promise<unknown> =>
      ipcRenderer.invoke("compose:list-gmail-drafts", { accountId, maxResults }),

    getGmailDraft: (gmailDraftId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("compose:get-gmail-draft", { gmailDraftId, accountId }),

    deleteGmailDraft: (gmailDraftId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("compose:delete-gmail-draft", { gmailDraftId, accountId }),

    // Reply helpers
    getReplyInfo: (
      emailId: string,
      mode: "new" | "reply" | "reply-all" | "forward",
      accountId: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke("compose:get-reply-info", { emailId, mode, accountId }),
  },

  // Email actions
  emails: {
    archive: (emailId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("emails:archive", { emailId, accountId }),

    batchArchive: (emailIds: string[], accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("emails:batch-archive", { emailIds, accountId }),

    archiveThread: (threadId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("emails:archive-thread", { threadId, accountId }),

    trash: (emailId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("emails:trash", { emailId, accountId }),

    batchTrash: (emailIds: string[], accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("emails:batch-trash", { emailIds, accountId }),

    setStarred: (emailId: string, accountId: string, starred: boolean): Promise<unknown> =>
      ipcRenderer.invoke("emails:set-starred", { emailId, accountId, starred }),

    setRead: (emailId: string, accountId: string, read: boolean): Promise<unknown> =>
      ipcRenderer.invoke("emails:set-read", { emailId, accountId, read }),

    getThread: (threadId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("emails:get-thread", { threadId, accountId }),

    search: (query: string, accountId: string, maxResults?: number): Promise<unknown> =>
      ipcRenderer.invoke("emails:search", { query, accountId, maxResults }),

    searchRemote: (
      query: string,
      accountId: string,
      maxResults?: number,
      pageToken?: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke("emails:search-remote", { query, accountId, maxResults, pageToken }),
  },

  // Style operations
  style: {
    getContext: (toAddress: string): Promise<unknown> =>
      ipcRenderer.invoke("style:get-context", { toAddress }),
  },

  // Contact suggestions (for email autocomplete)
  contacts: {
    suggest: (query: string, limit?: number): Promise<unknown> =>
      ipcRenderer.invoke("contacts:suggest", { query, limit }),
  },

  // Search operations
  search: {
    query: (
      query: string,
      options?: { accountId?: string; limit?: number; offset?: number },
    ): Promise<unknown> => ipcRenderer.invoke("search:query", { query, options }),
    suggestions: (query: string, limit?: number): Promise<unknown> =>
      ipcRenderer.invoke("search:suggestions", { query, limit }),
    rebuildIndex: (): Promise<unknown> => ipcRenderer.invoke("search:rebuild-index"),
  },

  // Settings operations
  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke("settings:get"),
    set: (config: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke("settings:set", config),
    validateApiKey: (apiKey: string): Promise<unknown> =>
      ipcRenderer.invoke("settings:validate-api-key", { apiKey }),
    getPrompts: (): Promise<unknown> => ipcRenderer.invoke("settings:get-prompts"),
    setPrompts: (prompts: {
      analysisPrompt?: string;
      draftPrompt?: string;
      archiveReadyPrompt?: string;
      stylePrompt?: string;
      agentDrafterPrompt?: string;
    }): Promise<unknown> => ipcRenderer.invoke("settings:set-prompts", prompts),
    onPromptsChanged: (callback: (data: unknown) => void): void => {
      ipcRenderer.on("prompts:changed", (_: Electron.IpcRendererEvent, data: unknown) =>
        callback(data),
      );
    },
    removePromptsChangedListener: (): void => {
      ipcRenderer.removeAllListeners("prompts:changed");
    },
    getEA: (): Promise<unknown> => ipcRenderer.invoke("settings:get-ea"),
    setEA: (eaConfig: { enabled: boolean; email?: string; name?: string }): Promise<unknown> =>
      ipcRenderer.invoke("settings:set-ea", eaConfig),
    exportLogs: (): Promise<unknown> => ipcRenderer.invoke("settings:export-logs"),
    validateGithubToken: (token: string): Promise<unknown> =>
      ipcRenderer.invoke("settings:validate-github-token", token),
    testOpenclawConnection: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("settings:test-openclaw-connection") as Promise<{
        success: boolean;
        error?: string;
      }>,
  },

  // Memory operations (persistent AI preferences)
  memory: {
    list: (accountId: string): Promise<unknown> => ipcRenderer.invoke("memory:list", { accountId }),
    getForEmail: (senderEmail: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("memory:get-for-email", { senderEmail, accountId }),
    save: (params: {
      accountId: string;
      scope: string;
      scopeValue?: string | null;
      content: string;
      source?: string;
      sourceEmailId?: string;
    }): Promise<unknown> => ipcRenderer.invoke("memory:save", params),
    update: (
      id: string,
      updates: { content?: string; enabled?: boolean; scope?: string; scopeValue?: string | null },
    ): Promise<unknown> => ipcRenderer.invoke("memory:update", { id, updates }),
    delete: (id: string): Promise<unknown> => ipcRenderer.invoke("memory:delete", { id }),
    categories: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("memory:categories", { accountId }),
    classify: (params: {
      content: string;
      senderEmail: string;
      senderDomain: string;
    }): Promise<unknown> => ipcRenderer.invoke("memory:classify", params),
    onDraftEditLearned: (
      callback: (data: {
        promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
        draftMemoriesCreated: number;
        draftMemoryIds: string[];
      }) => void,
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: {
          promoted: Array<{
            id: string;
            content: string;
            scope: string;
            scopeValue: string | null;
          }>;
          draftMemoriesCreated: number;
          draftMemoryIds: string[];
        },
      ) => callback(data);
      ipcRenderer.on("draft-edit:learned", handler);
      return () => ipcRenderer.removeListener("draft-edit:learned", handler);
    },

    onAnalysisOverrideLearned: (
      callback: (data: {
        promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
        draftMemoriesCreated: number;
      }) => void,
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: {
          promoted: Array<{
            id: string;
            content: string;
            scope: string;
            scopeValue: string | null;
          }>;
          draftMemoriesCreated: number;
        },
      ) => callback(data);
      ipcRenderer.on("analysis-override:learned", handler);
      return () => ipcRenderer.removeListener("analysis-override:learned", handler);
    },

    // Draft memory operations
    draftMemories: {
      list: (accountId: string): Promise<unknown> =>
        ipcRenderer.invoke("draft-memory:list", { accountId }),
      promote: (id: string, accountId: string): Promise<unknown> =>
        ipcRenderer.invoke("draft-memory:promote", { id, accountId }),
      delete: (id: string): Promise<unknown> => ipcRenderer.invoke("draft-memory:delete", { id }),
    },
  },

  // Sender profile operations
  sender: {
    getProfile: (email: string): Promise<unknown> =>
      ipcRenderer.invoke("sender:get-profile", { email }),
    lookup: (from: string, email: string): Promise<unknown> =>
      ipcRenderer.invoke("sender:lookup", { from, email }),
  },

  // Onboarding operations
  onboarding: {
    initialSync: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("onboarding:initial-sync", { accountId }),
    startProcessing: (accountId: string, recentEmailIds: string[]): Promise<unknown> =>
      ipcRenderer.invoke("onboarding:start-processing", { accountId, recentEmailIds }),
  },

  // Account management
  accounts: {
    list: (): Promise<unknown> => ipcRenderer.invoke("accounts:list"),
    add: (accountId?: string): Promise<unknown> =>
      ipcRenderer.invoke("accounts:add", { accountId }),
    remove: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("accounts:remove", { accountId }),
    setPrimary: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("accounts:set-primary", { accountId }),
    cancelAdd: (): Promise<void> => ipcRenderer.invoke("accounts:cancel-add"),
    onAddProgress: (callback: (data: { phase: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { phase: string }) => callback(data);
      ipcRenderer.on("accounts:add-progress", handler);
      return () => ipcRenderer.removeListener("accounts:add-progress", handler);
    },
  },

  // Sync operations
  sync: {
    init: (): Promise<unknown> => ipcRenderer.invoke("sync:init"),
    start: (accountId: string): Promise<unknown> => ipcRenderer.invoke("sync:start", { accountId }),
    stop: (accountId: string): Promise<unknown> => ipcRenderer.invoke("sync:stop", { accountId }),
    now: (accountId: string): Promise<unknown> => ipcRenderer.invoke("sync:now", { accountId }),
    status: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("sync:status", { accountId }),
    setInterval: (intervalMs: number): Promise<unknown> =>
      ipcRenderer.invoke("sync:set-interval", { intervalMs }),
    getEmails: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("sync:get-emails", { accountId }),
    getSentEmails: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("sync:get-sent-emails", { accountId }),
    prefetchBodies: (ids: string[]): Promise<unknown> =>
      ipcRenderer.invoke("sync:prefetch-bodies", { ids }),
    // Event listeners for sync updates
    onNewEmails: (callback: (data: { accountId: string; emails: unknown[] }) => void): void => {
      ipcRenderer.on(
        "sync:new-emails",
        (_: Electron.IpcRendererEvent, data: { accountId: string; emails: unknown[] }) =>
          callback(data),
      );
    },
    onNewSentEmails: (callback: (data: { accountId: string; emails: unknown[] }) => void): void => {
      ipcRenderer.on(
        "sync:new-sent-emails",
        (_: Electron.IpcRendererEvent, data: { accountId: string; emails: unknown[] }) =>
          callback(data),
      );
    },
    onStatusChange: (callback: (data: { accountId: string; status: string }) => void): void => {
      ipcRenderer.on(
        "sync:status-change",
        (_: Electron.IpcRendererEvent, data: { accountId: string; status: string }) =>
          callback(data),
      );
    },
    onEmailsRemoved: (
      callback: (data: { accountId: string; emailIds: string[] }) => void,
    ): void => {
      ipcRenderer.on(
        "sync:emails-removed",
        (_: Electron.IpcRendererEvent, data: { accountId: string; emailIds: string[] }) =>
          callback(data),
      );
    },
    onEmailsUpdated: (
      callback: (data: {
        accountId: string;
        updates: { emailId: string; labelIds: string[] }[];
      }) => void,
    ): void => {
      ipcRenderer.on(
        "sync:emails-updated",
        (
          _: Electron.IpcRendererEvent,
          data: { accountId: string; updates: { emailId: string; labelIds: string[] }[] },
        ) => callback(data),
      );
    },
    onDraftsRemoved: (
      callback: (data: { accountId: string; emailIds: string[] }) => void,
    ): void => {
      ipcRenderer.on(
        "sync:drafts-removed",
        (_: Electron.IpcRendererEvent, data: { accountId: string; emailIds: string[] }) =>
          callback(data),
      );
    },
    onActionFailed: (
      callback: (data: {
        emailId: string;
        accountId: string;
        action: string;
        error: string;
      }) => void,
    ): void => {
      ipcRenderer.on(
        "sync:action-failed",
        (
          _: Electron.IpcRendererEvent,
          data: { emailId: string; accountId: string; action: string; error: string },
        ) => callback(data),
      );
    },
    onActionSucceeded: (
      callback: (data: { emailId: string; accountId: string; action: string }) => void,
    ): void => {
      ipcRenderer.on(
        "sync:action-succeeded",
        (
          _: Electron.IpcRendererEvent,
          data: { emailId: string; accountId: string; action: string },
        ) => callback(data),
      );
    },
    onSyncProgress: (
      callback: (data: { accountId: string; fetched: number; total: number }) => void,
    ): void => {
      ipcRenderer.on(
        "sync:progress",
        (
          _: Electron.IpcRendererEvent,
          data: { accountId: string; fetched: number; total: number },
        ) => callback(data),
      );
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("sync:new-emails");
      ipcRenderer.removeAllListeners("sync:new-sent-emails");
      ipcRenderer.removeAllListeners("sync:status-change");
      ipcRenderer.removeAllListeners("sync:emails-removed");
      ipcRenderer.removeAllListeners("sync:emails-updated");
      ipcRenderer.removeAllListeners("sync:drafts-removed");
      ipcRenderer.removeAllListeners("sync:action-failed");
      ipcRenderer.removeAllListeners("sync:action-succeeded");
      ipcRenderer.removeAllListeners("sync:progress");
    },
  },

  // Prefetch operations (background processing)
  prefetch: {
    status: (): Promise<unknown> => ipcRenderer.invoke("prefetch:status"),
    processAll: (): Promise<unknown> => ipcRenderer.invoke("prefetch:process-all"),
    queueEmails: (emailIds: string[]): Promise<unknown> =>
      ipcRenderer.invoke("prefetch:queue-emails", { emailIds }),
    clear: (): Promise<unknown> => ipcRenderer.invoke("prefetch:clear"),
    onProgress: (callback: (progress: unknown) => void): void => {
      ipcRenderer.on("prefetch:progress", (_: Electron.IpcRendererEvent, progress: unknown) =>
        callback(progress),
      );
    },
    onEmailAnalyzed: (callback: (email: unknown) => void): void => {
      ipcRenderer.on("prefetch:email-analyzed", (_: Electron.IpcRendererEvent, email: unknown) =>
        callback(email),
      );
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("prefetch:progress");
      ipcRenderer.removeAllListeners("prefetch:email-analyzed");
    },
  },

  // Background sync for all-mail (enables local search)
  backgroundSync: {
    onProgress: (
      callback: (progress: {
        accountId: string;
        status: string;
        synced: number;
        total: number;
        error?: string;
      }) => void,
    ): void => {
      ipcRenderer.on(
        "background-sync:progress",
        (
          _: Electron.IpcRendererEvent,
          progress: {
            accountId: string;
            status: string;
            synced: number;
            total: number;
            error?: string;
          },
        ) => callback(progress),
      );
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("background-sync:progress");
    },
  },

  // Inbox splits
  splits: {
    getAll: (): Promise<unknown> => ipcRenderer.invoke("splits:get-all"),
    save: (splits: unknown[]): Promise<unknown> => ipcRenderer.invoke("splits:save", splits),
    create: (split: unknown): Promise<unknown> => ipcRenderer.invoke("splits:create", split),
    update: (id: string, updates: unknown): Promise<unknown> =>
      ipcRenderer.invoke("splits:update", { id, updates }),
    delete: (id: string): Promise<unknown> => ipcRenderer.invoke("splits:delete", { id }),
    discoverSuperhuman: (): Promise<unknown> => ipcRenderer.invoke("splits:discover-superhuman"),
    importFromSuperhuman: (superhumanEmail: string, targetAccountId: string): Promise<unknown> =>
      ipcRenderer.invoke("splits:import-superhuman", { superhumanEmail, targetAccountId }),
  },

  // Theme
  theme: {
    get: (): Promise<unknown> => ipcRenderer.invoke("theme:get"),
    set: (theme: "light" | "dark" | "system"): Promise<unknown> =>
      ipcRenderer.invoke("theme:set", theme),
    onChange: (callback: (data: { preference: string; resolved: string }) => void): void => {
      ipcRenderer.on(
        "theme:changed",
        (_: Electron.IpcRendererEvent, data: { preference: string; resolved: string }) =>
          callback(data),
      );
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("theme:changed");
    },
  },

  // Auth events (token expiry, extension re-auth)
  auth: {
    onTokenExpired: (
      callback: (data: { accountId: string; email: string; source: string }) => void,
    ): void => {
      ipcRenderer.on(
        "auth:token-expired",
        (
          _: Electron.IpcRendererEvent,
          data: { accountId: string; email: string; source: string },
        ) => callback(data),
      );
    },
    onExtensionAuthRequired: (
      callback: (data: { extensionId: string; displayName: string; message?: string }) => void,
    ): void => {
      ipcRenderer.on(
        "auth:extension-auth-required",
        (
          _: Electron.IpcRendererEvent,
          data: { extensionId: string; displayName: string; message?: string },
        ) => callback(data),
      );
    },
    reauth: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("auth:reauth", { accountId }),
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("auth:token-expired");
      ipcRenderer.removeAllListeners("auth:extension-auth-required");
    },
  },

  // Extension system
  extensions: {
    getPanels: (): Promise<unknown> => ipcRenderer.invoke("extensions:get-panels"),
    getEnrichments: (emailId: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:get-enrichments", { emailId }),
    enrichEmail: (emailId: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:enrich-email", { emailId }),
    getSetting: (extensionId: string, key: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:get-setting", { extensionId, key }),
    setSetting: (extensionId: string, key: string, value: unknown): Promise<unknown> =>
      ipcRenderer.invoke("extensions:set-setting", { extensionId, key, value }),
    list: (): Promise<unknown> => ipcRenderer.invoke("extensions:list"),
    authenticate: (extensionId: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:authenticate", { extensionId }),
    getPendingAuths: (): Promise<unknown> => ipcRenderer.invoke("extensions:get-pending-auths"),
    onEnrichmentReady: (
      callback: (data: { emailId: string; enrichment: unknown }) => void,
    ): void => {
      ipcRenderer.on(
        "extensions:enrichment-ready",
        (_: Electron.IpcRendererEvent, data: { emailId: string; enrichment: unknown }) =>
          callback(data),
      );
    },
    // Extension management
    install: (filePath?: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:install", { filePath }),
    uninstall: (extensionId: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:uninstall", { extensionId }),
    listInstalled: (): Promise<unknown> => ipcRenderer.invoke("extensions:list-installed"),
    getRendererBundle: (extensionId: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:get-renderer-bundle", { extensionId }),
    onInstalled: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("extensions:installed", handler);
      return () => {
        ipcRenderer.removeListener("extensions:installed", handler);
      };
    },
    onUninstalled: (callback: (data: { extensionId: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { extensionId: string }) =>
        callback(data);
      ipcRenderer.on("extensions:uninstalled", handler);
      return () => {
        ipcRenderer.removeListener("extensions:uninstalled", handler);
      };
    },
    checkProviderHealth: (providerId: string): Promise<unknown> =>
      ipcRenderer.invoke("extensions:check-provider-health", { providerId }),
    saveProviderSettings: (
      providerId: string,
      settings: Record<string, unknown>,
    ): Promise<unknown> =>
      ipcRenderer.invoke("extensions:save-provider-settings", { providerId, settings }),
    getProviderSettings: (providerId: string, settingIds: string[]): Promise<unknown> =>
      ipcRenderer.invoke("extensions:get-provider-settings", { providerId, settingIds }),
    removeEnrichmentListeners: (): void => {
      ipcRenderer.removeAllListeners("extensions:enrichment-ready");
    },
  },

  // Archive-ready operations
  archiveReady: {
    getThreads: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("archive-ready:get-threads", { accountId }),
    analyzeThread: (threadId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("archive-ready:analyze-thread", { threadId, accountId }),
    scan: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("archive-ready:scan", { accountId }),
    dismiss: (threadId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("archive-ready:dismiss", { threadId, accountId }),
    archiveThread: (threadId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("archive-ready:archive-thread", { threadId, accountId }),
    archiveAll: (accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("archive-ready:archive-all", { accountId }),
    onProgress: (
      callback: (progress: {
        analyzed: number;
        total: number;
        current: string | null;
        done?: boolean;
      }) => void,
    ): void => {
      ipcRenderer.on(
        "archive-ready:progress",
        (
          _: Electron.IpcRendererEvent,
          progress: { analyzed: number; total: number; current: string | null; done?: boolean },
        ) => callback(progress),
      );
    },
    onResult: (
      callback: (data: {
        threadId: string;
        accountId: string;
        isReady: boolean;
        reason: string;
      }) => void,
    ): void => {
      ipcRenderer.on(
        "archive-ready:result",
        (
          _: Electron.IpcRendererEvent,
          data: { threadId: string; accountId: string; isReady: boolean; reason: string },
        ) => callback(data),
      );
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("archive-ready:progress");
      ipcRenderer.removeAllListeners("archive-ready:result");
    },
  },

  // Snooze operations
  snooze: {
    snooze: (
      emailId: string,
      threadId: string,
      accountId: string,
      snoozeUntil: number,
    ): Promise<unknown> =>
      ipcRenderer.invoke("snooze:snooze", { emailId, threadId, accountId, snoozeUntil }),

    unsnooze: (threadId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("snooze:unsnooze", { threadId, accountId }),

    list: (accountId: string): Promise<unknown> => ipcRenderer.invoke("snooze:list", { accountId }),

    get: (threadId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("snooze:get", { threadId, accountId }),

    onUnsnoozed: (callback: (data: { emails: unknown[] }) => void): void => {
      ipcRenderer.on(
        "snooze:unsnoozed",
        (_: Electron.IpcRendererEvent, data: { emails: unknown[] }) => callback(data),
      );
    },
    onSnoozed: (callback: (data: { snoozedEmail: unknown }) => void): void => {
      ipcRenderer.on(
        "snooze:snoozed",
        (_: Electron.IpcRendererEvent, data: { snoozedEmail: unknown }) => callback(data),
      );
    },
    onManuallyUnsnoozed: (
      callback: (data: { threadId: string; accountId: string; snoozeUntil: number }) => void,
    ): void => {
      ipcRenderer.on(
        "snooze:manually-unsnoozed",
        (
          _: Electron.IpcRendererEvent,
          data: { threadId: string; accountId: string; snoozeUntil: number },
        ) => callback(data),
      );
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("snooze:unsnoozed");
      ipcRenderer.removeAllListeners("snooze:snoozed");
      ipcRenderer.removeAllListeners("snooze:manually-unsnoozed");
    },
  },

  // Network status
  network: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke("network:status"),
    updateStatus: (online: boolean): Promise<unknown> =>
      ipcRenderer.invoke("network:update", { online }),
    onOnline: (callback: () => void): void => {
      ipcRenderer.on("network:online", () => callback());
    },
    onOffline: (callback: () => void): void => {
      ipcRenderer.on("network:offline", () => callback());
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("network:online");
      ipcRenderer.removeAllListeners("network:offline");
    },
  },

  // Scheduled send (send later)
  scheduledSend: {
    create: (options: {
      accountId: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText?: string;
      bodyHtml?: string;
      threadId?: string;
      inReplyTo?: string;
      references?: string;
      scheduledAt: number;
      recipientNames?: Record<string, string>;
    }): Promise<unknown> => ipcRenderer.invoke("scheduled-send:create", options),

    list: (accountId?: string): Promise<unknown> =>
      ipcRenderer.invoke("scheduled-send:list", { accountId }),

    cancel: (id: string): Promise<unknown> => ipcRenderer.invoke("scheduled-send:cancel", { id }),

    reschedule: (id: string, scheduledAt: number): Promise<unknown> =>
      ipcRenderer.invoke("scheduled-send:reschedule", { id, scheduledAt }),

    delete: (id: string): Promise<unknown> => ipcRenderer.invoke("scheduled-send:delete", { id }),

    stats: (accountId?: string): Promise<unknown> =>
      ipcRenderer.invoke("scheduled-send:stats", { accountId }),

    onSent: (
      callback: (data: { id: string; gmailId?: string; threadId?: string }) => void,
    ): void => {
      ipcRenderer.on(
        "scheduled-send:sent",
        (_: Electron.IpcRendererEvent, data: { id: string; gmailId?: string; threadId?: string }) =>
          callback(data),
      );
    },

    onFailed: (callback: (data: { id: string; error: string }) => void): void => {
      ipcRenderer.on(
        "scheduled-send:failed",
        (_: Electron.IpcRendererEvent, data: { id: string; error: string }) => callback(data),
      );
    },

    onStatsChanged: (callback: (stats: { scheduled: number; total: number }) => void): void => {
      ipcRenderer.on(
        "scheduled-send:stats-changed",
        (_: Electron.IpcRendererEvent, stats: { scheduled: number; total: number }) =>
          callback(stats),
      );
    },

    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("scheduled-send:sent");
      ipcRenderer.removeAllListeners("scheduled-send:failed");
      ipcRenderer.removeAllListeners("scheduled-send:stats-changed");
    },
  },

  // Calendar (day-view sidebar)
  calendar: {
    getEvents: (date: string): Promise<unknown> =>
      ipcRenderer.invoke("calendar:get-events", { date }),
    checkAccess: (): Promise<unknown> => ipcRenderer.invoke("calendar:check-access"),
    getCalendars: (): Promise<unknown> => ipcRenderer.invoke("calendar:get-calendars"),
    setVisibility: (accountId: string, calendarId: string, visible: boolean): Promise<unknown> =>
      ipcRenderer.invoke("calendar:set-visibility", { accountId, calendarId, visible }),
    onEventsUpdated: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on("calendar:events-updated", handler);
      return () => {
        ipcRenderer.removeListener("calendar:events-updated", handler);
      };
    },
  },

  // Attachment operations
  attachments: {
    download: (
      emailId: string,
      attachmentId: string,
      filename: string,
      accountId: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke("attachments:download", { emailId, attachmentId, filename, accountId }),
    preview: (emailId: string, attachmentId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("attachments:preview", { emailId, attachmentId, accountId }),
    pickFiles: (): Promise<unknown> => ipcRenderer.invoke("attachments:pick-files"),
    getForForward: (emailId: string, accountId: string): Promise<unknown> =>
      ipcRenderer.invoke("attachments:get-for-forward", { emailId, accountId }),
  },

  // Agent framework
  agent: {
    run: (
      taskId: string,
      providerIds: string[],
      prompt: string,
      context: unknown,
    ): Promise<unknown> =>
      ipcRenderer.invoke("agent:run", { taskId, providerIds, prompt, context }),
    cancel: (taskId: string): Promise<unknown> => ipcRenderer.invoke("agent:cancel", { taskId }),
    confirm: (toolCallId: string, approved: boolean): Promise<unknown> =>
      ipcRenderer.invoke("agent:confirm", { toolCallId, approved }),
    providers: (): Promise<unknown> => ipcRenderer.invoke("agent:providers"),
    authenticate: (providerId: string): Promise<unknown> =>
      ipcRenderer.invoke("agent:authenticate", { providerId }),
    getTrace: (taskId: string): Promise<unknown> =>
      ipcRenderer.invoke("agent:get-trace", { taskId }),
    claudeAuthStatus: (): Promise<unknown> => ipcRenderer.invoke("agent:claude-auth-status"),
    claudeLogin: (): Promise<unknown> => ipcRenderer.invoke("agent:claude-login"),
    onEvent: (callback: (data: unknown) => void): void => {
      ipcRenderer.on("agent:event", (_: Electron.IpcRendererEvent, data: unknown) =>
        callback(data),
      );
    },
    onConfirmation: (callback: (data: unknown) => void): void => {
      ipcRenderer.on("agent:confirmation", (_: Electron.IpcRendererEvent, data: unknown) =>
        callback(data),
      );
    },
    onProviders: (callback: (data: unknown) => void): void => {
      ipcRenderer.on("agent:providers", (_: Electron.IpcRendererEvent, data: unknown) =>
        callback(data),
      );
    },
    onDraftSaved: (
      callback: (data: {
        emailId: string;
        draft: {
          body: string;
          status: string;
          createdAt: number;
          composeMode?: string;
          to?: string[];
          cc?: string[];
          bcc?: string[];
        };
      }) => void,
    ): void => {
      ipcRenderer.on(
        "agent:draft-saved",
        (
          _: Electron.IpcRendererEvent,
          data: {
            emailId: string;
            draft: {
              body: string;
              status: string;
              createdAt: number;
              composeMode?: string;
              to?: string[];
              cc?: string[];
              bcc?: string[];
            };
          },
        ) => callback(data),
      );
    },
    onLocalDraftSaved: (callback: (data: { draft: Record<string, unknown> }) => void): void => {
      ipcRenderer.on(
        "agent:local-draft-saved",
        (_: Electron.IpcRendererEvent, data: { draft: Record<string, unknown> }) => callback(data),
      );
    },
    removeDraftSavedListeners: (): void => {
      ipcRenderer.removeAllListeners("agent:draft-saved");
      ipcRenderer.removeAllListeners("agent:local-draft-saved");
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("agent:event");
      ipcRenderer.removeAllListeners("agent:confirmation");
      ipcRenderer.removeAllListeners("agent:providers");
    },
  },

  // Default mail app (mailto: handler)
  defaultMailApp: {
    isDefault: (): Promise<boolean> => ipcRenderer.invoke("default-mail-app:is-default"),
    setDefault: (enable: boolean): Promise<boolean> =>
      ipcRenderer.invoke("default-mail-app:set", enable),
    getPending: (): Promise<{
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      body: string;
    } | null> => ipcRenderer.invoke("default-mail-app:get-pending"),
    onMailtoOpen: (
      callback: (data: {
        to: string[];
        cc: string[];
        bcc: string[];
        subject: string;
        body: string;
      }) => void,
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string },
      ) => callback(data);
      ipcRenderer.on("mailto:open", handler);
      return () => {
        ipcRenderer.off("mailto:open", handler);
      };
    },
  },

  // Auto-updates
  updates: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke("updates:get-status"),
    check: (): Promise<unknown> => ipcRenderer.invoke("updates:check"),
    download: (): Promise<unknown> => ipcRenderer.invoke("updates:download"),
    install: (): Promise<unknown> => ipcRenderer.invoke("updates:install"),
    getVersion: (): Promise<unknown> => ipcRenderer.invoke("updates:get-version"),
    onStatusChanged: (callback: (status: unknown) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on("updates:status-changed", handler);
      return () => {
        ipcRenderer.off("updates:status-changed", handler);
      };
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("updates:status-changed");
    },
  },

  // Outbox (offline message queue)
  outbox: {
    getStats: (accountId?: string): Promise<unknown> =>
      ipcRenderer.invoke("outbox:stats", { accountId }),
    getItems: (accountId?: string): Promise<unknown> =>
      ipcRenderer.invoke("outbox:list", { accountId }),
    getItem: (id: string): Promise<unknown> => ipcRenderer.invoke("outbox:get", { id }),
    retry: (id: string): Promise<unknown> => ipcRenderer.invoke("outbox:retry", { id }),
    remove: (id: string): Promise<unknown> => ipcRenderer.invoke("outbox:remove", { id }),
    process: (): Promise<unknown> => ipcRenderer.invoke("outbox:process"),
    onStatsChanged: (
      callback: (stats: {
        pending: number;
        sending: number;
        failed: number;
        total: number;
      }) => void,
    ): void => {
      ipcRenderer.on(
        "outbox:stats-changed",
        (
          _: Electron.IpcRendererEvent,
          stats: { pending: number; sending: number; failed: number; total: number },
        ) => callback(stats),
      );
    },
    onSent: (
      callback: (data: { id: string; gmailId?: string; threadId?: string }) => void,
    ): void => {
      ipcRenderer.on(
        "outbox:sent",
        (_: Electron.IpcRendererEvent, data: { id: string; gmailId?: string; threadId?: string }) =>
          callback(data),
      );
    },
    onFailed: (
      callback: (data: {
        id: string;
        error: string;
        permanent: boolean;
        retryCount?: number;
      }) => void,
    ): void => {
      ipcRenderer.on(
        "outbox:failed",
        (
          _: Electron.IpcRendererEvent,
          data: { id: string; error: string; permanent: boolean; retryCount?: number },
        ) => callback(data),
      );
    },
    onAuthRequired: (callback: (data: { accountId: string; itemId: string }) => void): void => {
      ipcRenderer.on(
        "outbox:auth-required",
        (_: Electron.IpcRendererEvent, data: { accountId: string; itemId: string }) =>
          callback(data),
      );
    },
    removeAllListeners: (): void => {
      ipcRenderer.removeAllListeners("outbox:stats-changed");
      ipcRenderer.removeAllListeners("outbox:sent");
      ipcRenderer.removeAllListeners("outbox:failed");
      ipcRenderer.removeAllListeners("outbox:auth-required");
    },
  },

  // Usage / cost tracking
  usage: {
    getStats: (): Promise<unknown> => ipcRenderer.invoke("settings:get-usage-stats"),
    getCallHistory: (limit?: number): Promise<unknown> =>
      ipcRenderer.invoke("settings:get-call-history", { limit }),
  },
};

// Expose API to renderer
contextBridge.exposeInMainWorld("api", api);
