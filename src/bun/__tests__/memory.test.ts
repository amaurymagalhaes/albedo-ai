import { describe, expect, test, beforeEach } from "bun:test";
import { Memory } from "../memory";
import { unlinkSync } from "fs";
import path from "path";

const DB_PATH = path.join(process.env.HOME ?? "~", ".config/albedo-ai", "memory.sqlite");

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

  test("saveSessionSummary and getRecentSummaries", () => {
    const sessionId = "test_summary_" + Date.now();
    const mem = new Memory(sessionId);
    mem.saveExchange("Hello", "Hi there!");
    mem.saveExchange("What is AI?", "AI is artificial intelligence.");

    const count = mem.getSessionExchangeCount();
    expect(count).toBe(2);

    const startTime = mem.getSessionStartTime();
    expect(startTime).not.toBeNull();
    expect(typeof startTime).toBe("number");

    mem.saveSessionSummary("User asked about AI and got an explanation.", count, startTime ?? undefined);

    const otherMem = new Memory("test_other_" + Date.now());
    const summaries = otherMem.getRecentSummaries(5);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    const found = summaries.find(s => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found!.summary).toBe("User asked about AI and got an explanation.");
    expect(found!.exchangeCount).toBe(2);
    expect(found!.startedAt).toBe(startTime);
    expect(found!.endedAt).not.toBeNull();
    mem.close();
    otherMem.close();
  });

  test("getRecentSummaries excludes current session", () => {
    const sessionId = "test_exclude_" + Date.now();
    const mem = new Memory(sessionId);
    mem.saveExchange("Test", "Response");
    mem.saveSessionSummary("A summary for exclusion test.", 1);

    const summaries = mem.getRecentSummaries(10);
    expect(summaries.every(s => s.sessionId !== sessionId)).toBe(true);
    mem.close();
  });

  test("getRecentSummaries returns multiple summaries ordered by created_at DESC", () => {
    const prefix = "test_multi_" + Date.now() + "_";
    const mem1 = new Memory(prefix + "a");
    mem1.saveExchange("A", "B");
    mem1.saveSessionSummary("First summary.", 1);
    mem1.close();

    const mem2 = new Memory(prefix + "b");
    mem2.saveExchange("C", "D");
    mem2.saveSessionSummary("Second summary.", 1);
    mem2.close();

    const reader = new Memory(prefix + "reader");
    const summaries = reader.getRecentSummaries(5);
    const matched = summaries.filter(s => s.sessionId.startsWith(prefix));
    expect(matched.length).toBe(2);
    expect(matched[0].createdAt).toBeGreaterThanOrEqual(matched[1].createdAt);
    reader.close();
  });

  test("getSessionExchangeCount returns 0 for empty session", () => {
    const mem = new Memory("test_empty_count_" + Date.now());
    expect(mem.getSessionExchangeCount()).toBe(0);
    mem.close();
  });

  test("getSessionStartTime returns null for empty session", () => {
    const mem = new Memory("test_empty_start_" + Date.now());
    expect(mem.getSessionStartTime()).toBeNull();
    mem.close();
  });
});

describe("Memory Facts", () => {
  beforeEach(() => {
    try { unlinkSync(DB_PATH); } catch {}
    try { unlinkSync(DB_PATH + "-wal"); } catch {}
    try { unlinkSync(DB_PATH + "-shm"); } catch {}
  });

  test("adds and retrieves facts", () => {
    const mem = new Memory("test_facts_" + Date.now());
    const res = mem.addFact("user_profile", "User likes TypeScript");
    expect(res.success).toBe(true);

    const facts = mem.getAllFacts();
    expect(facts.length).toBe(1);
    expect(facts[0].category).toBe("user_profile");
    expect(facts[0].content).toBe("User likes TypeScript");
    mem.close();
  });

  test("prevents exact duplicates", () => {
    const mem = new Memory("test_dup_" + Date.now());
    mem.addFact("agent_knowledge", "Sky is blue");
    const res = mem.addFact("agent_knowledge", "Sky is blue");
    expect(res.success).toBe(false);
    expect(res.error).toContain("duplicate");
    mem.close();
  });

  test("enforces memory section char limit", () => {
    const mem = new Memory("test_memlimit_" + Date.now());
    const longContent = "a".repeat(2190);
    const res1 = mem.addFact("agent_knowledge", longContent);
    expect(res1.success).toBe(true);

    const res2 = mem.addFact("preference", "this would overflow");
    expect(res2.success).toBe(false);
    expect(res2.error).toContain("exceed");
    mem.close();
  });

  test("enforces user profile char limit", () => {
    const mem = new Memory("test_proflimit_" + Date.now());
    const longContent = "x".repeat(1370);
    const res1 = mem.addFact("user_profile", longContent);
    expect(res1.success).toBe(true);

    const res2 = mem.addFact("user_profile", "overflow");
    expect(res2.success).toBe(false);
    expect(res2.error).toContain("exceed");
    mem.close();
  });

  test("replaceFact with substring matching", () => {
    const mem = new Memory("test_replace_" + Date.now());
    mem.addFact("agent_knowledge", "User prefers dark mode");
    const res = mem.replaceFact("dark mode", "User prefers light mode");
    expect(res.success).toBe(true);

    const facts = mem.getAllFacts();
    expect(facts[0].content).toBe("User prefers light mode");
    mem.close();
  });

  test("removeFact with substring matching", () => {
    const mem = new Memory("test_remove_" + Date.now());
    mem.addFact("agent_knowledge", "Fact to remove");
    mem.addFact("agent_knowledge", "Fact to keep");
    const res = mem.removeFact("to remove");
    expect(res.success).toBe(true);

    const facts = mem.getAllFacts();
    expect(facts.length).toBe(1);
    expect(facts[0].content).toBe("Fact to keep");
    mem.close();
  });

  test("replaceFact errors on multiple matches", () => {
    const mem = new Memory("test_replacemulti_" + Date.now());
    mem.addFact("agent_knowledge", "User likes cats");
    mem.addFact("agent_knowledge", "User dislikes cats");
    const res = mem.replaceFact("cats", "dogs");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Multiple");
    mem.close();
  });

  test("removeFact errors on multiple matches", () => {
    const mem = new Memory("test_removemulti_" + Date.now());
    mem.addFact("agent_knowledge", "Alpha fact");
    mem.addFact("agent_knowledge", "Alpha other fact");
    const res = mem.removeFact("Alpha");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Multiple");
    mem.close();
  });

  test("replaceFact errors on no match", () => {
    const mem = new Memory("test_replacenomatch_" + Date.now());
    const res = mem.replaceFact("nonexistent", "something");
    expect(res.success).toBe(false);
    expect(res.error).toContain("No fact");
    mem.close();
  });

  test("removeFact errors on no match", () => {
    const mem = new Memory("test_removenomatch_" + Date.now());
    const res = mem.removeFact("nonexistent");
    expect(res.success).toBe(false);
    expect(res.error).toContain("No fact");
    mem.close();
  });

  test("getFactsString formats correctly with category separation", () => {
    const mem = new Memory("test_format_" + Date.now());
    mem.addFact("agent_knowledge", "Agent fact one");
    mem.addFact("preference", "Prefers vim");
    mem.addFact("user_profile", "User is developer");

    const str = mem.getFactsString();
    expect(str).toContain("MEMORY (agent knowledge)");
    expect(str).toContain("USER PROFILE");
    expect(str).toContain("Agent fact one§Prefers vim");
    expect(str).toContain("User is developer");
    expect(str).toContain("════════════════════════════════════════════");
    mem.close();
  });

  test("getFactsString empty sections show zero counts", () => {
    const mem = new Memory("test_empty_" + Date.now());
    const str = mem.getFactsString();
    expect(str).toContain("0% — 0/2200");
    expect(str).toContain("0% — 0/1375");
    mem.close();
  });

  test("getFactsCharCount separates categories correctly", () => {
    const mem = new Memory("test_charcount_" + Date.now());
    mem.addFact("agent_knowledge", "12345");
    mem.addFact("preference", "678");
    mem.addFact("user_profile", "abcd");

    const counts = mem.getFactsCharCount();
    expect(counts.memory).toBe(8);
    expect(counts.userProfile).toBe(4);
    mem.close();
  });

  test("addFact returns usage percentage", () => {
    const mem = new Memory("test_usage_" + Date.now());
    const res = mem.addFact("agent_knowledge", "A".repeat(220));
    expect(res.success).toBe(true);
    expect(res.usage).toContain("10%");
    expect(res.usage).toContain("220/2200");
    mem.close();
  });

  test("getAllFacts ordered by category then id", () => {
    const mem = new Memory("test_order_facts_" + Date.now());
    mem.addFact("user_profile", "Profile B");
    mem.addFact("agent_knowledge", "Agent A");
    mem.addFact("preference", "Pref C");

    const facts = mem.getAllFacts();
    const categories = facts.map((f) => f.category);
    expect(categories[0]).toBe("agent_knowledge");
    expect(categories[1]).toBe("preference");
    expect(categories[2]).toBe("user_profile");
    mem.close();
  });
});

describe("Memory searchConversations", () => {
  test("searchConversations finds matches with snippets", () => {
    const mem = new Memory("test_search_" + Date.now());
    mem.saveExchange("Tell me about quantum computing", "Quantum computing uses qubits.");
    mem.saveExchange("What is machine learning?", "Machine learning is a subset of AI.");
    mem.saveExchange("How does photosynthesis work?", "Photosynthesis converts sunlight to energy.");

    const results = mem.searchConversations("quantum");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content.toLowerCase()).toContain("quantum");
    expect(results[0].snippet).toContain(">>>");
    expect(results[0].snippet).toContain("<<<");
    expect(typeof results[0].id).toBe("number");
    expect(typeof results[0].sessionId).toBe("string");
    expect(typeof results[0].timestampMs).toBe("number");
    mem.close();
  });

  test("searchConversations handles special characters", () => {
    const mem = new Memory("test_special_" + Date.now());
    mem.saveExchange("Use the chat-send function", "chat-send is a helper utility.");

    const results = mem.searchConversations("chat-send");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("chat-send");
    mem.close();
  });
});

describe("Memory Skills", () => {
  beforeEach(() => {
    try { unlinkSync(DB_PATH); } catch {}
    try { unlinkSync(DB_PATH + "-wal"); } catch {}
    try { unlinkSync(DB_PATH + "-shm"); } catch {}
  });

  test("createSkill and getSkill", () => {
    const mem = new Memory("test_skill_create_" + Date.now());
    const res = mem.createSkill("morning-briefing", "Give morning summary", "bom dia,good morning", "Check weather\nRead calendar\nSummarize pending tasks");
    expect(res.success).toBe(true);

    const skill = mem.getSkill("morning-briefing");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("morning-briefing");
    expect(skill!.description).toBe("Give morning summary");
    expect(skill!.triggerPattern).toBe("bom dia,good morning");
    expect(skill!.procedure).toBe("Check weather\nRead calendar\nSummarize pending tasks");
    expect(skill!.useCount).toBe(0);
    mem.close();
  });

  test("createSkill rejects duplicate name", () => {
    const mem = new Memory("test_skill_dup_" + Date.now());
    mem.createSkill("test-skill", "Desc", "trigger", "proc");
    const res = mem.createSkill("test-skill", "Other", "other", "other proc");
    expect(res.success).toBe(false);
    expect(res.error).toContain("already exists");
    mem.close();
  });

  test("createSkill normalizes name to lowercase", () => {
    const mem = new Memory("test_skill_lower_" + Date.now());
    mem.createSkill("My-Skill", "Desc", "trigger", "proc");
    const skill = mem.getSkill("my-skill");
    expect(skill).not.toBeNull();
    mem.close();
  });

  test("updateSkill modifies fields", () => {
    const mem = new Memory("test_skill_update_" + Date.now());
    mem.createSkill("test-skill", "Original", "old trigger", "old proc");

    const res = mem.updateSkill("test-skill", {
      description: "Updated",
      triggerPattern: "new trigger",
    });
    expect(res.success).toBe(true);

    const skill = mem.getSkill("test-skill");
    expect(skill!.description).toBe("Updated");
    expect(skill!.triggerPattern).toBe("new trigger");
    expect(skill!.procedure).toBe("old proc");
    mem.close();
  });

  test("updateSkill errors on missing skill", () => {
    const mem = new Memory("test_skill_update_miss_" + Date.now());
    const res = mem.updateSkill("nonexistent", { description: "x" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("not found");
    mem.close();
  });

  test("deleteSkill removes skill", () => {
    const mem = new Memory("test_skill_delete_" + Date.now());
    mem.createSkill("to-delete", "Desc", "trigger", "proc");
    const res = mem.deleteSkill("to-delete");
    expect(res.success).toBe(true);

    const skill = mem.getSkill("to-delete");
    expect(skill).toBeNull();
    mem.close();
  });

  test("deleteSkill errors on missing skill", () => {
    const mem = new Memory("test_skill_delete_miss_" + Date.now());
    const res = mem.deleteSkill("nonexistent");
    expect(res.success).toBe(false);
    mem.close();
  });

  test("listSkills returns skills ordered by use_count desc", () => {
    const mem = new Memory("test_skill_list_" + Date.now());
    mem.createSkill("popular", "Used a lot", "trigger1", "proc");
    mem.createSkill("unpopular", "Rarely used", "trigger2", "proc");

    mem.incrementSkillUse("popular");
    mem.incrementSkillUse("popular");
    mem.incrementSkillUse("popular");

    const skills = mem.listSkills();
    expect(skills.length).toBe(2);
    expect(skills[0].name).toBe("popular");
    expect(skills[0].useCount).toBe(3);
    expect(skills[1].useCount).toBe(0);
    mem.close();
  });

  test("findMatchingSkills returns skills whose trigger patterns match input", () => {
    const mem = new Memory("test_skill_match_" + Date.now());
    mem.createSkill("greeting", "Morning greeting", "bom dia,good morning,hello", "Say hello and give briefing");
    mem.createSkill("code-help", "Coding help", "help me code,debug,programming", "Assist with coding");

    const matches = mem.findMatchingSkills("bom dia, como vai?");
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe("greeting");

    const noMatches = mem.findMatchingSkills("what's the weather?");
    expect(noMatches.length).toBe(0);
    mem.close();
  });

  test("incrementSkillUse increments count and updates last_used", () => {
    const mem = new Memory("test_skill_inc_" + Date.now());
    mem.createSkill("test", "Desc", "trigger", "proc");
    const before = mem.getSkill("test")!;
    expect(before.useCount).toBe(0);
    expect(before.lastUsed).toBeNull();

    mem.incrementSkillUse("test");
    const after = mem.getSkill("test")!;
    expect(after.useCount).toBe(1);
    expect(after.lastUsed).not.toBeNull();
    mem.close();
  });

  test("getSkill returns null for nonexistent skill", () => {
    const mem = new Memory("test_skill_null_" + Date.now());
    expect(mem.getSkill("nonexistent")).toBeNull();
    mem.close();
  });
});
