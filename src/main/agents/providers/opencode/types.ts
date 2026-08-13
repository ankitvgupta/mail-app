/**
 * OpenCode provider config (subset of AgentFrameworkConfig).
 *
 * Stored under appConfig.providers.opencode and forwarded to the worker
 * by AgentCoordinator. Read by the provider in its constructor and
 * updateConfig().
 */
export interface OpenCodeProviderConfig {
  /** Master enable flag from Settings. */
  enabled: boolean;
  /**
   * Model in `provider/model` form, e.g. `anthropic/claude-sonnet-4-6` or
   * `ollama-cloud/qwen3:32b`. When undefined, falls back to whatever
   * Ollama Cloud or Anthropic routing buildOpencodeConfig() decides.
   */
  model?: string;
}
