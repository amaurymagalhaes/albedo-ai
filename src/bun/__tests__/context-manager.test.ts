import { describe, expect, test } from "bun:test";
import { SentenceDetector, ContextManager } from "../context-manager";

describe("SentenceDetector", () => {
  test("splits on period followed by space", () => {
    const detector = new SentenceDetector();
    const result = detector.feed("Hello. How are you?");
    expect(result).toEqual(["Hello.", "How are you?"]);
    const remaining = detector.flush();
    expect(remaining).toBe("");
  });

  test("splits multiple sentences in one feed", () => {
    const detector = new SentenceDetector();
    const result = detector.feed("First. Second. Third.");
    expect(result).toEqual(["First.", "Second.", "Third."]);
  });

  test("splits on streaming input character by character", () => {
    const detector = new SentenceDetector();
    const text = "Hello world. How are you?";
    const sentences: string[] = [];
    for (const ch of text) {
      sentences.push(...detector.feed(ch));
    }
    sentences.push(detector.flush());
    expect(sentences.filter(Boolean)).toEqual(["Hello world.", "How are you?"]);
  });

  test("skips abbreviations", () => {
    const detector = new SentenceDetector();
    const result = detector.feed("Dr. Smith is here. He is nice.");
    expect(result).toEqual(["Dr. Smith is here.", "He is nice."]);
    const remaining = detector.flush();
    expect(remaining).toBe("");
  });

  test("flush returns remaining buffer", () => {
    const detector = new SentenceDetector();
    detector.feed("Hello world");
    const remaining = detector.flush();
    expect(remaining).toBe("Hello world");
  });

  test("handles CJK punctuation", () => {
    const detector = new SentenceDetector();
    const result = detector.feed("你好。我很好。");
    expect(result).toEqual(["你好。", "我很好。"]);
  });

  test("force-splits long runs without punctuation", () => {
    const detector = new SentenceDetector();
    const longText = "a".repeat(200);
    const result = detector.feed(longText);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ContextManager", () => {
  test("buildMessages returns correct structure", () => {
    const cm = new ContextManager();
    const messages = cm.buildMessages("Hello");
    expect(messages[0].role).toBe("system");
    expect(messages[messages.length - 1].role).toBe("user");
    expect(messages[messages.length - 1].content).toBe("Hello");
  });

  test("adds exchanges and trims history", () => {
    const cm = new ContextManager();
    const longText = "x".repeat(8000);
    for (let i = 0; i < 500; i++) {
      cm.addExchange(`User ${i}: ${longText}`, `Response ${i}: ${longText}`);
    }
    expect(cm.history.length).toBeLessThan(1000);
  });

  test("injects awareness into system prompt", () => {
    const cm = new ContextManager();
    cm.updateAwareness({
      activeWindow: { title: "Test", appName: "TestApp", appPath: "/test", pid: 1 },
      metrics: { cpuPercent: 50, ramPercent: 60, diskPercent: 70, networkMbpsIn: 1, networkMbpsOut: 2 },
      clipboardContent: "hello",
      recentNotifications: ["notif1"],
      timestampMs: Date.now(),
    });
    const messages = cm.buildMessages("Hi");
    const systemContent = messages[0].content as string;
    expect(systemContent).toContain("TestApp");
    expect(systemContent).toContain("50.0%");
  });

  test("injects vision data as image_url content block", () => {
    const cm = new ContextManager();
    cm.setVisionData("base64data");
    const messages = cm.buildMessages("Look at this");
    const lastMsg = messages[messages.length - 1];
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const content = lastMsg.content as any[];
    expect(content.some((c) => c.type === "image_url")).toBe(true);
  });

  test("pendingVisionB64 is cleared after buildMessages", () => {
    const cm = new ContextManager();
    cm.setVisionData("base64data");
    cm.buildMessages("Look at this");
    const messages2 = cm.buildMessages("Next message");
    const lastMsg = messages2[messages2.length - 1];
    expect(typeof lastMsg.content).toBe("string");
  });

  test("loads history from turns", () => {
    const cm = new ContextManager();
    cm.loadHistory([
      { role: "user", content: "Hello", timestampMs: 1000 },
      { role: "assistant", content: "Hi there", timestampMs: 1001 },
    ]);
    expect(cm.history.length).toBe(2);
    const messages = cm.buildMessages("How are you?");
    expect(messages.length).toBe(4);
  });
});
