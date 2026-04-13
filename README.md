# Albedo AI

A desktop AI assistant with voice interaction, Live2D avatar, and system awareness. Built with a multi-language architecture optimized for low latency and local inference.

```
User speaks → VAD → Whisper STT → Grok LLM → Kokoro TTS → Avatar speaks back
                                      ↕
                              System Awareness
                            (screen, windows, tools)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Electrobun Shell (Bun)                      │
│                                                             │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────────┐ │
│  │  Live2D     │  │  Chat /    │  │  System Tray +       │ │
│  │  WebGL      │  │  Subtitles │  │  Settings            │ │
│  └──────┬──────┘  └─────┬──────┘  └──────────────────────┘ │
│         │               │                                    │
│  ┌──────┴───────────────┴────────────────────────────────┐  │
│  │           Orchestrator (Bun main process)              │  │
│  │                                                        │  │
│  │  • Typed RPC ↔ webview                                │  │
│  │  • Spawns & manages Rust/Go child processes            │  │
│  │  • Routes messages between subsystems                  │  │
│  │  • Manages Grok API calls                              │  │
│  │  • Context window assembly                             │  │
│  └───┬──────────────┬──────────────┬─────────────────────┘  │
│      │              │              │                          │
│  ┌───┴────┐   ┌────┴─────┐  ┌────┴──────┐                  │
│  │ Rust   │   │ Go       │  │ SQLite    │                   │
│  │ Audio  │   │ Daemon   │  │ Memory    │                   │
│  │ Engine │   │ (Actions │  │ (Bun FFI  │                   │
│  │        │   │  + Aware) │  │  or       │                   │
│  │ (gRPC) │   │ (gRPC)   │  │  better-  │                   │
│  └────────┘   └──────────┘  │  sqlite3) │                   │
│                              └───────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

### Process Model

```
albedo-ai (Electrobun)
├── Main Process (Bun)          → Orchestrator, Grok API client, context management
├── Webview (React)             → Avatar Live2D, subtitles, settings UI
├── albedo-audio (Rust binary)  → VAD, Whisper STT, Kokoro TTS, lip sync, audio I/O
└── albedo-daemon (Go binary)   → System awareness, tool execution, screen capture
```

All inter-process communication uses **gRPC** (protobufs) over Unix sockets for low latency, type safety, and cross-language compatibility.

---

## Tech Stack

| Component | Language | Why |
|---|---|---|
| Desktop shell + UI | **TypeScript** (Bun) | Electrobun native, React webview |
| LLM orchestration | **TypeScript** (Bun) | Async streaming, context management |
| Audio I/O + VAD | **Rust** | Low latency, `cpal` ecosystem |
| STT (Whisper) | **Rust** | `whisper-rs` (C++ bindings), zero-copy |
| TTS (Kokoro) | **Rust** | ONNX runtime, audio pipeline locality |
| Lip sync | **Rust** | Real-time DSP, viseme extraction |
| Window tracking | **Go** | Cross-platform, `robotgo` ecosystem |
| Screen capture | **Go** | `kbinani/screenshot`, fast JPEG encode |
| Tool execution | **Go** | Process management, sandboxing |
| System metrics | **Go** | `gopsutil`, native OS APIs |
| Keyboard/mouse automation | **Go** | `robotgo` |
| Memory/embeddings | **TypeScript** + Zig | SQLite (Bun native), embedding model via Zig FFI |
| IPC | **Protobuf/gRPC** | Type-safe, cross-language, low overhead |

---

## Project Structure

```
albedo-ai/
├── package.json                     # Electrobun project root
├── electrobun.config.ts
├── Makefile
├── proto/                           # Shared protobuf definitions
│   ├── audio.proto                  # Rust ↔ Bun
│   └── daemon.proto                 # Go ↔ Bun
│
├── src/
│   ├── bun/                         # Electrobun main process (TypeScript)
│   │   ├── index.ts                 # Entry point, window creation, tray
│   │   ├── orchestrator.ts          # Core pipeline logic
│   │   ├── grok-client.ts           # xAI API client (streaming)
│   │   ├── context-manager.ts       # Context window builder (2M tokens)
│   │   ├── memory.ts                # Long-term memory (SQLite + embeddings)
│   │   ├── config.ts                # User preferences, persona config
│   │   └── rpc/
│   │       ├── audio-client.ts      # gRPC client → Rust audio engine
│   │       └── daemon-client.ts     # gRPC client → Go daemon
│   │
│   └── views/
│       └── mainview/                # Electrobun webview (React)
│           ├── index.html
│           ├── App.tsx
│           ├── components/
│           │   ├── Avatar.tsx       # pixi-live2d-display + WebGL
│           │   ├── Subtitles.tsx
│           │   ├── ChatInput.tsx    # Optional text input
│           │   └── Settings.tsx
│           └── hooks/
│               └── useRPC.ts        # Typed RPC bridge to main process
│
├── audio-engine/                    # Rust crate
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs                  # gRPC server entrypoint
│       ├── vad.rs                   # Voice Activity Detection (silero-vad)
│       ├── stt.rs                   # whisper-rs (whisper.cpp bindings)
│       ├── tts.rs                   # Kokoro TTS (via candle / onnxruntime)
│       ├── lipsync.rs              # Audio → viseme extraction
│       ├── audio_capture.rs         # Mic input (cpal)
│       ├── audio_playback.rs        # Speaker output (cpal)
│       └── loopback.rs             # Desktop audio capture (system loopback)
│
├── daemon/                          # Go module
│   ├── go.mod
│   ├── cmd/
│   │   └── albedo-daemon/
│   │       └── main.go             # gRPC server entrypoint
│   ├── awareness/
│   │   ├── window.go               # Active window tracking
│   │   ├── screen.go               # Screenshot capture + optional OCR
│   │   ├── clipboard.go            # Clipboard monitoring
│   │   ├── metrics.go              # CPU/RAM/Disk/Network stats
│   │   └── collector.go            # Aggregates all awareness data
│   ├── actions/
│   │   ├── registry.go             # Tool registry
│   │   ├── filesystem.go           # File read/write/search
│   │   ├── shell.go                # Controlled command execution
│   │   ├── automation.go           # Mouse/keyboard (robotgo)
│   │   ├── browser.go              # Browser control (rod/chromedp)
│   │   ├── appctl.go               # App launch/close/focus
│   │   └── notifications.go        # System notifications
│   └── security/
│       └── sandbox.go              # Command allowlist, path restrictions
│
└── assets/
    ├── models/                      # Live2D model files (.moc3, textures)
    ├── voices/                      # Kokoro voice model files
    └── whisper/                     # Whisper model (ggml-base.bin etc)
```

---

## How It Works

### Voice Pipeline

1. **Mic capture** (Rust/cpal) streams raw PCM audio
2. **VAD** (Rust/silero-vad) detects speech segments in real time
3. **STT** (Rust/whisper-rs) transcribes completed utterances via whisper.cpp
4. **Orchestrator** (Bun) builds context with conversation history + system awareness
5. **Grok API** streams the LLM response token by token
6. **TTS** (Rust/Kokoro) synthesizes each sentence as it completes, with viseme data
7. **Avatar** (React/Live2D) lip-syncs to the viseme stream while audio plays back

### System Awareness

The Go daemon continuously monitors:

- **Active window** — title, app name, PID (via xdotool/Win32 API)
- **System metrics** — CPU, RAM, disk, network usage
- **Clipboard** — content changes
- **Screen capture** — on-demand screenshots with optional OCR

This context is injected into every LLM call so Albedo understands what the user is currently doing.

### Tool Execution

Albedo can take actions on the user's behalf through a sandboxed tool system:

| Tool | Description |
|---|---|
| `read_file` | Read file contents |
| `run_command` | Execute shell commands (sandboxed) |
| `open_app` | Launch applications by name |
| `type_text` | Type text at cursor position |
| `screenshot` | Capture screen as JPEG |

All tool calls go through a security sandbox that enforces path restrictions, blocks dangerous commands (`rm -rf /`, `shutdown`, etc.), and flags risky operations for user confirmation.

### Proactive Behavior

Albedo doesn't just respond — it monitors system state and can proactively alert the user:

- High CPU/RAM usage warnings
- Context-aware suggestions based on active window
- Expression changes on the Live2D avatar based on conversation sentiment

---

## Latency Budget

```
User speaks  ─── 0ms
VAD detect   ─── ~100ms  (Rust, silero-vad)
Whisper STT  ─── ~300ms  (Rust, whisper.cpp base model)
Context build ── ~20ms   (Bun)
Grok API     ─── ~200ms  (first token, streaming)
TTS sentence ─── ~150ms  (Rust, Kokoro ONNX)
Audio play   ─── ~10ms   (Rust, cpal)
─────────────────────────
Total to first audio: ~780ms
```

Under 1 second from user speech to Albedo's first spoken word.

---

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Rust](https://rustup.rs/) >= 1.75
- [Go](https://go.dev/) >= 1.22
- [Protobuf compiler](https://grpc.io/docs/protoc-installation/) (`protoc`)
- OpenRouter API key (for LLM access)

### Model Files

Download and place in `assets/`:

| Model | Path | Source |
|---|---|---|
| Whisper base | `assets/whisper/ggml-base.bin` | [ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp/tree/master/models) |
| Model Files | `assets/voices/default.onnx` | [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) |
| Live2D model | `assets/models/` | Any .moc3 compatible model |

---

## Build

```bash
# Generate protobuf stubs
make proto

# Build everything (Rust + Go + Bun)
make all

# Or build individually
make build-rust
make build-go
make build-bun
```

## Run

```bash
# Set your API key
export OPENROUTER_API_KEY="your-key-here"

# Development mode (builds native binaries + starts Electrobun dev server)
make dev
```

---

## Configuration

Set your OpenRouter API key as an environment variable:

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

The orchestrator connects via OpenRouter with these defaults:

| Setting | Value |
|---|---|
| Model | `x-ai/grok-4.1-fast` |
| API base | `https://openrouter.ai/api/v1` |
| Max tokens | 4096 |
| Temperature | 0.7 |

You can use any OpenRouter-supported model by setting the `ALBEDO_MODEL` env var:

```bash
export ALBEDO_MODEL="google/gemini-2.5-flash"
export ALBEDO_MODEL="anthropic/claude-sonnet-4"
```

---

## Security

The Go daemon enforces a security sandbox on all tool execution:

- **Allowed read paths** — home directory, `/tmp`
- **Allowed write paths** — Desktop, Documents, Downloads, `/tmp`
- **Blocked commands** — `rm -rf /`, `mkfs`, `shutdown`, `chmod 777`, pipe-to-shell patterns
- **Dangerous commands** (require confirmation) — `rm`, `mv`, `kill`, `git push`, `git reset --hard`, `npm publish`

---

## Costs

| Item | Monthly Cost |
|---|---|
| Grok 4.1 Fast (via OpenRouter) | ~$14 |
| Rust + Go binaries | Free |
| Whisper.cpp model | Free |
| Kokoro TTS model | Free |
| Electrobun | Free |
| Live2D (sample model) | Free |
| **Total** | **~$14/month** |

---

## Roadmap

| Phase | Scope |
|---|---|
| **0. Scaffold** | Electrobun init + proto + Makefile |
| **1. Audio MVP** | Rust: mic → VAD → Whisper → gRPC |
| **2. TTS** | Rust: Kokoro + playback + visemes |
| **3. Orchestrator** | Bun: Grok streaming + context |
| **4. Avatar** | React: Live2D + lip sync + subtitles |
| **5. Daemon** | Go: awareness + basic tools |
| **6. Integration** | Wire everything, end-to-end flow |
| **7. Polish** | Personality, expressions, proactive behavior |

---

## License

MIT
