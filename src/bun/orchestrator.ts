import { EventEmitter } from "events";
import { AudioClient } from "./rpc/audio-client";
import { DaemonClient, type ToolSchemaDef, type AwarenessSnapshot } from "./rpc/daemon-client";
import {
  GrokClient,
  type Message,
  type StreamChunk,
  type ToolDef,
} from "./grok-client";
import { ContextManager, SentenceDetector } from "./context-manager";
import { Memory } from "./memory";
import { OmniVoiceClient } from "./tts-client";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Structured Logger with Timestamps ─────────────────────────────────
const LOG_DIR = join(homedir(), ".config", "albedo-ai", "logs");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const LOG_FILE = join(LOG_DIR, `session-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.log`);

function perfLog(event: string, data: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, event, ...data });
  console.log(`[perf] ${line}`);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

export { perfLog };

perfLog("session_start", { logFile: LOG_FILE });

interface ToolsCache {
  tools: ToolSchemaDef[];
  grokTools: ToolDef[];
  expiry: number;
}

const CONFIRMATION_TIMEOUT_MS = 15_000;

export class Orchestrator extends EventEmitter {
  private audio: AudioClient;
  private daemon: DaemonClient;
  private grok: GrokClient;
  private tts: OmniVoiceClient;
  private context: ContextManager;
  private memory: Memory;
  private rpc: any;
  private cfg: any;

  private toolsCache: ToolsCache | null = null;
  private ttsQueue: string[] = [];
  private ttsRunning = false;
  private currentAbortController: AbortController | null = null;
  private started = false;
  private unsubTranscription: (() => void) | null = null;

  private isSpeaking = false;
  private isProcessing = false;
  private processingQueue: string[] = [];
  private muted = false;

  isMuted(): boolean { return this.muted; }

  /** Called when PTT is released — transcribes the entire recorded buffer */
  async finalizePtt(): Promise<void> {
    const t0 = Date.now();
    try {
      this.emit("state-change", "thinking");
      perfLog("ptt_stop", { phase: "stop_recording" });
      // Stop recording (but keep capture running!)
      await this.audio.setPttRecording(false);
      perfLog("ptt_stop", { phase: "recording_stopped", ms: Date.now() - t0 });
      const text = await this.audio.forceTranscribe();
      perfLog("ptt_stop", { phase: "transcribed", text, whisperMs: Date.now() - t0 });
      console.log("[orchestrator] PTT transcription:", JSON.stringify(text));
      this.muted = true;
      if (text && text.trim() && !this.isHallucination(text.trim())) {
        this.processUtterance(text.trim());
      } else {
        console.log("[orchestrator] PTT: empty or hallucination, skipping");
        perfLog("ptt_skip", { text, reason: text?.trim() ? "hallucination" : "empty" });
        this.emit("state-change", "idle");
      }
    } catch (err: any) {
      console.warn("[orchestrator] finalizePtt failed:", err.message);
      perfLog("ptt_error", { error: err.message });
      this.muted = true;
      this.emit("state-change", "idle");
    }
  }
  private pendingConfirmation: {
    promise: Promise<boolean>;
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private lastCpuAlertTime = 0;

  private static readonly MEMORY_TOOLS: ToolSchemaDef[] = [
    {
      name: "memory_add",
      description: "Save a fact to persistent memory. Use 'user_profile' for user preferences/identity, 'agent_knowledge' for environment facts/learnings, 'preference' for behavioral preferences. Memory is bounded — consolidate when full.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          category: { type: "string", enum: ["user_profile", "agent_knowledge", "preference"], description: "Fact category" },
          content: { type: "string", description: "The fact to remember. Be concise and information-dense." }
        },
        required: ["category", "content"]
      }),
      dangerous: false,
    },
    {
      name: "memory_replace",
      description: "Update an existing memory fact. Provide a unique substring of the old fact and the new content.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          old_text: { type: "string", description: "Unique substring of the existing fact to replace" },
          new_content: { type: "string", description: "New fact content" }
        },
        required: ["old_text", "new_content"]
      }),
      dangerous: false,
    },
    {
      name: "memory_remove",
      description: "Remove a fact from persistent memory. Provide a unique substring of the fact to remove.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          old_text: { type: "string", description: "Unique substring of the fact to remove" }
        },
        required: ["old_text"]
      }),
      dangerous: false,
    },
    {
      name: "memory_search",
      description: "Search past conversations for relevant context. Returns matching messages with highlighted snippets.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — keywords or phrases from past conversations" },
          limit: { type: "number", description: "Max results (default 5)", default: 5 }
        },
        required: ["query"]
      }),
      dangerous: false,
    },
  ];

  private static readonly SKILL_TOOLS: ToolSchemaDef[] = [
    {
      name: "skill_create",
      description: "Create a reusable skill (learned behavior). After completing complex multi-step tasks, save the procedure so it can be reused automatically later. Trigger patterns are comma-separated keywords/phrases that activate the skill.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", description: "Short skill name (lowercase, hyphenated, e.g. 'morning-briefing')" },
          description: { type: "string", description: "One-line summary of what the skill does" },
          trigger_pattern: { type: "string", description: "Comma-separated keywords/phrases that should trigger this skill (e.g. 'bom dia,good morning,agenda')" },
          procedure: { type: "string", description: "Step-by-step instructions for executing this skill. Be specific about what to do, what tools to use, and in what order." }
        },
        required: ["name", "description", "trigger_pattern", "procedure"]
      }),
      dangerous: false,
    },
    {
      name: "skill_update",
      description: "Update an existing skill's trigger pattern, description, or procedure.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the skill to update" },
          description: { type: "string", description: "New description (optional)" },
          trigger_pattern: { type: "string", description: "New trigger patterns (optional)" },
          procedure: { type: "string", description: "New procedure (optional)" }
        },
        required: ["name"]
      }),
      dangerous: false,
    },
    {
      name: "skill_delete",
      description: "Delete a skill you no longer need.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the skill to delete" }
        },
        required: ["name"]
      }),
      dangerous: false,
    },
    {
      name: "skill_list",
      description: "List all available skills with their names, descriptions, and trigger patterns. Use this to see what you already know.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {},
        required: []
      }),
      dangerous: false,
    },
    {
      name: "skill_use",
      description: "Load the full procedure of a specific skill. Use this when you want to follow a learned procedure step by step.",
      parametersJsonSchema: JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the skill to load" }
        },
        required: ["name"]
      }),
      dangerous: false,
    },
  ];

  private static readonly SKILL_TOOL_NAMES = new Set(Orchestrator.SKILL_TOOLS.map(t => t.name));

  private static readonly LOCAL_TOOL_NAMES = new Set([
    ...Orchestrator.MEMORY_TOOLS.map(t => t.name),
    ...Orchestrator.SKILL_TOOLS.map(t => t.name),
  ]);

  constructor(opts: {
    audioClient: AudioClient;
    daemonClient: DaemonClient;
    grokClient: GrokClient;
    rpc: any;
    config: any;
  }) {
    super();
    this.audio = opts.audioClient;
    this.daemon = opts.daemonClient;
    this.grok = opts.grokClient;
    this.rpc = opts.rpc;
    this.cfg = opts.config;

    const ttsUrl = process.env.ALBEDO_TTS_URL ?? "http://localhost:9880";
    this.tts = new OmniVoiceClient(ttsUrl);

    this.memory = new Memory();
    this.context = new ContextManager();

    const recentTurns = this.memory.getRecentExchanges(20);
    if (recentTurns.length > 0) {
      this.context.loadHistory(recentTurns);
    }

    const summaries = this.memory.getRecentSummaries(5);
    if (summaries.length > 0) {
      this.context.loadSessionSummaries(summaries.map(s => ({ summary: s.summary, endedAt: s.endedAt ?? s.createdAt })));
    }

    const factsString = this.memory.getFactsString();
    if (factsString) {
      this.context.loadFacts(factsString);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    console.log("[orchestrator] starting...");

    const errors: string[] = [];

    try {
      await this.audio.connect();
      console.log("[orchestrator] audio client connected");
    } catch (err: any) {
      errors.push(`audio connect: ${err.message}`);
    }

    try {
      await this.daemon.connect();
      console.log("[orchestrator] daemon client connected");
    } catch (err: any) {
      errors.push(`daemon connect: ${err.message}`);
    }

    if (errors.length === 0) {
      try {
        await this.audio.startCapture({
          sampleRate: this.cfg.sampleRate ?? 16000,
          vadThreshold: this.cfg.vadThreshold ?? 0.2,
          deviceId: this.cfg.deviceId,
        });
        this.captureStarted = true;
        console.log("[orchestrator] audio capture started");
      } catch (err: any) {
        errors.push(`audio capture: ${err.message}`);
      }
    }

    if (!errors.some(e => e.startsWith("daemon connect"))) {
      try {
        const tools = await this.daemon.listTools();
        if (tools.length === 0) {
          errors.push("daemon tools: no tools registered");
        } else {
          this.toolsCache = {
            tools,
            grokTools: this.context.getToolsAsGrokTools(tools),
            expiry: Date.now() + 60_000,
          };
          console.log(`[orchestrator] ${tools.length} tools loaded from daemon`);
        }
      } catch (err: any) {
        errors.push(`daemon listTools: ${err.message}`);
      }

      try {
        this.daemon.streamAwareness(
          {
            intervalMs: this.cfg.awarenessIntervalMs ?? 5000,
            includeClipboard: true,
            includeScreenOcr: false,
          },
          (snapshot) => {
            this.context.updateAwareness(snapshot);
            this.checkCpuAlert(snapshot);
          }
        );
        console.log("[orchestrator] awareness stream started");
      } catch (err: any) {
        errors.push(`awareness stream: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      const msg = errors.join("; ");
      console.error(`[orchestrator] boot failed — ${msg}`);
      this.started = false;
      throw new Error(`Orchestrator boot failed: ${msg}`);
    }

    this.unsubTranscription = this.audio.onTranscription((result) => {
      console.log("[orchestrator] transcription:", JSON.stringify(result));
      if (result.isFinal && result.text.trim()) {
        this.processUtterance(result.text.trim());
      }
    });

    this.emit("state-change", "listening");
    console.log("[orchestrator] started — all services healthy");
  }

  private static readonly HALLUCINATION_PATTERNS = [
    /^thank(s| you)?\.?$/i,
    /^thanks for watching\.?$/i,
    /^hello\.?$/i,
    /^hi\.?$/i,
    /^hey\.?$/i,
    /^ok\.?$/i,
    /^yeah\.?$/i,
    /^you\.?$/i,
    /^the\.?$/i,
    /^subscribe\.?$/i,
    /^please subscribe\.?$/i,
    /^,\s*$/,/^\.+$/,
  ];

  private isHallucination(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    if (trimmed.length < 2) return true;
    for (const pattern of Orchestrator.HALLUCINATION_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
    // Reject text with non-Latin scripts (Cyrillic, CJK, Arabic, Devanagari, etc.)
    // This catches Whisper hallucinating in wrong languages (e.g. Croatian "Oveđe reći njepu")
    const latinChars = (trimmed.match(/[\p{Script=Latin}]/gu) || []).length;
    const totalAlpha = (trimmed.match(/[\p{L}]/gu) || []).length;
    if (totalAlpha > 3 && latinChars / totalAlpha < 0.8) return true;
    // Reject very short results with special chars that look garbled
    const garbled = (trimmed.match(/[đřšžćčňťďǎǔǐǒě]/g) || []).length;
    if (garbled > 2 && trimmed.length < 40) return true;
    return false;
  }

  async processUtterance(transcript: string): Promise<void> {
    if (this.isHallucination(transcript)) {
      console.log("[orchestrator] ignoring hallucination:", transcript);
      return;
    }

    // If already processing, abort the current one and queue the new utterance
    if (this.isProcessing) {
      // Abort current LLM stream immediately
      this.currentAbortController?.abort();
      // Clear pending TTS — we don't want to keep speaking old response
      this.ttsQueue = [];
      this.ttsRunning = false;
      this.ttsPrefetch = null;
      // Clear playback buffer so old audio stops
      this.audio.clearPlayback().catch(() => {});
      // Queue the new utterance — it will be picked up in the finally block
      this.processingQueue.push(transcript);
      return;
    }

    // If currently speaking, interrupt and proceed with new utterance
    if (this.isSpeaking) {
      this.ttsQueue = [];
      this.ttsRunning = false;
      this.ttsPrefetch = null;
      this.audio.clearPlayback().catch(() => {});
      // Fall through to process immediately
    }

    this.isProcessing = true;
    this.emit("state-change", "thinking");

    const ac = new AbortController();
    this.currentAbortController = ac;

    perfLog("utterance_start", { transcript, queueLen: this.processingQueue.length });
    const t0 = Date.now();

    console.log("[orchestrator] processing utterance:", transcript);

    this.rpc.send("user-speech", { text: transcript });
    this.rpc.send("speaking-state", { speaking: true });

    try {
      const matchingSkills = this.memory.findMatchingSkills(transcript);
      if (matchingSkills.length > 0) {
        this.context.setTriggeredSkills(matchingSkills);
        for (const skill of matchingSkills) {
          this.memory.incrementSkillUse(skill.name);
        }
      } else {
        this.context.setTriggeredSkills([]);
      }

      const t0 = Date.now();
      const messages = this.context.buildMessages(transcript);
      const { tools, grokTools } = await this.getTools();
      console.log(`[orchestrator] sending ${grokTools.length} tools to LLM`);

      let fullResponse = "";
      const sentenceDetector = new SentenceDetector();
      let firstTokenMs = 0;
      let firstSpeakMs = 0;

      let toolCallCount = 0;
      await this.streamWithToolLoop(
        messages,
        grokTools,
        tools,
        ac.signal,
        (chunk) => {
          if (chunk.type === "content") {
            if (!firstTokenMs) firstTokenMs = Date.now() - t0;
            fullResponse += chunk.text;
            this.rpc.send("subtitle", { text: fullResponse });
            const sentences = sentenceDetector.feed(chunk.text);
            for (const sentence of sentences) {
              if (!firstSpeakMs) firstSpeakMs = Date.now() - t0;
              this.enqueueSentence(sentence);
            }
          } else if (chunk.type === "tool_call") {
            toolCallCount++;
            this.rpc.send("tool-call-start", {
              name: chunk.name,
              args: chunk.arguments,
            });
          }
        }
      );

      const remaining = sentenceDetector.flush();
      if (remaining) {
        this.rpc.send("subtitle", { text: fullResponse });
        this.enqueueSentence(remaining);
      }

      console.log(`[perf] first_token=${firstTokenMs}ms first_speak=${firstSpeakMs}ms total_llm=${Date.now() - t0}ms tools=${toolCallCount}`);
      perfLog("llm_done", { firstTokenMs, firstSpeakMs, totalLlmMs: Date.now() - t0, responseLen: fullResponse.length, toolCalls: toolCallCount });

      await this.flushTtsQueue();

      this.context.addExchange(transcript, fullResponse);
      this.memory.saveExchange(transcript, fullResponse);

      const expression = this.inferExpression(fullResponse);
      this.rpc.send("set-expression", { expression });
    } catch (err: any) {
      if (err.name === "AbortError") {
        // aborted by new utterance, not an error
      } else {
        console.error("[orchestrator] error processing utterance:", err);

        const status = err.status ?? err.statusCode ?? 0;
        let userMessage = "Desculpe, tive um problema. Deixa eu tentar de novo.";

        if (err.message?.includes("daemon") || err.message?.includes("0 tools")) {
          userMessage = "Desculpe, estou sem acesso às ferramentas do sistema. Reinicia o app pra resolver.";
        } else if (status === 401) {
          userMessage = "Desculpe, tem um problema de autenticação com a IA. Verifica sua API key do OpenRouter.";
        } else if (status === 429) {
          userMessage = "Desculpe, o serviço de IA está com limite de requisições. Espera um momento e tenta de novo.";
        } else if (status >= 500) {
          userMessage = "Desculpe, o serviço de IA está com problemas. Tento de novo em breve.";
        } else if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ERR_NETWORK") {
          userMessage = "Desculpe, não consigo acessar o serviço de IA. Verifica sua conexão.";
        }

        this.rpc.send("error", { message: userMessage });
        this.rpc.send("subtitle", { text: userMessage });

        if (this.ttsQueue.length > 0) {
          await this.flushTtsQueue();
        }

        try {
          await this.speakSentence(this.cleanForTTS(userMessage) || userMessage);
        } catch (ttsErr: any) {
          console.warn("[orchestrator] fallback TTS failed:", ttsErr.message);
        }
      }
    } finally {
      if (this.currentAbortController === ac) {
        this.currentAbortController = null;
      }
      this.rpc.send("speaking-state", { speaking: false });
      this.isProcessing = false;
      perfLog("utterance_done", { totalMs: Date.now() - t0, queueRemaining: this.processingQueue.length });

      if (this.processingQueue.length > 0) {
        const next = this.processingQueue.shift()!;
        perfLog("queue_pop", { next: next.slice(0, 80) });
        setImmediate(() => this.processUtterance(next));
      } else {
        this.emit("state-change", "listening");
      }
    }
  }

  handleConfirmationResponse(approved: boolean): void {
    if (this.pendingConfirmation) {
      clearTimeout(this.pendingConfirmation.timer);
      this.pendingConfirmation.resolve(approved);
      this.pendingConfirmation = null;
    }
  }

  private async confirmTool(name: string, args: string): Promise<boolean> {
    this.rpc.send("tool-confirmation-request", {
      name,
      args,
      dangerous: true,
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirmation = null;
        resolve(false);
      }, CONFIRMATION_TIMEOUT_MS);

      this.pendingConfirmation = { promise: Promise.resolve(false), resolve, timer };
    });
  }

  private async streamWithToolLoop(
    messages: Message[],
    tools: ToolDef[],
    toolSchemas: ToolSchemaDef[],
    signal: AbortSignal,
    onChunk: (chunk: StreamChunk) => void,
    depth = 0
  ): Promise<void> {
    if (depth > 3) {
      console.warn("[orchestrator] max tool call depth reached");
      return;
    }

    const toolCallResults: Array<{
      id: string;
      name: string;
      arguments: string;
    }> = [];
    const rawToolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];

    for await (const chunk of this.grok.chatStream(messages, tools, signal)) {
      onChunk(chunk);

      if (chunk.type === "tool_call") {
        toolCallResults.push({
          id: chunk.id,
          name: chunk.name,
          arguments: chunk.arguments,
        });
        rawToolCalls.push({
          id: chunk.id,
          type: "function",
          function: {
            name: chunk.name,
            arguments: chunk.arguments,
          },
        });
      }
    }

    if (toolCallResults.length === 0) return;

    const toolMessages: Message[] = [];
    for (const tc of toolCallResults) {
      const schema = toolSchemas.find((s) => s.name === tc.name);

      if (schema?.dangerous) {
        const approved = await this.confirmTool(tc.name, tc.arguments);
        if (!approved) {
          this.rpc.send("tool-call-result", {
            name: tc.name,
            result: "Tool call rejected by user.",
            success: false,
          });
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: "The user declined to execute this tool. Respond accordingly and suggest an alternative if possible.",
          });
          continue;
        }
      }

      if (Orchestrator.LOCAL_TOOL_NAMES.has(tc.name)) {
        const memResult = this.executeMemoryTool(tc.name, tc.arguments);
        this.rpc.send("tool-call-result", {
          name: tc.name,
          result: memResult,
          success: true,
        });
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: memResult,
        });
        continue;
      }

      try {
        const result = await this.daemon.executeTool(tc.name, tc.arguments);

        const truncated = result.result.length > 500
          ? result.result.slice(0, 500) + "..."
          : result.result;

        this.rpc.send("tool-call-result", {
          name: tc.name,
          result: truncated,
          success: result.success,
        });

        const screenshotMatch = result.result?.match(
          /^\[SCREENSHOT:(\d+)x(\d+):(.+)\]$/
        );
        if (screenshotMatch) {
          this.context.setVisionData(screenshotMatch[3]);
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: "Screenshot captured and attached as vision data.",
          });
        } else {
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: result.success
              ? result.result
              : `Error: ${result.error}`,
          });
        }
      } catch (err: any) {
        this.rpc.send("tool-call-result", {
          name: tc.name,
          result: `Error: ${err.message}`,
          success: false,
        });
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: `Error executing tool: ${err.message}`,
        });
      }
    }

    const continuationMessages: Message[] = [
      ...messages,
      {
        role: "assistant",
        content: null,
        tool_calls: rawToolCalls,
      },
      ...toolMessages,
    ];

    await this.streamWithToolLoop(
      continuationMessages,
      tools,
      toolSchemas,
      signal,
      onChunk,
      depth + 1
    );
  }

  private ttsDrainPromise: Promise<void> | null = null;
  private ttsPrefetch: Promise<{ pcmData: Uint8Array; sampleRate: number; durationMs: number } | null> | null = null;

  private enqueueSentence(sentence: string): void {
    const cleaned = this.cleanForTTS(sentence);
    if (!cleaned) return;
    perfLog("tts_enqueue", { sentence: cleaned.slice(0, 80), queueLen: this.ttsQueue.length });
    this.ttsQueue.push(cleaned);
    if (!this.ttsRunning) {
      this.isSpeaking = true;
      this.emit("state-change", "speaking");
      this.ttsRunning = true;
      this.ttsDrainPromise = this.drainTtsQueue();
    } else if (this.ttsQueue.length === 1 && !this.ttsPrefetch) {
      this.prefetchNext();
    }
  }

  private prefetchNext(): void {
    if (this.ttsQueue.length === 0) return;
    const sentence = this.ttsQueue[0];
    // Prefetch via Kokoro (local, fast) — prefetch is only used for external TTS
    // With Kokoro as primary, prefetch is not needed since synthesize is fast
    // Keep this for ElevenLabs fallback path
    const voiceSpeed = typeof this.cfg.defaultVoiceSpeed === "number"
      ? this.cfg.defaultVoiceSpeed
      : 1.0;
    this.ttsPrefetch = this.tts.synthesize(sentence, voiceSpeed)
      .then(result => result)
      .catch(() => null);
  }

  private async drainTtsQueue(): Promise<void> {
    while (this.ttsQueue.length > 0) {
      const sentence = this.ttsQueue.shift()!;
      // Check if aborted
      if (this.currentAbortController?.signal.aborted) {
        this.ttsQueue = [];
        break;
      }
      // Kokoro is now primary — speakSentence handles it directly
      // The prefetch path is for ElevenLabs fallback only
      if (this.ttsPrefetch) {
        // If we have a prefetched ElevenLabs result, use it
        const result = await this.ttsPrefetch;
        this.ttsPrefetch = null;
        if (result) {
          const enqueueResult = await this.audio.enqueuePCM(result.pcmData, result.sampleRate);
          console.log("[tts] speaking (prefetched):", sentence.slice(0, 80), `(${Math.round(enqueueResult.durationMs)}ms)`);
        } else {
          await this.speakSentence(sentence);
        }
      } else {
        await this.speakSentence(sentence);
      }
    }
    this.ttsRunning = false;
    this.ttsDrainPromise = null;
    this.ttsPrefetch = null;
    this.isSpeaking = false;
  }

  private async flushTtsQueue(): Promise<void> {
    if (this.ttsDrainPromise) {
      await this.ttsDrainPromise;
    }
    if (this.ttsQueue.length > 0 || this.ttsRunning) {
      await this.drainTtsQueue();
    }
  }

  private async speakSentence(sentence: string): Promise<void> {
    const t0 = Date.now();
    try {
      const voiceSpeed = typeof this.cfg.defaultVoiceSpeed === "number"
        ? this.cfg.defaultVoiceSpeed
        : 1.0;

      perfLog("tts_synthesize_start", { sentence: sentence.slice(0, 80) });
      const result = await this.tts.synthesize(sentence, voiceSpeed);
      perfLog("tts_synthesize_done", { bytes: result.pcmData.length, sampleRate: result.sampleRate, durationMs: result.durationMs, ttsMs: Date.now() - t0 });

      console.log("[tts] enqueuing PCM:", result.pcmData.length, "bytes", result.sampleRate, "Hz");
      const enqueueResult = await this.audio.enqueuePCM(result.pcmData, result.sampleRate);
      perfLog("tts_enqueue_pcm", { samplesEnqueued: enqueueResult.samplesEnqueued, durationMs: enqueueResult.durationMs });
      console.log("[tts] speaking:", sentence.slice(0, 80), `(${Math.round(enqueueResult.durationMs)}ms)`);
    } catch (err: any) {
      perfLog("tts_failed", { error: err.message, ms: Date.now() - t0 });
      console.warn("[tts] synthesis failed:", err.message);
    }
  }

  private cleanForTTS(text: string): string {
    let cleaned = text;

    if (/^[-*]\s/.test(cleaned)) {
      cleaned = cleaned.replace(/^[-*]\s+/, "");
    }

    cleaned = cleaned.replace(/```[\s\S]*?```/g, "here is the code");
    cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

    cleaned = cleaned.replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{FE0F}]/gu,
      ""
    );

    cleaned = cleaned.replace(/\s+/g, " ").trim();

    return cleaned;
  }

  private async getTools(): Promise<{
    tools: ToolSchemaDef[];
    grokTools: ToolDef[];
  }> {
    if (this.toolsCache && Date.now() < this.toolsCache.expiry) {
      return {
        tools: this.toolsCache.tools,
        grokTools: this.toolsCache.grokTools,
      };
    }

    let daemonTools: ToolSchemaDef[] = [];
    try {
      if (!this.daemon.isConnected()) {
        console.warn("[orchestrator] daemon disconnected, attempting reconnect...");
        await this.daemon.connect();
      }
      daemonTools = await this.daemon.listTools();
    } catch (err: any) {
      console.warn("[orchestrator] failed to list daemon tools:", err.message);
    }

    const tools = [...Orchestrator.MEMORY_TOOLS, ...daemonTools];
    const grokTools = this.context.getToolsAsGrokTools(tools);
    this.toolsCache = {
      tools,
      grokTools,
      expiry: Date.now() + 60_000,
    };
    return { tools, grokTools };
  }

  private executeMemoryTool(name: string, argsJson: string): string {
    try {
      const args = JSON.parse(argsJson);
      switch (name) {
        case "memory_add": {
          const res = this.memory.addFact(args.category, args.content);
          if (res.success) {
            return `Fact saved. ${res.usage}`;
          }
          return `Error: ${res.error}`;
        }
        case "memory_replace": {
          const res = this.memory.replaceFact(args.old_text, args.new_content);
          if (res.success) {
            return "Fact updated successfully.";
          }
          return `Error: ${res.error}`;
        }
        case "memory_remove": {
          const res = this.memory.removeFact(args.old_text);
          if (res.success) {
            return "Fact removed successfully.";
          }
          return `Error: ${res.error}`;
        }
        case "memory_search": {
          const results = this.memory.searchConversations(args.query, args.limit ?? 5);
          if (results.length === 0) {
            return "No matching conversations found.";
          }
          return results
            .map(r => `[${new Date(r.timestampMs).toLocaleDateString()}] ${r.role}: ${r.snippet}`)
            .join("\n\n");
        }
        case "skill_create": {
          const res = this.memory.createSkill(args.name, args.description, args.trigger_pattern, args.procedure);
          if (res.success) {
            return `Skill "${args.name}" created successfully.`;
          }
          return `Error: ${res.error}`;
        }
        case "skill_update": {
          const res = this.memory.updateSkill(args.name, {
            description: args.description,
            triggerPattern: args.trigger_pattern,
            procedure: args.procedure,
          });
          if (res.success) {
            return `Skill "${args.name}" updated successfully.`;
          }
          return `Error: ${res.error}`;
        }
        case "skill_delete": {
          const res = this.memory.deleteSkill(args.name);
          if (res.success) {
            return `Skill "${args.name}" deleted.`;
          }
          return `Error: ${res.error}`;
        }
        case "skill_list": {
          const skills = this.memory.listSkills();
          if (skills.length === 0) {
            return "No skills created yet. Use skill_create after completing complex tasks.";
          }
          return skills.map(s =>
            `• ${s.name}: ${s.description} [triggers: ${s.triggerPattern}] (used ${s.useCount}x)`
          ).join("\n");
        }
        case "skill_use": {
          const skill = this.memory.getSkill(args.name);
          if (!skill) {
            return `Skill "${args.name}" not found. Use skill_list to see available skills.`;
          }
          this.memory.incrementSkillUse(args.name);
          return `SKILL: ${skill.name}\n${skill.procedure}`;
        }
        default:
          return `Unknown memory tool: ${name}`;
      }
    } catch (err: any) {
      return `Error executing ${name}: ${err.message}`;
    }
  }

  private async generateAndSaveSummary(): Promise<void> {
    try {
      const exchangeCount = this.memory.getSessionExchangeCount();
      if (exchangeCount === 0) return;
      const startTime = this.memory.getSessionStartTime();
      const exchanges = this.memory.getRecentExchanges(100);
      const formatted = exchanges.map(e => `${e.role}: ${e.content}`).join("\n").slice(0, 8000);
      const summaryPrompt = `Summarize this conversation in 2-3 concise sentences. Focus on what was discussed, what was decided, and any important outcomes. Write in English. Be terse.\n\nCONVERSATION:\n${formatted}`;
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.cfg.llmModel ?? "x-ai/grok-4.1-fast",
          messages: [{ role: "user", content: summaryPrompt }],
          max_tokens: 200,
          temperature: 0.3,
        }),
      });
      const data = await response.json() as any;
      const summary = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (summary) {
        this.memory.saveSessionSummary(summary, exchangeCount, startTime ?? undefined);
      }
    } catch (err: any) {
      console.warn("[orchestrator] failed to generate session summary:", err.message);
    }
  }

  inferExpression(
    text: string
  ): "neutral" | "happy" | "sad" | "alert" {
    const lower = text.toLowerCase();
    if (
      lower.includes("happy") ||
      lower.includes("great") ||
      lower.includes("awesome") ||
      lower.includes("thank")
    ) {
      return "happy";
    }
    if (
      lower.includes("sad") ||
      lower.includes("sorry") ||
      lower.includes("unfortunately")
    ) {
      return "sad";
    }
    if (
      lower.includes("alert") ||
      lower.includes("warning") ||
      lower.includes("critical") ||
      lower.includes("error")
    ) {
      return "alert";
    }
    return "neutral";
  }

  private async proactiveSpeak(text: string): Promise<void> {
    if (this.isSpeaking || this.isProcessing) return;
    this.isSpeaking = true;
    this.emit("state-change", "speaking");
    await this.speakSentence(this.cleanForTTS(text) || text);
    this.rpc.send("subtitle", { text });
    this.isSpeaking = false;
    this.emit("state-change", "listening");
  }

  private static readonly CPU_ALERT_COOLDOWN_MS = 300_000;

  private checkCpuAlert(snapshot: AwarenessSnapshot): void {
    const threshold = this.cfg.cpuAlertThreshold ?? 90;
    if (snapshot.metrics && snapshot.metrics.cpuPercent > threshold) {
      const now = Date.now();
      if (now - this.lastCpuAlertTime > Orchestrator.CPU_ALERT_COOLDOWN_MS) {
        this.lastCpuAlertTime = now;
        this.proactiveSpeak(
          `Your CPU usage is above ${threshold}%. You might want to close some applications.`
        );
      }
    }
  }

  private captureStarted = false;

  setMuted(muted: boolean): void {
    perfLog("set_muted", { muted, captureStarted: this.captureStarted, isProcessing: this.isProcessing, isSpeaking: this.isSpeaking });
    this.muted = muted;
    if (muted) {
      // Just stop recording to PTT buffer, keep capture stream alive
      this.audio.setPttRecording(false).then((res) => {
        console.log("[orchestrator] PTT recording OFF:", res);
      }).catch((err: any) => {
        console.error("[orchestrator] setPttRecording(false) failed:", err.message);
      });
      this.emit("state-change", "idle");
      console.log("[orchestrator] MUTED — recording stopped, capture still running");
    } else {
      // Start recording to PTT buffer (capture is already running)
      if (!this.captureStarted) {
        // First time: need to actually start capture
        this.captureStarted = true;
        this.audio.startCapture({
          sampleRate: this.cfg.sampleRate ?? 16000,
          vadThreshold: this.cfg.vadThreshold ?? 0.2,
          deviceId: this.cfg.deviceId,
        }).then(async (status) => {
          console.log("[orchestrator] Capture started (persistent):", status);
          perfLog("capture_started", { deviceName: status.deviceName });
          try {
            const res = await this.audio.setPttRecording(true);
            console.log("[orchestrator] PTT recording ON:", res);
            perfLog("ptt_recording_on", { bufferedSamples: res.bufferedSamples });
          } catch (err: any) {
            console.error("[orchestrator] setPttRecording(true) failed:", err.message);
            perfLog("ptt_recording_error", { error: err.message });
          }
        }).catch((err: any) => {
          // ALREADY_EXISTS means capture is already running from boot — that's fine
          if (err.message?.includes('ALREADY_EXISTS')) {
            console.log("[orchestrator] Capture already running, starting recording");
            perfLog("capture_already_running", {});
            this.audio.setPttRecording(true).then((res) => {
              console.log("[orchestrator] PTT recording ON (already running):", res);
              perfLog("ptt_recording_on_existing", { bufferedSamples: res.bufferedSamples });
            }).catch((err2: any) => {
              console.error("[orchestrator] setPttRecording(true) failed:", err2.message);
              perfLog("ptt_recording_error", { error: err2.message });
            });
          } else {
            console.warn("[orchestrator] startCapture failed:", err.message);
            perfLog("capture_start_error", { error: err.message });
            this.captureStarted = false;
          }
        });
      } else {
        // Capture already running, just start recording
        this.audio.setPttRecording(true).then((res) => {
          console.log("[orchestrator] PTT recording ON (reuse):", res);
          perfLog("ptt_recording_on_reuse", { bufferedSamples: res.bufferedSamples });
        }).catch((err: any) => {
          console.error("[orchestrator] setPttRecording(true) reuse failed:", err.message);
          perfLog("ptt_recording_error_reuse", { error: err.message });
        });
        console.log("[orchestrator] UNMUTED — recording started (capture already running)");
      }
      this.emit("state-change", "listening");
    }
  }

  async stop(): Promise<void> {
    this.currentAbortController?.abort();
    this.currentAbortController = null;

    this.ttsQueue = [];
    this.ttsRunning = false;
    this.isSpeaking = false;
    this.isProcessing = false;
    this.processingQueue = [];

    if (this.unsubTranscription) {
      this.unsubTranscription();
      this.unsubTranscription = null;
    }

    this.daemon.stopAwarenessStream();

    try {
      await this.audio.stopCapture();
    } catch (err: any) {
      console.warn("[orchestrator] stopCapture error during shutdown:", err.message);
    }

    try {
      await this.audio.disconnect();
    } catch (err: any) {
      console.warn("[orchestrator] audio disconnect error:", err.message);
    }

    try {
      await this.daemon.disconnect();
    } catch (err: any) {
      console.warn("[orchestrator] daemon disconnect error:", err.message);
    }

    await this.generateAndSaveSummary();

    this.memory.close();

    this.started = false;
    this.removeAllListeners();
    console.log("[orchestrator] stopped");
  }
}
