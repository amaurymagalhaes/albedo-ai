# Phase 0: Scaffold — Implementation Plan

**Project:** Albedo AI  
**Phase:** 0 of 7  
**Estimated duration:** 1 day  
**Author:** Engineering  
**Last updated:** 2026-04-13

---

## Objective

Stand up the complete repository skeleton for Albedo AI so every subsequent phase has a stable foundation to build on. At the end of this phase:

- The Electrobun project is initialised with a valid `package.json` and `electrobun.config.ts`.
- Both protobuf definition files (`proto/audio.proto`, `proto/daemon.proto`) are committed and accurate.
- The Rust crate (`audio-engine/`) compiles (`cargo check` passes) with `tonic-build` generating code from the protos during `build.rs`.
- The Go module (`daemon/`) compiles (`go build ./...` passes) with the protobuf-generated Go code present.
- A `Makefile` with `proto`, `build-rust`, `build-go`, `build-bun`, `dev`, and `clean` targets ties the whole build together.
- Empty placeholder source files exist for every module listed in the architecture spec, preventing import errors in later phases.
- `make proto` completes without errors.

This phase produces **no runtime behaviour** — it is purely structural scaffolding.

---

## Prerequisites

### Operating system

Linux (Ubuntu 22.04+ or equivalent) or macOS 13+. Windows is not targeted for development; WSL2 is an acceptable Linux substitute.

### Required tools and versions

| Tool | Minimum version | Install reference |
|---|---|---|
| **Bun** | 1.1.x | `curl -fsSL https://bun.sh/install \| bash` |
| **Rust** (via rustup) | 1.78.0 stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Go** | 1.22.x | https://go.dev/dl/ |
| **protoc** (Protocol Buffers compiler) | 27.x | See below |
| **protoc-gen-go** | 1.34.x | `go install google.golang.org/protobuf/cmd/protoc-gen-go@latest` |
| **protoc-gen-go-grpc** | 1.4.x | `go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest` |
| **protoc-gen-ts** | 0.8.x | installed via npm/bun (see Step 5) |
| **git** | any recent | system package manager |

### Installing protoc

**Linux (apt):**
```bash
sudo apt-get update
sudo apt-get install -y protobuf-compiler
# Verify: protoc --version  →  libprotoc 27.x
```

**macOS (Homebrew):**
```bash
brew install protobuf
# Verify: protoc --version  →  libprotoc 27.x
```

### PATH requirements

After installing Go tools, ensure `$GOPATH/bin` (usually `~/go/bin`) is on your `$PATH`:

```bash
export PATH="$PATH:$(go env GOPATH)/bin"
# Add to ~/.bashrc or ~/.zshrc to persist
```

After installing Rust, `~/.cargo/bin` must also be on `$PATH` (the rustup installer does this automatically).

---

## Step-by-step tasks

### Step 1 — Create the repository root and initialise git

```bash
mkdir -p albedo-ai
cd albedo-ai
git init
```

Create a `.gitignore` at the repo root:

```
# Binaries
bin/

# Rust
audio-engine/target/

# Go
daemon/cmd/albedo-daemon/albedo-daemon

# Node / Bun
node_modules/
.electrobun/

# Generated protobuf code
src/bun/rpc/generated/
daemon/proto/*.pb.go

# Secrets
.env
*.ggml
*.onnx
*.bin
*.moc3
```

> **Note:** The `*.bin`, `*.onnx`, and `*.ggml` ignores prevent accidental commits of large model files. These will be downloaded separately in Phase 1 and Phase 2.

---

### Step 2 — Initialise the Electrobun project

```bash
# From repo root
bun init -y
```

Replace the generated `package.json` with the following content:

**`package.json`**
```json
{
  "name": "albedo-ai",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "electrobun dev",
    "build": "electrobun build",
    "start": "electrobun start"
  },
  "dependencies": {
    "electrobun": "^0.0.45",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.4.5",
    "@protobuf-ts/plugin": "^2.9.4",
    "@grpc/grpc-js": "^1.11.1",
    "@grpc/proto-loader": "^0.7.13"
  }
}
```

Install dependencies:

```bash
bun install
```

Create **`electrobun.config.ts`** at the repo root:

```typescript
import { defineConfig } from "electrobun/config";

export default defineConfig({
  app: {
    name: "Albedo AI",
    identifier: "ai.albedo.app",
    version: "0.1.0",
  },
  main: "src/bun/index.ts",
  views: {
    mainview: "src/views/mainview/index.html",
  },
  build: {
    outDir: ".electrobun/build",
  },
});
```

Create **`tsconfig.json`**:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@bun/*": ["src/bun/*"],
      "@views/*": ["src/views/*"]
    },
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "electrobun.config.ts"]
}
```

---

### Step 3 — Create the full directory skeleton

Run the following to create every directory and placeholder file at once:

```bash
# Directories
mkdir -p proto
mkdir -p src/bun/rpc/generated
mkdir -p src/views/mainview/components
mkdir -p src/views/mainview/hooks
mkdir -p audio-engine/src
mkdir -p daemon/cmd/albedo-daemon
mkdir -p daemon/awareness
mkdir -p daemon/actions
mkdir -p daemon/security
mkdir -p daemon/proto
mkdir -p assets/models
mkdir -p assets/voices
mkdir -p assets/whisper
mkdir -p assets/vad
mkdir -p bin

# Bun source placeholders (touched here; implemented in later phases)
touch src/bun/index.ts
touch src/bun/orchestrator.ts
touch src/bun/grok-client.ts
touch src/bun/context-manager.ts
touch src/bun/memory.ts
touch src/bun/config.ts
touch src/bun/rpc/audio-client.ts
touch src/bun/rpc/daemon-client.ts

# Webview placeholders
touch src/views/mainview/index.html
touch src/views/mainview/App.tsx
touch src/views/mainview/components/Avatar.tsx
touch src/views/mainview/components/Subtitles.tsx
touch src/views/mainview/components/ChatInput.tsx
touch src/views/mainview/components/Settings.tsx
touch src/views/mainview/hooks/useRPC.ts

# Rust source placeholders (implemented in Phase 1 and 2)
touch audio-engine/src/vad.rs
touch audio-engine/src/stt.rs
touch audio-engine/src/tts.rs
touch audio-engine/src/lipsync.rs
touch audio-engine/src/audio_capture.rs
touch audio-engine/src/audio_playback.rs
touch audio-engine/src/loopback.rs

# Go source placeholders (implemented in Phase 5)
touch daemon/awareness/window.go
touch daemon/awareness/screen.go
touch daemon/awareness/clipboard.go
touch daemon/awareness/metrics.go
touch daemon/awareness/collector.go
touch daemon/actions/registry.go
touch daemon/actions/filesystem.go
touch daemon/actions/shell.go
touch daemon/actions/automation.go
touch daemon/actions/browser.go
touch daemon/actions/appctl.go
touch daemon/actions/notifications.go
touch daemon/security/sandbox.go
```

---

### Step 4 — Write the protobuf definitions

Create **`proto/audio.proto`**:

```protobuf
syntax = "proto3";
package albedo.audio;

option go_package = "albedo-ai/daemon/proto;proto";

service AudioEngine {
  // Streaming: mic audio chunks → transcription results
  rpc StreamSTT(stream AudioChunk) returns (stream TranscriptionResult);

  // Server-push: completed transcriptions after internal VAD+Whisper
  rpc WatchTranscriptions(Empty) returns (stream TranscriptionResult);

  // Single: text → synthesized audio
  rpc Synthesize(SynthesizeRequest) returns (SynthesizeResponse);

  // Start/stop mic capture
  rpc StartCapture(CaptureConfig) returns (CaptureStatus);
  rpc StopCapture(Empty) returns (CaptureStatus);

  // Start/stop desktop audio loopback
  rpc StartLoopback(Empty) returns (CaptureStatus);
  rpc StopLoopback(Empty) returns (CaptureStatus);
}

message AudioChunk {
  bytes  pcm_data    = 1;   // f32le PCM
  uint32 sample_rate = 2;
  bool   is_speech   = 3;   // VAD result
  uint64 timestamp_ms = 4;
}

message TranscriptionResult {
  string text         = 1;
  float  confidence   = 2;
  bool   is_final     = 3;  // Partial vs final
  uint64 timestamp_ms = 4;
}

message SynthesizeRequest {
  string text     = 1;
  string voice_id = 2;
  float  speed    = 3;
}

message SynthesizeResponse {
  bytes            pcm_data = 1;
  repeated Viseme  visemes  = 2;  // For lip sync
}

message Viseme {
  string shape       = 1;  // "A", "E", "I", "O", "U", "rest", etc.
  uint32 start_ms    = 2;
  uint32 duration_ms = 3;
  float  weight      = 4;
}

message CaptureConfig {
  string device_id     = 1;  // Optional, default = system mic
  uint32 sample_rate   = 2;  // Default 16000
  float  vad_threshold = 3;  // Default 0.5
}

message CaptureStatus {
  bool   active      = 1;
  string device_name = 2;
}

message Empty {}
```

Create **`proto/daemon.proto`**:

```protobuf
syntax = "proto3";
package albedo.daemon;

option go_package = "albedo-ai/daemon/proto;proto";

service Daemon {
  // Awareness
  rpc GetAwareness(Empty)                               returns (AwarenessSnapshot);
  rpc StreamAwareness(AwarenessConfig)                  returns (stream AwarenessSnapshot);
  rpc CaptureScreen(ScreenCaptureRequest)               returns (ScreenCaptureResponse);

  // Tool execution
  rpc ExecuteTool(ToolRequest)  returns (ToolResponse);
  rpc ListTools(Empty)          returns (ToolList);
}

message AwarenessSnapshot {
  ActiveWindow          active_window         = 1;
  SystemMetrics         metrics               = 2;
  string                clipboard_content     = 3;
  repeated string       recent_notifications  = 4;
  uint64                timestamp_ms          = 5;
}

message ActiveWindow {
  string title    = 1;
  string app_name = 2;
  string app_path = 3;
  uint32 pid      = 4;
}

message SystemMetrics {
  float                  cpu_percent      = 1;
  float                  ram_percent      = 2;
  float                  disk_percent     = 3;
  float                  network_mbps_in  = 4;
  float                  network_mbps_out = 5;
  repeated ProcessInfo   top_processes    = 6;
}

message ProcessInfo {
  string name        = 1;
  uint32 pid         = 2;
  float  cpu_percent = 3;
  float  ram_mb      = 4;
}

message AwarenessConfig {
  uint32 interval_ms        = 1;  // Polling interval in milliseconds
  bool   include_clipboard  = 2;
  bool   include_screen_ocr = 3;
}

message ScreenCaptureRequest {
  string region      = 1;  // "full" | "active_window"
  string format      = 2;  // "jpeg" | "png"
  uint32 quality     = 3;  // JPEG quality 1-100
  bool   include_ocr = 4;
}

message ScreenCaptureResponse {
  bytes  image_data = 1;
  string ocr_text   = 2;
  uint32 width      = 3;
  uint32 height     = 4;
}

message ToolRequest {
  string tool_name             = 1;
  string arguments_json        = 2;  // JSON-encoded args
  bool   requires_confirmation = 3;
}

message ToolResponse {
  bool   success = 1;
  string result  = 2;
  string error   = 3;
}

message ToolList {
  repeated ToolSchema tools = 1;
}

message ToolSchema {
  string name                    = 1;
  string description             = 2;
  string parameters_json_schema  = 3;
  bool   dangerous               = 4;
}

message Empty {}
```

> **Design note:** Both proto files include `option go_package` so `protoc-gen-go` can resolve imports. The Rust side does not use this option — `tonic-build` resolves by file path via `build.rs`.

---

### Step 5 — Initialise the Rust crate

```bash
cd audio-engine
cargo init --name albedo-audio
```

Replace the generated **`audio-engine/Cargo.toml`** with:

```toml
[package]
name    = "albedo-audio"
version = "0.1.0"
edition = "2021"

[dependencies]
# gRPC / protobuf
tonic  = "0.13"
prost  = "0.13"
tokio  = { version = "1", features = ["full"] }
tokio-stream = "0.1"

# Audio I/O
cpal = "0.15"

# STT — whisper.cpp bindings (Phase 1)
# whisper-rs = "0.14"

# TTS — ONNX runtime for Kokoro (Phase 2)
# ort = { version = "2.0", features = ["load-dynamic"] }

# VAD — silero via ONNX (Phase 1)
# silero-vad = "0.1"

# DSP
rubato = "0.16"
hound  = "3.5"

[build-dependencies]
tonic-build = "0.13"
```

> **Note:** `whisper-rs`, `ort`, and `silero-vad` are commented out for Phase 0 because they require native libraries (libwhisper, ONNX Runtime shared lib) that are not yet present. They will be uncommented and configured in Phase 1 and Phase 2 respectively.

Create **`audio-engine/build.rs`**:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(false) // Rust only hosts the server; Bun is the client
        .compile_protos(
            &[
                "../proto/audio.proto",
                "../proto/daemon.proto",
            ],
            &["../proto"],
        )?;
    Ok(())
}
```

Replace **`audio-engine/src/main.rs`** with the skeleton that imports the generated module:

```rust
//! albedo-audio — gRPC server skeleton (Phase 0)
//! Real implementations are added in Phase 1 (STT/VAD) and Phase 2 (TTS).

pub mod audio_proto {
    tonic::include_proto!("albedo.audio");
}

fn main() {
    println!("[albedo-audio] scaffold placeholder — implement in Phase 1");
}
```

Populate the stub source files so `cargo check` resolves every `mod` declaration that later phases will use. Write the following minimal content to each file:

**`audio-engine/src/vad.rs`**
```rust
// Phase 1: Voice Activity Detection (silero-vad)
pub struct VadEngine;
impl VadEngine {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> { Ok(VadEngine) }
}
```

**`audio-engine/src/stt.rs`**
```rust
// Phase 1: Whisper STT (whisper-rs)
pub struct WhisperEngine;
impl WhisperEngine {
    pub fn new(_model_path: &str) -> Result<Self, Box<dyn std::error::Error>> { Ok(WhisperEngine) }
    pub async fn transcribe(&self, _samples: &[f32]) -> String { String::new() }
}
```

**`audio-engine/src/tts.rs`**
```rust
// Phase 2: Kokoro TTS (ONNX Runtime)
use crate::audio_proto::Viseme;
pub struct KokoroEngine;
impl KokoroEngine {
    pub fn new(_model_path: &str) -> Result<Self, Box<dyn std::error::Error>> { Ok(KokoroEngine) }
    pub async fn synthesize(&self, _text: &str, _voice_id: &str, _speed: f32)
        -> Result<(Vec<u8>, Vec<Viseme>), Box<dyn std::error::Error>>
    {
        Ok((Vec::new(), Vec::new()))
    }
}
```

**`audio-engine/src/lipsync.rs`**
```rust
// Phase 2: Audio → viseme extraction
```

**`audio-engine/src/audio_capture.rs`**
```rust
// Phase 1: Microphone capture (cpal)
use crate::audio_proto::CaptureConfig;
pub async fn start(_config: CaptureConfig) -> Result<(), Box<dyn std::error::Error>> { Ok(()) }
pub async fn stop() {}
```

**`audio-engine/src/audio_playback.rs`**
```rust
// Phase 2: Speaker output (cpal)
pub async fn play(_pcm: &[u8]) -> Result<(), Box<dyn std::error::Error>> { Ok(()) }
```

**`audio-engine/src/loopback.rs`**
```rust
// Phase 2: Desktop audio loopback (WASAPI / PulseAudio / CoreAudio)
```

Run the initial compile check from the `audio-engine/` directory:

```bash
cd audio-engine
cargo check
```

> `cargo check` will invoke `build.rs`, which runs `tonic-build` and requires `protoc` to be on `$PATH`. Ensure Step 1 prerequisites are met before running this.

---

### Step 6 — Initialise the Go module

```bash
cd daemon
go mod init albedo-ai/daemon
```

This creates **`daemon/go.mod`**. Add the required dependencies:

```bash
# gRPC and protobuf runtime
go get google.golang.org/grpc@v1.65.0
go get google.golang.org/protobuf@v1.34.2

# Awareness / system info (used in Phase 5)
go get github.com/shirou/gopsutil/v3@v3.24.5

# Screen capture (used in Phase 5)
go get github.com/kbinani/screenshot@v0.0.0-20230812210009-b87d31814237

# UI automation (used in Phase 5)
go get github.com/go-vgo/robotgo@v0.110.5
```

After running the above, **`daemon/go.mod`** will resemble:

```
module albedo-ai/daemon

go 1.22

require (
    google.golang.org/grpc             v1.65.0
    google.golang.org/protobuf         v1.34.2
    github.com/shirou/gopsutil/v3      v3.24.5
    github.com/kbinani/screenshot      v0.0.0-20230812210009-b87d31814237
    github.com/go-vgo/robotgo          v0.110.5
)
```

> **Note:** `go mod tidy` will populate the full `require` block with indirect dependencies. Run it after `go get` commands complete.

Populate **`daemon/cmd/albedo-daemon/main.go`** with a minimal compilable skeleton:

```go
package main

import (
	"log"
	"net"
	"os"

	"google.golang.org/grpc"
	pb "albedo-ai/daemon/proto"
)

type server struct {
	pb.UnimplementedDaemonServer
}

func main() {
	socketPath := "/tmp/albedo-daemon.sock"
	os.Remove(socketPath)

	lis, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	grpcServer := grpc.NewServer()
	pb.RegisterDaemonServer(grpcServer, &server{})

	log.Printf("[albedo-daemon] scaffold placeholder — implement in Phase 5")
	log.Printf("[albedo-daemon] listening on %s", socketPath)
	if err := grpcServer.Serve(lis); err != nil {
		log.Fatalf("failed to serve: %v", err)
	}
}
```

Populate stub Go files so the package compiles cleanly. Each file below is the minimum needed to satisfy `go build ./...` without implementing logic:

**`daemon/awareness/collector.go`**
```go
package awareness

// Collector aggregates all awareness data. Implemented in Phase 5.
type Collector struct{}

func NewCollector() *Collector { return &Collector{} }
```

**`daemon/awareness/window.go`**, **`daemon/awareness/screen.go`**, **`daemon/awareness/clipboard.go`**, **`daemon/awareness/metrics.go`** — each gets:

```go
package awareness
// Implemented in Phase 5.
```

**`daemon/actions/registry.go`**
```go
package actions

// Registry holds registered tool handlers. Implemented in Phase 5.
type Registry struct{}

func NewRegistry() *Registry { return &Registry{} }
func RegisterDefaults(_ *Registry) {}
```

**`daemon/actions/filesystem.go`**, **`daemon/actions/shell.go`**, **`daemon/actions/automation.go`**, **`daemon/actions/browser.go`**, **`daemon/actions/appctl.go`**, **`daemon/actions/notifications.go`** — each gets:

```go
package actions
// Implemented in Phase 5.
```

**`daemon/security/sandbox.go`**
```go
package security

// Sandbox enforces command and path restrictions. Implemented in Phase 5.
type Sandbox struct{}

func NewSandbox() *Sandbox { return &Sandbox{} }
```

---

### Step 7 — Generate protobuf code

#### 7a. Go code generation

Run from the **repo root**:

```bash
protoc \
  --proto_path=proto \
  --go_out=daemon/proto \
  --go_opt=paths=source_relative \
  --go-grpc_out=daemon/proto \
  --go-grpc_opt=paths=source_relative \
  proto/audio.proto \
  proto/daemon.proto
```

This produces:
- `daemon/proto/audio.pb.go` — Go structs for `audio.proto` messages
- `daemon/proto/audio_grpc.pb.go` — Go client/server interfaces for `AudioEngine`
- `daemon/proto/daemon.pb.go` — Go structs for `daemon.proto` messages
- `daemon/proto/daemon_grpc.pb.go` — Go client/server interfaces for `Daemon`

#### 7b. TypeScript code generation (Bun gRPC clients)

Install the TypeScript protobuf generator (already in `devDependencies`, run if not yet installed):

```bash
bun install
```

Generate TypeScript stubs:

```bash
mkdir -p src/bun/rpc/generated
bun x protoc-gen-ts \
  --ts_out=src/bun/rpc/generated \
  --ts_opt=long_type_string,server_none \
  --proto_path=proto \
  proto/audio.proto \
  proto/daemon.proto
```

> **Alternative:** If `@protobuf-ts/plugin` is preferred over standalone `protoc-gen-ts`, use:
> ```bash
> bun x protoc \
>   --plugin=protoc-gen-ts=$(bun pm ls -g | grep @protobuf-ts/plugin)/bin/protoc-gen-ts \
>   --ts_out=src/bun/rpc/generated \
>   --proto_path=proto \
>   proto/audio.proto proto/daemon.proto
> ```
> The exact invocation depends on the version of `@protobuf-ts/plugin` installed.

#### 7c. Rust code generation (tonic-build)

Rust codegen is automatic — it runs as part of `cargo build` via `build.rs`. Trigger it explicitly:

```bash
cd audio-engine && cargo build 2>&1 | head -40
```

Generated files are written to Cargo's `OUT_DIR` scratch directory. The `tonic::include_proto!` macro in `main.rs` resolves them at compile time via `OUT_DIR` automatically.

> **Decision — idiomatic `OUT_DIR` approach:** `build.rs` does not override `.out_dir(...)`. Generated files go to Cargo's `$OUT_DIR` and `tonic::include_proto!("albedo.audio")` resolves them automatically. This is the standard tonic pattern and avoids committing machine-generated code into `src/`.
>
> For reference, the idiomatic `build.rs` (which matches what is written above) is:
>
> ```rust
> fn main() -> Result<(), Box<dyn std::error::Error>> {
>     tonic_build::configure()
>         .build_server(true)
>         .build_client(false)
>         .compile_protos(
>             &["../proto/audio.proto", "../proto/daemon.proto"],
>             &["../proto"],
>         )?;
>     Ok(())
> }
> ```
>
> `include_proto!("albedo.audio")` resolves correctly because Cargo sets `OUT_DIR` and tonic writes there by default.

---

### Step 8 — Write the Makefile

Create **`Makefile`** at the repo root:

```makefile
.PHONY: all dev build-rust build-go build-bun proto clean

RUST_BINARY   = audio-engine/target/release/albedo-audio
GO_BINARY     = daemon/cmd/albedo-daemon/albedo-daemon
BIN_DIR       = bin

PROTO_DIR     = proto
GO_PROTO_OUT  = daemon/proto
TS_PROTO_OUT  = src/bun/rpc/generated

# ─── Default: build everything ──────────────────────────────────────────────

all: proto build-rust build-go build-bun

# ─── Protobuf codegen ────────────────────────────────────────────────────────

proto: $(GO_PROTO_OUT) $(TS_PROTO_OUT)
	@echo "==> Generating Go protobuf code..."
	protoc \
		--proto_path=$(PROTO_DIR) \
		--go_out=$(GO_PROTO_OUT) \
		--go_opt=paths=source_relative \
		--go-grpc_out=$(GO_PROTO_OUT) \
		--go-grpc_opt=paths=source_relative \
		$(PROTO_DIR)/audio.proto \
		$(PROTO_DIR)/daemon.proto
	@echo "==> Generating TypeScript protobuf stubs..."
	mkdir -p $(TS_PROTO_OUT)
	bun x protoc-gen-ts \
		--ts_out=$(TS_PROTO_OUT) \
		--ts_opt=long_type_string,server_none \
		--proto_path=$(PROTO_DIR) \
		$(PROTO_DIR)/audio.proto \
		$(PROTO_DIR)/daemon.proto
	@echo "==> proto done."

$(GO_PROTO_OUT):
	mkdir -p $(GO_PROTO_OUT)

$(TS_PROTO_OUT):
	mkdir -p $(TS_PROTO_OUT)

# ─── Rust Audio Engine ───────────────────────────────────────────────────────

build-rust:
	@echo "==> Building Rust audio engine..."
	cd audio-engine && cargo build --release
	mkdir -p $(BIN_DIR)
	cp $(RUST_BINARY) $(BIN_DIR)/albedo-audio
	@echo "==> albedo-audio built."

# ─── Go Daemon ───────────────────────────────────────────────────────────────

build-go:
	@echo "==> Building Go daemon..."
	cd daemon && go build -o cmd/albedo-daemon/albedo-daemon ./cmd/albedo-daemon
	mkdir -p $(BIN_DIR)
	cp $(GO_BINARY) $(BIN_DIR)/albedo-daemon
	@echo "==> albedo-daemon built."

# ─── Electrobun / Bun ────────────────────────────────────────────────────────

build-bun:
	@echo "==> Building Electrobun app..."
	bun run build
	@echo "==> Electrobun build done."

# ─── Dev mode ────────────────────────────────────────────────────────────────

dev: build-rust build-go
	@echo "==> Starting native processes..."
	$(BIN_DIR)/albedo-audio &
	$(BIN_DIR)/albedo-daemon &
	@echo "==> Starting Electrobun dev server..."
	bun run dev

# ─── Clean ───────────────────────────────────────────────────────────────────

clean:
	@echo "==> Cleaning build artefacts..."
	rm -rf $(BIN_DIR)
	cd audio-engine && cargo clean
	rm -f $(GO_BINARY)
	rm -rf $(GO_PROTO_OUT)/*.pb.go
	rm -rf $(TS_PROTO_OUT)
	@echo "==> Clean done."
```

---

### Step 9 — Final validation pass

Run each check in order:

```bash
# From repo root

# 1. Proto generation
make proto

# 2. Rust compile check (fast — no linking)
cd audio-engine && cargo check && cd ..

# 3. Go build
cd daemon && go build ./... && cd ..

# 4. Bun type-check
bunx tsc --noEmit
```

All four commands should exit 0 to consider Phase 0 complete.

---

## File manifest

Every file created or modified in this phase. Files marked **(skeleton)** contain placeholder implementations only.

```
albedo-ai/
├── .gitignore                               [NEW]
├── package.json                             [NEW]
├── electrobun.config.ts                     [NEW]
├── tsconfig.json                            [NEW]
├── Makefile                                 [NEW]
│
├── proto/
│   ├── audio.proto                          [NEW — full definition]
│   └── daemon.proto                         [NEW — full definition]
│
├── src/
│   ├── bun/
│   │   ├── index.ts                         [NEW — skeleton]
│   │   ├── orchestrator.ts                  [NEW — skeleton]
│   │   ├── grok-client.ts                   [NEW — skeleton]
│   │   ├── context-manager.ts               [NEW — skeleton]
│   │   ├── memory.ts                        [NEW — skeleton]
│   │   ├── config.ts                        [NEW — skeleton]
│   │   └── rpc/
│   │       ├── audio-client.ts              [NEW — skeleton]
│   │       ├── daemon-client.ts             [NEW — skeleton]
│   │       └── generated/                   [GENERATED by make proto]
│   │           ├── audio.client.ts
│   │           ├── audio.ts
│   │           ├── daemon.client.ts
│   │           └── daemon.ts
│   │
│   └── views/
│       └── mainview/
│           ├── index.html                   [NEW — skeleton]
│           ├── App.tsx                      [NEW — skeleton]
│           ├── components/
│           │   ├── Avatar.tsx               [NEW — skeleton]
│           │   ├── Subtitles.tsx            [NEW — skeleton]
│           │   ├── ChatInput.tsx            [NEW — skeleton]
│           │   └── Settings.tsx             [NEW — skeleton]
│           └── hooks/
│               └── useRPC.ts                [NEW — skeleton]
│
├── audio-engine/
│   ├── Cargo.toml                           [NEW]
│   ├── build.rs                             [NEW]
│   └── src/
│       ├── main.rs                          [NEW — skeleton]
│       ├── vad.rs                           [NEW — skeleton]
│       ├── stt.rs                           [NEW — skeleton]
│       ├── tts.rs                           [NEW — skeleton]
│       ├── lipsync.rs                       [NEW — skeleton]
│       ├── audio_capture.rs                 [NEW — skeleton]
│       ├── audio_playback.rs                [NEW — skeleton]
│       └── loopback.rs                      [NEW — skeleton]
│
├── daemon/
│   ├── go.mod                               [NEW]
│   ├── go.sum                               [GENERATED by go get]
│   ├── proto/                               [GENERATED by make proto]
│   │   ├── audio.pb.go
│   │   ├── audio_grpc.pb.go
│   │   ├── daemon.pb.go
│   │   └── daemon_grpc.pb.go
│   ├── cmd/
│   │   └── albedo-daemon/
│   │       └── main.go                      [NEW — skeleton]
│   ├── awareness/
│   │   ├── collector.go                     [NEW — skeleton]
│   │   ├── window.go                        [NEW — skeleton]
│   │   ├── screen.go                        [NEW — skeleton]
│   │   ├── clipboard.go                     [NEW — skeleton]
│   │   └── metrics.go                       [NEW — skeleton]
│   ├── actions/
│   │   ├── registry.go                      [NEW — skeleton]
│   │   ├── filesystem.go                    [NEW — skeleton]
│   │   ├── shell.go                         [NEW — skeleton]
│   │   ├── automation.go                    [NEW — skeleton]
│   │   ├── browser.go                       [NEW — skeleton]
│   │   ├── appctl.go                        [NEW — skeleton]
│   │   └── notifications.go                 [NEW — skeleton]
│   └── security/
│       └── sandbox.go                       [NEW — skeleton]
│
├── assets/
│   ├── models/                              [NEW — empty, populated in Phase 4]
│   ├── voices/                              [NEW — empty, populated in Phase 2]
│   ├── whisper/                             [NEW — empty, populated in Phase 1]
│   └── vad/                                 [NEW — empty, populated in Phase 1]
│
└── bin/                                     [NEW — empty, populated by make build-*]
```

---

## Protobuf schema details

### `proto/audio.proto`

**Package:** `albedo.audio`  
**Service:** `AudioEngine` (hosted by the Rust binary, consumed by Bun)

| RPC method | Request type | Response type | Streaming |
|---|---|---|---|
| `StreamSTT` | `AudioChunk` (stream) | `TranscriptionResult` (stream) | Bidirectional client→server stream |
| `WatchTranscriptions` | `Empty` | `TranscriptionResult` (stream) | Server-streaming (push after internal VAD+Whisper) |
| `Synthesize` | `SynthesizeRequest` | `SynthesizeResponse` | Unary |
| `StartCapture` | `CaptureConfig` | `CaptureStatus` | Unary |
| `StopCapture` | `Empty` | `CaptureStatus` | Unary |
| `StartLoopback` | `Empty` | `CaptureStatus` | Unary |
| `StopLoopback` | `Empty` | `CaptureStatus` | Unary |

**Messages:**

| Message | Key fields |
|---|---|
| `AudioChunk` | `pcm_data` (bytes, f32le), `sample_rate` (uint32), `is_speech` (bool), `timestamp_ms` (uint64) |
| `TranscriptionResult` | `text`, `confidence` (float), `is_final` (bool), `timestamp_ms` (uint64) |
| `SynthesizeRequest` | `text`, `voice_id`, `speed` (float) |
| `SynthesizeResponse` | `pcm_data` (bytes), `visemes` (repeated Viseme) |
| `Viseme` | `shape` (string: A/E/I/O/U/rest/…), `start_ms`, `duration_ms`, `weight` (float) |
| `CaptureConfig` | `device_id`, `sample_rate` (default 16000), `vad_threshold` (default 0.5) |
| `CaptureStatus` | `active` (bool), `device_name` |
| `Empty` | — |

### `proto/daemon.proto`

**Package:** `albedo.daemon`  
**Service:** `Daemon` (hosted by the Go binary, consumed by Bun)

| RPC method | Request type | Response type | Streaming |
|---|---|---|---|
| `GetAwareness` | `Empty` | `AwarenessSnapshot` | Unary |
| `StreamAwareness` | `AwarenessConfig` | `AwarenessSnapshot` (stream) | Server-streaming |
| `CaptureScreen` | `ScreenCaptureRequest` | `ScreenCaptureResponse` | Unary |
| `ExecuteTool` | `ToolRequest` | `ToolResponse` | Unary |
| `ListTools` | `Empty` | `ToolList` | Unary |

**Messages:**

| Message | Key fields |
|---|---|
| `AwarenessSnapshot` | `active_window`, `metrics`, `clipboard_content`, `recent_notifications` (repeated string), `timestamp_ms` |
| `ActiveWindow` | `title`, `app_name`, `app_path`, `pid` |
| `SystemMetrics` | `cpu_percent`, `ram_percent`, `disk_percent`, `network_mbps_in/out`, `top_processes` (repeated ProcessInfo) |
| `ProcessInfo` | `name`, `pid`, `cpu_percent`, `ram_mb` |
| `AwarenessConfig` | `interval_ms`, `include_clipboard`, `include_screen_ocr` |
| `ScreenCaptureRequest` | `region` ("full"/"active_window"), `format` ("jpeg"/"png"), `quality` (1-100), `include_ocr` |
| `ScreenCaptureResponse` | `image_data` (bytes), `ocr_text`, `width`, `height` |
| `ToolRequest` | `tool_name`, `arguments_json`, `requires_confirmation` |
| `ToolResponse` | `success` (bool), `result`, `error` |
| `ToolList` | `tools` (repeated ToolSchema) |
| `ToolSchema` | `name`, `description`, `parameters_json_schema`, `dangerous` (bool) |
| `Empty` | — |

---

## Build system

### Makefile targets summary

| Target | What it does |
|---|---|
| `make all` | Runs `proto`, `build-rust`, `build-go`, `build-bun` in sequence |
| `make proto` | Runs `protoc` for Go and `protoc-gen-ts` for TypeScript; Rust is handled by `cargo build` via `build.rs` |
| `make build-rust` | `cargo build --release` in `audio-engine/`, copies binary to `bin/albedo-audio` |
| `make build-go` | `go build ./cmd/albedo-daemon` in `daemon/`, copies binary to `bin/albedo-daemon` |
| `make build-bun` | `bun run build` (Electrobun build) |
| `make dev` | Builds Rust + Go, starts both binaries in background, starts Electrobun dev server |
| `make clean` | Removes `bin/`, `audio-engine/target/`, Go binary, generated proto files |

### Protobuf codegen commands (expanded)

**Go:**
```bash
protoc \
  --proto_path=proto \
  --go_out=daemon/proto \
  --go_opt=paths=source_relative \
  --go-grpc_out=daemon/proto \
  --go-grpc_opt=paths=source_relative \
  proto/audio.proto \
  proto/daemon.proto
```

**TypeScript:**
```bash
bun x protoc-gen-ts \
  --ts_out=src/bun/rpc/generated \
  --ts_opt=long_type_string,server_none \
  --proto_path=proto \
  proto/audio.proto \
  proto/daemon.proto
```

**Rust** — via `audio-engine/build.rs`, executed automatically by `cargo build`:
```rust
tonic_build::configure()
    .build_server(true)
    .build_client(false)
    .compile_protos(
        &["../proto/audio.proto", "../proto/daemon.proto"],
        &["../proto"],
    )?;
```

The macro `tonic::include_proto!("albedo.audio")` in `main.rs` includes the generated code at compile time from Cargo's `OUT_DIR`.

---

## Dependencies installed

### Rust (`audio-engine/Cargo.toml`)

| Crate | Version | Purpose |
|---|---|---|
| `tonic` | 0.13 | gRPC server framework |
| `prost` | 0.13 | Protobuf runtime (used by tonic) |
| `tokio` | 1.x (features = ["full"]) | Async runtime |
| `tokio-stream` | 0.1 | Stream utilities for gRPC |
| `cpal` | 0.15 | Cross-platform audio I/O |
| `rubato` | 0.16 | Audio resampling (16kHz ↔ system rate) |
| `hound` | 3.5 | WAV file read/write |
| `tonic-build` *(build dep)* | 0.13 | Codegen from `.proto` at build time |

**Deferred to Phase 1/2 (commented out in Phase 0):**
- `whisper-rs = "0.14"` — requires whisper.cpp native build
- `ort = { version = "2.0", features = ["load-dynamic"] }` — requires ONNX Runtime shared library
- `silero-vad = "0.1"` — depends on ONNX Runtime

### Go (`daemon/go.mod`)

| Module | Version | Purpose |
|---|---|---|
| `google.golang.org/grpc` | v1.65.0 | gRPC server |
| `google.golang.org/protobuf` | v1.34.2 | Protobuf runtime |
| `github.com/shirou/gopsutil/v3` | v3.24.5 | CPU/RAM/disk/network metrics (Phase 5) |
| `github.com/kbinani/screenshot` | v0.0.0-20230812 | Cross-platform screen capture (Phase 5) |
| `github.com/go-vgo/robotgo` | v0.110.5 | Keyboard/mouse automation (Phase 5) |

**Build tools (installed to `$GOPATH/bin`):**

| Tool | Version | Purpose |
|---|---|---|
| `protoc-gen-go` | v1.34.2 | Generates Go message structs from `.proto` |
| `protoc-gen-go-grpc` | v1.4.0 | Generates Go gRPC service stubs from `.proto` |

### Bun / npm (`package.json`)

| Package | Version | Type | Purpose |
|---|---|---|---|
| `electrobun` | ^0.0.45 | dep | Desktop shell framework |
| `react` | ^18.3.1 | dep | UI framework |
| `react-dom` | ^18.3.1 | dep | React DOM renderer |
| `@types/react` | ^18.3.3 | devDep | TypeScript types for React |
| `@types/react-dom` | ^18.3.0 | devDep | TypeScript types for React DOM |
| `typescript` | ^5.4.5 | devDep | TypeScript compiler |
| `@protobuf-ts/plugin` | ^2.9.4 | devDep | TypeScript protobuf + gRPC codegen |
| `@grpc/grpc-js` | ^1.11.1 | devDep | gRPC client runtime for Node/Bun |
| `@grpc/proto-loader` | ^0.7.13 | devDep | Dynamic proto loading (dev/testing) |

---

## Validation criteria

Phase 0 is considered complete when **all** of the following pass:

### V1 — `make proto` succeeds

```bash
make proto
# Expected: exit code 0
# Expected artefacts:
#   daemon/proto/audio.pb.go
#   daemon/proto/audio_grpc.pb.go
#   daemon/proto/daemon.pb.go
#   daemon/proto/daemon_grpc.pb.go
#   src/bun/rpc/generated/audio.ts  (or audio.client.ts depending on plugin version)
#   src/bun/rpc/generated/daemon.ts
```

### V2 — `cargo check` passes for the Rust crate

```bash
cd audio-engine && cargo check
# Expected: no errors (warnings about unused placeholders are acceptable)
```

### V3 — `go build ./...` passes for the Go module

```bash
cd daemon && go build ./...
# Expected: exit code 0, binary produced at cmd/albedo-daemon/albedo-daemon
```

### V4 — TypeScript type-check passes

```bash
bunx tsc --noEmit
# Expected: exit code 0 (or only errors in generated files, which can be ignored with // @ts-nocheck)
```

### V5 — Directory structure matches manifest

```bash
# Spot-check key paths exist:
test -f proto/audio.proto
test -f proto/daemon.proto
test -f audio-engine/Cargo.toml
test -f audio-engine/build.rs
test -f daemon/go.mod
test -f Makefile
test -f package.json
test -f electrobun.config.ts
```

### V6 — `make clean` leaves no artefacts

```bash
make clean
ls bin/              # Should be empty or not exist
ls audio-engine/target/ 2>/dev/null || echo "target absent — ok"
```

---

## Risks and notes

### R1 — `protoc` version mismatch with `protoc-gen-go`

The generated Go code must match the `google.golang.org/protobuf` runtime version. If `protoc` is version 24.x but `protoc-gen-go` was compiled against proto runtime 1.34.x there can be version compatibility warnings. Always use `protoc` >= 27.x with `protoc-gen-go` v1.34+.

**Mitigation:** Pin protoc to ≥ 27.0 and install `protoc-gen-go` via `go install` at the exact version specified (not `@latest`).

### R2 — tonic/prost version alignment

`tonic 0.13` requires `prost 0.13`. Do not mix versions — tonic generates code that uses internal prost types. If you see trait-not-implemented errors from the Rust compiler, check that both crates are on the same minor version.

**Mitigation:** Cargo's dependency resolver will enforce this, but explicit version pins in `Cargo.toml` prevent surprises.

### R3 — Electrobun is pre-1.0

Electrobun is at `0.0.x` and its API is unstable. The exact method signatures for `BrowserWindow`, `Tray`, and `webview.rpc.emit` may differ from the architecture spec sketches. Review the Electrobun changelog when pinning a version.

**Mitigation:** Pin to a specific patch version (e.g., `"electrobun": "0.0.45"`) rather than `^0.0.45` to avoid surprise breaks during development.

### R4 — robotgo CGo requirements

`github.com/go-vgo/robotgo` uses CGo and requires system libraries: `libx11-dev`, `libxtst-dev`, `libpng-dev` on Linux. Running `go build ./...` will fail if these are missing, even in Phase 0 where robotgo is only imported but not called.

**Mitigation (Phase 0):** Do not import `robotgo` in any Go file during Phase 0. Only add the `go.mod` entry. The import will be added to `daemon/actions/automation.go` in Phase 5 after the system libraries are confirmed present.

To satisfy the go.sum without importing:
```bash
go get github.com/go-vgo/robotgo@v0.110.5
go mod tidy
# Do NOT add import statements yet
```

### R5 — Unix socket path conflicts

Both processes use fixed Unix socket paths (`/tmp/albedo-audio.sock`, `/tmp/albedo-daemon.sock`). If a previous crashed run left stale sockets behind, the next startup will fail with "address already in use".

**Mitigation:** Each process should call `os.Remove(socketPath)` before `net.Listen(...)` — this is already in the `main.go` skeleton for the Go daemon. Add the equivalent to the Rust gRPC server in Phase 1.

### R6 — Cargo edition 2024 vs 2021

The architecture spec lists `edition = "2024"` in `Cargo.toml`. Rust edition 2024 requires Rust toolchain ≥ 1.85. The Phase 0 plan uses `edition = "2021"` (stable and universally available). Upgrade to `edition = "2024"` only after confirming the CI toolchain supports it.

### R7 — TypeScript protobuf client approach

The architecture spec references both `@protobuf-ts/plugin` and `protoc-gen-ts` in different places. These are different tools with slightly different generated APIs. For consistency, **pick one and use it throughout**. This plan uses `@protobuf-ts/plugin` (the `--ts_out` flag) which generates idiomatic TypeScript with proper async/streaming support for gRPC-web.

If you need native gRPC (not gRPC-web) from Bun, consider using `@grpc/grpc-js` with `@grpc/proto-loader` instead of generated stubs — proto-loader loads `.proto` files dynamically at runtime, which eliminates the TypeScript codegen step entirely and may be simpler for the Bun client side.
