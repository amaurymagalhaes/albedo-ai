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
  private pendingConfirmation: {
    promise: Promise<boolean>;
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private lastCpuAlertTime = 0;

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

    this.memory = new Memory();
    this.context = new ContextManager();

    const recentTurns = this.memory.getRecentExchanges(20);
    if (recentTurns.length > 0) {
      this.context.loadHistory(recentTurns);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    console.log("[orchestrator] starting...");

    try {
      await this.audio.connect();
      console.log("[orchestrator] audio client connected");
    } catch (err: any) {
      console.warn("[orchestrator] audio connect failed:", err.message);
    }

    try {
      await this.daemon.connect();
      console.log("[orchestrator] daemon client connected");
    } catch (err: any) {
      console.warn("[orchestrator] daemon connect failed:", err.message);
    }

    try {
      await this.audio.startCapture({
        sampleRate: this.cfg.sampleRate ?? 16000,
        vadThreshold: this.cfg.vadThreshold ?? 0.5,
      });
      console.log("[orchestrator] audio capture started");
    } catch (err: any) {
      console.warn("[orchestrator] audio capture failed:", err.message);
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
      console.warn("[orchestrator] awareness stream failed:", err.message);
    }

    this.unsubTranscription = this.audio.onTranscription((result) => {
      if (result.isFinal && result.text.trim()) {
        this.processUtterance(result.text.trim());
      }
    });

    this.emit("state-change", "listening");
    console.log("[orchestrator] started");
  }

  async processUtterance(transcript: string): Promise<void> {
    if (this.isProcessing || this.isSpeaking) {
      this.processingQueue.push(transcript);
      return;
    }

    this.isProcessing = true;
    this.emit("state-change", "thinking");

    this.currentAbortController?.abort();
    this.ttsQueue = [];
    this.ttsRunning = false;

    const ac = new AbortController();
    this.currentAbortController = ac;

    console.log("[orchestrator] processing utterance:", transcript);

    this.rpc.send("user-speech", { text: transcript });
    this.rpc.send("speaking-state", { speaking: true });

    try {
      const messages = this.context.buildMessages(transcript);
      const { tools, grokTools } = await this.getTools();

      let fullResponse = "";
      const sentenceDetector = new SentenceDetector();

      await this.streamWithToolLoop(
        messages,
        grokTools,
        tools,
        ac.signal,
        (chunk) => {
          if (chunk.type === "content") {
            fullResponse += chunk.text;
            const sentences = sentenceDetector.feed(chunk.text);
            for (const sentence of sentences) {
              this.rpc.send("subtitle", { text: sentence });
              this.enqueueSentence(sentence);
            }
          } else if (chunk.type === "tool_call") {
            this.rpc.send("tool-call-start", {
              name: chunk.name,
              args: chunk.arguments,
            });
          }
        }
      );

      const remaining = sentenceDetector.flush();
      if (remaining) {
        this.rpc.send("subtitle", { text: remaining });
        this.enqueueSentence(remaining);
      }

      await this.drainTtsQueue();

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
        let userMessage = "Sorry, I ran into an issue. Let me try again.";

        if (status === 401) {
          userMessage = "Sorry, there's an authentication issue with the AI service. Please check your API key.";
        } else if (status === 429) {
          userMessage = "Sorry, the AI service is rate-limited. Please wait a moment and try again.";
        } else if (status >= 500) {
          userMessage = "Sorry, the AI service is having problems. Let me try again shortly.";
        } else if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ERR_NETWORK") {
          userMessage = "Sorry, I can't reach the AI service. Please check your internet connection.";
        }

        this.rpc.send("error", { message: userMessage });
        this.rpc.send("subtitle", { text: userMessage });

        if (this.ttsQueue.length > 0) {
          await this.drainTtsQueue();
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

      if (this.processingQueue.length > 0) {
        const next = this.processingQueue.shift()!;
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

  private enqueueSentence(sentence: string): void {
    const cleaned = this.cleanForTTS(sentence);
    if (!cleaned) return;
    this.ttsQueue.push(cleaned);
    if (!this.ttsRunning) {
      this.isSpeaking = true;
      this.emit("state-change", "speaking");
      this.drainTtsQueue();
    }
  }

  private async drainTtsQueue(): Promise<void> {
    this.ttsRunning = true;
    while (this.ttsQueue.length > 0) {
      const sentence = this.ttsQueue.shift()!;
      await this.speakSentence(sentence);
    }
    this.ttsRunning = false;
    this.isSpeaking = false;
  }

  private async speakSentence(sentence: string): Promise<void> {
    try {
      const voiceSpeed = typeof this.cfg.defaultVoiceSpeed === "number"
        ? this.cfg.defaultVoiceSpeed
        : 1.0;
      const result = await this.audio.synthesize({
        text: sentence,
        voiceId: this.cfg.defaultVoiceId ?? "default",
        speed: voiceSpeed,
      });

      this.rpc.send("visemes", {
        visemes: result.visemes.map((v) => ({
          shape: v.shape,
          startMs: v.startMs,
          durationMs: v.durationMs,
          weight: v.weight,
        })),
      });

      console.log("[tts] speaking:", sentence.slice(0, 80));
    } catch (err: any) {
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

    return cleaned.trim();
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

    try {
      const tools = await this.daemon.listTools();
      const grokTools = this.context.getToolsAsGrokTools(tools);
      this.toolsCache = {
        tools,
        grokTools,
        expiry: Date.now() + 60_000,
      };
      return { tools, grokTools };
    } catch (err: any) {
      console.warn("[orchestrator] failed to list tools:", err.message);
      return { tools: [], grokTools: [] };
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

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      try {
        this.audio.stopCapture();
      } catch (err: any) {
        console.warn("[orchestrator] stopCapture on mute failed:", err.message);
      }
      this.emit("state-change", "idle");
    } else {
      try {
        this.audio.startCapture({
          sampleRate: this.cfg.sampleRate ?? 16000,
          vadThreshold: this.cfg.vadThreshold ?? 0.5,
        });
      } catch (err: any) {
        console.warn("[orchestrator] startCapture on unmute failed:", err.message);
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

    this.memory.close();

    this.started = false;
    this.removeAllListeners();
    console.log("[orchestrator] stopped");
  }
}
