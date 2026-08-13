import { z } from "zod";
import { type ToolDefinition, ToolRiskLevel } from "./types";
import type { DashboardEmail } from "../../../shared/types";
import { htmlToPlainText } from "../../util/html-to-text";

const analyzeEmail: ToolDefinition<{ emailId: string }> = {
  name: "analyze_email",
  description:
    "Analyze an email to determine if it needs a reply (Priority) or not (Other), with reasoning. Returns cached analysis if available.",
  category: "analysis",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    emailId: z.string().describe("The email ID to analyze"),
  }),
  async execute(input, ctx) {
    const email = (await ctx.db("getEmail", input.emailId)) as DashboardEmail | null;
    if (!email) {
      throw new Error(`Email not found: ${input.emailId}`);
    }
    if (email.analysis) {
      return {
        emailId: input.emailId,
        cached: true,
        ...email.analysis,
      };
    }
    // If no cached analysis, return the email content for the LLM
    // to analyze inline (the orchestrator/provider handles actual Claude calls)
    return {
      emailId: input.emailId,
      cached: false,
      subject: email.subject,
      from: email.from,
      to: email.to,
      date: email.date,
      body: email.body ? htmlToPlainText(email.body) : undefined,
      message: "No cached analysis found. The email content is provided for inline analysis.",
    };
  },
};

const lookupSender: ToolDefinition<{ email: string }> = {
  name: "lookup_sender",
  description:
    "Look up information about an email sender. Returns cached profile if available, otherwise indicates a lookup is needed.",
  category: "analysis",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    email: z.string().describe("The sender's email address to look up"),
  }),
  async execute(input, ctx) {
    const profile = await ctx.db("getSenderProfile", input.email);
    if (profile) {
      return { email: input.email, cached: true, profile };
    }
    return {
      email: input.email,
      cached: false,
      message: "No cached profile found. Use web_search to find information about this sender.",
    };
  },
};

export const tools: ToolDefinition[] = [
  analyzeEmail as ToolDefinition,
  lookupSender as ToolDefinition,
];
