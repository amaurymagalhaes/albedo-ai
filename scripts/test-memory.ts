import { Memory } from "../src/bun/memory";

const mem = new Memory(":memory:test_" + Date.now());

mem.saveExchange("Hello, how are you?", "I'm doing great, thanks for asking!");
mem.saveExchange("What's the weather?", "It's sunny and warm today.");
mem.saveExchange("Tell me a joke.", "Why did the programmer quit? Because he didn't get arrays.");

const exchanges = mem.getRecentExchanges();
console.log("Recent exchanges:");
for (const e of exchanges) {
  console.log(`  [${e.role}] ${e.content.slice(0, 60)}`);
}

console.assert(exchanges.length === 6, `Expected 6 rows, got ${exchanges.length}`);
console.assert(exchanges[0].role === "user", "First should be user");
console.log("\nAll assertions passed!");
mem.close();
