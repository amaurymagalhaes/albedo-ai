import { GrokClient } from "../src/bun/grok-client";

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  console.error("Set XAI_API_KEY environment variable");
  process.exit(1);
}

const grok = new GrokClient({
  apiKey,
  model: process.env.GROK_MODEL ?? "grok-4-fast",
  baseUrl: "https://api.x.ai/v1",
  maxTokens: 512,
  temperature: 0.7,
});

const messages = [
  { role: "user" as const, content: "Say exactly: 'Integration test passed.'" },
];

let fullText = "";
for await (const chunk of grok.chatStream(messages)) {
  if (chunk.type === "content") {
    process.stdout.write(chunk.text);
    fullText += chunk.text;
  }
}
console.log();
console.assert(
  fullText.includes("Integration test passed"),
  "Expected response not found"
);
