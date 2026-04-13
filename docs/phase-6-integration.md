# Phase 6: Integration

**Status:** Planned  
**Estimated Duration:** 3–4 days  
**Depends On:** Phases 0–5 complete and individually validated

---

## Objective

Phase 6 delivers the **complete, working Albedo AI application** by wiring every previously built subsystem into a single cohesive runtime. At the end of this phase:

- Speaking to the microphone produces a voice response from the Live2D avatar with synchronized lip movements and subtitle display.
- The Grok LLM can invoke tools via the Go daemon (file reads, shell commands, app control, screenshots) and incorporate their results into its replies.
- Ambient system awareness (active window, CPU/RAM, clipboard) is continuously injected into the LLM context.
- The Electrobun main process (`src/bun/index.ts`) acts as the central conductor: it spawns both native binaries, manages their lifecycle, handles crashes, and routes all inter-system messages.
- A system tray icon provides quick access to show/hide, mute, settings, and quit.
- The application starts cleanly from a single `bun start` or `make dev` invocation and shuts down cleanly without leaving orphaned processes or stale sockets.

---

## Prerequisites

All of the following phases must be complete, individually buildable, and manually verified before beginning Phase 6:

| Phase | Deliverable | Validation Gate |
|-------|-------------|-----------------|
| **0. Scaffold** | `proto/audio.proto`, `proto/daemon.proto`, `Makefile`, `electrobun.config.ts`, project skeleton | `make proto` runs without errors; directory tree matches spec |
| **1. Audio MVP** | `audio-engine/` Rust crate: mic capture → VAD → Whisper STT → gRPC server on `/tmp/albedo-audio.sock` | Running `./bin/albedo-audio` and sending a `StartCapture` then `StreamSTT` RPC returns transcription text |
| **2. TTS + Lip Sync** | Rust: Kokoro TTS ONNX inference → PCM audio → visemes → `SynthesizeResponse` | Calling `Synthesize("Hello world")` returns audio bytes + at least 3 viseme entries; audio plays correctly |
| **3. Orchestrator** | `src/bun/orchestrator.ts`, `src/bun/grok-client.ts`, `src/bun/context-manager.ts` | Unit test: `GrokClient.chatStream()` returns streaming tokens; `ContextManager.buildMessages()` returns valid messages array |
| **4. Avatar UI** | `src/views/mainview/`: Live2D avatar renders, `useRPC.ts` hook wired, `Subtitles.tsx` and `Avatar.tsx` respond to RPC events | Manually emitting `visemes` and `subtitle` RPC events from Bun REPL updates the webview in real time |
| **5. Daemon** | `daemon/` Go module: awareness collector + tool registry + gRPC server on `/tmp/albedo-daemon.sock` | Running `./bin/albedo-daemon` and calling `GetAwareness` returns a populated `AwarenessSnapshot`; `ListTools` returns at least 5 tools |

Additionally, ensure:

- `XAI_API_KEY` is set and a test call to `https://api.x.ai/v1/chat/completions` succeeds.
- `bin/albedo-audio` and `bin/albedo-daemon` are compiled release binaries present in the `bin/` directory.
- Model files are present: `assets/whisper/ggml-base.bin`, `assets/voices/default.onnx`, and Live2D model assets under `assets/models/`.

---

## Step-by-Step Tasks

### Task 1 — Audit and finalise `src/bun/config.ts`

**File:** `src/bun/config.ts`

Define a single authoritative configuration object that all other Bun modules import. Do not scatter `process.env` reads across the codebase.

```typescript
export interface AlbedoConfig {
  xaiApiKey: string;
  grokModel: string;
  grokBaseUrl: string;
  grokMaxTokens: number;
  grokTemperature: number;
  audioSocketPath: string;
  daemonSocketPath: string;
  audioBinPath: string;
  daemonBinPath: string;
  whisperModelPath: string;
  voiceModelPath: string;
  vadThreshold: number;
  sampleRate: number;
  defaultVoiceId: string;
  defaultVoiceSpeed: number;
  awarenessIntervalMs: number;
  cpuAlertThreshold: number;
  socketReadyTimeoutMs: number;
  processRestartDelayMs: number;
  maxProcessRestarts: number;
}
```

- Load from environment variables first, then a JSON config file at `~/.config/albedo-ai/config.json` if present, then fall back to defaults.
- Throw a descriptive error at startup if `XAI_API_KEY` is missing — do not silently use an empty string.
- Export a single frozen `config: AlbedoConfig` instance.

Default socket paths:
- Linux/macOS: `/tmp/albedo-audio.sock` and `/tmp/albedo-daemon.sock`
- Windows: `\\.\pipe\albedo-audio` and `\\.\pipe\albedo-daemon`
- Detect at runtime with `process.platform`.

---

### Task 2 — Implement `src/bun/process-manager.ts`

**File:** `src/bun/process-manager.ts` (new file)

Extract all child-process lifecycle logic out of `index.ts` into a dedicated `ProcessManager` class. This is the most critical correctness boundary in Phase 6.

**Responsibilities:**

1. **Spawn** `albedo-audio` and `albedo-daemon` with `Bun.spawn()` (preferred) or Node's `child_process.spawn`. Set `cwd` to the project root so relative asset paths resolve correctly.
2. **Stream stderr** of each process to the console with a tagged prefix (`[audio]`, `[daemon]`).
3. **Wait for socket readiness** — do not proceed until the Unix socket file exists and accepts a connection. Implement `waitForSocket(path, timeoutMs)` using a polling loop with 50 ms intervals. On timeout, throw a structured error.
4. **Restart on crash** — if a child process exits unexpectedly (non-zero exit code or signal), wait `processRestartDelayMs` (default 1000 ms), then respawn. Track restart count per process. After `maxProcessRestarts` (default 5) consecutive restarts within 60 seconds, emit a `fatal-crash` event and surface a user-visible error dialog rather than looping forever.
5. **Graceful shutdown** — expose a `shutdown()` method that sends `SIGTERM` to both processes, waits up to 3 seconds for clean exit, then `SIGKILL`s any that remain. Remove socket files after shutdown.
6. **Emit typed events** — `spawned`, `ready`, `crash`, `restarting`, `fatal-crash`, `shutdown-complete`.

```typescript
export class ProcessManager extends EventEmitter {
  private processes: Map<string, ManagedProcess>;

  async start(): Promise<void>
  async waitForSocket(socketPath: string, timeoutMs: number): Promise<void>
  async shutdown(): Promise<void>
  getProcess(name: string): ManagedProcess | undefined
}

interface ManagedProcess {
  name: string;
  binPath: string;
  socketPath: string;
  proc: Bun.Subprocess | null;
  restartCount: number;
  lastRestartTime: number;
}
```

---

### Task 3 — Implement `src/bun/rpc/audio-client.ts`

**File:** `src/bun/rpc/audio-client.ts`

The gRPC client wrapping the Rust audio engine. Use the TypeScript stubs generated by `make proto` (via `protoc-gen-ts` into `src/bun/rpc/generated/`).

Key methods to implement:

```typescript
export class AudioClient {
  constructor(socketPath: string)

  // Connection lifecycle
  async connect(): Promise<void>
  async disconnect(): Promise<void>
  isConnected(): boolean

  // Health check — call GetAwareness or any trivial RPC; used by reconnect loop
  async healthCheck(): Promise<boolean>

  // Capture control
  async startCapture(config: CaptureConfig): Promise<CaptureStatus>
  async stopCapture(): Promise<CaptureStatus>

  // TTS
  async synthesize(req: SynthesizeRequest): Promise<SynthesizeResponse>

  // Play PCM audio through Rust playback engine
  async play(pcmData: Uint8Array): Promise<void>

  // Subscribe to transcription events (server-streaming STT)
  onTranscription(handler: (result: TranscriptionResult) => void): void
  offTranscription(): void
}
```

**Reconnection logic:**

- On any gRPC call, if the channel is in `TRANSIENT_FAILURE` or `SHUTDOWN` state, attempt reconnect up to 3 times with exponential backoff (100 ms, 400 ms, 1600 ms) before propagating the error.
- Maintain a `reconnectInterval` that periodically calls `healthCheck()` when disconnected, and re-establishes the capture stream on successful reconnect.
- Log all connection state changes at `[audio-client]` prefix.

---

### Task 4 — Implement `src/bun/rpc/daemon-client.ts`

**File:** `src/bun/rpc/daemon-client.ts`

Symmetric to `AudioClient` but for the Go daemon.

```typescript
export class DaemonClient {
  constructor(socketPath: string)

  async connect(): Promise<void>
  async disconnect(): Promise<void>
  isConnected(): boolean
  async healthCheck(): Promise<boolean>

  // Awareness
  async getAwareness(): Promise<AwarenessSnapshot>
  streamAwareness(
    config: AwarenessConfig,
    onSnapshot: (snap: AwarenessSnapshot) => void,
    onError?: (err: Error) => void
  ): () => void  // returns unsubscribe function

  // Screen capture
  async captureScreen(req: ScreenCaptureRequest): Promise<ScreenCaptureResponse>

  // Tools
  async listTools(): Promise<ToolSchema[]>
  async executeTool(name: string, argsJson: string): Promise<ToolResponse>
}
```

**Awareness stream resilience:** If the `StreamAwareness` gRPC stream drops (network error, daemon crash), the client must re-establish it automatically after reconnect. The `streamAwareness()` method returns an unsubscribe function; internally it re-subscribes on reconnect using the same `config` and `onSnapshot` callback, preserving the caller's subscription contract.

---

### Task 5 — Complete `src/bun/orchestrator.ts`

**File:** `src/bun/orchestrator.ts`

Fill in the remaining pieces of the orchestrator skeleton from the architecture spec:

**5a. Sentence extraction hardening**

The current `extractSentences` implementation using a regex on `fullResponse` will re-emit already-spoken sentences. Replace with a cursor-based approach:

```typescript
private spokenCursor = 0;

private extractNewSentences(fullText: string): string[] {
  const tail = fullText.slice(this.spokenCursor);
  const sentences = tail.match(/[^.!?…]+[.!?…]+(?:\s|$)/g) ?? [];
  if (sentences.length > 0) {
    this.spokenCursor += sentences.join("").length;
  }
  return sentences.map(s => s.trim()).filter(s => s.length > 2);
}
```

Reset `spokenCursor` to 0 at the start of each `processUtterance()` call.

**5b. Tool call round-trip**

When `grok.chatStream()` yields a `tool_call` chunk:
1. Emit `tool-call-start` RPC event to webview (so the avatar can show a "thinking" expression).
2. Call `daemon.executeTool(chunk.name, chunk.arguments)`.
3. Emit `tool-call-result` RPC event to webview with the tool name and truncated result.
4. Append a `tool` role message to the conversation context so Grok continues with the result.
5. If the tool result begins with `[SCREENSHOT:`, decode the base64, set vision data on `ContextManager`, and pass it as an image message to the next Grok call.

**5c. Confirmation gate for dangerous tools**

Before calling `daemon.executeTool()` for any tool flagged `dangerous: true` in `ToolSchema`:
1. Emit `tool-confirmation-request` RPC event to webview with tool name and arguments.
2. Await a `tool-confirmation-response` RPC message from webview with `approved: boolean`.
3. If not approved within 15 seconds, decline and tell Grok the tool was rejected.

**5d. Mute state propagation**

When `setMuted(true)` is called, also call `audio.stopCapture()` to prevent spurious transcriptions. On `setMuted(false)`, call `audio.startCapture()` to resume.

**5e. Error handling in `processUtterance`**

Wrap the entire method body in a try/catch. On error:
- If it is a Grok API error (network, rate limit, invalid key), emit `error` RPC event to webview with a user-friendly message.
- If it is a gRPC error from the audio or daemon client, log it and attempt to continue if possible.
- Speak a fallback phrase via direct TTS if the error is non-fatal: `"Sorry, I ran into an issue. Let me try again."`.

---

### Task 6 — Implement `src/bun/context-manager.ts`

**File:** `src/bun/context-manager.ts`

The `ContextManager` is responsible for assembling the full `messages` array sent to Grok on each turn.

**System prompt construction** (`buildSystemPrompt()`):

```typescript
private buildSystemPrompt(): string {
  const awareness = this.currentAwareness;
  const sections: string[] = [
    `You are Albedo, a highly capable AI desktop assistant.`,
    `You have real-time awareness of the user's system.`,
    awareness ? `## Current System State\n${this.formatAwareness(awareness)}` : "",
    this.visionData ? `## Recent Screenshot\n[Image attached]` : "",
    `## Personality\nBe concise, warm, and practical. Respond in the same language the user speaks.`,
    `## Tools\nYou have access to system tools. Use them proactively when they would help.`,
  ];
  return sections.filter(Boolean).join("\n\n");
}
```

**Message assembly** (`buildMessages(userText)`):

1. System message with current awareness injected.
2. Last N turns from conversation history (default: 20 turns, configurable).
3. If `visionData` is set, attach it as a vision message before the user text.
4. User message.

**Token budget:** Track approximate token count. If the assembled context exceeds 1.8M tokens (safe margin under Grok's 2M limit), truncate oldest history turns first, then reduce awareness detail, never drop the system prompt.

**Long-term memory hook:** Expose `addExchange(userText, assistantText)` which saves to SQLite (Phase 3's `memory.ts`). This is a non-blocking fire-and-forget write.

---

### Task 7 — Complete `src/bun/index.ts`

**File:** `src/bun/index.ts`

This is the application entry point. Replace the simplified skeleton from the spec with the production version.

```typescript
import { BrowserWindow, Tray } from "electrobun/bun";
import { ProcessManager } from "./process-manager";
import { AudioClient } from "./rpc/audio-client";
import { DaemonClient } from "./rpc/daemon-client";
import { Orchestrator } from "./orchestrator";
import { GrokClient } from "./grok-client";
import { config } from "./config";

// ─── 1. Validate configuration ───
// config.ts throws if XAI_API_KEY is missing; no further check needed here.

// ─── 2. Create window (before spawning processes so it appears quickly) ───

const win = new BrowserWindow({
  title: "Albedo AI",
  url: "views://mainview/index.html",
  width: 420,
  height: 650,
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  skipTaskbar: true,
});

win.on("ready-to-show", () => win.show());

// ─── 3. System tray ───

let orchestratorRef: Orchestrator | null = null;

const tray = new Tray({
  icon: "assets/icon.png",
  tooltip: "Albedo AI",
  menu: [
    {
      label: "Show / Hide",
      action: () => (win.isVisible() ? win.hide() : win.show()),
    },
    {
      label: "Mute",
      type: "checkbox",
      checked: false,
      action: (checked: boolean) => orchestratorRef?.setMuted(checked),
    },
    { type: "separator" },
    {
      label: "Settings",
      action: () => win.webview.rpc.emit("open-settings", {}),
    },
    { type: "separator" },
    {
      label: "Quit",
      action: () => shutdown(0),
    },
  ],
});

// ─── 4. Spawn native processes and wait for socket readiness ───

const pm = new ProcessManager(config);

try {
  await pm.start(); // internally spawns both binaries and calls waitForSocket
} catch (err) {
  console.error("[index] Failed to start native processes:", err);
  win.webview.rpc.emit("fatal-error", {
    message: "Failed to start audio engine or daemon. Check that bin/ contains albedo-audio and albedo-daemon.",
    detail: String(err),
  });
  // Keep the window open so the user sees the error; do not exit immediately.
}

// ─── 5. Initialize gRPC clients ───

const audioClient = new AudioClient(config.audioSocketPath);
const daemonClient = new DaemonClient(config.daemonSocketPath);

await audioClient.connect();
await daemonClient.connect();

// ─── 6. Initialize orchestrator and start pipeline ───

const grok = new GrokClient({
  apiKey: config.xaiApiKey,
  model: config.grokModel,
  baseUrl: config.grokBaseUrl,
  maxTokens: config.grokMaxTokens,
  temperature: config.grokTemperature,
});

const orchestrator = new Orchestrator({
  grok,
  audioClient,
  daemonClient,
  win,
  config,
});
orchestratorRef = orchestrator;

await orchestrator.start();

// ─── 7. Wire process manager events to orchestrator ───

pm.on("crash", ({ name }) => {
  console.warn(`[index] Process ${name} crashed — attempting restart`);
  win.webview.rpc.emit("process-status", { name, status: "crashed" });
});

pm.on("restarting", ({ name, attempt }) => {
  console.log(`[index] Restarting ${name} (attempt ${attempt})`);
  win.webview.rpc.emit("process-status", { name, status: "restarting", attempt });
});

pm.on("ready", ({ name }) => {
  console.log(`[index] Process ${name} ready`);
  win.webview.rpc.emit("process-status", { name, status: "ready" });
  // Re-establish gRPC connections after restart
  if (name === "albedo-audio") audioClient.connect().catch(console.error);
  if (name === "albedo-daemon") daemonClient.connect().catch(console.error);
});

pm.on("fatal-crash", ({ name }) => {
  win.webview.rpc.emit("fatal-error", {
    message: `${name} crashed repeatedly and cannot be recovered. Please restart Albedo AI.`,
    detail: "",
  });
});

// ─── 8. Graceful shutdown ───

async function shutdown(code: number) {
  console.log("[index] Shutting down...");
  try {
    await orchestrator.stop();
    await audioClient.disconnect();
    await daemonClient.disconnect();
    await pm.shutdown();
  } catch (err) {
    console.error("[index] Error during shutdown:", err);
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  console.error("[index] Uncaught exception:", err);
  shutdown(1);
});
```

**Important:** Replace the `await Bun.sleep(1000)` hack from the spec skeleton with the proper `pm.start()` socket-readiness wait in `ProcessManager.waitForSocket()`.

---

### Task 8 — Wire webview RPC events

**File:** `src/views/mainview/hooks/useRPC.ts` and `src/views/mainview/App.tsx`

Define all RPC event types in a shared type file at `src/shared/rpc-types.ts` (import from both main process and webview):

```typescript
// src/shared/rpc-types.ts
export interface MainToViewEvents {
  "user-speech":       { text: string };
  "subtitle":          { text: string; isFinal: boolean };
  "visemes":           { visemes: Viseme[] };
  "set-expression":    { expression: string };
  "tool-call-start":   { name: string; args: string };
  "tool-call-result":  { name: string; result: string; success: boolean };
  "tool-confirmation-request": { name: string; args: string; dangerous: boolean };
  "process-status":    { name: string; status: string; attempt?: number };
  "fatal-error":       { message: string; detail: string };
  "open-settings":     {};
}

export interface ViewToMainEvents {
  "tool-confirmation-response": { approved: boolean };
  "text-input":        { text: string };
  "settings-update":   { key: string; value: unknown };
}
```

In `App.tsx`, subscribe to all `MainToViewEvents` using `useRPC` and dispatch to the relevant component state:
- `subtitle` → `Subtitles` component state
- `visemes` → `Avatar` component for Live2D mouth animation
- `set-expression` → `Avatar` expression parameter
- `tool-confirmation-request` → modal dialog component
- `fatal-error` → full-screen error overlay
- `process-status` → optional status indicator in corner

---

### Task 9 — Add awareness injection polling

**File:** `src/bun/orchestrator.ts`

In `Orchestrator.start()`, the daemon's `StreamAwareness` call is wired to `ContextManager.updateAwareness()`. Verify the following flow works end-to-end:

1. `DaemonClient.streamAwareness({ intervalMs: 5000 }, callback)` opens a server-streaming gRPC call.
2. Each snapshot is passed to `ContextManager.updateAwareness(snapshot)` which stores it.
3. On the next `processUtterance()`, `ContextManager.buildMessages()` calls `buildSystemPrompt()` which reads the stored snapshot and formats it as:

```
## Current System State
- Active window: VS Code — "orchestrator.ts"
- CPU: 34% | RAM: 61% | Disk: 42%
- Top process: bun (12.4% CPU)
- Clipboard: (last 100 chars of clipboard)
```

4. The proactive CPU alert (>90% threshold) should call `proactiveSpeak()` which in turn calls `speakSentence()` — verify it does not interrupt an in-progress response. Add an `isSpeaking` flag that gates proactive speech when already responding to the user.

---

### Task 10 — Integration smoke test script

**File:** `scripts/integration-test.ts` (new file)

A standalone Bun script (not a full E2E test framework) that exercises each connection in isolation before the full app starts:

```typescript
#!/usr/bin/env bun
// Usage: bun run scripts/integration-test.ts

import { AudioClient } from "../src/bun/rpc/audio-client";
import { DaemonClient } from "../src/bun/rpc/daemon-client";
import { GrokClient } from "../src/bun/grok-client";
import { config } from "../src/bun/config";

async function testAudio() {
  console.log("── Audio Engine ──");
  const c = new AudioClient(config.audioSocketPath);
  await c.connect();
  const status = await c.startCapture({ sampleRate: 16000, vadThreshold: 0.5 });
  console.assert(status.active, "startCapture should return active=true");
  await c.stopCapture();

  const resp = await c.synthesize({ text: "Hello world", voiceId: "default", speed: 1.0 });
  console.assert(resp.pcmData.length > 0, "synthesize should return audio bytes");
  console.assert(resp.visemes.length > 0, "synthesize should return visemes");
  console.log(`  TTS: ${resp.pcmData.length} bytes, ${resp.visemes.length} visemes ✓`);
  await c.disconnect();
}

async function testDaemon() {
  console.log("── Go Daemon ──");
  const c = new DaemonClient(config.daemonSocketPath);
  await c.connect();

  const snap = await c.getAwareness();
  console.assert(snap.timestampMs > 0, "awareness snapshot must have timestamp");
  console.log(`  Awareness: active window="${snap.activeWindow.title}" CPU=${snap.metrics.cpuPercent}% ✓`);

  const tools = await c.listTools();
  console.assert(tools.length >= 5, "daemon must expose at least 5 tools");
  console.log(`  Tools: ${tools.map(t => t.name).join(", ")} ✓`);

  const result = await c.executeTool("read_file", JSON.stringify({ path: "/etc/hostname" }));
  console.assert(result.success, "read_file should succeed");
  console.log(`  Tool exec: read_file → "${result.result.trim()}" ✓`);

  await c.disconnect();
}

async function testGrok() {
  console.log("── Grok API ──");
  const g = new GrokClient({ apiKey: config.xaiApiKey, model: config.grokModel, baseUrl: config.grokBaseUrl, maxTokens: 64, temperature: 0 });
  let tokens = "";
  for await (const chunk of g.chatStream([{ role: "user", content: "Say only: integration test ok" }], [])) {
    if (chunk.type === "content") tokens += chunk.text;
  }
  console.assert(tokens.length > 0, "Grok must return tokens");
  console.log(`  Grok response: "${tokens.trim()}" ✓`);
}

// Prerequisites: bin/albedo-audio and bin/albedo-daemon must be running
console.log("Albedo AI Integration Test");
console.log("Note: assumes albedo-audio and albedo-daemon are already running\n");

try {
  await testAudio();
  await testDaemon();
  await testGrok();
  console.log("\nAll checks passed.");
} catch (err) {
  console.error("\nTest failed:", err);
  process.exit(1);
}
```

---

### Task 11 — Electrobun window configuration review

**File:** `src/bun/index.ts` and `electrobun.config.ts`

Verify that `BrowserWindow` is configured with:

| Property | Value | Reason |
|----------|-------|--------|
| `transparent` | `true` | Avatar renders on transparent background |
| `frame` | `false` | No OS title bar; avatar is the chrome |
| `alwaysOnTop` | `true` | Avatar stays above other windows |
| `skipTaskbar` | `true` | Does not clutter the taskbar; tray is the access point |
| `width` / `height` | 420 × 650 | Fits avatar + subtitle area |
| `resizable` | `false` (initially) | Prevents accidental resize breaking Live2D layout |
| `hasShadow` | `false` | No OS drop-shadow on transparent window |

In `electrobun.config.ts`, confirm:
- The webview bundle output path matches `views://mainview/index.html`.
- Content Security Policy allows `blob:` URLs (needed for Pixi.js Live2D texture loading) and `wasm-unsafe-eval` (Pixi.js WebAssembly).
- `devtools` is enabled in development builds and disabled in production.

**Drag-to-move:** Since the window is frameless, the avatar area must be draggable. Add a CSS class `-webkit-app-region: drag` to the avatar container div, with `-webkit-app-region: no-drag` on interactive children (buttons, sliders). Wire this through `App.tsx`.

---

### Task 12 — Graceful shutdown and socket cleanup

**File:** `src/bun/process-manager.ts`

In the `shutdown()` method, after killing both processes:

```typescript
async shutdown(): Promise<void> {
  for (const [name, mp] of this.processes) {
    if (mp.proc) {
      mp.proc.kill("SIGTERM");
      // Give processes 3s to exit cleanly
      const deadline = Date.now() + 3000;
      while (mp.proc.exitCode === null && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      if (mp.proc.exitCode === null) {
        mp.proc.kill("SIGKILL");
      }
    }
    // Clean up socket files
    try {
      await Bun.file(mp.socketPath).exists() && fs.unlinkSync(mp.socketPath);
    } catch { /* ignore if already gone */ }
  }
  this.emit("shutdown-complete");
}
```

Also clean up in the Go daemon's `main.go` on SIGTERM (already partially in spec via `os.Remove(socketPath)` at startup — also add a `signal.NotifyContext` for graceful `grpcServer.GracefulStop()`).

---

## End-to-End Pipeline: Complete Flow

The following traces a single voice interaction from microphone to avatar response:

### Step 1: Mic → VAD → Whisper → gRPC → Bun

```
User speaks into mic
     │
     ▼
[Rust: audio_capture.rs]
  cpal captures PCM chunks at 16 kHz
     │ f32le PCM bytes
     ▼
[Rust: vad.rs]
  silero-vad processes each 30 ms frame
  sets chunk.is_speech = true/false
     │ AudioChunk stream
     ▼
[Rust: main.rs → StreamSTT handler]
  Accumulates speech chunks in audio_buffer
  On silence after speech: calls whisper.transcribe()
     │ TranscriptionResult { text, is_final: true }
     ▼
[gRPC stream → Bun]
     │
     ▼
[src/bun/rpc/audio-client.ts → onTranscription callback]
     │ TranscriptionResult
     ▼
[src/bun/orchestrator.ts → processUtterance(transcript)]
  Emits "user-speech" RPC event to webview (shows user text in chat)
```

### Step 2: Bun → Context Assembly → Grok API (Streaming)

```
[Orchestrator.processUtterance(transcript)]
     │
     ▼
[ContextManager.buildMessages(transcript)]
  1. buildSystemPrompt() — includes current awareness snapshot
  2. Conversation history (last 20 turns from SQLite)
  3. Optional vision data (screenshot if previously captured)
  4. User message
     │ Message[]
     ▼
[DaemonClient.listTools()]
  Returns ToolSchema[] with JSON schemas
     │ ToolSchema[]
     ▼
[GrokClient.chatStream(messages, tools)]
  POST https://api.x.ai/v1/chat/completions
  stream: true, model: grok-4.1-fast-reasoning
  tools: converted ToolSchema[] → OpenAI function format
     │ AsyncIterable<StreamChunk>
     ▼
[Orchestrator: iterates chunks]
  chunk.type === "content" → sentence extraction
  chunk.type === "tool_call" → tool round-trip (see Step 5)
```

### Step 3: Sentence → Rust TTS → Audio + Visemes → gRPC → Bun

```
[Orchestrator.extractNewSentences(fullText)]
  Returns newly completed sentences (cursor-based, no duplicates)
     │ string[]
     ▼
[Orchestrator.speakSentence(sentence)] for each sentence
     │
     ▼
[AudioClient.synthesize({ text, voiceId, speed })]
  gRPC call → Rust SynthesizeRequest
     │
     ▼
[Rust: tts.rs → KokoroEngine.synthesize()]
  ONNX inference → raw f32le PCM audio + timing data
     │
     ▼
[Rust: lipsync.rs]
  Maps audio energy and phoneme timing to Viseme structs
  e.g.: { shape: "A", start_ms: 120, duration_ms: 80, weight: 0.9 }
     │ SynthesizeResponse { pcm_data, visemes }
     ▼
[gRPC → AudioClient.synthesize() returns]
```

### Step 4: Bun → Webview RPC → Avatar Lip Sync + Subtitles

```
[Orchestrator.speakSentence() continues]
     │
     ├─► win.webview.rpc.emit("subtitle", { text: sentence, isFinal: false })
     │        │
     │        ▼
     │   [Subtitles.tsx] displays sentence with fade-in animation
     │
     └─► win.webview.rpc.emit("visemes", { visemes })
              │
              ▼
         [Avatar.tsx → Live2D model]
           Schedules each viseme on a timeline relative to audio start
           Maps viseme shape → Live2D mouth parameter:
             "A" → ParamMouthOpenY: 1.0
             "I" → ParamMouthForm: 0.8
             "O" → ParamMouthOpenY: 0.6, ParamMouthForm: -0.3
             "rest" → ParamMouthOpenY: 0.0
           Updates parameters via pixi-live2d-display at each animation frame

     ▼
[AudioClient.play(pcmData)]
  gRPC call → Rust plays PCM through cpal speaker output
  Playback begins simultaneous with viseme RPC emission
  (slight pre-send of visemes ~50ms before audio start recommended)
```

### Step 5: Tool Calls → Go Daemon → Results Back to Grok Context

```
[Orchestrator: chunk.type === "tool_call"]
     │ { name, arguments }
     │
     ▼
[win.webview.rpc.emit("tool-call-start", { name, args })]
  Avatar switches to "thinking" expression

     ▼
[Security check: is tool dangerous?]
  If dangerous:
    emit "tool-confirmation-request" to webview
    await user approval (15s timeout)
    if rejected: inject tool_result "User declined" → continue LLM stream

     ▼
[DaemonClient.executeTool(name, argsJson)]
  gRPC → Go daemon ToolRequest
     │
     ▼
[Go: sandbox.Validate(req)]  ← blocks if command is in BlockedCommands list
     │
     ▼
[Go: registry.Execute(req)]  ← calls registered ToolHandler
  e.g. run_command: exec.CommandContext with 30s timeout
  e.g. screenshot: CaptureScreenJPEG(60) → base64 string
     │ ToolResponse { success, result, error }
     ▼
[gRPC → DaemonClient.executeTool() returns]
     │
     ▼
[Orchestrator: inject result into context]
  Append: { role: "tool", tool_call_id: chunk.id, content: result }
  If screenshot: ContextManager.setVisionData(base64)
     │
     ▼
[GrokClient continues streaming with tool result in context]
  Grok generates response incorporating tool output
     │
     ▼
[win.webview.rpc.emit("tool-call-result", { name, result, success })]
  Avatar returns to normal expression
```

---

## Electrobun Window Setup

### BrowserWindow Configuration

```typescript
const win = new BrowserWindow({
  title: "Albedo AI",
  url: "views://mainview/index.html",
  width: 420,
  height: 650,
  transparent: true,       // Required for Live2D avatar background transparency
  frame: false,            // No OS title bar
  alwaysOnTop: true,       // Avatar stays visible over other apps
  skipTaskbar: true,       // Only accessible via system tray
  resizable: false,        // Fixed layout for Live2D canvas sizing
  hasShadow: false,        // No drop shadow on transparent window
  // Electrobun-specific: initial position (bottom-right corner)
  x: "screen-right - 440",
  y: "screen-bottom - 680",
});
```

### System Tray Menu

The tray is the primary UI control surface. Menu structure:

```
[ Albedo AI icon ]
├── Show / Hide               (toggles window visibility)
├── [✓] Mute                  (checkbox; stops mic capture)
├── ─────────────
├── Settings                  (opens settings panel in webview)
├── About                     (version, model info)
├── ─────────────
└── Quit                      (graceful shutdown)
```

Additional tray icon states (update icon based on state):
- `icon-idle.png` — waiting for speech
- `icon-listening.png` — VAD detected speech
- `icon-thinking.png` — Grok API call in flight
- `icon-speaking.png` — TTS playback active
- `icon-muted.png` — muted
- `icon-error.png` — a subprocess has crashed

Update the tray icon from the orchestrator by calling `tray.setIcon(path)` on state transitions.

---

## Error Handling

### Subprocess Crash

| Scenario | Detection | Response |
|----------|-----------|----------|
| `albedo-audio` exits | `proc.on("exit")` in ProcessManager | Log crash, update tray icon to error, attempt restart after `processRestartDelayMs`. Re-establish `AudioClient` gRPC channel after socket is ready again. Emit `process-status` to webview. |
| `albedo-daemon` exits | Same | Same flow. Awareness stream subscription is re-created by `DaemonClient` reconnect logic. |
| 5 consecutive restarts in 60s | Counted in ProcessManager | Emit `fatal-crash`. Show persistent error overlay in webview. Do not restart further. |

### gRPC Disconnection

| Scenario | Detection | Response |
|----------|-----------|----------|
| Channel goes to `TRANSIENT_FAILURE` | gRPC channel state listener | Exponential backoff reconnect (100 ms → 400 ms → 1600 ms). Log each attempt. |
| `StreamSTT` stream drops | Stream error event | If audio process is still running, re-open the stream. The `onTranscription` handler stays registered; only the underlying stream needs re-opening. |
| `StreamAwareness` stream drops | Stream error event | `DaemonClient` re-subscribes automatically using stored config + callback reference. |
| RPC call returns non-OK status | `status.code !== grpc.status.OK` | Log with status code and message. Surface to orchestrator as a typed `GrpcError`. Orchestrator decides whether to retry or degrade gracefully. |

### Grok API Errors

| Error | Response |
|-------|----------|
| `401 Unauthorized` | Log clearly: "Invalid XAI_API_KEY". Speak: "My connection to the AI service failed. Please check your API key in settings." Disable further API calls until config is updated. |
| `429 Rate Limited` | Wait for `Retry-After` header duration (or 60s default). Speak: "I'm being rate limited. I'll try again in a moment." Queue the utterance for retry. |
| `500 / 503 Server Error` | Retry once after 2s with exponential backoff. If second attempt also fails, speak: "The AI service is temporarily unavailable." |
| Network timeout | Abort the stream after 30s of no tokens. Speak fallback phrase. |
| JSON parse error in tool_call | Log the malformed JSON. Skip the tool call. Continue processing the response. |

### First-Run / Configuration Errors

- Missing `XAI_API_KEY`: Show a setup wizard in the webview (`open-settings` RPC event with `{ tab: "api-key" }`) before any audio starts.
- Missing model files: Detect at startup (check file existence). Log which model is missing and show a descriptive error in the webview rather than crashing with a confusing Rust panic.
- Missing binary (`bin/albedo-audio` or `bin/albedo-daemon` not found): Detect before spawn, show error: "Please run `make all` to build the native components."

---

## Process Lifecycle

### Startup Sequence

```
1. config.ts validates env
2. BrowserWindow created (webview loading begins in parallel)
3. ProcessManager.start()
   a. spawn bin/albedo-audio
   b. waitForSocket("/tmp/albedo-audio.sock", 10_000ms)
   c. spawn bin/albedo-daemon
   d. waitForSocket("/tmp/albedo-daemon.sock", 10_000ms)
4. AudioClient.connect()
5. DaemonClient.connect()
6. GrokClient instantiated (no I/O yet)
7. Orchestrator.start()
   a. audio.startCapture()
   b. daemon.streamAwareness(...)
   c. audio.onTranscription(...) — pipeline is now live
8. Tray icon set to idle state
9. win.show() if not already visible
```

### Shutdown Sequence

Triggered by: SIGINT, SIGTERM, tray "Quit", `uncaughtException`.

```
1. orchestrator.stop()
   a. audio.stopCapture()
   b. Cancel awareness stream subscription
   c. If TTS is in flight, wait for current sentence to complete (or abort after 2s)
2. audioClient.disconnect()
3. daemonClient.disconnect()
4. processManager.shutdown()
   a. SIGTERM to albedo-audio → wait 3s → SIGKILL if still alive
   b. SIGTERM to albedo-daemon → wait 3s → SIGKILL if still alive
   c. Unlink /tmp/albedo-audio.sock
   d. Unlink /tmp/albedo-daemon.sock
5. process.exit(0)
```

### Socket File Hygiene

- The Go daemon already calls `os.Remove(socketPath)` at startup — this handles the case where a previous run crashed and left a stale socket.
- The Rust binary should do the same: before calling `Server::builder().serve()`, attempt to remove the socket path if it exists (add to `audio-engine/src/main.rs`).
- `ProcessManager.waitForSocket()` should verify that the socket is actually connectable (not just that the file exists), because the file may appear before the server has called `accept()`.

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XAI_API_KEY` | **Yes** | — | xAI API key for Grok access |
| `ALBEDO_MODEL` | No | `grok-4.1-fast-reasoning` | Grok model ID |
| `ALBEDO_AUDIO_SOCKET` | No | `/tmp/albedo-audio.sock` | Path to Rust audio gRPC socket |
| `ALBEDO_DAEMON_SOCKET` | No | `/tmp/albedo-daemon.sock` | Path to Go daemon gRPC socket |
| `ALBEDO_VOICE_ID` | No | `default` | Kokoro voice ID |
| `ALBEDO_VOICE_SPEED` | No | `1.0` | TTS speed multiplier |
| `ALBEDO_VAD_THRESHOLD` | No | `0.5` | Silero-VAD speech probability threshold (0–1) |
| `ALBEDO_LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `ALBEDO_DEV` | No | `false` | Enables devtools, verbose logging |

### Config File

Location: `~/.config/albedo-ai/config.json`

```json
{
  "persona": {
    "name": "Albedo",
    "language": "auto",
    "personality": "warm, concise, practical"
  },
  "audio": {
    "micDeviceId": null,
    "speakerDeviceId": null,
    "vadThreshold": 0.5,
    "sampleRate": 16000
  },
  "ui": {
    "windowX": null,
    "windowY": null,
    "opacity": 1.0,
    "scale": 1.0
  },
  "awareness": {
    "enabled": true,
    "intervalMs": 5000,
    "includeClipboard": true,
    "cpuAlertThreshold": 90
  },
  "tools": {
    "dangerousRequireConfirmation": true,
    "allowedReadPaths": ["~"],
    "allowedWritePaths": ["~/Desktop", "~/Documents", "~/Downloads", "/tmp"]
  }
}
```

`config.ts` merges: environment variables → config file → defaults (env takes priority).

---

## Testing Strategy

### Full End-to-End Test (Manual)

Before marking Phase 6 complete, walk through this checklist:

**Voice pipeline:**
- [ ] Application starts without errors (`bun start` or Electrobun dev command)
- [ ] Live2D avatar renders and is visible with transparent background
- [ ] System tray icon appears and menu opens
- [ ] Speak "Hello, what's your name?" → Albedo responds with voice + lip sync
- [ ] Subtitles appear in sync with speech
- [ ] Avatar mouth moves through viseme shapes during speech
- [ ] User speech transcript appears in chat area during/after speaking

**Awareness:**
- [ ] Ask "What app am I using right now?" → Albedo correctly identifies the active window
- [ ] Ask "How much CPU am I using?" → Albedo gives accurate system stats
- [ ] Simulate CPU spike (run stress tool) → Albedo proactively alerts (if threshold met)

**Tool calls:**
- [ ] Ask "Read the file /etc/hostname" → Albedo reads and speaks the hostname
- [ ] Ask "Take a screenshot and describe it" → Albedo captures screen, describes content via Grok vision
- [ ] Ask "Open a calculator" → Calculator launches
- [ ] Ask to run a dangerous command → Confirmation dialog appears in webview

**Resilience:**
- [ ] Kill `albedo-audio` process while running → tray shows error state → restarts automatically → voice resumes
- [ ] Kill `albedo-daemon` while Albedo is mid-sentence → no crash in Bun process → daemon restarts → tool calls work again
- [ ] Disconnect network while Grok streaming → graceful error message spoken → reconnects on next utterance
- [ ] Set `XAI_API_KEY` to an invalid value → clear error message in UI, not a crash

**Lifecycle:**
- [ ] Click "Quit" in tray → application exits cleanly, no orphaned processes (verify with `ps aux | grep albedo`)
- [ ] Socket files are cleaned up after quit (`ls /tmp/albedo-*.sock` returns nothing)
- [ ] Restart application → no "address already in use" error from stale socket

### Integration Test Script

```bash
# Build all binaries
make all

# Start native processes in background
./bin/albedo-audio &
AUDIO_PID=$!
./bin/albedo-daemon &
DAEMON_PID=$!

# Wait for sockets
sleep 2

# Run integration tests
bun run scripts/integration-test.ts
EXIT_CODE=$?

# Cleanup
kill $AUDIO_PID $DAEMON_PID
rm -f /tmp/albedo-audio.sock /tmp/albedo-daemon.sock

exit $EXIT_CODE
```

Add to `Makefile`:
```makefile
test-integration: build-rust build-go
	bun run scripts/run-integration-test.sh
```

### Smoke Tests (Automated)

Add unit tests for pure logic in `src/bun/`:

- `context-manager.test.ts`: verify `extractNewSentences` cursor advancement, token budget truncation, system prompt formatting with/without awareness data.
- `config.test.ts`: verify that missing `XAI_API_KEY` throws, that config file values are merged correctly.
- `process-manager.test.ts`: mock `Bun.spawn` and `fs.existsSync`; verify restart backoff logic, fatal-crash after max restarts, socket cleanup.

---

## Validation Criteria

Phase 6 is **complete** when all of the following pass without manual workarounds:

1. **Voice response:** Speak any sentence → Albedo replies within ~1s (first audio), with correctly synchronized lip movements and subtitles displayed.

2. **Tool execution:** Ask Albedo to read a file → it calls the `read_file` tool via Go daemon and incorporates the result into its spoken response.

3. **Awareness reflection:** Ask "What am I working on?" → Albedo's response references the correct currently active application window title.

4. **Crash recovery:** `kill -9 $(pgrep albedo-audio)` → within 3s the process restarts, tray icon recovers to idle, voice interaction resumes normally.

5. **Clean shutdown:** `SIGTERM` sent to the Electrobun main process → both child processes exit within 5s, socket files are removed, no zombie processes.

6. **Error UX:** Remove `XAI_API_KEY` from environment and restart → user sees a clear, actionable error message in the UI, not a raw stack trace.

---

## Known Integration Issues

### Timing: Socket Readiness vs. gRPC Connect

The Rust binary writes "Listening on …" to stderr and then calls `serve()`, but there is a small window between stderr output and the kernel accepting connections on the socket. The `waitForSocket()` implementation must attempt an actual TCP/Unix connect probe, not just check for file existence. Without this, a fast machine may attempt gRPC connection before `accept()` is ready, producing an immediate `ECONNREFUSED`.

**Mitigation:** `waitForSocket` polls with `net.connect()` attempts every 50 ms, not just `fs.existsSync()`.

### Race: Transcription Arrives Before Grok Call Returns

If the user speaks again while Albedo is still generating/speaking a response, a second `processUtterance()` call begins concurrently. This can cause:
- Two simultaneous Grok streams mutating shared context
- Interleaved TTS output from both responses

**Mitigation:** Add a `processingQueue: string[]` to the orchestrator. If `isSpeaking || isProcessing`, enqueue new utterances. Process the queue sequentially after each turn completes. Alternatively, abort the current Grok stream when a new utterance arrives (interrupt-and-replace behavior, more natural).

### Buffer Management: Large TTS Responses

If Grok produces a very long response before the first sentence boundary, the user will wait for a disproportionately long time. The sentence extractor regex `[^.!?…]+[.!?…]+` will buffer everything.

**Mitigation:** Add a maximum buffer length (e.g., 200 characters). If no sentence boundary appears within 200 characters, force a synthetic split at the last whitespace and speak the accumulated text as a partial sentence.

### Unix Socket Paths on Different Platforms

- **Linux/macOS:** `/tmp/albedo-audio.sock` and `/tmp/albedo-daemon.sock` work as expected.
- **Windows:** gRPC does not support Unix domain sockets on Windows without WSL or a named-pipe transport. Both Rust (tonic) and Go (google.golang.org/grpc) support named pipes (`\\.\pipe\albedo-audio`), but the path format and connection URL differ. `config.ts` must emit the correct path per platform, and the binary source code must also switch.
- **macOS sandboxing:** Notarized apps may have `/tmp` write restrictions. Use `os.tmpdir()` or a path under `$TMPDIR` if distributing a signed macOS build.

### Viseme Pre-Send Timing

The `speakSentence()` method currently emits `visemes` and then calls `audio.play()`. However, the gRPC call for `play()` has ~5–10 ms overhead, meaning the viseme timeline starts slightly before audio playback. The Avatar component should introduce a configurable delay (`VISEME_LEAD_MS`, default 50 ms) that shifts the entire viseme schedule forward in time to account for playback latency.

### Awareness Snapshot Size in Context

A full `AwarenessSnapshot` with `top_processes` (10 entries), clipboard content, and recent notifications may add ~500–800 tokens to every Grok call. For a typical conversation, this is fine. If the user has a very large clipboard (e.g., copied a long document), the clipboard field should be truncated to 500 characters in `buildSystemPrompt()`.

### Concurrent Tool Calls

Grok may emit multiple `tool_call` chunks in a single response (parallel tool use). The current orchestrator processes them serially. This is safe for correctness but may introduce unnecessary latency when tools are independent (e.g., `read_file` + `get_system_metrics` could run in parallel). For Phase 6 MVP, serial execution is acceptable. Mark as a Phase 7 optimization.

---

## Risks and Notes

### Electrobun Maturity

Electrobun is a young framework. Known considerations:
- The `BrowserWindow` API surface is smaller than Electron's; some properties documented here (e.g., `skipTaskbar`, `hasShadow`) may need to be verified against the actual Electrobun version in `package.json`.
- Webview RPC (`win.webview.rpc.emit`) is Electrobun-specific and not a standard Web API. Type generation from `rpc-types.ts` may require a custom Electrobun codegen step.
- If a needed BrowserWindow feature is missing from Electrobun, the fallback is a Zig native binding via `electrobun/zig` — budget an extra day if this is required.
- Monitor the Electrobun changelog: Phase 0–6 development may span multiple Electrobun releases.

### Cross-Platform Socket Paths

See the "Known Integration Issues" section above. Committing to Linux-only for Phase 6 MVP is reasonable. Document platform gaps clearly so Phase 7 polish can address Windows/macOS differences.

### First-Run Experience

A user running Albedo AI for the first time faces:
1. Needing to set `XAI_API_KEY`.
2. Needing to run `make all` to build native binaries (30–90s for Rust, 5–10s for Go).
3. Needing model files (Whisper ggml-base.bin is ~150 MB, Kokoro ONNX varies).

For Phase 6, print clear instructions to stderr on startup if any prerequisite is missing. A proper first-run setup wizard is a Phase 7 concern.

### Grok Model Name

The spec uses `grok-4.1-fast-reasoning`. Verify this model ID against the xAI API documentation as of the implementation date — model names and tiers change. Store the model ID in `config.ts` so it can be updated without code changes.

### Audio Device Enumeration

`cpal` requires a valid audio device. On headless CI machines or Docker environments, `albedo-audio` will fail to start if no audio device is present. The integration test script should skip audio tests when `ALBEDO_CI=1` is set.

### Long-Running Memory Growth

The Rust audio engine accumulates PCM in `audio_buffer` until silence is detected. If the user is in a very loud environment and VAD never triggers silence, the buffer grows indefinitely. Add a maximum buffer size (e.g., 30 seconds of audio at 16 kHz = ~1.9 MB of f32) after which the engine forces a transcription attempt even without a silence boundary.

---

*Phase 6 estimated completion: 3–4 days of focused implementation. Primary complexity is in `ProcessManager` socket readiness, `AudioClient`/`DaemonClient` reconnection logic, and the sentence cursor bug in the orchestrator. Everything else is wiring that follows directly from the architecture spec.*
