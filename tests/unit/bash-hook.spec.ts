/**
 * Unit tests for the Bash PreToolUse hook in ClaudeAgentProvider.
 *
 * The hook uses an allowlist to gate which CLI commands the agent may run.
 * These tests verify that the allowlist approach closes bypass vectors that
 * the previous blocklist approach missed (subshells, brace expansion, etc.)
 * while still permitting legitimate CLI tool invocations.
 */
import { test, expect } from "@playwright/test";
import { buildBashPreToolUseHook } from "../../src/main/agents/providers/bash-hook";
import type { CliToolConfig } from "../../src/shared/types";

// Helper: build a hook for a given set of allowed commands and invoke it.
async function invoke(
  allowedCommands: string[],
  command: string,
): Promise<"allow" | "deny"> {
  const cliTools: CliToolConfig[] = allowedCommands.map((cmd) => ({
    command: cmd,
    instructions: "",
  }));
  const hookConfig = buildBashPreToolUseHook(cliTools);
  if (!hookConfig) throw new Error("expected hook to be non-null");
  const hook = hookConfig.hooks[0];
  const result = await hook({ tool_input: { command } } as Record<string, unknown>);
  const decision = (result as Record<string, unknown>).hookSpecificOutput as {
    permissionDecision: "allow" | "deny";
  };
  return decision.permissionDecision;
}

test.describe("buildBashPreToolUseHook", () => {
  test("returns null when no CLI tools are configured", () => {
    expect(buildBashPreToolUseHook([])).toBeNull();
  });

  test("returns null when all CLI tool commands are blank", () => {
    const tools: CliToolConfig[] = [{ command: "  ", instructions: "" }];
    expect(buildBashPreToolUseHook(tools)).toBeNull();
  });

  test("hook matcher targets Bash", () => {
    const config = buildBashPreToolUseHook([{ command: "git", instructions: "" }]);
    expect(config?.matcher).toBe("Bash");
  });

  // --- Legitimate commands ---

  test("allows configured command with no arguments", async () => {
    expect(await invoke(["git"], "git status")).toBe("allow");
  });

  test("allows command with flags and paths", async () => {
    expect(await invoke(["ls"], "ls -la /tmp/my_dir")).toBe("allow");
  });

  test("allows command with colon in script name", async () => {
    expect(await invoke(["npm"], "npm run test:unit")).toBe("allow");
  });

  test("allows command with equals-style options", async () => {
    expect(await invoke(["npm"], "npm install --save-exact=true")).toBe("allow");
  });

  test("allows command with quoted argument", async () => {
    expect(await invoke(["git"], 'git commit -m "fix: correct off-by-one"')).toBe("allow");
  });

  test("allows command with @ in argument (e.g. npm scope)", async () => {
    expect(await invoke(["npm"], "npm install @scope/package")).toBe("allow");
  });

  test("allows command with tilde path", async () => {
    expect(await invoke(["ls"], "ls ~/Documents")).toBe("allow");
  });

  test("allows command with colon (e.g. npm script name)", async () => {
    expect(await invoke(["npm"], "npm run test:e2e")).toBe("allow");
  });

  test("allows full-path command when base name is in allowlist", async () => {
    expect(await invoke(["git"], "/usr/bin/git status")).toBe("allow");
  });

  // --- Command not in allowlist ---

  test("denies a command whose base name is not in the allowed list", async () => {
    expect(await invoke(["git"], "rm -rf /")).toBe("deny");
  });

  test("denies an empty command string", async () => {
    expect(await invoke(["git"], "")).toBe("deny");
  });

  test("denies a whitespace-only command string", async () => {
    expect(await invoke(["git"], "   ")).toBe("deny");
  });

  // --- Blocklist bypass vectors now caught by the allowlist ---

  test("denies semicolon-chained commands", async () => {
    expect(await invoke(["git"], "git status; rm -rf /")).toBe("deny");
  });

  test("denies AND-chained commands", async () => {
    expect(await invoke(["git"], "git status && rm -rf /")).toBe("deny");
  });

  test("denies pipe to another command", async () => {
    expect(await invoke(["git"], "git log | cat /etc/passwd")).toBe("deny");
  });

  test("denies output redirection", async () => {
    expect(await invoke(["git"], "git status > /etc/crontab")).toBe("deny");
  });

  test("denies input redirection", async () => {
    expect(await invoke(["git"], "git status < /etc/passwd")).toBe("deny");
  });

  test("denies backtick command substitution", async () => {
    expect(await invoke(["git"], "git `rm -rf /`")).toBe("deny");
  });

  test("denies $() command substitution", async () => {
    expect(await invoke(["git"], 'git commit -m "$(cat /etc/passwd)"')).toBe("deny");
  });

  test("denies subshell via parentheses", async () => {
    expect(await invoke(["git"], "(rm -rf /)")).toBe("deny");
  });

  test("denies brace expansion", async () => {
    // {rm,-rf,/} expands to: rm -rf /
    expect(await invoke(["git"], "{rm,-rf,/}")).toBe("deny");
  });

  test("denies newline-separated commands", async () => {
    expect(await invoke(["git"], "git status\nrm -rf /")).toBe("deny");
  });

  test("denies line continuation backslash", async () => {
    expect(await invoke(["git"], "git status\\")).toBe("deny");
  });

  test("denies history expansion", async () => {
    expect(await invoke(["git"], "git !$")).toBe("deny");
  });

  test("denies background operator &", async () => {
    expect(await invoke(["git"], "git status & rm -rf /")).toBe("deny");
  });

  // --- Environment variable injection (Devin review finding) ---

  test("denies PATH env var injection", async () => {
    expect(await invoke(["git"], "PATH=/tmp/evil/git git status")).toBe("deny");
  });

  test("denies LD_PRELOAD env var injection", async () => {
    expect(await invoke(["npm"], "LD_PRELOAD=/tmp/evil.so/npm npm install")).toBe("deny");
  });

  test("denies GIT_EXEC_PATH env var injection", async () => {
    expect(await invoke(["git"], "GIT_EXEC_PATH=/tmp/evil/git git fetch")).toBe("deny");
  });

  test("denies multiple env var assignments", async () => {
    expect(await invoke(["git"], "FOO=bar BAZ=qux git status")).toBe("deny");
  });

  test("denies single-letter env var assignment", async () => {
    expect(await invoke(["git"], "X=1 git status")).toBe("deny");
  });

  test("denies underscore-prefixed env var", async () => {
    expect(await invoke(["git"], "_VAR=val git status")).toBe("deny");
  });

  // --- Exhaustive shell metacharacter and bypass tests ---

  // Process substitution
  test("denies process substitution <()", async () => {
    expect(await invoke(["diff"], "diff <(ls) <(ls /)")).toBe("deny");
  });

  test("denies process substitution >()", async () => {
    expect(await invoke(["git"], "git log >(cat)")).toBe("deny");
  });

  // Variable expansion
  test("denies dollar variable expansion", async () => {
    expect(await invoke(["echo"], "echo $HOME")).toBe("deny");
  });

  test("denies dollar braces variable expansion", async () => {
    expect(await invoke(["echo"], "echo ${HOME}")).toBe("deny");
  });

  test("denies dollar single-quote ANSI-C quoting", async () => {
    expect(await invoke(["echo"], "echo $'\\x41'")).toBe("deny");
  });

  // Heredoc and herestring
  test("denies heredoc redirection", async () => {
    expect(await invoke(["cat"], "cat <<EOF\nhello\nEOF")).toBe("deny");
  });

  test("denies herestring", async () => {
    expect(await invoke(["cat"], "cat <<<'hello'")).toBe("deny");
  });

  // Arithmetic expansion
  test("denies arithmetic expansion $(())", async () => {
    expect(await invoke(["echo"], "echo $((1+1))")).toBe("deny");
  });

  // Glob wildcards
  test("denies glob star wildcard", async () => {
    expect(await invoke(["git"], "git add *.ts")).toBe("deny");
  });

  test("denies glob question mark wildcard", async () => {
    expect(await invoke(["ls"], "ls file?.txt")).toBe("deny");
  });

  // Carriage return (can hide commands in terminal output)
  test("denies carriage return", async () => {
    expect(await invoke(["git"], "git status\rrm -rf /")).toBe("deny");
  });

  // Tab character
  test("denies tab character", async () => {
    expect(await invoke(["git"], "git\tstatus")).toBe("deny");
  });

  // Null byte
  test("denies null byte", async () => {
    expect(await invoke(["git"], "git\x00status")).toBe("deny");
  });

  // OR chaining
  test("denies OR-chained commands", async () => {
    expect(await invoke(["git"], "git status || rm -rf /")).toBe("deny");
  });

  // Append redirection
  test("denies append redirection >>", async () => {
    expect(await invoke(["git"], "git log >> /tmp/out")).toBe("deny");
  });

  // File descriptor redirection
  test("denies fd redirection 2>&1", async () => {
    expect(await invoke(["git"], "git status 2>&1")).toBe("deny");
  });

  // Clobber operator
  test("denies clobber operator >|", async () => {
    expect(await invoke(["git"], "git log >| /tmp/out")).toBe("deny");
  });

  // Exclamation negation in various positions
  test("denies ! at start of command (shell negation)", async () => {
    expect(await invoke(["git"], "! git status")).toBe("deny");
  });

  test("denies !! history repeat", async () => {
    expect(await invoke(["git"], "!!")).toBe("deny");
  });

  // Hash comment injection
  test("denies hash comment to hide trailing command", async () => {
    expect(await invoke(["git"], "git status #")).toBe("deny");
  });

  // Percent (parameter expansion in some shells)
  test("denies percent character", async () => {
    expect(await invoke(["git"], "git log --format=%H")).toBe("deny");
  });

  // Caret (history substitution in some configs)
  test("denies caret character", async () => {
    expect(await invoke(["git"], "^old^new")).toBe("deny");
  });

  // Tilde expansion with user (valid ~ is in allowlist, but ~user could expand)
  test("allows plain tilde in path", async () => {
    expect(await invoke(["ls"], "ls ~/dir")).toBe("allow");
  });

  // Control characters
  test("denies escape character (0x1B)", async () => {
    expect(await invoke(["git"], "git \x1bstatus")).toBe("deny");
  });

  test("denies bell character (0x07)", async () => {
    expect(await invoke(["git"], "git \x07status")).toBe("deny");
  });

  // Unicode tricks
  test("denies unicode homoglyph semicolon (fullwidth ;)", async () => {
    // Fullwidth semicolon U+FF1B - not in allowlist so blocked
    expect(await invoke(["git"], "git status\uFF1Brm -rf /")).toBe("deny");
  });

  // Multiple pipes
  test("denies multiple pipes", async () => {
    expect(await invoke(["git"], "git log | grep x | xargs rm")).toBe("deny");
  });

  // Nested command substitution
  test("denies nested command substitution", async () => {
    expect(await invoke(["git"], "git $(echo $(whoami))")).toBe("deny");
  });

  // Subshell with semicolons inside
  test("denies complex subshell expression", async () => {
    expect(await invoke(["git"], "(cd /tmp; rm -rf *)")).toBe("deny");
  });

  // Double ampersand without spaces (harder to spot)
  test("denies && without spaces", async () => {
    expect(await invoke(["git"], "git status&&rm -rf /")).toBe("deny");
  });

  // Semicolon without spaces
  test("denies ; without spaces", async () => {
    expect(await invoke(["git"], "git status;rm -rf /")).toBe("deny");
  });

  // Background job with no second command
  test("denies standalone background operator", async () => {
    expect(await invoke(["git"], "git status &")).toBe("deny");
  });

  // Backslash-newline continuation
  test("denies backslash-newline line continuation", async () => {
    expect(await invoke(["git"], "git \\\nstatus")).toBe("deny");
  });

  // Extended glob patterns
  test("denies extglob pattern ?()", async () => {
    expect(await invoke(["ls"], "ls ?(foo|bar)")).toBe("deny");
  });

  // Here string with redirection
  test("denies <<< here-string operator", async () => {
    expect(await invoke(["cat"], "cat <<< secret")).toBe("deny");
  });

  // Coprocess (bash 4+)
  test("denies coproc keyword via pipe", async () => {
    expect(await invoke(["git"], "git status |& cat")).toBe("deny");
  });

  // --- Legitimate commands that should be allowed ---

  test("allows single-word command with no args", async () => {
    expect(await invoke(["git"], "git")).toBe("allow");
  });

  test("allows command with multiple flags", async () => {
    expect(await invoke(["git"], "git log --oneline --graph -n 10")).toBe("allow");
  });

  test("allows command with dot-relative path", async () => {
    expect(await invoke(["ls"], "ls ./src/main")).toBe("allow");
  });

  test("allows command with parent directory path", async () => {
    expect(await invoke(["ls"], "ls ../other-dir/file.ts")).toBe("allow");
  });

  test("allows command with comma-separated values", async () => {
    expect(await invoke(["git"], "git log --format=format:a,b,c")).toBe("allow");
  });

  test("allows command with single-quoted argument", async () => {
    expect(await invoke(["git"], "git commit -m 'simple message'")).toBe("allow");
  });

  test("denies command with % inside square brackets", async () => {
    expect(await invoke(["git"], "git log --format=[%h]")).toBe("deny");
    // Note: %h is blocked because % is not in allowlist — this is correct
  });

  test("allows command with bracket-only notation", async () => {
    expect(await invoke(["npm"], "npm install foo[bar]")).toBe("allow");
  });

  test("allows command with multiple path separators", async () => {
    expect(await invoke(["ls"], "ls /usr/local/bin/")).toBe("allow");
  });

  test("allows command with mixed quotes", async () => {
    expect(await invoke(["git"], "git commit -m \"it's done\"")).toBe("allow");
  });

  test("allows command with @ and version", async () => {
    expect(await invoke(["npm"], "npm install @types/node@20.0.0")).toBe("allow");
  });

  // --- Edge cases for the command extraction logic ---

  test("denies command not in allowlist even with safe characters", async () => {
    expect(await invoke(["git"], "curl example.com")).toBe("deny");
  });

  test("allows command when multiple tools are configured", async () => {
    expect(await invoke(["git", "npm", "ls"], "npm install")).toBe("allow");
    expect(await invoke(["git", "npm", "ls"], "git status")).toBe("allow");
    expect(await invoke(["git", "npm", "ls"], "ls -la")).toBe("allow");
  });

  test("denies command not in multi-tool allowlist", async () => {
    expect(await invoke(["git", "npm"], "curl example.com")).toBe("deny");
  });

  // --- Missing/undefined command input edge cases ---

  test("denies when tool_input has no command field", async () => {
    const cliTools: CliToolConfig[] = [{ command: "git", instructions: "" }];
    const hookConfig = buildBashPreToolUseHook(cliTools);
    if (!hookConfig) throw new Error("expected hook to be non-null");
    const hook = hookConfig.hooks[0];
    const result = await hook({ tool_input: {} } as Record<string, unknown>);
    const decision = (result as Record<string, unknown>).hookSpecificOutput as {
      permissionDecision: "allow" | "deny";
    };
    expect(decision.permissionDecision).toBe("deny");
  });

  test("denies when tool_input is undefined", async () => {
    const cliTools: CliToolConfig[] = [{ command: "git", instructions: "" }];
    const hookConfig = buildBashPreToolUseHook(cliTools);
    if (!hookConfig) throw new Error("expected hook to be non-null");
    const hook = hookConfig.hooks[0];
    const result = await hook({} as Record<string, unknown>);
    const decision = (result as Record<string, unknown>).hookSpecificOutput as {
      permissionDecision: "allow" | "deny";
    };
    expect(decision.permissionDecision).toBe("deny");
  });
});
