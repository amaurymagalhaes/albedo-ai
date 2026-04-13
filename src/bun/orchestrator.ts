import { AudioClient } from "./rpc/audio-client";
import { DaemonClient, type ToolSchemaDef } from "./rpc/daemon-client";
import {
  GrokClient,
  type Message,
  type StreamChunk,
  type ToolDef,
} from "./grok-client";
import { ContextManager, SentenceDetector } from "./context-manager";
import { Memory } from "./memory";
import { config } from "./config";

interface ToolsCache {
  tools: ToolSchemaDef[];
  grokTools: ToolDef[];
  expiry: number;
}

export class Orchestrator {
  private audio: AudioClient;
  private daemon: DaemonClient;
  private grok: GrokClient;
  private context: ContextManager;
  private memory: Memory;
  private rpc: any;

  private toolsCache: ToolsCache | null = null;
  private ttsQueue: string[] = [];
  private ttsRunning = false;
  private currentAbortController: AbortController | null = null;
  private started = false;
  private unsubTranscription: (() => void) | null = null;

  constructor(rpc: any) {
    this.rpc = rpc;

    const audioSocket =
      process.env.ALBEDO_AUDIO_SOCKET ?? "unix:///tmp/albedo-audio.sock";
    const daemonSocket =
      process.env.ALBEDO_DAEMON_SOCKET ?? "unix:///tmp/albedo-daemon.sock";

    this.audio = new AudioClient(audioSocket);
    this.daemon = new DaemonClient(daemonSocket);
    this.grok = new GrokClient({
      apiKey: process.env.XAI_API_KEY ?? "",
      model: process.env.GROK_MODEL ?? "grok-4-fast",
      baseUrl: "https://api.x.ai/v1",
      maxTokens: 4096,
      temperature: 0.7,
    });
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
      await this.audio.startCapture({
        sampleRate: 16000,
        vadThreshold: 0.5,
      });
      console.log("[orchestrator] audio capture started");
    } catch (err: any) {
      console.warn("[orchestrator] audio capture failed:", err.message);
    }

    try {
      this.daemon.streamAwareness(
        { intervalMs: 5000, includeClipboard: true, includeScreenOcr: false },
        (snapshot) => {
          this.context.updateAwareness(snapshot);
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

    console.log("[orchestrator] started");
  }

  async processUtterance(transcript: string): Promise<void> {
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
      const { grokTools } = await this.getTools();

      let fullResponse = "";
      const sentenceDetector = new SentenceDetector();
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

      await this.streamWithToolLoop(
        messages,
        grokTools,
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
      if (err.name === "AbortError") return;
      console.error("[orchestrator] error processing utterance:", err);
      this.rpc.send("subtitle", {
        text: "Sorry, I encountered an error.",
      });
    } finally {
      if (this.currentAbortController === ac) {
        this.currentAbortController = null;
      }
      this.rpc.send("speaking-state", { speaking: false });
    }
  }

  private async streamWithToolLoop(
    messages: Message[],
    tools: ToolDef[],
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
      try {
        const result = await this.daemon.executeTool(tc.name, tc.arguments);

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
      signal,
      onChunk,
      depth + 1
    );
  }

  private enqueueSentence(sentence: string): void {
    const cleaned = this.cleanForTTS(sentence);
    if (!cleaned) return;
    this.ttsQueue.push(cleaned);
    if (!this.ttsRunning) this.drainTtsQueue();
  }

  private async drainTtsQueue(): Promise<void> {
    this.ttsRunning = true;
    while (this.ttsQueue.length > 0) {
      const sentence = this.ttsQueue.shift()!;
      await this.speakSentence(sentence);
    }
    this.ttsRunning = false;
  }

  private async speakSentence(sentence: string): Promise<void> {
    try {
      const voiceSpeed = Number(config.get("voice-speed")) || 1.0;
      const result = await this.audio.synthesize({
        text: sentence,
        voiceId: "default",
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

  async stop(): Promise<void> {
    this.currentAbortController?.abort();
    this.currentAbortController = null;

    this.ttsQueue = [];
    this.ttsRunning = false;

    this.daemon.stopAwarenessStream();

    if (this.unsubTranscription) {
      this.unsubTranscription();
      this.unsubTranscription = null;
    }

    try {
      await this.audio.stopCapture();
    } catch (err: any) {
      console.warn("[orchestrator] stopCapture error during shutdown:", err.message);
    }

    this.audio.close();
    this.daemon.close();
    this.memory.close();

    this.started = false;
    console.log("[orchestrator] stopped");
  }
}
