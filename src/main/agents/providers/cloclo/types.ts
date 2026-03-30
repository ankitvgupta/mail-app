/**
 * Cloclo agent provider types.
 *
 * Cloclo CLI (`cloclo -p "..." --json`) returns structured JSON output.
 * These types model both the provider configuration and the CLI output shape.
 */

import { z } from "zod";

// --- Provider configuration (passed from settings) ---

export interface ClocloProviderConfig {
  enabled: boolean;
  /** Override the model used by cloclo (e.g. "claude-sonnet", "gpt-5", "ollama/llama3") */
  model?: string;
  /** Extra CLI flags passed to cloclo */
  extraFlags?: string[];
}

// --- CLI response shape (`cloclo -p "..." --json`) ---

export const ClocloResponseSchema = z.object({
  role: z.string(),
  content: z.string(),
  model: z.string().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }).optional(),
  cost_usd: z.number().optional(),
});

export type ClocloResponse = z.infer<typeof ClocloResponseSchema>;
