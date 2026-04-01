import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { CliToolConfig } from "../../../shared/types";

/**
 * Characters permitted in a CLI tool command string.
 *
 * An allowlist is fundamentally more secure than a blocklist: instead of
 * enumerating known-dangerous characters (and inevitably missing some),
 * we explicitly permit only characters that are safe in shell arguments.
 *
 * Permitted: letters, digits, spaces, hyphens, underscores, dots, forward
 * slashes (paths), colons, equals, commas, @, tildes, square brackets, and
 * single/double quotes (safe without $, `, or \ which are not in the set).
 *
 * Rejected (implicitly, by absence): ; & | ` $ > < ( ) { } \ ! ? and
 * newlines — all of which enable command chaining or shell expansion.
 */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9 \-_./\:=,@~[\]"']+$/;

/**
 * Build a PreToolUse hook that gates Bash commands against the CLI tool allowlist.
 *
 * Returns null if no CLI tools are configured (Bash won't be in the tools list).
 * When active, each Bash invocation is checked:
 *   1. The full command string must match SAFE_COMMAND_PATTERN (allowlist).
 *   2. The base command (first token) must be in the configured CLI tool set.
 */
export function buildBashPreToolUseHook(
  cliTools: CliToolConfig[],
): { matcher: string; hooks: HookCallback[] } | null {
  const activeCli = cliTools.filter((t) => t.command.trim());
  if (activeCli.length === 0) return null;

  const allowedCommands = new Set(activeCli.map((t) => t.command.trim()));

  const hook: HookCallback = async (input) => {
    const toolInput = (input as Record<string, unknown>).tool_input as
      | { command?: string }
      | undefined;
    const command = toolInput?.command ?? "";

    // Reject any character outside the safe allowlist.
    // This closes bypass vectors that a blocklist misses: subshells (()),
    // brace expansion ({}), line continuation (\), history expansion (!),
    // and command substitution ($(), ``).
    if (!SAFE_COMMAND_PATTERN.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason:
            "Command contains characters not permitted in CLI tool commands. " +
            "Only letters, digits, spaces, and common path/option characters are allowed.",
        },
      };
    }

    // Extract the base command (first token, stripping any path prefix).
    // Deny leading VAR=value env assignments — they modify the execution
    // environment (e.g. PATH=/evil/dir git status runs a different binary).
    const tokens = command.trim().split(/\s+/);
    const envVarPattern = /^[A-Za-z_][A-Za-z0-9_]*=/;
    let firstCommandIndex = 0;
    while (firstCommandIndex < tokens.length && envVarPattern.test(tokens[firstCommandIndex])) {
      firstCommandIndex++;
    }
    if (firstCommandIndex > 0) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason:
            "Command contains environment variable assignments, which are not permitted.",
        },
      };
    }
    const firstToken = tokens[0] ?? "";
    const baseCommand = firstToken.split("/").pop() ?? firstToken;

    if (allowedCommands.has(baseCommand)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "allow" as const,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason:
          `Command "${baseCommand}" is not in the allowed CLI tools list. ` +
          `Allowed commands: ${[...allowedCommands].join(", ")}`,
      },
    };
  };

  return { matcher: "Bash", hooks: [hook] };
}
