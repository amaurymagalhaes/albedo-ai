import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";

const DB_DIR = path.resolve(
  process.env.HOME ?? "~",
  ".config/albedo-ai"
);
const DB_PATH = path.join(DB_DIR, "memory.sqlite");

export class Memory {
  private db: Database;
  private sessionId: string;

  constructor(sessionId?: string) {
    mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    this.migrate();
    this.applyRetentionPolicy();
  }

  private applyRetentionPolicy(): void {
    const days = parseInt(
      process.env.ALBEDO_MEMORY_RETENTION_DAYS ?? "90",
      10
    );
    this.db.run(
      `DELETE FROM conversations WHERE timestamp_ms < (strftime('%s','now') * 1000 - ${days} * 86400000)`
    );
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversations_session
        ON conversations(session_id, timestamp_ms)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        exchange_count INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at DESC)
    `);

    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
          content,
          content=conversations,
          content_rowid=id
        )
      `);
    } catch {}

    try {
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS conversations_fts_insert AFTER INSERT ON conversations BEGIN
          INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
    } catch {}

    try {
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS conversations_fts_delete AFTER DELETE ON conversations BEGIN
          INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
        END
      `);
    } catch {}

    try {
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS conversations_fts_update AFTER UPDATE ON conversations BEGIN
          INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
    } catch {}

    this.db.run(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        procedure TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  saveExchange(userText: string, assistantText: string): void {
    const stmt = this.db.prepare(
      "INSERT INTO conversations (session_id, role, content, timestamp_ms, token_count) VALUES ($sessionId, $role, $content, $ts, $tokens)"
    );
    const now = Date.now();
    this.db.transaction(() => {
      stmt.run({
        $sessionId: this.sessionId,
        $role: "user",
        $content: userText,
        $ts: now,
        $tokens: Math.ceil(userText.length / 4),
      });
      stmt.run({
        $sessionId: this.sessionId,
        $role: "assistant",
        $content: assistantText,
        $ts: now + 1,
        $tokens: Math.ceil(assistantText.length / 4),
      });
    })();
  }

  getRecentExchanges(
    limit = 50
  ): Array<{ role: string; content: string; timestampMs: number }> {
    return (
      this.db
        .prepare(
          "SELECT role, content, timestamp_ms as timestampMs FROM conversations WHERE session_id = $sessionId ORDER BY timestamp_ms DESC LIMIT $limit"
        )
        .all({
          $sessionId: this.sessionId,
          $limit: limit * 2,
        }) as any[]
    ).reverse();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  searchConversations(query: string, limit: number = 10): Array<{
    id: number;
    sessionId: string;
    role: string;
    content: string;
    timestampMs: number;
    snippet: string;
  }> {
    const sanitized = this.sanitizeFtsQuery(query);
    const stmt = this.db.prepare(`
      SELECT c.id, c.session_id as sessionId, c.role, c.content, c.timestamp_ms as timestampMs,
             snippet(conversations_fts, 0, '>>>', '<<<', '...', 32) as snippet
      FROM conversations_fts
      JOIN conversations c ON c.id = conversations_fts.rowid
      WHERE conversations_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(sanitized, limit) as any[];
  }

  private sanitizeFtsQuery(query: string): string {
    let result = query.trim();

    let quoteCount = 0;
    for (const ch of result) {
      if (ch === '"') quoteCount++;
    }
    if (quoteCount % 2 !== 0) {
      const lastIdx = result.lastIndexOf('"');
      result = result.slice(0, lastIdx) + result.slice(lastIdx + 1);
    }

    result = result.replace(/(\S*-\S+)/g, (match) => {
      if (!match.startsWith('"')) return `"${match}"`;
      return match;
    });

    result = result.replace(/\s+(AND|OR|NOT)\s*$/i, '');

    if (result.trim().length === 0) {
      return `"${query}"`;
    }

    return result;
  }

  saveSessionSummary(summary: string, exchangeCount: number, startedAt?: number): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO session_summaries (session_id, summary, exchange_count, started_at, ended_at, created_at) VALUES ($sessionId, $summary, $exchangeCount, $startedAt, $endedAt, $createdAt)"
    ).run({
      $sessionId: this.sessionId,
      $summary: summary,
      $exchangeCount: exchangeCount,
      $startedAt: startedAt ?? null,
      $endedAt: Date.now(),
      $createdAt: Date.now(),
    });
  }

  getRecentSummaries(limit: number = 5): Array<{ sessionId: string; summary: string; exchangeCount: number; startedAt: number | null; endedAt: number | null; createdAt: number }> {
    return (
      this.db
        .prepare(
          "SELECT session_id as sessionId, summary, exchange_count as exchangeCount, started_at as startedAt, ended_at as endedAt, created_at as createdAt FROM session_summaries WHERE session_id != $currentSession ORDER BY created_at DESC LIMIT $limit"
        )
        .all({
          $currentSession: this.sessionId,
          $limit: limit,
        }) as any[]
    );
  }

  getSessionExchangeCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM conversations WHERE session_id = $sessionId AND role = 'user'"
      )
      .get({ $sessionId: this.sessionId }) as any;
    return row?.cnt ?? 0;
  }

  getSessionStartTime(): number | null {
    const row = this.db
      .prepare(
        "SELECT timestamp_ms as ts FROM conversations WHERE session_id = $sessionId ORDER BY timestamp_ms ASC LIMIT 1"
      )
      .get({ $sessionId: this.sessionId }) as any;
    return row?.ts ?? null;
  }

  addFact(category: string, content: string): { success: boolean; error?: string; usage?: string } {
    const MEMORY_LIMIT = 2200;
    const PROFILE_LIMIT = 1375;

    const exact = this.db.prepare("SELECT id FROM facts WHERE content = $content").get({ $content: content });
    if (exact) {
      return { success: false, error: "Exact duplicate fact already exists." };
    }

    const counts = this.getFactsCharCount();
    const isProfile = category === "user_profile";
    const currentCount = isProfile ? counts.userProfile : counts.memory;
    const limit = isProfile ? PROFILE_LIMIT : MEMORY_LIMIT;

    if (currentCount + content.length > limit) {
      const pct = Math.round((currentCount / limit) * 100);
      const entries = this.getAllFacts()
        .filter((f) => isProfile ? f.category === "user_profile" : f.category !== "user_profile")
        .map((f) => f.content)
        .join("§");
      return {
        success: false,
        error: `Would exceed ${limit} char limit (${pct}% full, ${currentCount}/${limit} chars). Current entries: ${entries}`,
      };
    }

    const now = Date.now();
    this.db.run(
      "INSERT INTO facts (category, content, created_at, updated_at) VALUES ($category, $content, $createdAt, $updatedAt)",
      { $category: category, $content: content, $createdAt: now, $updatedAt: now }
    );

    const newCounts = this.getFactsCharCount();
    const newCount = isProfile ? newCounts.userProfile : newCounts.memory;
    const pct = Math.round((newCount / limit) * 100);
    return { success: true, usage: `${pct}% — ${newCount}/${limit} chars` };
  }

  replaceFact(oldText: string, newContent: string): { success: boolean; error?: string } {
    const matches = this.db
      .prepare("SELECT id, content FROM facts WHERE content LIKE $pattern")
      .all({ $pattern: `%${oldText}%` }) as any[];

    if (matches.length === 0) {
      return { success: false, error: `No fact found containing "${oldText}".` };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `Multiple facts match "${oldText}". Please provide a more specific match. Matching entries: ${matches.map((m) => m.content).join("§")}`,
      };
    }

    this.db.run(
      "UPDATE facts SET content = $content, updated_at = $updatedAt WHERE id = $id",
      { $content: newContent, $updatedAt: Date.now(), $id: matches[0].id }
    );
    return { success: true };
  }

  removeFact(oldText: string): { success: boolean; error?: string } {
    const matches = this.db
      .prepare("SELECT id, content FROM facts WHERE content LIKE $pattern")
      .all({ $pattern: `%${oldText}%` }) as any[];

    if (matches.length === 0) {
      return { success: false, error: `No fact found containing "${oldText}".` };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `Multiple facts match "${oldText}". Please provide a more specific match. Matching entries: ${matches.map((m) => m.content).join("§")}`,
      };
    }

    this.db.run("DELETE FROM facts WHERE id = $id", { $id: matches[0].id });
    return { success: true };
  }

  getAllFacts(): Array<{ id: number; category: string; content: string; createdAt: number; updatedAt: number }> {
    return this.db
      .prepare("SELECT id, category, content, created_at as createdAt, updated_at as updatedAt FROM facts ORDER BY category, id")
      .all() as any[];
  }

  getFactsString(): string {
    const facts = this.getAllFacts();
    const counts = this.getFactsCharCount();

    const memoryFacts = facts.filter((f) => f.category === "agent_knowledge" || f.category === "preference");
    const profileFacts = facts.filter((f) => f.category === "user_profile");

    const memPct = Math.round((counts.memory / 2200) * 100);
    const profPct = Math.round((counts.userProfile / 1375) * 100);

    const line = "════════════════════════════════════════════";

    const memorySection = `${line}\nMEMORY (agent knowledge) [${memPct}% — ${counts.memory}/2200 chars]\n${line}\n${memoryFacts.map((f) => f.content).join("§")}`;
    const profileSection = `${line}\nUSER PROFILE [${profPct}% — ${counts.userProfile}/1375 chars]\n${line}\n${profileFacts.map((f) => f.content).join("§")}`;

    return `${memorySection}\n\n${profileSection}`;
  }

  getFactsCharCount(): { memory: number; userProfile: number } {
    const facts = this.getAllFacts();
    let memory = 0;
    let userProfile = 0;
    for (const f of facts) {
      if (f.category === "user_profile") {
        userProfile += f.content.length;
      } else {
        memory += f.content.length;
      }
    }
    return { memory, userProfile };
  }

  createSkill(name: string, description: string, triggerPattern: string, procedure: string): { success: boolean; error?: string } {
    const existing = this.db.prepare("SELECT id FROM skills WHERE name = $name").get({ $name: name.toLowerCase() });
    if (existing) {
      return { success: false, error: `Skill "${name}" already exists. Use skill_update to modify it.` };
    }
    const now = Date.now();
    this.db.run(
      "INSERT INTO skills (name, description, trigger_pattern, procedure, use_count, created_at, updated_at) VALUES ($name, $desc, $trigger, $proc, 0, $createdAt, $updatedAt)",
      { $name: name.toLowerCase(), $desc: description, $trigger: triggerPattern, $proc: procedure, $createdAt: now, $updatedAt: now }
    );
    return { success: true };
  }

  updateSkill(name: string, updates: { description?: string; triggerPattern?: string; procedure?: string }): { success: boolean; error?: string } {
    const existing = this.db.prepare("SELECT id FROM skills WHERE name = $name").get({ $name: name.toLowerCase() }) as any;
    if (!existing) {
      return { success: false, error: `Skill "${name}" not found.` };
    }
    const sets: string[] = [];
    const params: any = { $name: name.toLowerCase(), $updatedAt: Date.now() };
    if (updates.description !== undefined) { sets.push("description = $desc"); params.$desc = updates.description; }
    if (updates.triggerPattern !== undefined) { sets.push("trigger_pattern = $trigger"); params.$trigger = updates.triggerPattern; }
    if (updates.procedure !== undefined) { sets.push("procedure = $proc"); params.$proc = updates.procedure; }
    if (sets.length === 0) return { success: true };
    this.db.run(`UPDATE skills SET ${sets.join(", ")}, updated_at = $updatedAt WHERE name = $name`, params);
    return { success: true };
  }

  deleteSkill(name: string): { success: boolean; error?: string } {
    const existing = this.db.prepare("SELECT id FROM skills WHERE name = $name").get({ $name: name.toLowerCase() }) as any;
    if (!existing) {
      return { success: false, error: `Skill "${name}" not found.` };
    }
    this.db.run("DELETE FROM skills WHERE name = $name", { $name: name.toLowerCase() });
    return { success: true };
  }

  listSkills(): Array<{ name: string; description: string; triggerPattern: string; useCount: number; lastUsed: number | null }> {
    return this.db
      .prepare("SELECT name, description, trigger_pattern as triggerPattern, use_count as useCount, last_used as lastUsed FROM skills ORDER BY use_count DESC, name ASC")
      .all() as any[];
  }

  getSkill(name: string): { name: string; description: string; triggerPattern: string; procedure: string; useCount: number; lastUsed: number | null } | null {
    const row = this.db
      .prepare("SELECT name, description, trigger_pattern as triggerPattern, procedure, use_count as useCount, last_used as lastUsed FROM skills WHERE name = $name")
      .get({ $name: name.toLowerCase() }) as any;
    if (!row) return null;
    return row;
  }

  findMatchingSkills(input: string): Array<{ name: string; description: string; procedure: string; triggerPattern: string }> {
    const skills = this.db
      .prepare("SELECT name, description, procedure, trigger_pattern as triggerPattern FROM skills")
      .all() as any[];
    const lower = input.toLowerCase();
    return skills.filter(s => {
      const patterns = s.triggerPattern.split(",").map((p: string) => p.trim().toLowerCase());
      return patterns.some((p: string) => lower.includes(p));
    });
  }

  incrementSkillUse(name: string): void {
    this.db.run(
      "UPDATE skills SET use_count = use_count + 1, last_used = $now WHERE name = $name",
      { $name: name.toLowerCase(), $now: Date.now() }
    );
  }

  close(): void {
    this.db.close();
  }
}
