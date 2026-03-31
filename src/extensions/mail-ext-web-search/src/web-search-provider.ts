import { createMessage } from "../../../main/services/anthropic-service";
import type {
  ExtensionContext,
  EnrichmentProvider,
  EnrichmentData,
} from "../../../shared/extension-types";
import type { DashboardEmail } from "../../../shared/types";

// Known reminder/automated service patterns
const REMINDER_SERVICE_PATTERNS = [
  /reminder/i,
  /boomerang/i,
  /snooze/i,
  /followup/i,
  /follow-up/i,
  /scheduled/i,
  /noreply/i,
  /no-reply/i,
  /donotreply/i,
  /notifications?@/i,
  /mailer-daemon/i,
  /postmaster/i,
];

/**
 * Check if an email address looks like a reminder/automated service
 */
function isReminderService(from: string): boolean {
  return REMINDER_SERVICE_PATTERNS.some((pattern) => pattern.test(from));
}

/**
 * Extract sender email from "from" field
 */
function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

/**
 * Extract sender name from "from" field
 */
function extractSenderName(from: string): string {
  const match = from.match(/^([^<]+)/);
  return match ? match[1].trim() : from;
}

/**
 * Build an effective search query for the sender
 */
function buildSearchQuery(name: string, email: string): string {
  const domain = email.split("@")[1];
  const isPersonalEmail = [
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "me.com",
  ].includes(domain);

  if (isPersonalEmail) {
    return `"${name}" linkedin OR professional`;
  }

  const companyName = domain.split(".")[0];
  return `"${name}" ${companyName} linkedin OR professional`;
}

export interface SenderProfileData {
  email: string;
  name: string;
  summary: string;
  linkedinUrl?: string;
  company?: string;
  title?: string;
  lookupAt: number;
  isReminder: boolean;
}

/**
 * Strip citation markup from Claude's web search responses.
 * Citations look like: <cite index="2-1,7-3">text</cite>
 */
function stripCitations(text: string): string {
  return text.replace(/<cite[^>]*>/gi, "").replace(/<\/cite>/gi, "");
}

/**
 * Robustly parse Claude's response into profile data.
 * Handles: raw JSON, markdown-wrapped JSON, partial JSON, or plain text.
 * Always returns a valid Partial<SenderProfileData>.
 */
function parseProfileResponse(
  responseText: string,
  fallbackName: string,
  context: ExtensionContext,
): Partial<SenderProfileData> {
  // Strip citation markup from web search responses before parsing
  const text = stripCitations(responseText).trim();

  // Strategy 1: Try to find and parse JSON from markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (typeof parsed === "object" && parsed !== null) {
        return validateProfileData(parsed, fallbackName);
      }
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 2: Try to find JSON object anywhere in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed === "object" && parsed !== null) {
        return validateProfileData(parsed, fallbackName);
      }
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 3: Try parsing the entire text as JSON
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return validateProfileData(parsed, fallbackName);
    }
  } catch {
    // Continue to fallback
  }

  // Strategy 4: Extract useful info from plain text
  context.logger.warn(`Could not parse JSON from response, using fallback`);

  // Try to extract meaningful sentences for summary
  const cleanText = text
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/[{}"[\]]/g, " ") // Remove JSON characters
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();

  return {
    name: fallbackName,
    summary: cleanText.length > 0 && cleanText.length < 500 ? cleanText : "No information found.",
  };
}

/**
 * Validate and normalize parsed profile data.
 * Ensures all string fields are actually strings and strips any citation markup.
 */
function validateProfileData(
  data: Record<string, unknown>,
  fallbackName: string,
): Partial<SenderProfileData> {
  const getString = (val: unknown): string | undefined => {
    if (typeof val === "string" && val.trim().length > 0) {
      // Strip any citation markup that might be in the value
      return stripCitations(val).trim();
    }
    return undefined;
  };

  return {
    name: getString(data.name) || fallbackName,
    summary: getString(data.summary) || "No information found.",
    title: getString(data.title),
    company: getString(data.company),
    linkedinUrl: getString(data.linkedinUrl) || getString(data.linkedin_url),
  };
}

/**
 * Create the web search enrichment provider
 */
export function createWebSearchProvider(
  context: ExtensionContext,
  getModelId: () => string,
): EnrichmentProvider {
  return {
    id: "sender-lookup",
    panelId: "sender-profile",
    priority: 100,

    canEnrich(email: DashboardEmail): boolean {
      // Skip if the email is from a reminder service with no thread context
      return !isReminderService(email.from);
    },

    async enrich(
      email: DashboardEmail,
      threadEmails: DashboardEmail[],
    ): Promise<EnrichmentData | null> {
      // Determine the real sender (handle reminder services)
      let realSenderEmail = extractSenderEmail(email.from);
      let realSenderFrom = email.from;
      let isReminder = false;

      if (isReminderService(email.from)) {
        isReminder = true;
        // Look for the original sender in the thread
        for (const threadEmail of threadEmails) {
          if (threadEmail.id === email.id) continue;
          if (isReminderService(threadEmail.from)) continue;

          realSenderEmail = extractSenderEmail(threadEmail.from);
          realSenderFrom = threadEmail.from;
          break;
        }

        // If still a reminder service, skip enrichment
        if (isReminderService(realSenderFrom)) {
          return null;
        }
      }

      const senderName = extractSenderName(realSenderFrom);
      context.logger.info(`Looking up sender: ${senderName} (${realSenderEmail})`);

      // Check cache first
      const cacheKey = `profile:${realSenderEmail.toLowerCase()}`;
      const cached = await context.storage.get<SenderProfileData>(cacheKey);
      if (cached) {
        // Check if cache is still valid (7 days)
        const cacheAge = Date.now() - cached.lookupAt;
        if (cacheAge < 7 * 24 * 60 * 60 * 1000) {
          context.logger.debug(`Cache hit for ${realSenderEmail}`);
          return {
            extensionId: "web-search",
            panelId: "sender-profile",
            data: { ...cached, isReminder } as unknown as Record<string, unknown>,
          };
        }
      }

      try {
        // Use Claude with web search to find information
        const searchQuery = buildSearchQuery(senderName, realSenderEmail);

        const response = await createMessage(
          {
            model: getModelId(),
            max_tokens: 200, // Responses are ~100 tokens
            tools: [
              {
                type: "web_search_20250305",
                name: "web_search",
                max_uses: 1, // 1 search is usually enough
              },
            ],
            messages: [
              {
                role: "user",
                content: `I received an email from "${senderName}" with email address "${realSenderEmail}".

Please search the web to find information about who this person is. Look for:
- Their professional role/title
- Their company or organization
- Any relevant background that would help me write a better reply

Search query to start with: ${searchQuery}

After searching, respond with ONLY valid JSON (no markdown):
{
  "name": "Full name",
  "summary": "2-3 sentence summary of who they are",
  "title": "Their job title if found",
  "company": "Their company if found",
  "linkedinUrl": "LinkedIn URL if found"
}

If you can't find specific information, return:
{
  "name": "${senderName}",
  "summary": "No public information found for this person."
}`,
              },
            ],
          },
          { caller: "web-search-sender-lookup" },
        );

        // Extract the text response
        let jsonText = "";
        for (const block of response.content) {
          if (block.type === "text") {
            jsonText += block.text;
          }
        }

        // Parse the JSON response - handle various formats Claude might return
        const profileData = parseProfileResponse(jsonText, senderName, context);

        const profile: SenderProfileData = {
          email: realSenderEmail,
          name: profileData.name || senderName,
          summary: profileData.summary || "No information found.",
          linkedinUrl: profileData.linkedinUrl,
          company: profileData.company,
          title: profileData.title,
          lookupAt: Date.now(),
          isReminder,
        };

        // Cache the result
        await context.storage.set(cacheKey, profile);
        context.logger.info(`Cached profile for ${realSenderEmail}`);

        return {
          extensionId: "web-search",
          panelId: "sender-profile",
          data: profile as unknown as Record<string, unknown>,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        };
      } catch (error) {
        context.logger.error(`Failed to look up ${realSenderEmail}:`, error);
        return null;
      }
    },
  };
}
