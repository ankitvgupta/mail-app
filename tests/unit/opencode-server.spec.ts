import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

import {
  buildOpenCodeChildEnv,
  launchOpenCodeServer,
} from "../../src/main/services/opencode-server";

function createFakeChild() {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killCount = 0;

  Object.defineProperties(child, {
    stdout: { value: stdout },
    stderr: { value: stderr },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
    pid: { value: undefined },
  });
  child.kill = () => {
    killCount += 1;
    return true;
  };

  return { child, stdout, stderr, getKillCount: () => killCount };
}

function launchWithFakeChild(fake: ReturnType<typeof createFakeChild>, timeout = 100) {
  return launchOpenCodeServer({
    binaryPath: "/fake/opencode",
    timeout,
    spawnProcess: () => fake.child,
  });
}

test("OpenCode child env removes Exo's Anthropic key without mutating or dropping safe env", () => {
  const parentEnv = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/Users/test",
    EXO_SAFE_SETTING: "kept",
    ANTHROPIC_API_KEY: "exo-stored-secret",
  };
  const config = { logLevel: "WARN", mcp: { mail: { enabled: true } } };

  const childEnv = buildOpenCodeChildEnv(parentEnv, config);

  expect(childEnv).toEqual({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/Users/test",
    EXO_SAFE_SETTING: "kept",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  });
  expect(parentEnv.ANTHROPIC_API_KEY).toBe("exo-stored-secret");
});

test("parses fragmented stdout even when stderr is interleaved", async () => {
  const fake = createFakeChild();
  const launch = launchWithFakeChild(fake);

  fake.stdout.write("opencode server lis");
  fake.stderr.write("diagnostic warning\n");
  fake.stdout.write("tening on http://127.0.0.1:4321\n");

  const handle = await launch;
  expect(handle.url).toBe("http://127.0.0.1:4321");
  handle.close();
});

test("stops the child when startup times out", async () => {
  const fake = createFakeChild();

  await expect(launchWithFakeChild(fake, 5)).rejects.toThrow(
    "Timeout waiting for server to start after 5ms",
  );
  expect(fake.getKillCount()).toBe(1);
  expect(fake.stdout.listenerCount("data")).toBe(0);
  expect(fake.stderr.listenerCount("data")).toBe(0);
  expect(fake.child.listenerCount("error")).toBe(0);
  expect(fake.child.listenerCount("exit")).toBe(0);
});

test("reports exit-before-ready with separate stdout and stderr diagnostics", async () => {
  const fake = createFakeChild();
  const launch = launchWithFakeChild(fake);
  fake.stdout.write("starting server\n");
  fake.stderr.write("address already in use\n");
  fake.child.exitCode = 23;
  fake.child.emit("exit", 23, null);

  await expect(launch).rejects.toThrow(
    /Server exited with code 23[\s\S]*starting server[\s\S]*address already in use/,
  );
});

test("close is idempotent", async () => {
  const fake = createFakeChild();
  const launch = launchWithFakeChild(fake);
  fake.stdout.write("opencode server listening on http://127.0.0.1:4321\n");
  const handle = await launch;

  handle.close();
  handle.close();

  expect(fake.getKillCount()).toBe(1);
});
