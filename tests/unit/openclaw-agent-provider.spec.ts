import { expect, test } from "@playwright/test";
import {
  buildOpenClawPrompt,
  buildOpenClawSessionKey,
} from "../../src/main/agents/providers/openclaw/openclaw-agent-provider";
import { canAnyAgentProviderUseKnowledgeContext } from "../../src/main/agents/types";

test("OpenClaw-only runs skip GBrain recall that the provider cannot safely consume", () => {
  expect(canAnyAgentProviderUseKnowledgeContext(["openclaw-agent"])).toBe(false);
  expect(canAnyAgentProviderUseKnowledgeContext([])).toBe(false);
  expect(canAnyAgentProviderUseKnowledgeContext(["claude"])).toBe(true);
  expect(canAnyAgentProviderUseKnowledgeContext(["openclaw-agent", "hostler"])).toBe(true);
});

test("buildOpenClawPrompt does not mix retrieved knowledge into a user-authority message", () => {
  const prompt = buildOpenClawPrompt(
    {
      accountId: "acc1",
      userEmail: "user@example.com",
      knowledgeContext: "<personal_knowledge>Jordan leads Acme.</personal_knowledge>",
    },
    "Draft a note to Jordan",
  );

  expect(prompt).toBe("Draft a note to Jordan");
  expect(prompt).not.toContain("Jordan leads Acme.");
});

test("buildOpenClawPrompt preserves the raw prompt without recalled knowledge", () => {
  expect(
    buildOpenClawPrompt(
      { accountId: "acc1", userEmail: "user@example.com" },
      "Summarize this thread",
    ),
  ).toBe("Summarize this thread");
});

test("buildOpenClawSessionKey isolates mailboxes and conversations", () => {
  const workThread = buildOpenClawSessionKey(
    { accountId: "work", userEmail: "work@example.com", currentThreadId: "thread-1" },
    "task-1",
  );
  const personalThread = buildOpenClawSessionKey(
    { accountId: "personal", userEmail: "me@example.com", currentThreadId: "thread-1" },
    "task-2",
  );
  const otherWorkThread = buildOpenClawSessionKey(
    { accountId: "work", userEmail: "work@example.com", currentThreadId: "thread-2" },
    "task-3",
  );

  expect(workThread).not.toBe(personalThread);
  expect(workThread).not.toBe(otherWorkThread);
});

test("buildOpenClawSessionKey resumes only a session from the same mailbox", () => {
  const context = { accountId: "work", userEmail: "work@example.com", currentThreadId: "thread-1" };
  const existing = buildOpenClawSessionKey(context, "task-1");

  expect(
    buildOpenClawSessionKey(
      { ...context, providerConversationIds: { "openclaw-agent": existing } },
      "task-2",
    ),
  ).toBe(existing);
  expect(
    buildOpenClawSessionKey(
      {
        accountId: "personal",
        userEmail: "me@example.com",
        currentThreadId: "thread-1",
        providerConversationIds: { "openclaw-agent": existing },
      },
      "task-2",
    ),
  ).not.toBe(existing);
});
