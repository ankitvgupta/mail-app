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
  priority: z.enum(["high", "medium", "low", "skip"]).optional(),
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

SKIP (no reply needed):
- Newsletters, marketing, promotions
- Automated notifications (GitHub, CI/CD, receipts, shipping, alerts)
- Calendar invites (handled by calendar app)
- CC'd emails where I'm not the primary recipient
- FYI-only messages with no question or action
- Transactional emails (order confirmations, password resets, etc.)
- Social media notifications
- Mailing list digests

HIGH priority:
- Urgent requests with deadlines
- Direct questions from important contacts
- Time-sensitive business decisions

MEDIUM priority:
- Direct questions addressed to me
- Requests requiring my response
- Meeting coordination needing my input
- Business/personal emails expecting a reply
- Action items assigned to me

LOW priority:
- Nice-to-reply but not urgent
- Casual follow-ups
- Informational threads where a brief acknowledgment would be polite`;

// JSON format suffix appended automatically — never shown to the user
export const ANALYSIS_JSON_FORMAT = `

RESPOND WITH ONLY VALID JSON (no markdown, no code blocks):
{
  "needs_reply": true or false,
  "reason": "brief explanation",
  "priority": "high" or "medium" or "low" (only if needs_reply is true)
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

Output ONLY the email body text - no subject line, no "Dear X" if not needed, no signature (I have one set up). Just the reply content.

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
  priorities: z.array(z.enum(["high", "medium", "low"])),
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
};

/** Resolve a model tier to its concrete model ID string. */
export function resolveModelId(tier: ModelTier): string {
  return MODEL_TIER_IDS[tier];
}

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
  theme: z.enum(["light", "dark", "system"]).default("system"),
  inboxDensity: z.enum(["default", "compact"]).default("compact"),
  undoSendDelay: z.number().min(0).max(30).default(5), // seconds; 0 = disabled
  signatures: z.array(SignatureSchema).optional(),
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
  posthog: z
    .object({
      enabled: z.boolean().default(false),
      sessionReplay: z.boolean().default(false),
    })
    .optional(),
  keyboardBindings: z.enum(["superhuman", "gmail"]).default("superhuman"),
  openclaw: z
    .object({
      enabled: z.boolean().default(false),
      gatewayUrl: z.string().default(""),
      gatewayToken: z.string().default(""),
    })
    .optional(),
  configVersion: z.number().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

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
    priority?: "high" | "medium" | "low" | "skip";
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
