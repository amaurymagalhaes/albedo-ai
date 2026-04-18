import type {
  Message,
  MessageContent,
  ToolDef,
} from "./grok-client";
import type { AwarenessSnapshot } from "./rpc/daemon-client";

const FORCE_SPLIT_CHARS = 80;

export class SentenceDetector {
  private accumulated = "";
  private cursor = 0;
  private readonly ABBREVIATIONS = new Set([
    "dr",
    "mr",
    "mrs",
    "ms",
    "prof",
    "sr",
    "jr",
    "vs",
    "etc",
    "e.g",
    "i.e",
    "approx",
    "fig",
  ]);

  feed(text: string): string[] {
    this.accumulated += text;
    const sentences: string[] = [];
    const ASCII_END = /([.!?]+)(\s|$)/g;
    const CJK_END = /([。！？]+)/g;

    let scanFrom = this.cursor;

    while (scanFrom < this.accumulated.length) {
      ASCII_END.lastIndex = scanFrom;
      const asciiMatch = ASCII_END.exec(this.accumulated);
      const asciiIdx = asciiMatch ? asciiMatch.index : Infinity;

      CJK_END.lastIndex = scanFrom;
      const cjkMatch = CJK_END.exec(this.accumulated);
      const cjkIdx = cjkMatch ? cjkMatch.index : Infinity;

      let matchIdx: number;
      let matchEnd: number;
      let isCJK = false;

      if (cjkIdx <= asciiIdx && cjkMatch) {
        matchIdx = cjkMatch.index;
        matchEnd = matchIdx + cjkMatch[1].length;
        isCJK = true;
      } else if (asciiMatch) {
        matchIdx = asciiMatch.index;
        matchEnd = matchIdx + asciiMatch[1].length;
      } else {
        break;
      }

      if (!isCJK) {
        const textBefore = this.accumulated.slice(this.cursor, matchIdx);
        const wordBefore = textBefore
          .trimEnd()
          .split(/\s+/)
          .at(-1)
          ?.replace(/[.!?。！？]+$/, "")
          .toLowerCase();
        if (wordBefore && this.ABBREVIATIONS.has(wordBefore)) {
          scanFrom = matchEnd;
          continue;
        }
      }

      const candidate = this.accumulated.slice(this.cursor, matchEnd).trim();
      if (candidate.length > 0) {
        sentences.push(candidate);
      }
      this.cursor = matchEnd;
      while (
        this.cursor < this.accumulated.length &&
        /\s/.test(this.accumulated[this.cursor])
      ) {
        this.cursor++;
      }
      scanFrom = this.cursor;
    }

    const tail = this.accumulated.slice(this.cursor);
    if (tail.length > FORCE_SPLIT_CHARS) {
      const splitPoint = tail.lastIndexOf(" ", FORCE_SPLIT_CHARS);
      const forcedChunk =
        splitPoint > 0 ? tail.slice(0, splitPoint) : tail.slice(0, FORCE_SPLIT_CHARS);
      if (forcedChunk.trim().length > 0) {
        sentences.push(forcedChunk.trim());
      }
      this.cursor += forcedChunk.length;
      while (
        this.cursor < this.accumulated.length &&
        /\s/.test(this.accumulated[this.cursor])
      ) {
        this.cursor++;
      }
    }

    return sentences;
  }

  flush(): string {
    const remaining = this.accumulated.slice(this.cursor).trim();
    this.accumulated = "";
    this.cursor = 0;
    return remaining;
  }
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestampMs: number;
  tokenCount: number;
}

export interface ToolSchemaDef {
  name: string;
  description: string;
  parametersJsonSchema: string;
  dangerous: boolean;
}

const HISTORY_BUDGET = 1_800_000;

export class ContextManager {
  history: ConversationTurn[] = [];
  private awarenessSnapshot: AwarenessSnapshot | null = null;
  private pendingVisionB64: string | null = null;
  private totalHistoryTokens = 0;
  private sessionSummaries: Array<{ summary: string; endedAt: number }> = [];
  private factsString: string = "";
  private triggeredSkills: Array<{ name: string; description: string; procedure: string; triggerPattern: string }> = [];

  updateAwareness(snapshot: AwarenessSnapshot): void {
    this.awarenessSnapshot = snapshot;
  }

  setVisionData(b64: string): void {
    this.pendingVisionB64 = b64;
  }

  addExchange(userText: string, assistantText: string): void {
    const now = Date.now();
    this.history.push({
      role: "user",
      content: userText,
      timestampMs: now,
      tokenCount: this.estimateTokens(userText),
    });
    this.totalHistoryTokens += this.estimateTokens(userText);

    this.history.push({
      role: "assistant",
      content: assistantText,
      timestampMs: now + 1,
      tokenCount: this.estimateTokens(assistantText),
    });
    this.totalHistoryTokens += this.estimateTokens(assistantText);

    this.trimHistory();
  }

  loadHistory(
    turns: Array<{ role: string; content: string; timestampMs: number }>
  ): void {
    for (const turn of turns) {
      const role = turn.role as "user" | "assistant";
      const tokenCount = this.estimateTokens(turn.content);
      this.history.push({
        role,
        content: turn.content,
        timestampMs: turn.timestampMs,
        tokenCount,
      });
      this.totalHistoryTokens += tokenCount;
    }
    this.trimHistory();
  }

  loadSessionSummaries(summaries: Array<{ summary: string; endedAt: number }>): void {
    this.sessionSummaries = summaries;
  }

  loadFacts(factsString: string): void {
    this.factsString = factsString;
  }

  setTriggeredSkills(skills: Array<{ name: string; description: string; procedure: string; triggerPattern: string }>): void {
    this.triggeredSkills = skills;
  }

  buildMessages(userText: string): Message[] {
    const systemPrompt = this.buildSystemPrompt();
    const systemTokens = this.estimateTokens(systemPrompt);

    let historySlice = this.history;
    let historyTokens = this.totalHistoryTokens;

    while (historyTokens + systemTokens > HISTORY_BUDGET && historySlice.length > 2) {
      const removed = historySlice[0];
      const paired = historySlice[1];
      historyTokens -= removed.tokenCount + (paired ? paired.tokenCount : 0);
      historySlice = historySlice.slice(2);
    }

    const messages: Message[] = [{ role: "system", content: systemPrompt }];

    for (const turn of historySlice) {
      messages.push({ role: turn.role, content: turn.content });
    }

    if (this.pendingVisionB64) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${this.pendingVisionB64}`,
            },
          },
        ],
      });
      this.pendingVisionB64 = null;
    } else {
      messages.push({ role: "user", content: userText });
    }

    return messages;
  }

  getToolsAsGrokTools(
    schemas: Array<ToolSchemaDef>
  ): Array<ToolDef> {
    return schemas.map((s) => ({
      type: "function" as const,
      function: {
        name: s.name,
        description: s.description,
        parameters: JSON.parse(
          s.parametersJsonSchema || '{"type":"object","properties":{}}'
        ),
      },
    }));
  }

  private buildSystemPrompt(): string {
    const awareness = this.awarenessSnapshot;
    const sections: string[] = [
      `You are Albedo, a highly capable AI desktop assistant.`,
      `You have real-time awareness of the user's system.`,
      awareness ? `## Current System State\n${this.formatAwareness(awareness)}` : "",
      this.pendingVisionB64 ? `## Recent Screenshot\n[Image attached]` : "",
      this.factsString ? `## Persistent Memory\n${this.factsString}` : "",
      `## Personality\nYou are a companion, not a servant. Be concise, warm, and natural — like talking to a friend. Never end responses with offers to help (like "how can I help?" or "what can I do for you?"). Respond in Portuguese (Brazilian) by default unless the user speaks another language. Keep it short.`,
      this.sessionSummaries.length > 0
        ? `## Recent Sessions\n${this.sessionSummaries.map(s => `- ${new Date(s.endedAt).toLocaleDateString()}: ${s.summary}`).join("\n")}`
        : "",
      `## Tools\nYou have access to system tools (open_app, screenshot, list_windows, run_command, etc.). You MUST use these tools to actually perform actions — never just claim you did something. If the user asks you to open an app, use open_app. If they ask you to look at the screen, use screenshot. If they ask about running processes, use list_windows or run_command. Do NOT pretend to have performed actions you did not actually perform via tool calls. Always call the appropriate tool first, then respond based on the result.`,
      this.triggeredSkills.length > 0
        ? `## Active Skills (auto-triggered)\n${this.triggeredSkills.map(s => `### ${s.name}: ${s.description}\n${s.procedure}`).join("\n\n")}`
        : "",
    ];
    return sections.filter(Boolean).join("\n\n");
  }

  private formatAwareness(aw: AwarenessSnapshot): string {
    const lines: string[] = [];
    if (aw.activeWindow) {
      lines.push(`- Active window: ${aw.activeWindow.appName} — "${aw.activeWindow.title}"`);
    }
    if (aw.metrics) {
      lines.push(`- CPU: ${aw.metrics.cpuPercent.toFixed(1)}% | RAM: ${aw.metrics.ramPercent.toFixed(1)}% | Disk: ${aw.metrics.diskPercent.toFixed(1)}%`);
      if (aw.metrics.networkMbpsIn > 0 || aw.metrics.networkMbpsOut > 0) {
        lines.push(`- Network: ↓${aw.metrics.networkMbpsIn.toFixed(1)} Mbps / ↑${aw.metrics.networkMbpsOut.toFixed(1)} Mbps`);
      }
    }
    lines.push(`- Time: ${new Date(aw.timestampMs).toLocaleString()}`);
    if (aw.clipboardContent) {
      lines.push(`- Clipboard: ${this.truncate(aw.clipboardContent, 500)}`);
    }
    if (aw.recentNotifications.length > 0) {
      lines.push(`- Recent notifications: ${aw.recentNotifications.slice(0, 3).join("; ")}`);
    }
    return lines.join("\n");
  }

  private trimHistory(): void {
    while (
      this.totalHistoryTokens > HISTORY_BUDGET &&
      this.history.length > 2
    ) {
      const removed = this.history.shift()!;
      this.totalHistoryTokens -= removed.tokenCount;
      if (this.history.length > 0) {
        const paired = this.history.shift()!;
        this.totalHistoryTokens -= paired.tokenCount;
      }
    }
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + "...";
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
