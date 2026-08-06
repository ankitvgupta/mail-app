import { z } from "zod";

// Attachment metadata (extracted from Gmail MIME parts)
export const AttachmentMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  attachmentId: z.string().optional(), // Gmail attachment ID for downloading
});

export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

// Email from Gmail API
export const EmailSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  subject: z.string(),
  from: z.string(),
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  date: z.string(),
  body: z.string(),
  snippet: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  attachments: z.array(AttachmentMetaSchema).optional(),
  messageIdHeader: z.string().optional(), // RFC 5322 Message-ID header
  inReplyTo: z.string().optional(), // RFC 5322 In-Reply-To header
});

export type Email = z.infer<typeof EmailSchema>;

// Email search result (lighter weight)
export const EmailSearchResultSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string(),
});

export type EmailSearchResult = z.infer<typeof EmailSearchResultSchema>;

// Analysis result from Claude
export const AnalysisResultSchema = z.object({
  needs_reply: z.boolean(),
  reason: z.string(),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// Draft creation result
export const DraftResultSchema = z.object({
  emailId: z.string(),
  threadId: z.string(),
  subject: z.string(),
  draftBody: z.string(),
  draftId: z.string().optional(),
  created: z.boolean(),
  error: z.string().optional(),
});

export type DraftResult = z.infer<typeof DraftResultSchema>;

// Processing result for a single email
export const ProcessingResultSchema = z.object({
  emailId: z.string(),
  subject: z.string(),
  from: z.string(),
  analysis: AnalysisResultSchema,
  draft: DraftResultSchema.optional(),
});

export type ProcessingResult = z.infer<typeof ProcessingResultSchema>;

// Default prompts
// The user-editable analysis prompt contains only the behavioral rules.
// The JSON output format is appended automatically by EmailAnalyzer.
export const DEFAULT_ANALYSIS_PROMPT = `Analyze this email and decide if it requires a reply from me.

NEEDS REPLY (Priority):
- Direct questions addressed to me
- Requests requiring my response or decision
- Meeting coordination needing my input
- Business/personal emails expecting a reply
- Action items assigned to me
- Anything that requires me to do external work (update a doc, send an invite, etc.)

OTHER (no reply needed):
- Newsletters, marketing, promotions
- Automated notifications (GitHub, CI/CD, receipts, shipping, alerts)
- Calendar invites (handled by calendar app)
- CC'd emails where I'm not the primary recipient
- FYI-only messages with no question or action
- Transactional emails (order confirmations, password resets, etc.)
- Social media notifications
- Mailing list digests`;

// JSON format suffix appended automatically — never shown to the user
export const ANALYSIS_JSON_FORMAT = `

RESPOND WITH ONLY VALID JSON (no markdown, no code blocks):
{
  "needs_reply": true or false,
  "reason": "brief explanation"
}`;

// The user-editable draft prompt contains only the behavioral guidelines.
// The output format instruction is appended automatically by DraftGenerator.
export const DEFAULT_DRAFT_PROMPT = `Draft a reply to this email. Guidelines:
- Be casual and warm — not formal or corporate. Match my natural voice.
- Default to very short replies. Most of my emails are under 20 words.
  - One-word/phrase acks are fine: "done!", "great!", "sounds good!", "yeah sounds good"
  - Typical reply is 1-3 short sentences. Only go longer (4+ sentences) for substantive topics that genuinely require it.
- Skip greetings most of the time. When one fits, use "hey [name]" or "hi [name]" — never "dear" or "hello".
- Use my natural vocabulary: great, yeah, cool, sounds good, happy to, sure, nice, super, awesome, definitely, probably, lmk.
- Use exclamation marks naturally — I use them often to convey warmth, not emphasis.
- Use contractions freely (I'm, don't, won't, I'd, it's, that's, let's, etc.).
- Occasional casual abbreviations are fine: fyi, btw, bc, idk, np.
- I mostly capitalize normally (including "I"), but sometimes start messages lowercase especially for very casual/short replies.
- For introductions: use the pattern "[name] - meet [name], [context]. [name] - meet [name], [context]. I'll let you take it from here."

If the email requires a decision or action that I must take personally (like reviewing a document, approving something, or making a choice between options), note "[REVIEW NEEDED: brief reason]" at the very start of the draft.`;

// Output format suffix appended automatically — never shown to the user
export const DRAFT_FORMAT_SUFFIX = `

Output ONLY the email body text - no subject line, no "Dear X" if not needed, no signature (I have one set up). Just the reply content. Do NOT include any signature like "--Sent by Exo" or "Sent from Exo" — the app appends its own signature automatically.

FORMATTING: Write plain text paragraphs separated by blank lines. Do NOT use HTML tags of any kind (<p>, <br>, <div>, <b>, <i>, <ul>, <ol>, etc.). For bold, wrap text in double asterisks like **bold text**. For italic, wrap text in single asterisks like *italic text*. For bullet lists, use lines starting with "- ". For numbered lists, use "1. ", "2. ", etc. The email client converts plain text structure to rich formatting automatically.`;

export const DEFAULT_CALENDARING_PROMPT = `Analyze if this email involves scheduling or calendar coordination.

RESPOND WITH ONLY VALID JSON:
{
  "hasSchedulingContext": true or false,
  "action": "defer_to_ea" or "suggest_times" or "none",
  "reason": "brief explanation"
}

Scheduling indicators:
- Requests for meetings, calls, appointments
- Questions about availability
- Scheduling language ("let's find a time", "when are you free")

IMPORTANT: Default to "defer_to_ea" for ANY scheduling unless:
- Simple yes/no to an already-proposed time
- Sender explicitly asked for direct availability`;

export const DEFAULT_STYLE_PROMPT = `I write informally, especially in replies. Short sentences, lowercase greetings, minimal sign-offs.
Don't mimic the examples exactly — use them to calibrate tone and formality for this person.`;

export const DEFAULT_EA_DEFERRAL_TEMPLATE = `I've copied my assistant {{EA_NAME}} ({{EA_EMAIL}}) who can help coordinate scheduling. They have access to my calendar and will find a time that works for everyone.`;

// Default prompt for agent-mode auto-drafting. The agent has access to tools like
// getEmail, searchEmails, getEmailsByThread, getSenderProfile, and generateDraft.
export const DEFAULT_AGENT_DRAFTER_PROMPT = `You are an email drafting assistant. Research the sender and conversation context, then generate a well-informed reply draft.

Steps:
1. Read the email thread to understand the full conversation context
2. Look up the sender's profile to understand who they are
3. Search for prior email conversations with this sender if it would help provide better context
4. Call generateDraft with any additional context you gathered as instructions

Pass relevant research findings to generateDraft in the instructions parameter — for example, who the sender is, their role, and any important history. Keep research proportional to the email's complexity: a simple question doesn't need extensive background research.`;

// The user-editable archive-ready prompt contains only the behavioral rules.
// The JSON output format is appended automatically by ArchiveReadyAnalyzer.
export const DEFAULT_ARCHIVE_READY_PROMPT = `Analyze this email thread and determine if the conversation is "done" and ready to be archived.

A conversation is READY TO ARCHIVE when:
- The user was the last to reply and didn't ask a question or request further action
- Someone sent a "thanks", acknowledgment, or confirmation (conversation naturally concluded)
- It's a notification, newsletter, or automated email with no action needed
- A meeting/event was confirmed and no further coordination is needed
- An FYI or announcement that's been read
- The thread contains only the user's sent reply with no pending response expected
- All action items have been addressed or delegated

A conversation is NOT ready to archive when:
- Someone asked the user a direct question that hasn't been answered
- There's a pending action item or deadline the user hasn't addressed
- The user is waiting for a response they need
- There's an ongoing back-and-forth that hasn't concluded
- A decision is still pending

Be conservative - if unsure, mark as NOT ready to archive.`;

// JSON format suffix appended automatically — never shown to the user
export const ARCHIVE_READY_JSON_FORMAT = `

RESPOND WITH ONLY VALID JSON (no markdown, no code blocks):
{
  "archive_ready": true or false,
  "reason": "brief explanation"
}`;

// Archive-ready analysis result
export const ArchiveReadyResultSchema = z.object({
  archive_ready: z.boolean(),
  reason: z.string(),
});

export type ArchiveReadyResult = z.infer<typeof ArchiveReadyResultSchema>;

// EA (Executive Assistant) configuration
export const EAConfigSchema = z.object({
  enabled: z.boolean(),
  email: z.string().optional(),
  name: z.string().optional(),
});

export type EAConfig = z.infer<typeof EAConfigSchema>;

// Calendaring analysis result
export const CalendaringResultSchema = z.object({
  hasSchedulingContext: z.boolean(),
  action: z.enum(["defer_to_ea", "suggest_times", "none"]),
  reason: z.string(),
  eaDeferralLanguage: z.string().optional(),
});

export type CalendaringResult = z.infer<typeof CalendaringResultSchema>;

// Generated draft response (includes CC and calendaring info)
export const GeneratedDraftResponseSchema = z.object({
  body: z.string(),
  subject: z.string().optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  calendaringResult: CalendaringResultSchema.optional(),
});

export type GeneratedDraftResponse = z.infer<typeof GeneratedDraftResponseSchema>;

// Auto-draft configuration
export const AutoDraftConfigSchema = z.object({
  enabled: z.boolean(),
});

export type AutoDraftConfig = z.infer<typeof AutoDraftConfigSchema>;

// Theme preference
export type ThemePreference = "light" | "dark" | "system";

// Inbox density levels
export type InboxDensity = "default" | "compact";

// Email signature
export const SignatureSchema = z.object({
  id: z.string(),
  name: z.string(),
  bodyHtml: z.string(),
  isDefault: z.boolean(),
  accountId: z.string().optional(),
});

export type Signature = z.infer<typeof SignatureSchema>;

// Custom MCP server configuration — supports stdio, http, and sse transports.
// Shape mirrors the Claude Agent SDK's McpServerConfig union type.
const McpStdioConfigSchema = z.object({
  type: z.literal("stdio").optional(), // default transport when omitted
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpHttpConfigSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpSseConfigSchema = z.object({
  type: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerConfigSchema = z
  .discriminatedUnion("type", [
    McpHttpConfigSchema,
    McpSseConfigSchema,
    // stdio has type as optional, so it can't be in the discriminated union directly.
    // We handle it as a fallback below.
  ])
  .or(McpStdioConfigSchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const CliToolConfigSchema = z.object({
  command: z.string().min(1),
  instructions: z.string().default(""),
});
export type CliToolConfig = z.infer<typeof CliToolConfigSchema>;

// AI model tiers — user-facing names mapped to specific model IDs
export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
export const ModelTierSchema = z.enum(["haiku", "sonnet", "opus"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

// Centralized mapping from tier to model ID. Update these when new model versions ship.
// Note: sonnet maps to 4.5 (not the legacy 4.0 default) — this is an intentional upgrade.
// Opus uses the non-date-stamped alias because no pinned snapshot is available yet for 4.6.
// Pin to a date-stamped ID (e.g. "claude-opus-4-6-YYYYMMDD") once Anthropic publishes one.
export const MODEL_TIER_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
};

// Display labels for the UI
export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  haiku: "Haiku (fast, lightweight)",
  sonnet: "Sonnet (balanced)",
  opus: "Opus (most capable)",
};

// Per-feature model configuration
export const ModelConfigSchema = z.object({
  analysis: ModelTierSchema.default("sonnet"),
  drafts: ModelTierSchema.default("sonnet"),
  refinement: ModelTierSchema.default("sonnet"),
  calendaring: ModelTierSchema.default("sonnet"),
  archiveReady: ModelTierSchema.default("sonnet"),
  senderLookup: ModelTierSchema.default("haiku"),
  agentDrafter: ModelTierSchema.default("sonnet"),
  agentChat: ModelTierSchema.default("opus"),
  // styleInference defaults to opus because the task (analyzing 100 sent
  // emails to extract a writing style) benefits from a more capable model
  // and runs rarely (once per recipient profile build, then cached).
  styleInference: ModelTierSchema.default("opus"),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  analysis: "sonnet",
  drafts: "sonnet",
  refinement: "sonnet",
  calendaring: "sonnet",
  archiveReady: "sonnet",
  senderLookup: "haiku",
  agentDrafter: "sonnet",
  agentChat: "opus",
  styleInference: "opus",
};

/** Resolve a model tier to its concrete model ID string. */
export function resolveModelId(tier: ModelTier): string {
  return MODEL_TIER_IDS[tier];
}

// LLM Provider types — supports routing features to different backends
export const LLM_PROVIDERS = ["anthropic", "ollama-cloud"] as const;
export const LlmProviderSchema = z.enum(["anthropic", "ollama-cloud"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

// Search backends for sender lookup. "anthropic" uses Claude's built-in
// web_search tool (search + extraction in one LLM call). "exa" hits Exa's
// /search REST endpoint and then sends the results to the configured
// senderLookup LLM for extraction — which means the parsing LLM can be
// any provider (Anthropic or Ollama Cloud), unlike the bundled path.
export const SENDER_LOOKUP_PROVIDERS = ["anthropic", "exa"] as const;
export const SenderLookupProviderSchema = z.enum(["anthropic", "exa"]);
export type SenderLookupProvider = z.infer<typeof SenderLookupProviderSchema>;

/**
 * Default Ollama Cloud model when none is configured.
 *
 * glm-5.2:cloud (z.ai, 744B MoE, 1M context). Chosen after a 16-task
 * agent-sidebar benchmark against kimi-k2.7-code:cloud: GLM 5.2 was
 * consistently the faster model at parity final-answer quality (both clearly
 * beat the prior kimi-k2.6 default). Reasoning is returned in proper
 * `thinking` blocks on Ollama's Anthropic-compat endpoint (the agent path),
 * so chain-of-thought does not leak into drafts; non-agent features use the
 * native /api/chat path with think:true, which likewise keeps CoT out of
 * parsed JSON. Note: GLM emits brief inter-turn progress text in agent loops
 * (visible as status lines in the sidebar) — suppressible via the agent
 * system prompt if undesired.
 *
 * Note: cloud models may occasionally return overloaded_error during peak
 * traffic — llm-service.ts retry logic catches this via Anthropic.APIError
 * status 529 (rate_limit category) and backs off automatically.
 */
export const DEFAULT_OLLAMA_MODEL = "glm-5.2:cloud";

/**
 * Curated list of common Ollama Cloud models for the settings dropdown, so
 * users don't have to hand-type model ids. The first entry is the default
 * (glm-5.2:cloud — kept in sync with DEFAULT_OLLAMA_MODEL). This is a
 * convenience list, NOT an allowlist — new models ship on Ollama Cloud
 * regularly, so the UI also offers a "Custom…" escape hatch for any other id.
 * Ids use the ":cloud" tag to match how the app addresses Ollama Cloud models
 * (see DEFAULT_OLLAMA_MODEL); each was confirmed to resolve against
 * https://ollama.com/v1.
 */
export const COMMON_OLLAMA_MODELS: readonly { id: string; label: string }[] = [
  { id: "glm-5.2:cloud", label: "GLM 5.2 — z.ai (default)" },
  { id: "minimax-m3:cloud", label: "MiniMax M3 — newest, agentic" },
  { id: "minimax-m2.7:cloud", label: "MiniMax M2.7" },
  { id: "kimi-k2.6:cloud", label: "Kimi K2.6 — Moonshot" },
  { id: "kimi-k2-thinking:cloud", label: "Kimi K2 Thinking" },
  { id: "qwen3-coder:480b-cloud", label: "Qwen3 Coder 480B" },
  { id: "deepseek-v3.2:cloud", label: "DeepSeek V3.2" },
] as const;

export const OllamaCloudConfigSchema = z.object({
  apiKey: z.string().default(""),
  defaultModel: z.string().default(DEFAULT_OLLAMA_MODEL),
  featureModels: z.record(z.string(), z.string()).optional(),
});

/** Default Hostler harness. Single source of truth for the zod default below,
 *  the provider's fallback, the settings-IPC deep-merge fallback, and the
 *  Extensions card — renderer-safe (same pattern as DEFAULT_OLLAMA_MODEL). */
export const DEFAULT_HOSTLER_HARNESS = "opencode";

// Config schema
export const ConfigSchema = z.object({
  maxEmails: z.number().default(50),
  // Legacy field — no longer drives any AI calls. All features now use modelConfig
  // via getModelIdForFeature(). Kept in the schema so existing config files parse without error.
  model: z.string().default("claude-sonnet-4-20250514"),
  modelConfig: ModelConfigSchema.optional(),
  dryRun: z.boolean().default(false),
  anthropicApiKey: z.string().optional(),
  analysisPrompt: z.string().default(DEFAULT_ANALYSIS_PROMPT),
  draftPrompt: z.string().default(DEFAULT_DRAFT_PROMPT),
  ea: EAConfigSchema.optional(),
  calendaringPrompt: z.string().optional(),
  archiveReadyPrompt: z.string().optional(),
  autoDraft: AutoDraftConfigSchema.optional(),
  agentDrafterPrompt: z.string().optional(),
  enableSenderLookup: z.boolean().default(true),
  // Search backend for sender lookup. Default "anthropic" (Claude web_search
  // tool) preserves existing behavior; users can switch to Exa to use a
  // dedicated search API + a configurable parsing model (which can be Ollama).
  senderLookupProvider: SenderLookupProviderSchema.default("anthropic"),
  // Exa API key. Only consulted when senderLookupProvider === "exa".
  exaApiKey: z.string().optional(),
  syncDraftsToGmail: z.boolean().default(false),
  theme: z.enum(["light", "dark", "system"]).default("system"),
  inboxDensity: z.enum(["default", "compact"]).default("compact"),
  undoSendDelay: z.number().min(0).max(30).default(5), // seconds; 0 = disabled
  sendAndArchive: z.boolean().default(false),
  signatures: z.array(SignatureSchema).optional(),
  showExoBranding: z.boolean().default(true),
  stylePrompt: z.string().optional(),
  githubToken: z.string().optional(),
  allowPrereleaseUpdates: z.boolean().optional(),
  agentBrowser: z
    .object({
      enabled: z.boolean().default(false),
      chromeDebugPort: z.number().default(9222),
      chromeProfilePath: z.string().optional(),
    })
    .optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  cliTools: z.array(CliToolConfigSchema).optional(),
  extraPathDirs: z.array(z.string()).optional(),
  // Defaults intentionally not declared here: ConfigSchema is only used for
  // type inference + validation. Runtime defaults are applied in getConfig()
  // because they depend on configVersion (legacy installs opt out, fresh
  // installs opt in).
  posthog: z
    .object({
      enabled: z.boolean(),
      sessionReplay: z.boolean(),
    })
    .optional(),
  keyboardBindings: z.enum(["superhuman", "gmail"]).default("superhuman"),
  // Persists the last-selected inbox view across restarts.
  //   string id  → that specific account
  //   null       → unified "All Inboxes" view
  //   undefined  → first run; renderer falls back to primary account
  lastSelectedAccountId: z.string().nullable().optional(),
  openclaw: z
    .object({
      enabled: z.boolean().default(false),
      gatewayUrl: z.string().default(""),
      gatewayToken: z.string().default(""),
    })
    .optional(),
  // OpenCode provider settings — experimental open-source agent harness
  // alternative to the Claude Agent SDK. Disabled by default; users opt in
  // via Settings → AI / Agents. When enabled, the worker registers an
  // OpenCodeAgentProvider that spawns the local `opencode` binary on first run.
  opencode: z
    .object({
      enabled: z.boolean().default(false),
      // Optional override; empty = use whatever the framework's Ollama or
      // Anthropic resolution produces. Stored as "provider/model" or just the
      // model name — see OpenCodeAgentProvider.resolveModel().
      model: z.string().optional(),
    })
    .optional(),
  // Hostler provider settings — hosted cloud agent backend (hostler.dev).
  // The agent harness runs in a Hostler sandbox; tool calls still execute
  // locally in the app via Hostler's client-tools loop. Disabled by default;
  // users opt in via Settings → Extensions with a Hostler API key.
  hostler: z
    .object({
      enabled: z.boolean().default(false),
      apiKey: z.string().default(""),
      // Which agent harness runs in the sandbox. Hostler hosts "pi",
      // "opencode", and "codex" (July 2026); kept free-text so new harnesses
      // work without an app update — unknown ones fail fast with a 400 that
      // lists the supported set.
      harness: z.string().default(DEFAULT_HOSTLER_HARNESS),
      // "provider/model" (e.g. "openai/kimi-k2.5") or a bare model id, which
      // pairs with "anthropic". Blank uses glm-5.2 from Hostler's brokered
      // catalog (GET /v1/models) — the same model family as the app's own
      // Ollama Cloud default.
      model: z.string().optional(),
      // Dev/test escape hatch (e.g. scripts/mock-hostler-server.mjs); no UI,
      // and the settings IPC only accepts loopback values (see settings.ipc).
      // Every request carries the Bearer API key and tool results carry email
      // content, so anything non-loopback must at least be https.
      baseUrl: z
        .string()
        .refine(
          (value) => {
            if (value === "") return true;
            try {
              const url = new URL(value);
              return (
                url.protocol === "https:" ||
                url.hostname === "127.0.0.1" ||
                url.hostname === "localhost" ||
                url.hostname === "[::1]"
              );
            } catch {
              return false;
            }
          },
          { message: "hostler.baseUrl must be a valid https:// URL (or a local loopback URL)" },
        )
        .optional(),
    })
    .optional(),
  // Which agent provider runs background auto-draft tasks — the agent that
  // fires on every new email needing a reply, plus the "Regenerate draft"
  // rerun path. "claude" (default), "opencode", or "hostler" today; kept
  // free-text so future providers work without a schema change. Resolution
  // (including fallback when the chosen provider is disabled) happens in
  // resolveBackgroundAgentProviderId below.
  backgroundAgentProvider: z.string().optional(),
  ollamaCloud: OllamaCloudConfigSchema.optional(),
  featureProviders: z.record(z.string(), LlmProviderSchema).optional(),
  configVersion: z.number().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Resolve the Ollama Cloud config the agent framework should use, or `undefined`
 * if Ollama isn't configured for the agent. Two independent conditions must hold:
 *  1. The user has actually configured an Ollama API key.
 *  2. featureProviders.agentChat === "ollama-cloud" (per-feature opt-in — having
 *     a key alone isn't enough, the user may want agent on Anthropic while routing
 *     other features to Ollama).
 *
 * Both `agent-coordinator.spawnWorker` (initial config at boot) and
 * `settings:set` (config changes at runtime) call this so the rules stay in sync.
 */
export function resolveAgentOllamaConfig(
  cfg: Pick<Config, "ollamaCloud" | "featureProviders">,
): { enabled: true; apiKey: string; model: string } | undefined {
  const oc = cfg.ollamaCloud;
  // The agent worker is a single shared subprocess pointed at one URL via env
  // vars at spawn time. Both agentChat (sidebar chat) and agentDrafter (auto-
  // draft background tasks) flow through it. We can't satisfy two different
  // destinations simultaneously, so require BOTH features to opt into Ollama
  // before routing the worker there. Mismatched configs default to Anthropic
  // — better than silently sending Claude model names to ollama.com (404) or
  // Ollama model names to api.anthropic.com (invalid_model).
  const agentChatProvider = cfg.featureProviders?.agentChat ?? "anthropic";
  const agentDrafterProvider = cfg.featureProviders?.agentDrafter ?? "anthropic";
  const bothOllama =
    agentChatProvider === "ollama-cloud" && agentDrafterProvider === "ollama-cloud";
  if (!oc?.apiKey || !bothOllama) return undefined;
  return {
    enabled: true,
    apiKey: oc.apiKey,
    // Use agentDrafter's per-feature model since the coordinator's `model` field
    // is also derived from agentDrafter — keeps the env-var remap and the
    // explicit query() model param in sync.
    model: oc.featureModels?.agentDrafter ?? oc.defaultModel ?? DEFAULT_OLLAMA_MODEL,
  };
}

/** Provider id used for background auto-drafts when nothing else is configured. */
export const DEFAULT_BACKGROUND_AGENT_PROVIDER = "claude";

/**
 * Resolve which agent provider runs background auto-draft tasks (the agent
 * that fires on every new email needing a reply, and the "Regenerate draft"
 * rerun path).
 *
 * Falls back to "claude" when the configured provider's config-level gates
 * aren't met — mirroring each provider's isAvailable() check, which runs in
 * the agent worker where the main process can't call it. Without the
 * fallback, disabling e.g. Hostler while it's selected would make every
 * background draft fail until the user also updated this setting.
 *
 * Unknown provider ids (e.g. an installed provider) pass through unchanged:
 * we can't know their config gates here, and the orchestrator fails
 * explicitly for unregistered ids.
 */
export function resolveBackgroundAgentProviderId(
  cfg: Pick<Config, "backgroundAgentProvider" | "opencode" | "hostler" | "openclaw">,
): string {
  // `||` (not `??`) so an empty string in a hand-edited config counts as
  // unset instead of reaching the orchestrator as an unknown provider id.
  const requested = cfg.backgroundAgentProvider || DEFAULT_BACKGROUND_AGENT_PROVIDER;
  if (requested === "opencode" && !cfg.opencode?.enabled) {
    return DEFAULT_BACKGROUND_AGENT_PROVIDER;
  }
  if (requested === "hostler" && !(cfg.hostler?.enabled && cfg.hostler.apiKey)) {
    return DEFAULT_BACKGROUND_AGENT_PROVIDER;
  }
  if (requested === "openclaw-agent" && !(cfg.openclaw?.enabled && cfg.openclaw.gatewayUrl)) {
    return DEFAULT_BACKGROUND_AGENT_PROVIDER;
  }
  return requested;
}

/** Agent runtimes selectable for background drafts besides the built-in Claude agent. */
export const EXTERNAL_AGENT_RUNTIMES = ["opencode", "hostler"] as const;

/**
 * Whether selecting `id` as the background agent provider would actually take
 * effect, derived from the same resolver that routes background drafts — so
 * UI enablement can't drift from runtime fallback behavior.
 */
export function isAgentRuntimeAvailable(
  id: string,
  cfg: Pick<Config, "opencode" | "hostler" | "openclaw">,
): boolean {
  return resolveBackgroundAgentProviderId({ ...cfg, backgroundAgentProvider: id }) === id;
}

/**
 * Interpret a selection from the Agent Drafter provider dropdown, which mixes
 * agent runtimes (EXTERNAL_AGENT_RUNTIMES) with LLM providers for the built-in
 * Claude runtime (LLM_PROVIDERS). Picking a runtime routes background drafts
 * there and leaves the Claude-runtime model choice untouched; picking an LLM
 * provider returns the runtime to the built-in Claude agent and selects its
 * model source. Returns null for values that are neither, so unknown option
 * values are an explicit no-op rather than a silent misroute.
 */
export function applyAgentDrafterSelection(
  selected: string,
): { backgroundAgentProvider: string; agentDrafterProvider?: LlmProvider } | null {
  if ((EXTERNAL_AGENT_RUNTIMES as readonly string[]).includes(selected)) {
    return { backgroundAgentProvider: selected };
  }
  const llmParse = LlmProviderSchema.safeParse(selected);
  if (llmParse.success) {
    return {
      backgroundAgentProvider: DEFAULT_BACKGROUND_AGENT_PROVIDER,
      agentDrafterProvider: llmParse.data,
    };
  }
  return null;
}

// Dashboard-specific types

// Email with analysis and draft status for the UI
export type DashboardEmail = {
  id: string;
  threadId: string;
  accountId?: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  date: string;
  body?: string;
  snippet?: string;
  labelIds?: string[]; // Gmail labels like "SENT", "INBOX", etc.
  isUnread?: boolean;
  attachments?: AttachmentMeta[];
  messageId?: string; // RFC 5322 Message-ID header
  inReplyTo?: string; // RFC 5322 In-Reply-To header
  analysis?: {
    needsReply: boolean;
    reason: string;
    analyzedAt: number;
  };
  draft?: {
    body: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    gmailDraftId?: string;
    status: "pending" | "created" | "edited";
    createdAt: number;
    composeMode?: "reply" | "reply-all" | "forward";
    calendaringResult?: CalendaringResult;
    agentTaskId?: string; // Links to agent_conversation_mirror for trace retrieval
  };
};

// Sent email for style learning
export type SentEmail = {
  id: string;
  toAddress: string;
  subject: string;
  body: string;
  date: string;
};

// ==============================================
// Compose & Send Types
// ==============================================

// Gmail draft from the API
export const GmailDraftSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  body: z.string(),
  snippet: z.string().optional(),
});

export type GmailDraft = z.infer<typeof GmailDraftSchema>;

// Attachment for composing/sending (file path or buffer)
export type ComposeAttachment = {
  filename: string;
  mimeType: string;
  path?: string; // local file path
  content?: string; // base64-encoded content (for forwarded attachments)
  size?: number;
};

// Gmail send-as alias (cached from Gmail settings)
export type SendAsAlias = {
  email: string;
  displayName?: string;
  isDefault: boolean;
  replyToAddress?: string;
};

// Options for composing a message (used internally)
export type ComposeMessageOptions = {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: ComposeAttachment[];
  /** Map of lowercase email → display name, used to format MIME addresses as "Name <email>" */
  recipientNames?: Record<string, string>;
  /** True when this is a forward, so reply-specific side effects (mark-as-read, reanalysis) are skipped */
  isForward?: boolean;
};

// Options for sending a message (IPC)
export type SendMessageOptions = ComposeMessageOptions;

// Result from sending a message
export type SendMessageResult = {
  id: string;
  threadId: string;
  queued?: boolean; // true if message was queued for offline sending
};

// Local draft stored in SQLite
export const LocalDraftSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  gmailDraftId: z.string().optional(),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  bodyHtml: z.string(),
  bodyText: z.string().optional(),
  fromAddress: z.string().optional(),
  isReply: z.boolean().default(false),
  isForward: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
  syncedAt: z.number().optional(),
});

export type LocalDraft = z.infer<typeof LocalDraftSchema>;

// Compose mode for the UI
export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

// Compose request from UI
export type ComposeRequest = {
  mode: ComposeMode;
  accountId: string;
  replyToEmailId?: string;
  draftId?: string;
};

// Reply info extracted from an email
export type ReplyInfo = {
  to: string[];
  cc: string[];
  subject: string;
  threadId: string;
  inReplyTo: string;
  references: string;
  quotedBody: string; // Full Gmail-format quoted HTML for sending
  originalBody: string; // Raw original email HTML for display in compose
  attribution: string; // "On [date], [person] wrote:" or forward header
  forwardedAttachments?: AttachmentMeta[]; // Original attachments when forwarding
};

// Style sample extracted from sent emails
export type StyleSample = {
  id: number;
  sentEmailId: string;
  context: "business" | "casual" | "technical";
  characteristics: string[];
  samplePhrases: string[];
};

// Correspondent profile for style learning (per-recipient formality)
export type CorrespondentProfile = {
  email: string;
  accountId: string;
  displayName: string | null;
  emailCount: number;
  avgWordCount: number;
  dominantGreeting: string; // "hey" | "hi" | "hello" | "dear" | "none"
  dominantSignoff: string; // "thanks" | "best" | "cheers" | "regards" | "none"
  formalityScore: number; // 0.0 → 1.0
  lastComputedAt: number;
};

// Agent memory (persistent preference for draft generation)
export const MemoryScopeSchema = z.enum(["global", "person", "domain", "category"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemorySourceSchema = z.enum([
  "manual",
  "refinement",
  "draft-edit",
  "priority-override",
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemoryTypeSchema = z.enum(["drafting", "analysis"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemorySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: MemoryScopeSchema,
  scopeValue: z.string().nullable(),
  content: z.string(),
  source: MemorySourceSchema,
  sourceEmailId: z.string().nullable().optional(),
  enabled: z.boolean(),
  memoryType: MemoryTypeSchema.default("drafting"),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Memory = z.infer<typeof MemorySchema>;

// Draft memory (low-confidence observation, promoted to Memory after repeated confirmation)
export const DraftMemorySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: MemoryScopeSchema,
  scopeValue: z.string().nullable(),
  content: z.string(),
  voteCount: z.number(),
  sourceEmailIds: z.array(z.string()),
  // Context about where this observation came from (for understanding scope)
  senderEmail: z.string().nullable(),
  senderDomain: z.string().nullable(),
  subject: z.string().nullable(),
  emailContext: z.string().nullable(), // Brief description of what the email was about
  memoryType: MemoryTypeSchema.default("drafting"),
  createdAt: z.number(),
  lastVotedAt: z.number(),
});
export type DraftMemory = z.infer<typeof DraftMemorySchema>;

// Contact suggestion for email autocomplete
export type ContactSuggestion = {
  email: string;
  name: string;
  frequency: number;
};

// ==============================================
// Snippets (reusable text blocks for composing)
export const SnippetSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string().min(1),
  body: z.string(), // HTML content
  shortcut: z.string().optional(), // trigger text (e.g. "thanks")
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Snippet = z.infer<typeof SnippetSchema>;

// Inbox Splits (filtered inbox sections)
// ==============================================

// Condition types:
// - "from": matches sender email/name (supports wildcards like *@company.com)
// - "to": matches recipient email/name (supports wildcards)
// - "subject": matches subject line (supports wildcards)
// - "label": matches Gmail label ID exactly
export const SplitConditionSchema = z.object({
  type: z.enum(["from", "to", "subject", "label", "has_attachment"]),
  value: z.string(),
  negate: z.boolean().optional(),
});

export type SplitCondition = z.infer<typeof SplitConditionSchema>;

export const InboxSplitSchema = z.object({
  id: z.string(),
  accountId: z.string(), // Splits are per-account
  name: z.string(),
  icon: z.string().optional(),
  conditions: z.array(SplitConditionSchema),
  conditionLogic: z.enum(["and", "or"]),
  order: z.number(),
  exclusive: z.boolean().optional(), // If true, matching emails are hidden from "All" inbox
});

export type InboxSplit = z.infer<typeof InboxSplitSchema>;

// IPC channel types
export type IpcChannels = {
  // Gmail operations
  "gmail:fetch-unread": { maxResults?: number; accountId?: string };
  "gmail:create-draft": {
    emailId: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    accountId?: string;
  };
  "gmail:get-email": { emailId: string };

  // Analysis operations
  "analysis:analyze": { emailId: string };
  "analysis:analyze-batch": { emailIds: string[] };

  // Draft operations
  "drafts:generate": { emailId: string };
  "drafts:save": { emailId: string; body: string };
  "drafts:refine": { emailId: string; currentDraft: string; critique: string };

  // Style operations
  "style:get-context": { toAddress: string };
  "style:infer": void;

  // Settings operations
  "settings:get": void;
  "settings:set": Partial<Config>;
  "settings:get-prompts": void;
  "settings:set-prompts": { analysisPrompt?: string; draftPrompt?: string; stylePrompt?: string };
  "settings:get-ea": void;
  "settings:set-ea": EAConfig;
};

// IPC response wrapper
export type IpcResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; cancelled?: boolean };

// ============================================
// Onboarding Types
// ============================================

export interface OnboardingSyncResult {
  accountId: string;
  email: string;
  totalSynced: number;
  /** Total emails in Gmail's INBOX label (may be larger than totalSynced) */
  totalInboxCount: number;
  oldMarked: number;
  recentCount: number;
  recentEmailIds: string[];
}

// ============================================
// Outbox Types (for offline sending)
// ============================================

export type OutboxStatus = "pending" | "sending" | "sent" | "failed";
export type OutboxType = "send" | "reply";

export type OutboxStats = {
  pending: number;
  sending: number;
  failed: number;
  total: number;
};

export type OutboxItem = {
  id: string;
  accountId: string;
  type: OutboxType;
  threadId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  status: OutboxStatus;
  errorMessage?: string;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
};

// ============================================
// Snooze Types
// ============================================

export type SnoozedEmail = {
  id: string;
  emailId: string;
  threadId: string;
  accountId: string;
  snoozeUntil: number; // Unix timestamp (ms)
  snoozedAt: number; // Unix timestamp (ms)
};

// ==============================================
// Scheduled Send Types
// ==============================================

export type ScheduledMessageStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export type ScheduledMessage = {
  id: string;
  accountId: string;
  type: "send" | "reply";
  threadId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  scheduledAt: number; // Unix timestamp in ms
  status: ScheduledMessageStatus;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
};

export type ScheduledMessageStats = {
  scheduled: number;
  total: number;
};

// Blocked sender (mirrors a Gmail filter that routes a sender to Spam)
export type BlockedSender = {
  senderEmail: string;
  accountId: string;
  gmailFilterId: string | null;
  blockedAt: number;
};

// App state for Zustand
export type AppState = {
  emails: DashboardEmail[];
  selectedEmailId: string | null;
  isLoading: boolean;
  isAnalyzing: boolean;
  error: string | null;
  showSkipped: boolean;

  // Actions
  setEmails: (emails: DashboardEmail[]) => void;
  setSelectedEmailId: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setAnalyzing: (analyzing: boolean) => void;
  setError: (error: string | null) => void;
  setShowSkipped: (show: boolean) => void;
  updateEmail: (id: string, updates: Partial<DashboardEmail>) => void;
};
