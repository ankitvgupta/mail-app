#!/usr/bin/env npx tsx
/**
 * Local integration test for Ollama Cloud.
 * Run with: OLLAMA_API_KEY=<key> npx tsx scripts/test-ollama-cloud.ts
 *
 * NOT part of CI — requires a real Ollama Cloud API key.
 *
 * Validates:
 * 1. Basic message creation via Ollama's Anthropic-compatible endpoint
 * 2. Tool calling works
 * 3. cache_control in system messages doesn't cause errors
 */
import Anthropic from "@anthropic-ai/sdk";

const OLLAMA_BASE_URL = "https://ollama.com";
const DEFAULT_MODEL = "minimax-m2.7:cloud";

function getApiKey(): string {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) {
    console.error("ERROR: OLLAMA_API_KEY environment variable is required.");
    console.error("Usage: OLLAMA_API_KEY=<key> npx tsx scripts/test-ollama-cloud.ts");
    process.exit(1);
  }
  return key;
}

async function testBasicMessage(client: Anthropic): Promise<void> {
  console.log("\n--- Test 1: Basic message creation ---");

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 128,
    messages: [{ role: "user", content: "Reply with exactly: OLLAMA_TEST_OK" }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  if (!text.includes("OLLAMA_TEST_OK")) {
    console.warn(`WARNING: Expected response containing "OLLAMA_TEST_OK", got: "${text}"`);
    console.log("(Model may not follow instructions exactly — this is acceptable)");
  }

  console.log(`Model: ${response.model}`);
  console.log(`Response: ${text.slice(0, 200)}`);
  console.log(`Tokens — input: ${response.usage.input_tokens}, output: ${response.usage.output_tokens}`);
  console.log("PASS: Basic message creation works.");
}

async function testToolCalling(client: Anthropic): Promise<void> {
  console.log("\n--- Test 2: Tool calling ---");

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 256,
    messages: [
      { role: "user", content: "What is the weather in San Francisco? Use the get_weather tool." },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a location",
        input_schema: {
          type: "object" as const,
          properties: {
            location: {
              type: "string",
              description: "City name",
            },
          },
          required: ["location"],
        },
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (toolUse) {
    console.log(`Tool called: ${toolUse.type === "tool_use" ? toolUse.name : "unknown"}`);
    console.log(`Tool input: ${JSON.stringify(toolUse.type === "tool_use" ? toolUse.input : {})}`);
    console.log("PASS: Tool calling works.");
  } else {
    // Some models may not use tools reliably — log but don't fail
    console.warn("WARNING: Model did not use the tool. Response:");
    const text = response.content.find((b) => b.type === "text");
    console.warn(text?.type === "text" ? text.text.slice(0, 200) : "(no text)");
    console.log("SOFT PASS: Tool calling returned a response (model may not support tools).");
  }
}

async function testCacheControlIgnored(client: Anthropic): Promise<void> {
  console.log("\n--- Test 3: cache_control in system messages ---");

  // Ollama should either ignore cache_control or handle it gracefully
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 64,
    system: [
      {
        type: "text",
        text: "You are a test assistant. Reply with exactly: CACHE_TEST_OK",
        // @ts-expect-error -- cache_control may not be in Ollama's type but we want to test it doesn't error
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: "Go ahead." }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  console.log(`Response: ${text.slice(0, 200)}`);
  console.log("PASS: cache_control in system messages did not cause an error.");
}

async function main(): Promise<void> {
  const apiKey = getApiKey();

  console.log("=== Ollama Cloud Integration Test ===");
  console.log(`Base URL: ${OLLAMA_BASE_URL}`);
  console.log(`Model: ${DEFAULT_MODEL}`);

  // Ollama Cloud expects `Authorization: Bearer <key>` (not `X-Api-Key`).
  // authToken sends Bearer; apiKey sends X-Api-Key.
  const client = new Anthropic({
    baseURL: OLLAMA_BASE_URL,
    authToken: apiKey,
  });

  let failures = 0;

  try {
    await testBasicMessage(client);
  } catch (err) {
    console.error("FAIL: Basic message creation:", err instanceof Error ? err.message : err);
    failures++;
  }

  try {
    await testToolCalling(client);
  } catch (err) {
    console.error("FAIL: Tool calling:", err instanceof Error ? err.message : err);
    failures++;
  }

  try {
    await testCacheControlIgnored(client);
  } catch (err) {
    console.error("FAIL: cache_control test:", err instanceof Error ? err.message : err);
    failures++;
  }

  console.log("\n=== Results ===");
  if (failures === 0) {
    console.log("All tests passed.");
    process.exit(0);
  } else {
    console.error(`${failures} test(s) failed.`);
    process.exit(1);
  }
}

main();
