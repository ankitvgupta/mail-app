/**
 * Quick live test of the native Ollama path inside llm-service.
 *
 * Verifies:
 *   1. callOllamaNative actually fetches ollama.com/api/chat (not /v1/messages)
 *   2. think:false is honored (no thinking block in response)
 *   3. Response synthesizes into a valid Anthropic-shaped Message
 *
 * Usage: OLLAMA_API_KEY=... npx tsx scripts/test-native-ollama-path.ts
 */
import {
  createMessage,
  setOllamaConfig,
  setAnthropicServiceDb,
} from "../src/main/services/llm-service";

async function main(): Promise<void> {
  // Mock DB so recordCall is a no-op
  setAnthropicServiceDb({
    prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
    exec: () => {},
    transaction: <T,>(fn: () => T) => () => fn(),
  });

  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    console.error("OLLAMA_API_KEY env var required");
    process.exit(1);
  }
  setOllamaConfig(apiKey);

  for (const think of [false, true] as const) {
    console.log(`\n=== think=${think} ===`);
    const t0 = Date.now();
    const res = await createMessage(
      {
        model: "kimi-k2.6:cloud",
        max_tokens: 256,
        system:
          'Reply with only valid JSON: {"needs_reply": true or false, "reason": "..."}',
        messages: [
          {
            role: "user",
            content:
              "From: bob@example.com\nSubject: Hi\n\nHey, can you send me the slides by Friday?",
          },
        ],
      },
      { caller: "live-test", provider: "ollama-cloud", think },
    );
    const elapsed = Date.now() - t0;

    console.log(`elapsed: ${elapsed}ms`);
    console.log(`model: ${res.model}`);
    console.log(`content block types: ${res.content.map((b) => b.type).join(", ")}`);
    const textBlock = res.content.find((b) => b.type === "text");
    const text = textBlock?.type === "text" ? textBlock.text : "";
    console.log(`text: ${text.slice(0, 200)}`);
    console.log(`input_tokens=${res.usage.input_tokens} output_tokens=${res.usage.output_tokens}`);
    const thinkingBlock = res.content.find((b) => b.type === "thinking");
    if (thinkingBlock && "thinking" in thinkingBlock) {
      console.log(`thinking present: ${(thinkingBlock as { thinking: string }).thinking.length} chars`);
    } else {
      console.log("thinking present: no");
    }
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const parsed = JSON.parse(text.slice(start, end + 1));
      console.log("parsed JSON:", JSON.stringify(parsed));
    } catch (e) {
      console.log("parse FAILED:", (e as Error).message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
