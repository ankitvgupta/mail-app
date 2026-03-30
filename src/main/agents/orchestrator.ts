import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  AgentEvent,
  AgentFrameworkConfig,
  AgentProvider,
  AgentProviderConfig,
  AgentRunResult,
  ConfirmationDetails,
  OrchestratorDeps,
  ScopedAgentEvent,
  ToolExecutorFn,
} from "./types";
import { AgentProviderRegistry } from "./providers/registry";
import { ClaudeAgentProvider } from "./providers/claude-agent-provider";
import { OpenClawAgentProvider } from "./providers/openclaw/openclaw-agent-provider";
import { ClocloAgentProvider } from "./providers/cloclo/cloclo-agent-provider";
import { PermissionGate } from "./permission-gate";
import type { ToolRegistry } from "./tools/registry";
import type { ProxyContext } from "./tools/types";
import { createSubAgentTool } from "./tools/sub-agent-tool";
import { discoverPrivateProviders } from "./private-providers";

/**
 * AgentOrchestrator runs inside the utility process.
 *
 * It routes user commands to one or more AgentProviders, manages
 * the task lifecycle, and emits scoped events back to the renderer.
 *
 * Constraints:
 * - Multiple tasks may run concurrently (tracked via activeTasks map)
 * - Cancellation is end-to-end and idempotent
 * - All provider events are tagged with providerId before emission
 */
export class AgentOrchestrator {
  private providerRegistry: AgentProviderRegistry;
  private emitToRenderer: (taskId: string, event: ScopedAgentEvent) => void;
  private requestConfirmation: (details: ConfirmationDetails) => void;
  private deps: OrchestratorDeps;
  private config: AgentFrameworkConfig;

  private activeTasks = new Map<string, AbortController>();
  // Scoped by taskId → toolCallId → resolver, so cleanup only affects the finishing task
  private pendingConfirmations = new Map<string, Map<string, (approved: boolean) => void>>();

  // Lazy-initialized tool registry (async import to avoid circular deps)
  private toolRegistry: ToolRegistry | null = null;
  private toolRegistryPromise: Promise<ToolRegistry> | null = null;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.emitToRenderer = deps.emitToRenderer;
    this.requestConfirmation = deps.requestConfirmation;
    this.config = deps.config;

    this.providerRegistry = new AgentProviderRegistry();

    // Register the Claude provider by default
    this.providerRegistry.register(
      new ClaudeAgentProvider(deps.config),
    );

    // Register the OpenClaw provider
    const ocSettings = deps.config.providers?.["openclaw-agent"];
    this.providerRegistry.register(
      new OpenClawAgentProvider({
        enabled: ocSettings?.enabled ?? false,
        gatewayUrl: ocSettings?.gatewayUrl ?? "",
        gatewayToken: ocSettings?.gatewayToken ?? "",
      }),
    );

    // Register the Cloclo provider
    const clocloSettings = deps.config.providers?.["cloclo-agent"];
    this.providerRegistry.register(
      new ClocloAgentProvider({
        enabled: clocloSettings?.enabled ?? false,
        model: clocloSettings?.model,
        extraFlags: clocloSettings?.extraFlags,
      }),
    );

    // Register any auto-discovered private providers
    for (const provider of discoverPrivateProviders(deps.config)) {
      this.providerRegistry.register(provider);
    }
  }

  /** Propagate config changes to all registered providers. */
  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.config = { ...this.config, ...config };
    for (const provider of this.providerRegistry.getAll()) {
      provider.updateConfig?.(config);
    }
  }

  /** Register a dynamically loaded provider (e.g. from an installed .zip package). */
  registerProvider(provider: AgentProvider): void {
    this.providerRegistry.register(provider);
  }

  /** Unregister a dynamically loaded provider. */
  unregisterProvider(id: string): void {
    this.providerRegistry.unregister(id);
  }

  private async getToolRegistry(): Promise<ToolRegistry> {
    if (this.toolRegistry) return this.toolRegistry;
    if (!this.toolRegistryPromise) {
      this.toolRegistryPromise = import("./tools/registry").then(
        (mod) => mod.buildToolRegistry(),
      );
    }
    this.toolRegistry = await this.toolRegistryPromise;
    return this.toolRegistry;
  }

  private buildProxyContext(): ProxyContext {
    return {
      db: this.deps.dbProxy,
      gmail: this.deps.gmailProxy,
    };
  }

  private buildToolExecutor(taskId: string, registry: ToolRegistry, proxyCtx: ProxyContext): ToolExecutorFn {
    const permissionGate = new PermissionGate();

    return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      const tool = registry.get(toolName);
      if (!tool) throw new Error(`Unknown tool: ${toolName}`);

      const decision = permissionGate.checkPermission(tool, args);

      if (decision.action === "confirm" || decision.action === "confirm_preview") {
        const toolCallId = randomUUID();
        const approved = await this.awaitConfirmation(
          taskId,
          toolCallId,
          toolName,
          decision.action === "confirm_preview" ? decision.previewData : args,
          decision.description,
        );
        if (!approved) {
          throw new Error(`Tool "${toolName}" was rejected by user`);
        }
      }

      // Tag proxy requests with taskId so cancellation is scoped
      this.deps.setActiveTaskId(taskId);
      try {
        const parsed = tool.inputSchema.parse(args);
        return await tool.execute(parsed, proxyCtx);
      } finally {
        this.deps.setActiveTaskId(null);
      }
    };
  }

  /**
   * Run a command across one or more providers.
   *
   * Each provider runs in parallel via Promise.all. Events from each
   * provider are tagged with the providerId before being emitted.
   */
  async runCommand(
    taskId: string,
    providerIds: string[],
    prompt: string,
    context: AgentContext,
    modelOverride?: string,
  ): Promise<void> {
    if (providerIds.length === 0) {
      throw new Error("runCommand requires at least one provider ID");
    }

    const providers = providerIds.map((id) => {
      const provider = this.providerRegistry.get(id);
      if (!provider) throw new Error(`Unknown provider: ${id}`);
      return { id, provider };
    });

    const abortController = new AbortController();
    this.activeTasks.set(taskId, abortController);

    // Build tool registry, proxy context, and executor
    const baseRegistry = await this.getToolRegistry();
    const runRegistry = baseRegistry.clone();

    // Detect providers that can serve as sub-agent tools for this run.
    // A provider is eligible if it implements asSubAgentTool(), is not being
    // run directly (not in providerIds), and is currently available.
    const providerIdSet = new Set(providerIds);
    const subAgentGuidance = new Map<string, string>();

    for (const provider of this.providerRegistry.getAll()) {
      if (providerIdSet.has(provider.config.id)) continue;
      const toolConfig = provider.asSubAgentTool?.();
      if (!toolConfig) continue;
      if (!(await provider.isAvailable())) continue;

      const subAgentTool = createSubAgentTool({
        provider,
        toolConfig,
        emitToRenderer: this.emitToRenderer,
        netFetch: this.deps.netFetchProxy,
        signal: abortController.signal,
        taskId,
        context,
        parentProviderId: providerIds[0],
      });
      runRegistry.register(subAgentTool);

      if (toolConfig.systemPromptGuidance) {
        subAgentGuidance.set(toolConfig.name, toolConfig.systemPromptGuidance);
      }
    }

    const proxyCtx = this.buildProxyContext();
    const toolExecutor = this.buildToolExecutor(taskId, runRegistry, proxyCtx);
    const tools = runRegistry.toAgentToolSpecs();

    // Attach systemPromptGuidance to sub-agent tool specs
    for (const tool of tools) {
      const guidance = subAgentGuidance.get(tool.name);
      if (guidance) tool.systemPromptGuidance = guidance;
    }

    try {
      await Promise.all(
        providers.map(async ({ id, provider }) => {
          try {
            const gen = provider.run({
              taskId,
              prompt,
              context,
              tools,
              toolExecutor,
              netFetch: this.deps.netFetchProxy,
              signal: abortController.signal,
              modelOverride,
            });

            let result: IteratorResult<AgentEvent, AgentRunResult>;
            do {
              result = await gen.next();
              if (!result.done) {
                this.emitToRenderer(taskId, { providerId: id, ...result.value });
              }
            } while (!result.done);

            // Emit the final state from the run result
            const runResult = result.value;
            this.emitToRenderer(taskId, {
              providerId: id,
              type: "state",
              state: runResult.state,
              providerConversationId: runResult.providerTaskId,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.emitToRenderer(taskId, {
              providerId: id,
              type: "error",
              message,
            });
            // Ensure a terminal state event is always emitted so the renderer
            // transitions out of "running" even if the provider didn't do it.
            this.emitToRenderer(taskId, {
              providerId: id,
              type: "state",
              state: "failed",
            });
          }
        }),
      );
    } finally {
      this.activeTasks.delete(taskId);
      this.rejectPendingConfirmations(taskId);
    }
  }

  cancel(taskId: string): void {
    const controller = this.activeTasks.get(taskId);
    if (!controller) return;
    controller.abort();
    this.activeTasks.delete(taskId);

    for (const provider of this.providerRegistry.getAll()) {
      provider.cancel(taskId);
    }

    this.rejectPendingConfirmations(taskId);
  }

  resolveConfirmation(toolCallId: string, approved: boolean): void {
    // toolCallIds are UUIDs — globally unique, so search across all tasks
    for (const taskConfirmations of this.pendingConfirmations.values()) {
      const resolve = taskConfirmations.get(toolCallId);
      if (resolve) {
        resolve(approved);
        taskConfirmations.delete(toolCallId);
        return;
      }
    }
  }

  /**
   * Request confirmation from the user for a tool call.
   * Returns a Promise that resolves when the user approves or denies.
   */
  awaitConfirmation(
    taskId: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    description: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.pendingConfirmations.has(taskId)) {
        this.pendingConfirmations.set(taskId, new Map());
      }
      this.pendingConfirmations.get(taskId)!.set(toolCallId, resolve);
      this.emitToRenderer(taskId, {
        type: "confirmation_required",
        toolCallId,
        toolName,
        input,
        description,
      });
      this.requestConfirmation({
        toolCallId,
        toolName,
        input,
        description,
      });
    });
  }

  private rejectPendingConfirmations(taskId: string): void {
    const taskConfirmations = this.pendingConfirmations.get(taskId);
    if (taskConfirmations) {
      for (const resolve of taskConfirmations.values()) {
        resolve(false);
      }
      this.pendingConfirmations.delete(taskId);
    }
  }

  getProviderRegistry(): AgentProviderRegistry {
    return this.providerRegistry;
  }

  async listAvailableProviders(): Promise<AgentProviderConfig[]> {
    return this.providerRegistry.listAvailable();
  }
}
