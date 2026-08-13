import { randomUUID } from "node:crypto";
import type {
  AgentProvider,
  AgentEvent,
  AgentRunResult,
  NetFetchProxyFn,
  SubAgentToolConfig,
} from "../types";
import type { AgentContext, ScopedAgentEvent } from "../../../shared/agent-types";
import type { ToolDefinition } from "./types";
import { ToolRiskLevel } from "./types";
import { createLogger } from "../../services/logger";

const log = createLogger("sub-agent-tool");

/**
 * Dependencies injected into the sub-agent tool factory.
 * Captured via closure so the tool's execute() can stream events
 * and run the sub-agent provider without polluting ProxyContext.
 */
export interface SubAgentToolDeps {
  provider: AgentProvider;
  toolConfig: SubAgentToolConfig;
  emitToRenderer: (taskId: string, event: ScopedAgentEvent) => void;
  netFetch: NetFetchProxyFn;
  signal: AbortSignal;
  taskId: string;
  context: AgentContext;
  /** The providerId of the orchestrating agent (e.g. "claude") —
   *  nested events are emitted under this ID so they appear in
   *  the correct run in the renderer. */
  parentProviderId: string;
}

/**
 * Result returned by the sub-agent tool to the orchestrating LLM.
 * The `_type` discriminator lets the renderer detect sub-agent results
 * and render the nested event timeline instead of raw JSON.
 */
export interface SubAgentToolResult {
  _type: "sub_agent_result";
  text: string;
  nestedRunId: string;
  conversationId?: string;
}

/**
 * Create a ToolDefinition that wraps an AgentProvider as a callable tool.
 *
 * When executed, the tool:
 * 1. Runs the sub-agent's run() async generator
 * 2. Streams each event to the renderer tagged with `nestedRunId` (for live UI)
 * 3. Collects text output for the orchestrating LLM
 * 4. Returns a SubAgentToolResult with the summary text + nestedRunId
 *
 * The `nestedRunId` links the streamed events to this tool call in the renderer:
 * events with nestedRunId are rendered inside the ToolCallEvent card rather
 * than in the main timeline.
 */
export function createSubAgentTool(
  deps: SubAgentToolDeps,
): ToolDefinition<{ query: string; conversation_id?: string }, SubAgentToolResult> {
  const {
    provider,
    toolConfig,
    emitToRenderer,
    netFetch,
    signal,
    taskId,
    context,
    parentProviderId,
  } = deps;

  // Track conversation ID across multiple calls within the same run
  // so follow-up queries reuse the same conversation automatically
  let lastConversationId: string | undefined;

  return {
    name: toolConfig.name,
    description: toolConfig.description,
    category: "external",
    riskLevel: ToolRiskLevel.NONE,
    inputSchema: toolConfig.inputSchema,
    execute: async (input, _ctx) => {
      const nestedRunId = randomUUID();
      const conversationId = input.conversation_id ?? lastConversationId;

      // Build context for the sub-agent, forwarding conversation ID if available
      const subContext: AgentContext = {
        ...context,
        providerConversationIds: conversationId
          ? { ...context.providerConversationIds, [provider.config.id]: conversationId }
          : context.providerConversationIds,
      };

      const subTaskId = `${taskId}:${nestedRunId}`;
      const gen = provider.run({
        taskId: subTaskId,
        prompt: input.query,
        context: subContext,
        tools: [],
        toolExecutor: async () => {
          throw new Error("Sub-agent tools do not support nested tool execution");
        },
        netFetch,
        // Intentional no-op for nested invocations: the parent run's own
        // session-start row already covers the orchestration session, and
        // adding per-subagent rows would muddy session counts in queries
        // like `caller='agent-session-start:opencode'`. Swap this for the
        // real callback if per-subagent records become useful later.
        recordSessionStart: () => {},
        signal,
      });

      const textParts: string[] = [];
      let eventCount = 0;

      log.info(`[SubAgentTool] Starting ${toolConfig.name} run (nestedRunId=${nestedRunId})`);

      let runResult: AgentRunResult;
      let completed = false;
      try {
        let iterResult: IteratorResult<AgentEvent, AgentRunResult>;
        do {
          iterResult = await gen.next();
          if (iterResult.done) break;

          const event = iterResult.value;
          eventCount++;

          // Emit to renderer for live streaming, tagged with nestedRunId
          // so the renderer nests it inside the parent tool call card
          emitToRenderer(taskId, {
            providerId: parentProviderId,
            sourceProviderId: provider.config.id,
            nestedRunId,
            ...event,
          });

          // Collect text for the LLM's summary
          if (event.type === "text_delta") {
            textParts.push(event.text);
          }
        } while (!iterResult.done);

        runResult = iterResult.value;
        completed = true;
      } finally {
        // Only force-close the generator if it didn't complete normally.
        // Calling gen.return() on a finished generator is a no-op per spec,
        // but skipping it entirely makes the intent clearer.
        if (!completed) {
          try {
            await gen.return({ state: "cancelled" });
          } catch {
            /* ignore secondary errors */
          }
        }
      }

      // Extract conversation ID from the run result for follow-ups
      const resultConversationId = runResult.providerTaskId;
      if (resultConversationId) {
        lastConversationId = resultConversationId;
      }

      log.info(
        `[SubAgentTool] ${toolConfig.name} completed: ${eventCount} events, state=${runResult.state}, text=${textParts.join("").length} chars`,
      );

      // Emit final state for the nested run
      emitToRenderer(taskId, {
        providerId: parentProviderId,
        sourceProviderId: provider.config.id,
        nestedRunId,
        type: "state",
        state: runResult.state,
      });

      return {
        _type: "sub_agent_result",
        text: textParts.join("") || `Sub-agent completed with state: ${runResult.state}`,
        nestedRunId,
        conversationId: resultConversationId,
      };
    },
  };
}
