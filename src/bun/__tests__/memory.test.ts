import { describe, expect, test } from "bun:test";
import { Memory } from "../memory";

describe("Memory", () => {
  test("saves and retrieves exchanges", () => {
    const mem = new Memory("test_" + Date.now());
    mem.saveExchange("Hello", "Hi there!");
    mem.saveExchange("How are you?", "I'm fine.");
    mem.saveExchange("Goodbye", "See you later!");

    const exchanges = mem.getRecentExchanges();
    expect(exchanges.length).toBe(6);
    expect(exchanges[0].role).toBe("user");
    expect(exchanges[0].content).toBe("Hello");
    expect(exchanges[5].role).toBe("assistant");
    expect(exchanges[5].content).toBe("See you later!");
    mem.close();
  });

  test("exchanges are ordered oldest-first", () => {
    const mem = new Memory("test_order_" + Date.now());
    mem.saveExchange("First", "First response");
    mem.saveExchange("Second", "Second response");

    const exchanges = mem.getRecentExchanges();
    expect(exchanges[0].content).toBe("First");
    expect(exchanges[3].content).toBe("Second response");
    mem.close();
  });

  test("getSessionId returns a string", () => {
    const mem = new Memory("test_session_" + Date.now());
    expect(typeof mem.getSessionId()).toBe("string");
    mem.close();
  });
});
