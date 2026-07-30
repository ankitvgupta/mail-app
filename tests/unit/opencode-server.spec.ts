import { expect, test } from "@playwright/test";

import { buildOpenCodeChildEnv } from "../../src/main/services/opencode-server";

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
