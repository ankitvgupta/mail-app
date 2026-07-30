import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type OpenCodeServerHandle = {
  url: string;
  close: () => void;
};

export function buildOpenCodeChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  config: unknown,
): NodeJS.ProcessEnv {
  const childEnv = { ...parentEnv };
  delete childEnv.ANTHROPIC_API_KEY;
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(config ?? {});
  return childEnv;
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const stopped = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    if (!stopped.error && stopped.status === 0) return;
  }
  child.kill();
}

export async function launchOpenCodeServer({
  binaryPath,
  config,
  hostname = "127.0.0.1",
  port = 0,
  timeout = 30_000,
}: {
  binaryPath: string;
  config?: unknown;
  hostname?: string;
  port?: number;
  timeout?: number;
}): Promise<OpenCodeServerHandle> {
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
  if (typeof config === "object" && config !== null && "logLevel" in config) {
    const logLevel = config.logLevel;
    if (typeof logLevel === "string" && logLevel) args.push(`--log-level=${logLevel}`);
  }

  const child = spawn(binaryPath, args, {
    env: buildOpenCodeChildEnv(process.env, config),
    windowsHide: true,
  });

  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopChild(child);
      reject(new Error(`Timeout waiting for server to start after ${timeout}ms`));
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        clearTimeout(timer);
        if (match) resolve(match[1]);
        else {
          stopChild(child);
          reject(new Error(`Failed to parse server url from output: ${line}`));
        }
        return;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Server exited with code ${code}${output.trim() ? `\nServer output: ${output}` : ""}`,
        ),
      );
    });
  });

  return { url, close: () => stopChild(child) };
}
