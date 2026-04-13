import { describe, expect, test } from "bun:test";
import { GrokClient } from "../grok-client";

describe("GrokClient", () => {
  const client = new GrokClient({
    apiKey: "test",
    model: "test-model",
    baseUrl: "https://test.example.com/v1",
    maxTokens: 512,
    temperature: 0.7,
  });

  test("isCompleteJson returns true for valid JSON", () => {
    expect(client.isCompleteJson('{"key":"value"}')).toBe(true);
    expect(client.isCompleteJson("[1,2,3]")).toBe(true);
  });

  test("isCompleteJson returns false for incomplete JSON", () => {
    expect(client.isCompleteJson('{"key":')).toBe(false);
    expect(client.isCompleteJson("")).toBe(false);
    expect(client.isCompleteJson("{")).toBe(false);
  });

  test("estimateTokens returns reasonable estimate", () => {
    const text = "Hello, this is a test string.";
    expect(client.estimateTokens(text)).toBe(Math.ceil(text.length / 4));
  });
});
