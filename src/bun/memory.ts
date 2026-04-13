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

  close(): void {
    this.db.close();
  }
}
