# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this

Albedo AI is a desktop AI assistant with a Live2D anime avatar, built on Electrobun (Bun-based desktop framework using system webview). The voice pipeline is: **Mic → VAD → Whisper STT → LLM (OpenRouter/Grok) → Kokoro TTS → Avatar lip-sync**.

## Build & Development

```bash
# Full build (proto codegen + Rust + Go + Electrobun)
make all

# Development mode (builds everything, starts Electrobun dev server with hot reload)
export OPENROUTER_API_KEY="sk-or-..."
make dev

# Build individual components
make proto          # Generate gRPC stubs (Go + TypeScript)
make build-rust     # Build Rust audio engine → bin/albedo-audio
make build-go       # Build Go daemon → bin/albedo-daemon
make build-bun      # Build Electrobun app (bun run build)

make clean          # Remove all build artifacts
```

## Testing

```bash
# Unit tests (Bun test runner, uses bun:test)
bun test                                    # Run all unit tests
bun test src/bun/__tests__/memory.test.ts   # Run a single test file

# Integration tests (requires native binaries built first)
make test-integration

# Standalone test scripts
bun run scripts/test-grok.ts
bun run scripts/test-memory.ts
bun run scripts/test-audio-rpc.ts
bun run scripts/test-daemon-rpc.ts

# Mock servers for local development without native binaries
bun run scripts/start-mocks.ts
```

## Architecture

### Process Model

Four processes communicate via gRPC over Unix sockets:

```
Electrobun Main Process (Bun/TS)   src/bun/
├── Webview (React)                src/views/mainview/
├── albedo-audio (Rust)            audio-engine/       → /tmp/albedo-audio.sock
└── albedo-daemon (Go)             daemon/             → /tmp/albedo-daemon.sock
```

- **Bun main process** (`src/bun/index.ts`): Orchestrator, window management, tray, gRPC clients for audio and daemon
- **Webview** (`src/views/mainview/`): React app with Live2D avatar (pixi-live2d-display), subtitles, chat input, settings
- **Rust audio engine** (`audio-engine/`): VAD (silero), Whisper STT, Kokoro TTS, audio I/O via cpal
- **Go daemon** (`daemon/`): System awareness (active window, CPU/RAM, clipboard), tool execution, screen capture, OCR

### IPC

- **Bun ↔ native processes**: gRPC over Unix sockets. Proto definitions in `proto/audio.proto` and `proto/daemon.proto`. Generated stubs: Go → `daemon/proto/`, TypeScript → `src/bun/rpc/generated/`
- **Bun ↔ Webview**: Electrobun typed RPC (`BrowserView.defineRPC` / `Electroview.defineRPC`). Schema in `src/rpc-schema.ts`, shared types in `src/shared/rpc-types.ts`

### Key Modules (Bun main process)

- `orchestrator.ts` — Core pipeline: receives transcriptions, builds context, streams LLM, dispatches TTS, handles tool calls (up to 3 recursive rounds)
- `grok-client.ts` — OpenRouter API streaming client with tool-call support
- `context-manager.ts` — Builds context window with history budget (1.8M tokens), sentence detection
- `memory.ts` — SQLite long-term memory (`bun:sqlite`, stored at `~/.config/albedo-ai/memory.sqlite`, 90-day retention)
- `process-manager.ts` — Spawns and restarts native child processes
- `config.ts` — Config loading: env vars → `.env` → `~/.config/albedo-ai/config.json`

### Key Dependencies

- `pixi.js` is pinned to exactly `7.4.2` for Live2D compatibility (override in package.json)
- Rust audio engine uses `whisper-rs` (whisper.cpp bindings), `ort` (ONNX runtime for VAD + TTS), `tonic` (gRPC)
- Go daemon uses `robotgo` (input), `go-rod` (browser), `gosseract` (OCR), `gopsutil` (system metrics)

### Configuration

Priority order: environment variables > `.env` file > `~/.config/albedo-ai/config.json`

Key env vars: `OPENROUTER_API_KEY` (required), `ALBEDO_MODEL` (default: `x-ai/grok-4.1-fast`), `ALBEDO_VAD_THRESHOLD`, `ALBEDO_VOICE_ID`, `ALBEDO_VOICE_SPEED`

### Path Aliases (tsconfig)

- `@bun/*` → `src/bun/*`
- `@views/*` → `src/views/*`
