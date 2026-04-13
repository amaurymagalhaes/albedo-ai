# Phase 3: Orchestrator

**Estimated effort:** 3–4 days  
**Owner:** Bun main process (`src/bun/`)  
**Depends on:** Phase 1 (Rust audio engine with gRPC server), Phase 2 (Kokoro TTS + viseme output)

---

## Objective

Deliver a fully functional Bun/TypeScript orchestrator that:

- Connects to the Rust audio engine and Go daemon over Unix-socket gRPC
- Maintains a rolling conversation history and injects live awareness snapshots into every Grok request
- Streams chat completions from the xAI Grok API, extracting complete sentences as they arrive and dispatching each to TTS immediately
- Routes tool call chunks to the Go daemon, feeds results back into the conversation, and handles vision data (screenshots) by encoding them into the context window
- Saves each exchange to SQLite for long-term memory
- Bridges all events (subtitles, visemes, expressions) to the Electrobun webview via typed RPC

At the end of this phase, typing text in the UI (or speaking, if Phase 1/2 are complete) produces a Grok-generated spoken response with lip sync data flowing to the avatar.

---

## Prerequisites

1. **Phase 1 complete** — `albedo-audio` binary starts, listens on `unix:///tmp/albedo-audio.sock`, and the `StreamSTT` / `Synthesize` / `StartCapture` RPCs are implemented and tested.
2. **Phase 2 complete** — Kokoro TTS synthesizes PCM audio and returns `Viseme[]` data; audio playback via `cpal` works end-to-end.
3. **xAI API key** — `XAI_API_KEY` environment variable set. Obtain from [https://console.x.ai](https://console.x.ai). The target model is `grok-4-fast` (alias subject to xAI naming at time of development; confirm the current fast-reasoning model name in the API docs).
4. **Protobuf TypeScript stubs generated** — running `make proto` must have produced stub files under `src/bun/rpc/generated/`. Specifically:
   - `src/bun/rpc/generated/audio_grpc_pb.ts` + `audio_pb.ts`
   - `src/bun/rpc/generated/daemon_grpc_pb.ts` + `daemon_pb.ts`
5. **Go daemon running** (Phase 5 will fully implement it, but a stub gRPC server listening on `unix:///tmp/albedo-daemon.sock` is sufficient for Phase 3 to test the full pipeline).
6. **Bun ≥ 1.1** and `@grpc/grpc-js` + `@grpc/proto-loader` installed.

---

## Protobuf TypeScript Codegen

Before writing any client code, the `.proto` files must be compiled to TypeScript. The Makefile `proto` target runs:

```bash
npx protoc-gen-ts --ts_out=src/bun/rpc/generated proto/audio.proto proto/daemon.proto
```

If `protoc-gen-ts` does not produce usable gRPC service stubs, use `grpc_tools_node_protoc` with the `grpc-tools` npm package instead:

```bash
# Install once
bun add -d grpc-tools ts-protoc-gen

# Run codegen (add to Makefile `proto` target)
npx grpc_tools_node_protoc \
  --js_out=import_style=commonjs,binary:src/bun/rpc/generated \
  --grpc_out=grpc_js:src/bun/rpc/generated \
  --plugin=protoc-gen-ts=$(which protoc-gen-ts) \
  --ts_out=grpc_js:src/bun/rpc/generated \
  -I proto \
  proto/audio.proto \
  proto/daemon.proto
```

Commit the generated files to source control — they are derived artifacts but required for IDE type checking and should not be regenerated silently at runtime.

---

## Step-by-Step Tasks

### Task 1 — Package setup

**File:** `package.json`

Add the following runtime dependencies:

```json
"@grpc/grpc-js": "^1.10.0",
"@grpc/proto-loader": "^0.7.13"
```

Add dev dependencies:

```json
"grpc-tools": "^1.12.4",
"ts-protoc-gen": "^0.15.0"
```

Run `bun install`.

---

### Task 2 — Generate protobuf stubs

Run `make proto` from the project root. Verify that the following files are created (non-empty):

```
src/bun/rpc/generated/
├── audio_pb.d.ts
├── audio_pb.js
├── AudioEngineServiceClientPb.ts   (or audio_grpc_pb.ts, depending on generator)
├── daemon_pb.d.ts
├── daemon_pb.js
└── DaemonServiceClientPb.ts
```

If the generator outputs `.js` + `.d.ts` pairs, write thin `.ts` re-export wrappers in `src/bun/rpc/generated/index.ts` so the rest of the codebase only imports from one location.

---

### Task 3 — Implement `src/bun/rpc/audio-client.ts`

See [Module: `rpc/audio-client.ts`](#module-rpcaudio-clientts) below for full spec.

Verify by writing a quick smoke test script `scripts/test-audio-rpc.ts` that calls `startCapture` and prints the returned `CaptureStatus`.

---

### Task 4 — Implement `src/bun/rpc/daemon-client.ts`

See [Module: `rpc/daemon-client.ts`](#module-rpcdaemon-clientts) below.

Verify by calling `listTools()` against the stub daemon server and printing the tool names.

---

### Task 5 — Implement `src/bun/grok-client.ts`

See [Module: `grok-client.ts`](#module-grok-clientts) below.

Verify with `scripts/test-grok.ts`: send a single-turn message, print the full streamed response to stdout.

---

### Task 6 — Implement `src/bun/context-manager.ts`

See [Module: `context-manager.ts`](#module-context-managerts) below.

Verify with a unit test that builds a messages array and checks total token estimate stays under the budget when history is long.

---

### Task 7 — Implement `src/bun/memory.ts`

See [Module: `memory.ts`](#module-memoryts) below.

Verify with `scripts/test-memory.ts`: insert three exchanges, retrieve them, confirm ordering.

---

### Task 8 — Implement `src/bun/orchestrator.ts`

See [Module: `orchestrator.ts`](#module-orchestratorts) below.

At this point wire everything together in `src/bun/index.ts` per the architecture spec.

---

### Task 9 — Text-mode end-to-end validation

Before testing voice, validate the full pipeline in text mode:

1. Start the stub daemon and the real audio engine.
2. Run `bun dev`.
3. In the Electrobun webview, type a message in the chat input and submit.
4. Confirm: subtitle appears → TTS audio plays → avatar lip syncs.

See [Validation Criteria](#validation-criteria).

---

### Task 10 — Voice-mode end-to-end validation

With Phase 1/2 complete:

1. Speak into the microphone.
2. Confirm Whisper transcription arrives (`user-speech` event fires in the webview).
3. Confirm the full pipeline runs as in text-mode.

---

## Module Breakdown

---

### Module: `rpc/audio-client.ts`

**Path:** `src/bun/rpc/audio-client.ts`

**Purpose:** Thin typed wrapper around the gRPC client stubs for `AudioEngine`. All callers import this class rather than touching `@grpc/grpc-js` directly.

**Key methods:**

| Method | Proto RPC | Notes |
|---|---|---|
| `startCapture(config)` | `StartCapture` | Unary |
| `stopCapture()` | `StopCapture` | Unary |
| `synthesize(req)` | `Synthesize` | Unary, returns `{ pcmData: Uint8Array, visemes: Viseme[] }` |
| `onTranscription(cb)` | (internal) | Subscribes to the active `StreamSTT` bidirectional stream; calls `cb` for each `TranscriptionResult` where `isFinal === true` |
| `play(pcm)` | n/a | Writes PCM bytes to the audio engine's playback gRPC stream (to be defined in `audio.proto` as `rpc PlayAudio(stream AudioChunk) returns (PlayStatus)` — add if missing) |

**Constructor:**

```typescript
constructor(socketAddress: string)
// e.g. new AudioClient("unix:///tmp/albedo-audio.sock")
```

Internally creates a `grpc.Client` with `grpc.credentials.createInsecure()` targeting the Unix socket.

**Reconnect strategy:** On connection error, attempt reconnect with exponential backoff (100ms, 200ms, 400ms … capped at 5s). Log each attempt. Emit an `error` event after 5 failed attempts so the orchestrator can surface a user-facing warning.

**Implementation skeleton:**

```typescript
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { EventEmitter } from "events";

export class AudioClient extends EventEmitter {
  private client: any; // typed stub from generated code

  constructor(private address: string) {
    super();
    this.connect();
  }

  private connect() {
    // Close the previous client before creating a new one to avoid leaking
    // file handles on each reconnect attempt.
    this.client?.close();

    const packageDef = protoLoader.loadSync(
      path.resolve(import.meta.dir, "../../../proto/audio.proto"),
      { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
    );
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    this.client = new proto.albedo.audio.AudioEngine(
      this.address,
      grpc.credentials.createInsecure()
    );
  }

  /** Closes the underlying gRPC channel. Called by `Orchestrator.stop()`. */
  close() {
    this.client?.close();
  }

  async startCapture(config: { sampleRate: number; vadThreshold: number }) {
    return new Promise((resolve, reject) => {
      this.client.startCapture(
        { sample_rate: config.sampleRate, vad_threshold: config.vadThreshold },
        (err: grpc.ServiceError | null, response: any) => {
          if (err) reject(err);
          else resolve(response);
        }
      );
    });
  }

  async synthesize(req: { text: string; voiceId: string; speed: number }) {
    return new Promise<{ pcmData: Uint8Array; visemes: any[] }>((resolve, reject) => {
      this.client.synthesize(
        { text: req.text, voice_id: req.voiceId, speed: req.speed },
        (err: grpc.ServiceError | null, response: any) => {
          if (err) reject(err);
          else resolve({ pcmData: response.pcm_data, visemes: response.visemes });
        }
      );
    });
  }

  onTranscription(cb: (result: { text: string; isFinal: boolean; timestampMs: number }) => void) {
    // StreamSTT is bidirectional — the orchestrator writes audio chunks,
    // the engine writes back TranscriptionResults.
    // For Phase 3, the Rust engine handles mic capture internally after StartCapture;
    // we subscribe to transcription results via a server-streaming helper RPC
    // `WatchTranscriptions(Empty) returns (stream TranscriptionResult)`.
    // Add this RPC to audio.proto if not present, or poll via a callback stream.
    const call = this.client.watchTranscriptions({});
    call.on("data", (result: any) => {
      cb({
        text: result.text,
        isFinal: result.is_final,
        timestampMs: Number(result.timestamp_ms),
      });
    });
    call.on("error", (err: Error) => this.emit("error", err));
  }
}
```

**Note on `WatchTranscriptions`:** The architecture spec uses bidirectional `StreamSTT` where the client pushes audio chunks. For the orchestrator use case where the Rust engine manages mic capture autonomously after `StartCapture`, add a unidirectional server-streaming RPC to `audio.proto`:

```protobuf
// In AudioEngine service
rpc WatchTranscriptions(Empty) returns (stream TranscriptionResult);
rpc PlayAudio(stream AudioChunk) returns (PlayStatus);
```

This avoids the orchestrator having to relay raw PCM and lets the Rust side own the audio I/O loop.

---

### Module: `rpc/daemon-client.ts`

**Path:** `src/bun/rpc/daemon-client.ts`

**Purpose:** Typed wrapper for the Go daemon's `Daemon` gRPC service.

**Key methods:**

| Method | Proto RPC | Returns |
|---|---|---|
| `getAwareness()` | `GetAwareness` | `AwarenessSnapshot` |
| `streamAwareness(config, cb)` | `StreamAwareness` | `void` (calls `cb` per snapshot) |
| `captureScreen(req)` | `CaptureScreen` | `{ imageData: Uint8Array, ocrText: string, width: number, height: number }` |
| `executeTool(name, argsJson)` | `ExecuteTool` | `{ success: boolean, result: string, error: string }` |
| `listTools()` | `ListTools` | `ToolSchema[]` |

**`streamAwareness` implementation detail:** Opens a server-streaming call. Calls the callback for each received snapshot. Automatically restarts the stream on error after a 2s delay. Exposes a `stopAwarenessStream()` method that cancels the call.

**Reconnect strategy:** Mirrors `AudioClient`. Call `this.client?.close()` before instantiating a new `grpc.Client` during every reconnect attempt to avoid leaking file handles:

```typescript
private connect() {
  // Release the previous channel before opening a new one.
  this.client?.close();

  const packageDef = protoLoader.loadSync(
    path.resolve(import.meta.dir, "../../../proto/daemon.proto"),
    { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
  );
  const proto = grpc.loadPackageDefinition(packageDef) as any;
  this.client = new proto.albedo.daemon.Daemon(
    this.address,
    grpc.credentials.createInsecure()
  );
}

/** Closes the underlying gRPC channel. Called by `Orchestrator.stop()`. */
close() {
  this.client?.close();
}
```

**Tool execution flow:**

```typescript
async executeTool(toolName: string, argumentsJson: string): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    this.client.executeTool(
      { tool_name: toolName, arguments_json: argumentsJson, requires_confirmation: false },
      (err: grpc.ServiceError | null, response: any) => {
        if (err) reject(err);
        else resolve({
          success: response.success,
          result: response.result,
          error: response.error,
        });
      }
    );
  });
}
```

**Constructor mirrors `AudioClient`** — takes `socketAddress: string`, loads `proto/daemon.proto` at runtime via `protoLoader`.

---

### Module: `grok-client.ts`

**Path:** `src/bun/grok-client.ts`

**Purpose:** xAI Grok API client with streaming chat completions, tool use, error handling, retry logic, and token estimation.

**Config interface:**

```typescript
export interface GrokClientConfig {
  apiKey: string;
  model: string;            // e.g. "grok-4-fast"
  baseUrl: string;          // "https://api.x.ai/v1"
  maxTokens: number;        // Output token limit per request
  temperature: number;
}
```

**Message types:**

```typescript
export type Role = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image_url";
  image_url: { url: string }; // "data:image/jpeg;base64,..."
}

export type MessageContent = string | (TextContent | ImageContent)[];

export interface Message {
  role: Role;
  content: MessageContent;
  tool_call_id?: string;   // for role: "tool"
  name?: string;           // for role: "tool"
}
```

**Tool definition type (passed to API):**

```typescript
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema object
  };
}
```

**Streaming chunk types (internal to orchestrator):**

```typescript
export type StreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done" };
```

**`chatStream` method:**

```typescript
async *chatStream(
  messages: Message[],
  tools?: ToolDef[]
): AsyncGenerator<StreamChunk> {
  const body = {
    model: this.config.model,
    messages,
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? "auto" : undefined,
    stream: true,
    max_tokens: this.config.maxTokens,
    temperature: this.config.temperature,
  };

  const response = await this.fetchWithRetry("/chat/completions", body);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  // Accumulator for partial tool_call argument chunks
  const toolCallAccumulators = new Map<string, { name: string; args: string }>();

  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { yield { type: "done" }; return; }

      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      // Content token
      if (delta.content) {
        yield { type: "content", text: delta.content };
      }

      // Tool call chunk
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (tc.id) {
            // First chunk for this tool call
            toolCallAccumulators.set(idx, { name: tc.function.name, args: "" });
          }
          if (tc.function?.arguments) {
            const acc = toolCallAccumulators.get(idx)!;
            acc.args += tc.function.arguments;
          }
          // Check if args are complete JSON (closing brace received)
          const acc = toolCallAccumulators.get(idx);
          if (acc && this.isCompleteJson(acc.args)) {
            yield { type: "tool_call", id: tc.id ?? String(idx), name: acc.name, arguments: acc.args };
            toolCallAccumulators.delete(idx);
          }
        }
      }
    }
  }
}
```

**`isCompleteJson` helper:** Counts opening vs closing braces. Returns true when counts balance and the string is non-empty. For robustness, wrap in a try/catch around `JSON.parse` as the definitive check.

**`fetchWithRetry` method:**

```typescript
private async fetchWithRetry(path: string, body: unknown, attempt = 0): Promise<Response> {
  const MAX_ATTEMPTS = 4;
  const BACKOFF_MS = [0, 500, 1500, 4000];

  if (attempt > 0) {
    await Bun.sleep(BACKOFF_MS[attempt]);
  }

  const response = await fetch(`${this.config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429 || response.status >= 500) {
    if (attempt < MAX_ATTEMPTS - 1) {
      console.warn(`[grok] HTTP ${response.status}, retrying (attempt ${attempt + 1})...`);
      return this.fetchWithRetry(path, body, attempt + 1);
    }
    const text = await response.text();
    throw new Error(`Grok API error ${response.status}: ${text}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Grok API error ${response.status}: ${text}`);
  }

  return response;
}
```

**Token counting:** xAI does not expose a standalone tokenizer. Use a conservative estimate of **4 characters per token** for budget management:

```typescript
estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

Replace this with the tiktoken `cl100k_base` encoder (via `tiktoken` npm package) for more accuracy if token budget overflows become a problem. The Grok models use a similar BPE vocabulary.

---

### Module: `context-manager.ts`

**Path:** `src/bun/context-manager.ts`

**Purpose:** Assembles the full message array sent to Grok on each turn. Manages conversation history, awareness injection, screenshot/vision data, and token budget.

**Token budget:**

| Slot | Allocation |
|---|---|
| System prompt | ~2,000 tokens |
| Awareness snapshot (injected each turn) | ~500 tokens |
| Vision data (screenshot, when present) | ~1,500 tokens (JPEG base64 encoding overhead) |
| Conversation history (rolling window) | up to **1,990,000 tokens** |
| Output reservation | 4,096 tokens |
| **Total context** | **≤ 2,000,000 tokens** |

In practice, conversation history never approaches 2M tokens in normal use. The budget guard exists to prevent runaway accumulation.

**State:**

```typescript
interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestampMs: number;
  tokenCount: number;
}

class ContextManager {
  private history: ConversationTurn[] = [];
  private awarenessSnapshot: AwarenessSnapshot | null = null;
  private pendingVisionB64: string | null = null;
  private totalHistoryTokens = 0;

  private readonly TOKEN_BUDGET = 2_000_000;
  private readonly HISTORY_BUDGET = 1_990_000;
  private readonly SYSTEM_RESERVE = 6_096; // system + awareness + vision + output
}
```

**`buildMessages(userText: string): Message[]`:**

1. Build the system prompt (see below).
2. If `pendingVisionB64` is set, build a user message with mixed content (text + image_url). Clear `pendingVisionB64` after use.
3. Append history turns as alternating `user`/`assistant` messages.
4. Append the current user turn.
5. Return the assembled array.

```typescript
buildMessages(userText: string): Message[] {
  const systemPrompt = this.buildSystemPrompt();
  const messages: Message[] = [{ role: "system", content: systemPrompt }];

  // History (oldest first, already trimmed to budget)
  for (const turn of this.history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Current user turn, with optional vision data
  if (this.pendingVisionB64) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${this.pendingVisionB64}` } },
      ],
    });
    this.pendingVisionB64 = null;
  } else {
    messages.push({ role: "user", content: userText });
  }

  return messages;
}
```

**`buildSystemPrompt(): string`:**

```
You are Albedo, a helpful AI companion running on the user's desktop.
You have real-time awareness of the user's system state.

--- CURRENT SYSTEM STATE ---
Active window: ${snapshot.activeWindow.appName} — "${snapshot.activeWindow.title}"
CPU: ${snapshot.metrics.cpuPercent.toFixed(1)}% | RAM: ${snapshot.metrics.ramPercent.toFixed(1)}%
Time: ${new Date(snapshot.timestampMs).toLocaleString()}
Clipboard: ${truncate(snapshot.clipboardContent, 200)}
Recent notifications: ${snapshot.recentNotifications.slice(0, 3).join("; ")}
---

Respond conversationally and concisely. When the user asks you to do something that requires
a tool, use the available tools. Prefer short sentences that work well when spoken aloud.
Do not use markdown formatting in your spoken responses.
```

If `awarenessSnapshot` is null, omit the system state block.

**`updateAwareness(snapshot: AwarenessSnapshot): void`** — stores the latest snapshot. Called from the orchestrator's awareness stream callback.

**`setVisionData(b64: string): void`** — stores a screenshot for injection into the next user message.

**`addExchange(userText: string, assistantText: string): void`** — appends both turns to history, updates `totalHistoryTokens`, and trims if over budget.

**History trimming:**

```typescript
private trimHistory() {
  while (this.totalHistoryTokens > this.HISTORY_BUDGET && this.history.length > 2) {
    const removed = this.history.shift()!;
    this.totalHistoryTokens -= removed.tokenCount;
    // Also remove the paired turn (user removes assistant, etc.)
    if (this.history.length > 0) {
      const paired = this.history.shift()!;
      this.totalHistoryTokens -= paired.tokenCount;
    }
  }
}
```

Always remove in pairs (user + assistant) to keep message ordering valid for the API.

---

### Module: `memory.ts`

**Path:** `src/bun/memory.ts`

**Purpose:** Long-term memory backed by SQLite. Stores conversation exchanges with timestamps for persistence across sessions. Optional: semantic search via embeddings (Phase 7 scope).

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id, timestamp_ms);
```

**Implementation:**

```typescript
import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = path.resolve(
  process.env.HOME ?? "~",
  ".config/albedo-ai/memory.sqlite"
);

export class Memory {
  private db: Database;
  private sessionId: string;

  constructor(sessionId?: string) {
    this.db = new Database(DB_PATH);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    this.migrate();
    this.applyRetentionPolicy();
  }

  /**
   * Deletes conversations older than RETENTION_DAYS (default 90) and reclaims
   * disk space with VACUUM. Without this, the database grows indefinitely —
   * roughly 50–500 MB after a year of daily use, depending on response length.
   *
   * Set the `ALBEDO_MEMORY_RETENTION_DAYS` environment variable to override the
   * default 90-day window.
   */
  private applyRetentionPolicy() {
    const days = parseInt(process.env.ALBEDO_MEMORY_RETENTION_DAYS ?? "90", 10);
    this.db.run(`DELETE FROM conversations WHERE created_at < datetime('now', '-${days} days')`);
    this.db.run("VACUUM");
  }

  private migrate() {
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

  saveExchange(userText: string, assistantText: string) {
    const stmt = this.db.prepare(
      "INSERT INTO conversations (session_id, role, content, timestamp_ms, token_count) VALUES ($sessionId, $role, $content, $ts, $tokens)"
    );
    const now = Date.now();
    this.db.transaction(() => {
      stmt.run({ $sessionId: this.sessionId, $role: "user", $content: userText, $ts: now, $tokens: Math.ceil(userText.length / 4) });
      stmt.run({ $sessionId: this.sessionId, $role: "assistant", $content: assistantText, $ts: now + 1, $tokens: Math.ceil(assistantText.length / 4) });
    })();
  }

  getRecentExchanges(limit = 50): { role: string; content: string; timestampMs: number }[] {
    return (this.db.prepare(
      "SELECT role, content, timestamp_ms as timestampMs FROM conversations WHERE session_id = $sessionId ORDER BY timestamp_ms DESC LIMIT $limit"
    ).all({ $sessionId: this.sessionId, $limit: limit * 2 }) as any[]) // * 2 because each exchange is 2 rows
     .reverse();
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
```

**Relationship to `ContextManager`:** On startup, `ContextManager` loads recent history from `Memory` to restore the conversation across restarts. `addExchange` calls both `Memory.saveExchange` (durable) and the in-memory `history` array (fast).

---

### Module: `orchestrator.ts`

**Path:** `src/bun/orchestrator.ts`

**Purpose:** Core pipeline. Wires all modules together and owns the main event loop.

**Full flow (per utterance):**

```
TranscriptionResult (is_final)
  │
  ▼
processUtterance(transcript)
  │
  ├─ 1. Emit "user-speech" → webview (show subtitle immediately)
  │
  ├─ 2. context.buildMessages(transcript) → Message[]
  │
  ├─ 3. daemon.listTools() → ToolDef[] (cached, refreshed every 60s)
  │
  ├─ 4. grok.chatStream(messages, tools) → AsyncGenerator<StreamChunk>
  │       │
  │       ├─ chunk.type === "content"
  │       │     ├─ Append to fullResponse buffer
  │       │     └─ sentenceDetector.feed(chunk.text) → complete sentences
  │       │           └─ For each complete sentence:
  │       │                 ├─ emit "subtitle" → webview
  │       │                 └─ speakSentence(sentence)  [non-blocking, queued]
  │       │
  │       └─ chunk.type === "tool_call"
  │             ├─ Optionally emit "tool-executing" → webview
  │             ├─ daemon.executeTool(name, args) → ToolResult
  │             ├─ If result contains "[SCREENSHOT:...]":
  │             │     context.setVisionData(extractB64(result))
  │             └─ Append tool result message to in-flight messages list
  │                 (feed back into next Grok call if tool results need a follow-up)
  │
  ├─ 5. Await TTS queue to drain (all sentences spoken)
  │
  ├─ 6. context.addExchange(transcript, fullResponse)
  │
  └─ 7. inferExpression(fullResponse) → emit "set-expression" → webview
```

**TTS queue:** Use a simple async queue (array + async iterator or a `p-queue`-style structure) to ensure sentences are spoken in order even though `speakSentence` is async and involves a network call to the Rust engine.

```typescript
private ttsQueue: string[] = [];
private ttsRunning = false;

private enqueueSentence(sentence: string) {
  this.ttsQueue.push(sentence);
  if (!this.ttsRunning) this.drainTtsQueue();
}

private async drainTtsQueue() {
  this.ttsRunning = true;
  while (this.ttsQueue.length > 0) {
    const sentence = this.ttsQueue.shift()!;
    await this.speakSentence(sentence);
  }
  this.ttsRunning = false;
}
```

**`listTools` cache:** `daemon.listTools()` is an RPC call that returns the full tool schema list. Calling it on every utterance adds unnecessary latency and load on the Go daemon. Cache the result with a 60-second TTL:

```typescript
private toolsCache: { tools: ToolSchema[]; expiry: number } | null = null;

private async getTools(): Promise<ToolSchema[]> {
  if (this.toolsCache && Date.now() < this.toolsCache.expiry) {
    return this.toolsCache.tools;
  }
  const tools = await this.daemon.listTools();
  this.toolsCache = { tools, expiry: Date.now() + 60_000 };
  return tools;
}
```

Replace the direct `daemon.listTools()` call in `processUtterance` with `this.getTools()`. The cache is intentionally not invalidated on tool execution — the tool list changes only when the daemon restarts, which is infrequent. If a new tool must be available immediately, restart the daemon.

**Tool result feedback loop:** When Grok emits a `tool_call` chunk, the orchestrator must execute the tool and feed the result back. Since the Grok API is stateless, this requires a second API call if tool results are needed for continued generation. The flow:

```typescript
// After collecting all tool_calls from the stream:
if (toolCallResults.length > 0) {
  // Append assistant message with tool_calls field
  messages.push({ role: "assistant", content: null, tool_calls: rawToolCallObjects });
  // Append each tool result
  for (const result of toolCallResults) {
    messages.push({
      role: "tool",
      tool_call_id: result.id,
      name: result.name,
      content: result.result,
    });
  }
  // Re-invoke the stream (recursion or loop)
  // Max depth: 3 tool call rounds to prevent infinite loops
}
```

Keep a `toolCallDepth` counter and cap at 3 to prevent runaway tool execution loops.

**`Orchestrator.stop()`:** Called by Phase 6's shutdown sequence to tear down all active resources in a well-defined order. Must be idempotent (safe to call more than once).

```typescript
async stop(): Promise<void> {
  // 1. Abort any in-flight Grok API request immediately.
  this.currentAbortController?.abort();
  this.currentAbortController = null;

  // 2. Flush and clear the TTS queue so no further synthesis is attempted.
  this.ttsQueue = [];
  this.ttsRunning = false;

  // 3. Cancel the awareness stream subscription so the daemon callback stops firing.
  this.daemon.stopAwarenessStream();

  // 4. Release the microphone — tells the Rust audio engine to stop capture.
  try {
    await this.audio.stopCapture();
  } catch (err) {
    console.warn("[orchestrator] stopCapture error during shutdown:", err);
  }

  // 5. Close gRPC client connections to release file handles and OS resources.
  this.audio.close();
  this.daemon.close();
}
```

The `AudioClient.close()` and `DaemonClient.close()` methods must call `this.client?.close()` on their underlying `grpc.Client` instance. This is safe to call after the server-side process has already exited.

**`processUtterance` must be re-entrant-safe:** If a new transcription arrives while one is being processed (the user interrupts), cancel the in-flight Grok request and TTS queue, then start fresh. Use an `AbortController`:

```typescript
private currentAbortController: AbortController | null = null;

async processUtterance(transcript: string) {
  // Cancel any in-flight response
  this.currentAbortController?.abort();
  this.ttsQueue = [];
  this.ttsRunning = false;

  this.currentAbortController = new AbortController();
  // Pass signal to fetchWithRetry
  ...
}
```

---

## Sentence Streaming

The goal is to begin TTS synthesis for the first complete sentence before Grok has finished generating the full response, minimizing time-to-first-audio.

**Sentence detection algorithm:**

Use a cursor-based `SentenceDetector` rather than a stateless regex scan. The cursor tracks how far into the accumulated text has already been processed, so only genuinely new text is inspected on each `feed()` call. This avoids the index-confusion bug that arises when the buffer is sliced mid-loop and the regex's `lastIndex` no longer aligns with the new buffer start.

```typescript
const FORCE_SPLIT_CHARS = 150; // force-split punctuation-free runs at this length

class SentenceDetector {
  private accumulated = "";
  private cursor = 0; // index into `accumulated` up to which we have already scanned

  // Matches a sentence-ending punctuation sequence followed by whitespace or EOS.
  // The `u` flag enables Unicode word boundaries for CJK full-stops (。！？).
  private readonly SENTENCE_END = /([.!?。！？]+)(\s|$)/gu;

  // Abbreviations whose trailing period must NOT trigger a sentence split.
  private readonly ABBREVIATIONS = new Set([
    "dr", "mr", "mrs", "ms", "prof", "sr", "jr",
    "vs", "etc", "e.g", "i.e", "approx", "fig",
  ]);

  /**
   * Appends `text` to the internal buffer and returns any newly completed
   * sentences. Call `flush()` after the stream ends to retrieve any trailing
   * incomplete sentence.
   */
  feed(text: string): string[] {
    this.accumulated += text;
    const sentences: string[] = [];

    // Only scan the region that is new since last feed().
    // Reset lastIndex to `cursor` so the regex starts from where we left off.
    this.SENTENCE_END.lastIndex = this.cursor;

    let match: RegExpExecArray | null;
    while ((match = this.SENTENCE_END.exec(this.accumulated)) !== null) {
      const endIdx = match.index + match[1].length;

      // Check whether the word immediately before the punctuation is an abbreviation.
      const textBefore = this.accumulated.slice(this.cursor, match.index);
      const wordBefore = textBefore.trimEnd().split(/\s+/).at(-1)?.replace(/[.!?。！？]+$/, "").toLowerCase();
      if (wordBefore && this.ABBREVIATIONS.has(wordBefore)) {
        // Advance cursor past this punctuation without emitting a sentence.
        this.cursor = endIdx;
        this.SENTENCE_END.lastIndex = this.cursor;
        continue;
      }

      const candidate = this.accumulated.slice(this.cursor, endIdx).trim();
      if (candidate.length > 0) {
        sentences.push(candidate);
      }
      this.cursor = endIdx;
      // Skip leading whitespace so the next candidate starts cleanly.
      while (this.cursor < this.accumulated.length && /\s/.test(this.accumulated[this.cursor])) {
        this.cursor++;
      }
      this.SENTENCE_END.lastIndex = this.cursor;
    }

    // Force-split if the unprocessed tail exceeds FORCE_SPLIT_CHARS with no
    // sentence-ending punctuation (e.g. a long list item or run-on clause).
    const tail = this.accumulated.slice(this.cursor);
    if (tail.length > FORCE_SPLIT_CHARS) {
      // Split at the last word boundary before the limit.
      const splitPoint = tail.lastIndexOf(" ", FORCE_SPLIT_CHARS);
      const forcedChunk = splitPoint > 0 ? tail.slice(0, splitPoint) : tail.slice(0, FORCE_SPLIT_CHARS);
      if (forcedChunk.trim().length > 0) {
        sentences.push(forcedChunk.trim());
      }
      this.cursor += forcedChunk.length;
      while (this.cursor < this.accumulated.length && /\s/.test(this.accumulated[this.cursor])) {
        this.cursor++;
      }
      this.SENTENCE_END.lastIndex = this.cursor;
    }

    return sentences;
  }

  /**
   * Called after the Grok stream ends. Returns any text remaining in the buffer
   * that did not end with terminal punctuation (e.g. the final sentence of a
   * response that was cut off or simply lacked a period).
   */
  flush(): string {
    const remaining = this.accumulated.slice(this.cursor).trim();
    this.accumulated = "";
    this.cursor = 0;
    this.SENTENCE_END.lastIndex = 0;
    return remaining;
  }
}
```

**Integration in `processUtterance`:** Create a `SentenceDetector` instance per utterance. Feed each `content` chunk into it. When sentences come out, enqueue them for TTS. After the Grok stream ends, call `flush()` — if any remaining text exists (last sentence lacked terminal punctuation), enqueue it too.

**Edge cases:**
- Very long punctuation-free runs (>150 chars) are force-split at a word boundary by the detector itself — no extra handling needed in the caller.
- Markdown list items (starting with `-` or `*`) should be stripped of the marker before being sent to TTS.
- Code fences (` ``` `) should be detected and replaced with a natural-language summary ("here's the code") rather than spoken character by character.

---

## Tool Call Handling

### Flow

1. The `chatStream` generator accumulates streaming `tool_calls` delta chunks into a `Map<index, { id, name, args }>`.
2. Once an entry's `args` forms valid JSON (see `isCompleteJson`), yield a `tool_call` chunk.
3. In `processUtterance`, collect yielded tool calls, pause sentence streaming momentarily, execute each in parallel via `daemon.executeTool`, then continue.

### Tool result injection

Tool results must be returned to Grok in a follow-up request. The orchestrator builds the continuation messages array:

```typescript
type InFlightMessages = Message[];

// After stream ends with pending tool calls:
const toolMessages: Message[] = toolCallsYielded.map((tc) => ({
  role: "tool" as const,
  tool_call_id: tc.id,
  name: tc.name,
  content: toolResults.get(tc.id) ?? "error: no result",
}));

const continuationMessages = [
  ...originalMessages,
  { role: "assistant", content: null, tool_calls: rawToolCallArray },
  ...toolMessages,
];

// Start a new chatStream with continuationMessages
```

### Screenshot tool special case

When `executeTool("screenshot", ...)` returns a result matching `/^\[SCREENSHOT:(\d+)x(\d+):(.+)\]$/`:

1. Extract the base64 string.
2. Call `context.setVisionData(b64)`.
3. In the continuation messages array, the injected screenshot result becomes a `tool` role message with text content `"Screenshot captured and attached as vision data."` — the actual image is attached as a vision content block in the *next* user-role message, not in the tool result.

This is necessary because the xAI API (following OpenAI conventions) does not support image content in `tool` role messages; vision data must be in `user` or `system` role messages.

### Tool confirmation UX

If `ToolSchema.dangerous === true`, before executing the tool the orchestrator should:

1. Pause TTS.
2. Emit `"tool-confirm-request"` to the webview with `{ toolName, arguments }`.
3. Await a `"tool-confirm-response"` event from the webview (user clicks OK/Cancel).
4. If canceled, inject a tool result of `"User declined to execute this action."`.

This confirmation flow is wired in Phase 6 (Integration). In Phase 3, dangerous tools execute immediately (add a TODO comment).

---

## gRPC Client Setup

### Connecting to Unix sockets

Both `AudioClient` and `DaemonClient` connect to Unix domain sockets. `@grpc/grpc-js` supports Unix socket addresses with the `unix://` URI scheme:

```typescript
const address = "unix:///tmp/albedo-audio.sock";
const client = new AudioEngineClient(address, grpc.credentials.createInsecure());
```

On Windows, fall back to TCP loopback (`127.0.0.1:50051` for audio, `127.0.0.1:50052` for daemon). Read the address from an environment variable or config:

```typescript
const AUDIO_SOCKET = process.env.ALBEDO_AUDIO_SOCKET ?? "unix:///tmp/albedo-audio.sock";
const DAEMON_SOCKET = process.env.ALBEDO_DAEMON_SOCKET ?? "unix:///tmp/albedo-daemon.sock";
```

### Proto loading strategy

Two options:

**Option A — Runtime `protoLoader` (recommended for development):**  
Load `.proto` files at runtime using `@grpc/proto-loader`. No codegen step required. Less type safety, but faster iteration.

```typescript
const packageDefinition = protoLoader.loadSync(
  path.resolve(import.meta.dir, "../../../proto/audio.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
);
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const AudioEngine = (protoDescriptor.albedo as any).audio.AudioEngine;
```

**Option B — Pre-generated stubs (recommended for production):**  
Run `make proto` to generate typed stubs. Import the generated service client class. Full TypeScript types on all request/response objects.

Use Option A for Phase 3 to unblock development if codegen is not yet stable. Switch to Option B before Phase 6.

### Keepalive and channel options

```typescript
const channelOptions = {
  "grpc.keepalive_time_ms": 30_000,
  "grpc.keepalive_timeout_ms": 10_000,
  "grpc.keepalive_permit_without_calls": 1,
  "grpc.http2.max_pings_without_data": 0,
};
```

Pass as the third argument to the generated client constructor.

### Waiting for the socket to exist

The Rust and Go binaries may take 500ms–2s to start listening. The orchestrator must wait for the socket file to appear before attempting to connect:

```typescript
async function waitForSocket(sockPath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await Bun.file(sockPath).exists();
      // Try a dummy connection
      const client = new grpc.Client(
        `unix://${sockPath}`,
        grpc.credentials.createInsecure()
      );
      await new Promise<void>((resolve, reject) => {
        client.waitForReady(Date.now() + 3000, (err) => {
          client.close();
          if (err) reject(err); else resolve();
        });
      });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`Socket ${sockPath} not ready after ${timeoutMs}ms`);
}

// In index.ts, replace the fixed Bun.sleep(1000) with:
await Promise.all([
  waitForSocket("/tmp/albedo-audio.sock"),
  waitForSocket("/tmp/albedo-daemon.sock"),
]);
```

---

## Testing Strategy

### Unit tests

**File:** `src/bun/__tests__/grok-client.test.ts`

- Mock `fetch` to return a sequence of `data:` SSE lines.
- Assert that `chatStream` yields the correct `StreamChunk` sequence.
- Test retry logic: mock a 429 response followed by a 200, assert one retry occurred.
- Test `isCompleteJson` with partial and complete JSON strings.

**File:** `src/bun/__tests__/context-manager.test.ts`

- Add 100 fake turns to history, assert `totalHistoryTokens` stays within budget after each `addExchange`.
- Assert system prompt contains injected awareness fields when `updateAwareness` has been called.
- Assert vision content block is included in the user message when `setVisionData` was called.
- Assert `pendingVisionB64` is cleared after `buildMessages`.

**File:** `src/bun/__tests__/sentence-detector.test.ts`

- Feed streaming text character by character, assert sentences are detected at the correct positions.
- Test abbreviation skip list (`"Dr. Smith"` should not split at `"Dr."`).
- Test `flush()` returns remaining buffer.

**File:** `src/bun/__tests__/memory.test.ts`

- Use an in-memory SQLite (`:memory:`) path.
- Save three exchanges, retrieve them, assert count and ordering.

### Mock gRPC servers

Create `scripts/mock-audio-server.ts` and `scripts/mock-daemon-server.ts` using `@grpc/grpc-js` server APIs. These implement the minimum RPCs needed for testing:

- `mock-audio-server.ts`: `StartCapture` returns `{ active: true }`, `WatchTranscriptions` emits a fake `TranscriptionResult` every 5s, `Synthesize` returns silent 0.5s PCM audio.
- `mock-daemon-server.ts`: `ListTools` returns a hardcoded list of 3 tools, `GetAwareness` returns a fake snapshot, `ExecuteTool` always returns `{ success: true, result: "mock result" }`.

Run both mocks together with `bun run scripts/start-mocks.ts` for local development without requiring compiled Rust/Go binaries.

### Integration test with real Grok API

**File:** `scripts/test-grok-integration.ts`

```typescript
import { GrokClient } from "../src/bun/grok-client";

const grok = new GrokClient({
  apiKey: process.env.XAI_API_KEY!,
  model: "grok-4-fast",
  baseUrl: "https://api.x.ai/v1",
  maxTokens: 512,
  temperature: 0.7,
});

const messages = [{ role: "user" as const, content: "Say exactly: 'Integration test passed.'" }];

let fullText = "";
for await (const chunk of grok.chatStream(messages)) {
  if (chunk.type === "content") {
    process.stdout.write(chunk.text);
    fullText += chunk.text;
  }
}
console.log();
console.assert(fullText.includes("Integration test passed"), "Expected response not found");
```

Run with `bun run scripts/test-grok-integration.ts`. Requires `XAI_API_KEY` in environment.

### End-to-end voice test

1. Start mock servers: `bun run scripts/start-mocks.ts`
2. Start Electrobun: `bun dev`
3. The mock audio server emits a `TranscriptionResult` every 5 seconds.
4. Observe in console: `[orchestrator] Processing utterance: ...` → `[grok] streaming...` → `[tts] speaking: ...`
5. If Phase 2 TTS is wired: confirm audio output through speakers.

---

## Validation Criteria

The phase is complete when all of the following pass:

| # | Criterion | How to verify |
|---|---|---|
| 1 | `grok-client.ts` streams a response from the real xAI API | Run `scripts/test-grok-integration.ts`, see tokens in stdout |
| 2 | `context-manager.ts` assembles correct message array | Unit test: check array shape, system prompt content, user message last |
| 3 | `rpc/audio-client.ts` connects to mock server | `bun run scripts/test-audio-rpc.ts` prints `CaptureStatus { active: true }` |
| 4 | `rpc/daemon-client.ts` connects to mock server | `bun run scripts/test-daemon-rpc.ts` prints tool list |
| 5 | Sentence detector splits "Hello. How are you?" into two sentences | Unit test |
| 6 | **Text-mode pipeline:** type message → Grok responds → subtitles display | Manual test in Electrobun UI |
| 7 | **TTS pipeline:** text → `audio.synthesize` called → PCM returned | Log in `speakSentence`, confirmed with mock server returning real silence |
| 8 | **Tool call:** response triggers `daemon.executeTool`, result fed back | Add a test tool to mock daemon that echoes its input; verify Grok sees the result |
| 9 | History trims correctly at budget limit | Unit test with synthetic 2M-token history |
| 10 | **Voice-mode pipeline** (requires Phase 1/2): speak → transcription → Grok → TTS → audio out | Manual end-to-end with all binaries running |

---

## Risks and Notes

### Bun gRPC ecosystem maturity

`@grpc/grpc-js` runs in Bun but relies on Node.js compatibility mode. As of 2026, Bun's Node.js compatibility is high but not perfect. Known issues:

- `http2` sessions have occasionally exhibited connection reset bugs in Bun < 1.1.20. Keep Bun up to date.
- `@grpc/grpc-js` uses `node:net` for Unix socket connections. Test explicitly on the target OS.
- If `@grpc/grpc-js` proves unstable, consider `nice-grpc` or `@connectrpc/connect` (Connect protocol is HTTP/1.1 compatible, easier to debug).

**Fallback plan:** If gRPC over Unix sockets is unreliable in Bun, replace IPC with **stdio JSON-RPC** (newline-delimited JSON) for Phase 3. The Rust and Go servers write JSON to stdout; the Bun process reads stdin. Less efficient for audio streaming but reliable for control messages. Audio PCM can still go over a shared memory file or a simple TCP socket.

### Protobuf codegen for TypeScript

Multiple code generators exist with different output styles:

| Generator | Output | Notes |
|---|---|---|
| `protoc-gen-ts` | ES modules, class-based | Good for modern TS, actively maintained |
| `ts-proto` | Interfaces + plain functions | More idiomatic TS, works with `@grpc/grpc-js` |
| `grpc-web` + `protoc-gen-grpc-web` | Browser-compatible | Wrong target for Bun main process |
| `nice-grpc` codegen | Async iterables | Cleanest API for streaming, recommended |

Prefer `ts-proto` with `nice-grpc` if you want idiomatic async/await for streaming. The skeleton code above uses raw `@grpc/grpc-js` for clarity; migrate to `nice-grpc` if the raw stream management becomes unwieldy.

### Streaming edge cases

- **Empty `content` delta:** Some Grok stream events contain `delta.content === ""` or `delta.content === null`. Guard with `if (delta.content)` (truthy check, not strict null check).
- **Multiple tool calls in one response:** Grok may return several tool calls in a single stream. The accumulator `Map<index, ...>` handles this, but ensure the index key is the tool call's `index` field (integer), not the `id` (string), as `id` may be absent on intermediate chunks.
- **Interrupted streams:** If the Grok HTTP connection drops mid-stream, `reader.read()` throws. Wrap the entire stream loop in a try/catch. On error, yield `{ type: "done" }` and surface the error to the orchestrator. The orchestrator should speak a fallback phrase ("Sorry, I lost connection.") and retry if appropriate.
- **Concurrent utterances:** If the user speaks while a response is being streamed, abort the current stream (use `AbortController` signal passed to `fetch`). The `reader` will throw `AbortError` — catch and handle gracefully.
- **Unicode sentence boundaries:** The `SentenceDetector` regex works for ASCII punctuation. For languages using `。` (CJK full stop), `।` (Devanagari), etc., extend the pattern: `/([.!?。！？]+)(\s|$)/u`.

### Context window — vision data size

A 1920×1080 JPEG at quality 60 is roughly 200–400 KB. Base64-encoded, this is ~530–530 KB of text, approximately **130,000–135,000 tokens** at 4 chars/token. This is well within the 2M budget but non-trivial. Consider:

- Downscaling screenshots to 1280×720 before encoding (the Go daemon should do this; the `ScreenCaptureRequest.quality` field already exists).
- Only injecting vision data when the user explicitly asks Albedo to "look at the screen" or when a screenshot tool call is made. Do not inject screenshots on every turn.

### Model name

The architecture spec references `grok-4.1-fast-reasoning`. Verify the exact model identifier against the xAI API docs at time of implementation — model names and aliases change frequently. Use an environment variable `GROK_MODEL` with a default fallback so the model can be changed without code edits:

```typescript
model: process.env.GROK_MODEL ?? "grok-4-fast",
```

### xAI API tool use format

The xAI API follows the OpenAI tool use specification. Tools are passed as:

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "tool_name",
        "description": "...",
        "parameters": { ...JSON Schema... }
      }
    }
  ],
  "tool_choice": "auto"
}
```

Tool call results are returned as `role: "tool"` messages with `tool_call_id` matching the ID from the assistant's `tool_calls` field. Confirm this is still accurate against xAI's API changelog before implementation.

### Memory initialization on startup

When `Orchestrator.start()` runs, load recent conversation history from `Memory` into `ContextManager`:

```typescript
const recentTurns = this.memory.getRecentExchanges(20); // last 20 exchanges = 40 messages
for (const turn of recentTurns) {
  this.context.history.push({
    role: turn.role as "user" | "assistant",
    content: turn.content,
    timestampMs: turn.timestampMs,
    tokenCount: Math.ceil(turn.content.length / 4),
  });
}
```

This gives Albedo memory of the most recent conversations without requiring the entire history to be in context (which would be slow and expensive on first load).
