import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { type z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentToolSpec, ToolExecutorFn } from "../../types";
import { createLogger } from "../../../services/logger";

const log = createLogger("opencode-mcp-bridge");

/**
 * In-worker MCP HTTP server that exposes the orchestrator's tool registry to
 * an external agent harness (OpenCode). This is the structural replacement
 * for Claude Agent SDK's `createSdkMcpServer` — Claude's SDK had a clever
 * in-process bridge over the same stdio channel; OpenCode talks to MCP over
 * HTTP only, so we stand up a real (but local) HTTP MCP server inside the
 * worker process.
 *
 * Each request handler delegates to whichever `ToolExecutorFn` the provider
 * has registered for the active run. The active executor is a single shared
 * reference (single-flight assumption) — concurrent runs through one provider
 * would step on each other's executor. This matches OpenClawAgentProvider's
 * shape and the mail-app's typical usage of one active agent at a time. If
 * concurrent runs become a real workload, route by OpenCode session ID via a
 * Map<sessionId, ToolExecutorFn> and thread the ID through a custom MCP URL.
 *
 * Only 127.0.0.1 / ::1 requests are accepted; the listener binds explicitly to
 * 127.0.0.1 so external clients cannot reach the bridge.
 */
export class McpBridge {
  private server: McpServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private http: HttpServer | null = null;
  private url: string | null = null;
  private toolExecutor: ToolExecutorFn | null = null;

  /** Register the executor that subsequent tool calls should delegate to. */
  setExecutor(fn: ToolExecutorFn | null): void {
    this.toolExecutor = fn;
  }

  getUrl(): string {
    if (!this.url) throw new Error("MCP bridge not started");
    return this.url;
  }

  isRunning(): boolean {
    return this.url !== null;
  }

  /**
   * Start the bridge. Registers all `tools` once at startup — the orchestrator's
   * base tool set is static for the worker lifetime; sub-agent tools added per
   * run are not exposed to OpenCode in v1 (matches OpenClaw's scope).
   */
  async start(tools: AgentToolSpec[]): Promise<string> {
    if (this.url) return this.url;

    const mcp = new McpServer({ name: "mail-app-tools", version: "1.0.0" });

    for (const spec of tools) {
      // AgentToolSpec inputSchema is always a Zod object; McpServer wants the shape.
      const zodObject = spec.inputSchema as z.ZodObject<z.ZodRawShape>;
      const zodShape = zodObject.shape;

      mcp.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: zodShape,
        },
        async (args: unknown) => {
          const exec = this.toolExecutor;
          if (!exec) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `No active tool executor; tool "${spec.name}" cannot run.`,
                },
              ],
            };
          }
          try {
            const result = await exec(spec.name, args as Record<string, unknown>);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result),
                },
              ],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Error executing ${spec.name}: ${message}`,
                },
              ],
            };
          }
        },
      );
    }

    const transport = new StreamableHTTPServerTransport({
      // Stateful mode: the MCP SDK generates a session ID per client connection.
      // OpenCode handles session resumption against this transport's session;
      // we don't depend on it ourselves.
      sessionIdGenerator: () => randomUUID(),
    });
    await mcp.connect(transport);

    const http = createServer((req, res) => {
      // Reject anything not from localhost. The listener already binds to
      // 127.0.0.1 so this is defense-in-depth.
      const addr = req.socket.remoteAddress ?? "";
      if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
        res.statusCode = 403;
        res.end();
        return;
      }
      // Only /mcp — keep the surface narrow.
      const url = req.url ?? "";
      const pathname = url.split("?")[0];
      if (pathname !== "/mcp") {
        res.statusCode = 404;
        res.end();
        return;
      }

      // Buffer body so we can hand it to handleRequest pre-parsed; the
      // transport's signature expects a parsed JSON-RPC payload for POSTs.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        let body: unknown = undefined;
        if (bodyStr) {
          try {
            body = JSON.parse(bodyStr);
          } catch {
            // Leave undefined; transport will handle the bad request.
          }
        }
        transport.handleRequest(req, res, body).catch((err: unknown) => {
          log.error({ err }, "MCP request handler failed");
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          }
        });
      });
      req.on("error", (err) => {
        log.error({ err }, "MCP request stream error");
      });
    });

    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });

    const sockAddr = http.address();
    if (!sockAddr || typeof sockAddr === "string") {
      throw new Error("Failed to get MCP bridge socket address");
    }
    this.server = mcp;
    this.transport = transport;
    this.http = http;
    this.url = `http://127.0.0.1:${sockAddr.port}/mcp`;
    log.info(`MCP bridge listening at ${this.url} with ${tools.length} tools`);
    return this.url;
  }

  async close(): Promise<void> {
    if (this.http) {
      const http = this.http;
      await new Promise<void>((resolve) => http.close(() => resolve()));
      this.http = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    if (this.server) {
      // McpServer can hold open handles / internal listeners across the
      // transport it was connected to. close() is best-effort: some SDK
      // versions expose it, others don't (it's optional in the type).
      // Without this, every Settings change leaks an McpServer instance.
      await this.server.close?.();
      this.server = null;
    }
    this.url = null;
    this.toolExecutor = null;
  }
}
