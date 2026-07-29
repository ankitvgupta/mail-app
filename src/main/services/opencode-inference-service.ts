import { randomUUID } from "node:crypto";
import { dirname, delimiter as pathDelimiter } from "node:path";
import type * as OpenCodeV2Client from "@opencode-ai/sdk/v2/client";
import type * as OpenCodeV2Server from "@opencode-ai/sdk/v2/server";

import {
  resolveOpenCodeRoute,
  type OpenCodeModelOption,
} from "../../shared/types";
import { resolveOpencodeBinary } from "../agents/providers/opencode/opencode-agent-provider";
import { createLogger } from "./logger";

const log = createLogger("opencode-inference");

const importDynamic = new Function("s", "return import(s)") as (
  specifier: string,
) => Promise<unknown>;

export type OpenCodeInferenceRequest = {
  selector?: string;
  system?: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type OpenCodeInferenceResult = {
  id: string;
  text: string;
  structured?: unknown;
  providerId: string;
  modelId: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costDollars?: number;
};

type OpenCodeClient = ReturnType<typeof OpenCodeV2Client.createOpencodeClient>;
type OpenCodeClientLike = {
  provider: Pick<OpenCodeClient["provider"], "list">;
  tool: Pick<OpenCodeClient["tool"], "ids">;
  session: Pick<OpenCodeClient["session"], "create" | "prompt" | "delete">;
};

type OpenCodeHandle = {
  client: OpenCodeClientLike;
  close: () => void;
};

export type OpenCodeLauncher = () => Promise<OpenCodeHandle>;

async function launchOpenCode(): Promise<OpenCodeHandle> {
  const binPath = resolveOpencodeBinary();
  if (!binPath) throw new Error("Bundled OpenCode executable was not found");
  const binDir = dirname(binPath);
  const currentPath = process.env.PATH ?? "";
  if (!currentPath.split(pathDelimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${pathDelimiter}${currentPath}`;
  }

  const serverModule = (await importDynamic(
    "@opencode-ai/sdk/v2/server",
  )) as typeof OpenCodeV2Server;
  const clientModule = (await importDynamic(
    "@opencode-ai/sdk/v2/client",
  )) as typeof OpenCodeV2Client;
  const server = await serverModule.createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 30_000,
    config: { logLevel: "WARN" },
  });
  const client = clientModule.createOpencodeClient({ baseUrl: server.url });
  return { client, close: () => server.close() };
}

export class OpenCodeInferenceService {
  private handle: OpenCodeHandle | null = null;
  private startupPromise: Promise<OpenCodeHandle> | null = null;
  private configGeneration = 0;

  constructor(private readonly launcher: OpenCodeLauncher = launchOpenCode) {}

  async listModels(): Promise<OpenCodeModelOption[]> {
    const { client } = await this.ensureHandle();
    return this.listModelsFrom(client);
  }

  async complete(request: OpenCodeInferenceRequest): Promise<OpenCodeInferenceResult> {
    const { client } = await this.ensureHandle();
    const models = await this.listModelsFrom(client);
    const route = resolveOpenCodeRoute(request.selector, models);

    const toolResponse = await client.tool.ids();
    const toolIds = toolResponse.data;
    if (!toolIds) throw new Error("OpenCode tool catalog could not be loaded");
    const tools = Object.fromEntries(toolIds.map((id) => [id, false]));

    const created = await client.session.create({
      title: `exo-feature:${randomUUID()}`,
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    });
    const sessionId = created.data?.id;
    if (!sessionId) throw new Error("OpenCode session.create returned no id");

    let promptError: unknown;
    try {
      const prompted = await client.session.prompt(
        {
          sessionID: sessionId,
          ...(route ? { model: route } : {}),
          system: request.system,
          tools,
          format: request.outputSchema
            ? { type: "json_schema", schema: request.outputSchema }
            : { type: "text" },
          parts: [{ type: "text", text: request.prompt }],
        },
        { signal: request.signal },
      );
      if (!prompted.data) throw new Error("OpenCode session.prompt returned no response");

      const { info, parts } = prompted.data;
      return {
        id: info.id,
        text: parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        ...(info.structured === undefined ? {} : { structured: info.structured }),
        providerId: info.providerID,
        modelId: info.modelID,
        finishReason: info.finish ?? null,
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
        cacheReadTokens: info.tokens.cache.read,
        cacheWriteTokens: info.tokens.cache.write,
        reasoningTokens: info.tokens.reasoning,
        costDollars: info.cost,
      };
    } catch (error) {
      promptError = error;
      throw error;
    } finally {
      try {
        const deleted = await client.session.delete({ sessionID: sessionId });
        if (!deleted.data) throw new Error("OpenCode session.delete failed");
      } catch (cleanupError) {
        if (!promptError) throw cleanupError;
        log.warn(
          `OpenCode session cleanup failed after prompt failure: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      }
    }
  }

  close(): void {
    this.configGeneration += 1;
    const handle = this.handle;
    this.handle = null;
    this.startupPromise = null;
    handle?.close();
  }

  private async listModelsFrom(client: OpenCodeClientLike): Promise<OpenCodeModelOption[]> {
    const response = await client.provider.list();
    if (!response.data) throw new Error("OpenCode provider catalog could not be loaded");

    const connected = new Set(response.data.connected);
    return response.data.all
      .filter((provider) => connected.has(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          modelName: model.name,
        })),
      )
      .sort(
        (left, right) =>
          left.providerName.localeCompare(right.providerName) ||
          left.modelName.localeCompare(right.modelName),
      );
  }

  private ensureHandle(): Promise<OpenCodeHandle> {
    if (this.handle) return Promise.resolve(this.handle);
    if (this.startupPromise) return this.startupPromise;

    const startGeneration = this.configGeneration;
    const startup = this.launcher()
      .then((handle) => {
        if (this.configGeneration !== startGeneration) {
          try {
            handle.close();
          } catch (error) {
            log.warn(
              `Closing stale OpenCode server failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          throw new Error("OpenCode server changed during startup");
        }
        this.handle = handle;
        if (this.startupPromise === startup) this.startupPromise = null;
        return handle;
      })
      .catch((error) => {
        if (this.startupPromise === startup) this.startupPromise = null;
        throw error;
      });
    this.startupPromise = startup;
    return startup;
  }
}

export const openCodeInferenceService = new OpenCodeInferenceService();
