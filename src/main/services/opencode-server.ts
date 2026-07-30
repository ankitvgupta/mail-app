import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

export type OpenCodeServerHandle = {
  url: string;
  close: () => void;
};

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

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
  // Failed kills emit "error". Startup errors have already been handled
  // before shutdown reaches this path, so keep cleanup from becoming fatal.
  const onKillError = (): void => {};
  child.once("error", onKillError);
  if (child.kill()) child.off("error", onKillError);
}

export async function launchOpenCodeServer({
  binaryPath,
  config,
  hostname = "127.0.0.1",
  port = 0,
  timeout = 30_000,
  spawnProcess = spawn,
}: {
  binaryPath: string;
  config?: unknown;
  hostname?: string;
  port?: number;
  timeout?: number;
  spawnProcess?: SpawnProcess;
}): Promise<OpenCodeServerHandle> {
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
  if (typeof config === "object" && config !== null && "logLevel" in config) {
    const logLevel = config.logLevel;
    if (typeof logLevel === "string" && logLevel) args.push(`--log-level=${logLevel}`);
  }

  const child = spawnProcess(binaryPath, args, {
    env: buildOpenCodeChildEnv(process.env, config),
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;

    const diagnostics = (): string => {
      const parts: string[] = [];
      if (stdout.trim()) parts.push(`stdout: ${stdout.trim()}`);
      if (stderr.trim()) parts.push(`stderr: ${stderr.trim()}`);
      return parts.length > 0 ? `\nServer output:\n${parts.join("\n")}` : "";
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (match) {
          finish(() => resolve(match[1]));
        } else {
          finish(() => {
            stopChild(child);
            reject(new Error(`Failed to parse server url from output: ${line}`));
          });
        }
        return;
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onError = (error: Error): void => {
      finish(() => reject(error));
    };
    const onExit = (code: number | null): void => {
      finish(() => reject(new Error(`Server exited with code ${code}${diagnostics()}`)));
    };
    const timer = setTimeout(() => {
      finish(() => {
        stopChild(child);
        reject(new Error(`Timeout waiting for server to start after ${timeout}ms${diagnostics()}`));
      });
    }, timeout);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  let closed = false;
  return {
    url,
    close: () => {
      if (closed) return;
      closed = true;
      stopChild(child);
    },
  };
}
