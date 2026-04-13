# Albedo AI — Architecture v2

## Design Philosophy

- **Electrobun** → Shell desktop (Bun + system webview + Zig bindings)
- **Rust** → Audio pipeline (STT, TTS, lip sync, audio capture)
- **Go** → Action/awareness daemon (tools, system monitoring, screen capture)
- **TypeScript** → UI layer (React) + orchestration (Bun main process)

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

---

## Process Architecture

```
albedo-ai (Electrobun)
├── Main Process (Bun)          → Orquestrador, Grok API client, context mgmt
├── Webview (React)             → Avatar Live2D, subtitles, settings UI
├── albedo-audio (Rust binary)  → VAD, Whisper STT, Kokoro TTS, lip sync, audio I/O
└── albedo-daemon (Go binary)   → System awareness, tool execution, screen capture
```

IPC entre processos via **gRPC** (protobufs) sobre Unix socket/named pipe — baixa latência, typed, cross-language.

---

## 1. Project Structure

```
albedo-ai/
├── package.json                     # Electrobun project root
├── electrobun.config.ts
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
│   │   ├── rpc/
│   │   │   ├── audio-client.ts      # gRPC client → Rust audio engine
│   │   │   └── daemon-client.ts     # gRPC client → Go daemon
│   │   └── config.ts                # User preferences, persona config
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
│       ├── lipsync.rs               # Audio → viseme extraction
│       ├── audio_capture.rs         # Mic input (cpal)
│       ├── audio_playback.rs        # Speaker output (cpal)
│       └── loopback.rs              # Desktop audio capture (system loopback)
│
├── daemon/                          # Go module
│   ├── go.mod
│   ├── cmd/
│   │   └── albedo-daemon/
│   │       └── main.go              # gRPC server entrypoint
│   ├── awareness/
│   │   ├── window.go                # Active window tracking
│   │   ├── screen.go                # Screenshot capture + optional OCR
│   │   ├── clipboard.go             # Clipboard monitoring
│   │   ├── metrics.go               # CPU/RAM/Disk/Network stats
│   │   └── collector.go             # Aggregates all awareness data
│   ├── actions/
│   │   ├── registry.go              # Tool registry
│   │   ├── filesystem.go            # File read/write/search
│   │   ├── shell.go                 # Controlled command execution
│   │   ├── automation.go            # Mouse/keyboard (robotgo)
│   │   ├── browser.go               # Browser control (rod/chromedp)
│   │   ├── appctl.go                # App launch/close/focus
│   │   └── notifications.go         # System notifications
│   └── security/
│       └── sandbox.go               # Command allowlist, path restrictions
│
└── assets/
    ├── models/                      # Live2D model files (.moc3, textures)
    ├── voices/                      # Kokoro voice model files
    └── whisper/                     # Whisper model (ggml-base.bin etc)
```

---

## 2. Protobuf Definitions

### proto/audio.proto

```protobuf
syntax = "proto3";
package albedo.audio;

service AudioEngine {
  // Streaming: mic audio chunks → transcription results
  rpc StreamSTT(stream AudioChunk) returns (stream TranscriptionResult);

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
  bytes pcm_data = 1;       // f32le PCM
  uint32 sample_rate = 2;
  bool is_speech = 3;       // VAD result
}

message TranscriptionResult {
  string text = 1;
  float confidence = 2;
  bool is_final = 3;        // Partial vs final
  uint64 timestamp_ms = 4;
}

message SynthesizeRequest {
  string text = 1;
  string voice_id = 2;
  float speed = 3;
}

message SynthesizeResponse {
  bytes pcm_data = 1;
  repeated Viseme visemes = 2;  // For lip sync
}

message Viseme {
  string shape = 1;          // "A", "E", "I", "O", "U", "rest", etc
  uint32 start_ms = 2;
  uint32 duration_ms = 3;
  float weight = 4;
}

message CaptureConfig {
  string device_id = 1;     // Optional, default = system mic
  uint32 sample_rate = 2;   // Default 16000
  float vad_threshold = 3;  // Default 0.5
}

message CaptureStatus {
  bool active = 1;
  string device_name = 2;
}

message Empty {}
```

### proto/daemon.proto

```protobuf
syntax = "proto3";
package albedo.daemon;

service Daemon {
  // Awareness
  rpc GetAwareness(Empty) returns (AwarenessSnapshot);
  rpc StreamAwareness(AwarenessConfig) returns (stream AwarenessSnapshot);
  rpc CaptureScreen(ScreenCaptureRequest) returns (ScreenCaptureResponse);

  // Tool execution
  rpc ExecuteTool(ToolRequest) returns (ToolResponse);
  rpc ListTools(Empty) returns (ToolList);
}

message AwarenessSnapshot {
  ActiveWindow active_window = 1;
  SystemMetrics metrics = 2;
  string clipboard_content = 3;
  repeated string recent_notifications = 4;
  uint64 timestamp_ms = 5;
}

message ActiveWindow {
  string title = 1;
  string app_name = 2;
  string app_path = 3;
  uint32 pid = 4;
}

message SystemMetrics {
  float cpu_percent = 1;
  float ram_percent = 2;
  float disk_percent = 3;
  float network_mbps_in = 4;
  float network_mbps_out = 5;
  repeated ProcessInfo top_processes = 6;
}

message ProcessInfo {
  string name = 1;
  uint32 pid = 2;
  float cpu_percent = 3;
  float ram_mb = 4;
}

message AwarenessConfig {
  uint32 interval_ms = 1;          // Polling interval
  bool include_clipboard = 2;
  bool include_screen_ocr = 3;
}

message ScreenCaptureRequest {
  string region = 1;               // "full" | "active_window"
  string format = 2;               // "jpeg" | "png"
  uint32 quality = 3;              // JPEG quality 1-100
  bool include_ocr = 4;
}

message ScreenCaptureResponse {
  bytes image_data = 1;
  string ocr_text = 2;
  uint32 width = 3;
  uint32 height = 4;
}

message ToolRequest {
  string tool_name = 1;
  string arguments_json = 2;       // JSON-encoded args
  bool requires_confirmation = 3;
}

message ToolResponse {
  bool success = 1;
  string result = 2;
  string error = 3;
}

message ToolList {
  repeated ToolSchema tools = 1;
}

message ToolSchema {
  string name = 1;
  string description = 2;
  string parameters_json_schema = 3;
  bool dangerous = 4;
}

message Empty {}
```

---

## 3. Rust Audio Engine

### audio-engine/Cargo.toml

```toml
[package]
name = "albedo-audio"
version = "0.1.0"
edition = "2024"

[dependencies]
# gRPC
tonic = "0.13"
prost = "0.13"
tokio = { version = "1", features = ["full"] }

# Audio I/O
cpal = "0.15"

# STT
whisper-rs = "0.14"

# TTS (Kokoro via ONNX)
ort = "2.0"               # onnxruntime bindings

# VAD
silero-vad-rs = "0.1"     # or manual ONNX inference

# DSP
rubato = "0.16"           # Resampling
hound = "3.5"             # WAV I/O

[build-dependencies]
tonic-build = "0.13"
```

### audio-engine/src/main.rs (skeleton)

```rust
use tonic::{transport::Server, Request, Response, Status};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub mod audio_proto {
    tonic::include_proto!("albedo.audio");
}

use audio_proto::audio_engine_server::{AudioEngine, AudioEngineServer};
use audio_proto::*;

mod vad;
mod stt;
mod tts;
mod lipsync;
mod audio_capture;
mod audio_playback;

pub struct AlbedoAudioEngine {
    whisper: stt::WhisperEngine,
    kokoro: tts::KokoroEngine,
    vad: vad::VadEngine,
}

#[tonic::async_trait]
impl AudioEngine for AlbedoAudioEngine {
    type StreamSTTStream = ReceiverStream<Result<TranscriptionResult, Status>>;

    async fn stream_stt(
        &self,
        request: Request<tonic::Streaming<AudioChunk>>,
    ) -> Result<Response<Self::StreamSTTStream>, Status> {
        let mut stream = request.into_inner();
        let (tx, rx) = mpsc::channel(32);
        let whisper = self.whisper.clone();

        tokio::spawn(async move {
            let mut audio_buffer: Vec<f32> = Vec::new();

            while let Ok(Some(chunk)) = stream.message().await {
                if !chunk.is_speech {
                    // VAD says silence — if we have buffered speech, transcribe it
                    if !audio_buffer.is_empty() {
                        let text = whisper.transcribe(&audio_buffer).await;
                        let _ = tx.send(Ok(TranscriptionResult {
                            text,
                            confidence: 0.95,
                            is_final: true,
                            timestamp_ms: chunk.timestamp_ms,
                        })).await;
                        audio_buffer.clear();
                    }
                    continue;
                }

                // Accumulate speech audio
                let samples: Vec<f32> = chunk.pcm_data
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                audio_buffer.extend_from_slice(&samples);
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn synthesize(
        &self,
        request: Request<SynthesizeRequest>,
    ) -> Result<Response<SynthesizeResponse>, Status> {
        let req = request.into_inner();
        let (audio, visemes) = self.kokoro.synthesize(&req.text, &req.voice_id, req.speed).await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(SynthesizeResponse {
            pcm_data: audio,
            visemes,
        }))
    }

    async fn start_capture(
        &self,
        request: Request<CaptureConfig>,
    ) -> Result<Response<CaptureStatus>, Status> {
        let config = request.into_inner();
        audio_capture::start(config).await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(CaptureStatus {
            active: true,
            device_name: "Default Mic".into(),
        }))
    }

    async fn stop_capture(&self, _: Request<Empty>) -> Result<Response<CaptureStatus>, Status> {
        audio_capture::stop().await;
        Ok(Response::new(CaptureStatus {
            active: false,
            device_name: String::new(),
        }))
    }

    async fn start_loopback(&self, _: Request<Empty>) -> Result<Response<CaptureStatus>, Status> {
        // Desktop audio loopback via WASAPI (Win) / PulseAudio (Linux)
        todo!()
    }

    async fn stop_loopback(&self, _: Request<Empty>) -> Result<Response<CaptureStatus>, Status> {
        todo!()
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = if cfg!(unix) {
        // Unix socket
        "unix:///tmp/albedo-audio.sock"
    } else {
        // Named pipe on Windows or TCP fallback
        "[::1]:50051"
    };

    let engine = AlbedoAudioEngine {
        whisper: stt::WhisperEngine::new("assets/whisper/ggml-base.bin")?,
        kokoro: tts::KokoroEngine::new("assets/voices/default.onnx")?,
        vad: vad::VadEngine::new()?,
    };

    println!("[albedo-audio] Listening on {}", addr);

    Server::builder()
        .add_service(AudioEngineServer::new(engine))
        .serve(addr.parse()?)
        .await?;

    Ok(())
}
```

---

## 4. Go Daemon

### daemon/cmd/albedo-daemon/main.go

```go
package main

import (
	"log"
	"net"
	"os"

	"google.golang.org/grpc"
	pb "albedo-ai/daemon/proto"
	"albedo-ai/daemon/awareness"
	"albedo-ai/daemon/actions"
	"albedo-ai/daemon/security"
)

type server struct {
	pb.UnimplementedDaemonServer
	awareness *awareness.Collector
	tools     *actions.Registry
	sandbox   *security.Sandbox
}

func (s *server) GetAwareness(ctx context.Context, _ *pb.Empty) (*pb.AwarenessSnapshot, error) {
	return s.awareness.Snapshot()
}

func (s *server) StreamAwareness(
	config *pb.AwarenessConfig,
	stream pb.Daemon_StreamAwarenessServer,
) error {
	ticker := time.NewTicker(time.Duration(config.IntervalMs) * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			snapshot, err := s.awareness.Snapshot()
			if err != nil {
				continue
			}
			if err := stream.Send(snapshot); err != nil {
				return err
			}
		case <-stream.Context().Done():
			return nil
		}
	}
}

func (s *server) CaptureScreen(
	ctx context.Context,
	req *pb.ScreenCaptureRequest,
) (*pb.ScreenCaptureResponse, error) {
	return s.awareness.CaptureScreen(req)
}

func (s *server) ExecuteTool(
	ctx context.Context,
	req *pb.ToolRequest,
) (*pb.ToolResponse, error) {
	// Security check
	if err := s.sandbox.Validate(req); err != nil {
		return &pb.ToolResponse{Success: false, Error: err.Error()}, nil
	}
	return s.tools.Execute(req)
}

func (s *server) ListTools(ctx context.Context, _ *pb.Empty) (*pb.ToolList, error) {
	return s.tools.List(), nil
}

func main() {
	socketPath := "/tmp/albedo-daemon.sock"
	os.Remove(socketPath)

	lis, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}

	// Init subsystems
	collector := awareness.NewCollector()
	registry := actions.NewRegistry()
	sandbox := security.NewSandbox()

	// Register default tools
	actions.RegisterDefaults(registry)

	grpcServer := grpc.NewServer()
	pb.RegisterDaemonServer(grpcServer, &server{
		awareness: collector,
		tools:     registry,
		sandbox:   sandbox,
	})

	log.Printf("[albedo-daemon] Listening on %s", socketPath)
	grpcServer.Serve(lis)
}
```

### daemon/awareness/window.go

```go
package awareness

import (
	"os/exec"
	"runtime"
	"strings"
)

type ActiveWindow struct {
	Title   string
	AppName string
	AppPath string
	PID     uint32
}

func GetActiveWindow() (*ActiveWindow, error) {
	switch runtime.GOOS {
	case "windows":
		return getActiveWindowWindows()
	case "linux":
		return getActiveWindowLinux()
	case "darwin":
		return getActiveWindowMacOS()
	default:
		return nil, fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

func getActiveWindowWindows() (*ActiveWindow, error) {
	// Uses win32 API via syscall or go-ole
	// GetForegroundWindow → GetWindowText → GetWindowThreadProcessId
	// Could also use: github.com/nicebyte/activewindow
	out, err := exec.Command("powershell", "-Command",
		`(Get-Process | Where-Object {$_.MainWindowHandle -eq `+
		`(Add-Type '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' `+
		`-Name W -Passthru)::GetForegroundWindow()}).MainWindowTitle`).Output()
	if err != nil {
		return nil, err
	}
	return &ActiveWindow{
		Title: strings.TrimSpace(string(out)),
	}, nil
}

func getActiveWindowLinux() (*ActiveWindow, error) {
	// xdotool getactivewindow getwindowname
	out, err := exec.Command("xdotool", "getactivewindow", "getwindowname").Output()
	if err != nil {
		return nil, err
	}
	return &ActiveWindow{
		Title: strings.TrimSpace(string(out)),
	}, nil
}
```

### daemon/awareness/screen.go

```go
package awareness

import (
	"image/jpeg"
	"bytes"

	"github.com/kbinani/screenshot"
)

func CaptureScreenJPEG(quality int) ([]byte, int, int, error) {
	bounds := screenshot.GetDisplayBounds(0)
	img, err := screenshot.CaptureRect(bounds)
	if err != nil {
		return nil, 0, 0, err
	}

	var buf bytes.Buffer
	err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality})
	if err != nil {
		return nil, 0, 0, err
	}

	return buf.Bytes(), img.Bounds().Dx(), img.Bounds().Dy(), nil
}
```

### daemon/actions/registry.go

```go
package actions

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	pb "albedo-ai/daemon/proto"
)

type ToolHandler func(args json.RawMessage) (string, error)

type ToolDef struct {
	Name        string
	Description string
	Schema      string // JSON Schema
	Dangerous   bool
	Handler     ToolHandler
}

type Registry struct {
	tools map[string]*ToolDef
}

func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]*ToolDef)}
}

func (r *Registry) Register(tool *ToolDef) {
	r.tools[tool.Name] = tool
}

func (r *Registry) Execute(req *pb.ToolRequest) (*pb.ToolResponse, error) {
	tool, ok := r.tools[req.ToolName]
	if !ok {
		return &pb.ToolResponse{
			Success: false,
			Error:   fmt.Sprintf("unknown tool: %s", req.ToolName),
		}, nil
	}

	result, err := tool.Handler(json.RawMessage(req.ArgumentsJson))
	if err != nil {
		return &pb.ToolResponse{Success: false, Error: err.Error()}, nil
	}

	return &pb.ToolResponse{Success: true, Result: result}, nil
}

func (r *Registry) List() *pb.ToolList {
	list := &pb.ToolList{}
	for _, t := range r.tools {
		list.Tools = append(list.Tools, &pb.ToolSchema{
			Name:                 t.Name,
			Description:          t.Description,
			ParametersJsonSchema: t.Schema,
			Dangerous:            t.Dangerous,
		})
	}
	return list
}

// ─── Default tools ───

func RegisterDefaults(r *Registry) {
	r.Register(&ToolDef{
		Name:        "read_file",
		Description: "Read file contents",
		Schema:      `{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}`,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct{ Path string `json:"path"` }
			json.Unmarshal(args, &p)
			data, err := os.ReadFile(p.Path)
			return string(data), err
		},
	})

	r.Register(&ToolDef{
		Name:        "run_command",
		Description: "Execute shell command (sandboxed)",
		Schema:      `{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}`,
		Dangerous:   true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct{ Command string `json:"command"` }
			json.Unmarshal(args, &p)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			out, err := exec.CommandContext(ctx, "sh", "-c", p.Command).CombinedOutput()
			return string(out), err
		},
	})

	r.Register(&ToolDef{
		Name:        "open_app",
		Description: "Open application by name",
		Schema:      `{"type":"object","properties":{"app":{"type":"string"}},"required":["app"]}`,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct{ App string `json:"app"` }
			json.Unmarshal(args, &p)
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "windows":
				cmd = exec.Command("cmd", "/c", "start", p.App)
			case "linux":
				cmd = exec.Command("xdg-open", p.App)
			case "darwin":
				cmd = exec.Command("open", "-a", p.App)
			}
			return fmt.Sprintf("Opening %s", p.App), cmd.Start()
		},
	})

	r.Register(&ToolDef{
		Name:        "type_text",
		Description: "Type text at current cursor position",
		Schema:      `{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}`,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct{ Text string `json:"text"` }
			json.Unmarshal(args, &p)
			// Use robotgo for cross-platform keyboard input
			robotgo.TypeStr(p.Text)
			return fmt.Sprintf("Typed %d chars", len(p.Text)), nil
		},
	})

	r.Register(&ToolDef{
		Name:        "screenshot",
		Description: "Capture current screen as JPEG",
		Schema:      `{"type":"object","properties":{"quality":{"type":"integer","default":60}}}`,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct{ Quality int `json:"quality"` }
			p.Quality = 60
			json.Unmarshal(args, &p)
			data, w, h, err := CaptureScreenJPEG(p.Quality)
			if err != nil {
				return "", err
			}
			b64 := base64.StdEncoding.EncodeToString(data)
			return fmt.Sprintf("[SCREENSHOT:%dx%d:%s]", w, h, b64), nil
		},
	})
}
```

---

## 5. Electrobun Main Process (Bun)

### src/bun/index.ts

```typescript
import { BrowserWindow, ApplicationMenu, Tray } from "electrobun/bun";
import { Orchestrator } from "./orchestrator";
import { GrokClient } from "./grok-client";
import { AudioClient } from "./rpc/audio-client";
import { DaemonClient } from "./rpc/daemon-client";
import { spawn, ChildProcess } from "child_process";
import { resolve } from "path";

// ─── Spawn native processes ───

let audioProcess: ChildProcess;
let daemonProcess: ChildProcess;

function spawnNativeProcesses() {
  const binDir = resolve(import.meta.dir, "../../bin");

  audioProcess = spawn(resolve(binDir, "albedo-audio"), [], {
    stdio: "pipe",
  });
  audioProcess.stderr?.on("data", (d) => console.log(`[audio] ${d}`));

  daemonProcess = spawn(resolve(binDir, "albedo-daemon"), [], {
    stdio: "pipe",
  });
  daemonProcess.stderr?.on("data", (d) => console.log(`[daemon] ${d}`));
}

// ─── Create window ───

const win = new BrowserWindow({
  title: "Albedo AI",
  url: "views://mainview/index.html",
  width: 420,
  height: 650,
  transparent: true,
  frame: false,
  alwaysOnTop: true,
});

// ─── System tray ───

const tray = new Tray({
  icon: "assets/icon.png",
  menu: [
    { label: "Show/Hide", action: () => win.isVisible() ? win.hide() : win.show() },
    { label: "Mute", type: "checkbox", action: (checked) => orchestrator.setMuted(checked) },
    { type: "separator" },
    { label: "Settings", action: () => win.webview.rpc.emit("open-settings") },
    { label: "Quit", action: () => process.exit(0) },
  ],
});

// ─── Init orchestrator ───

spawnNativeProcesses();

// Wait for sockets to be ready
await Bun.sleep(1000);

const grok = new GrokClient({
  apiKey: process.env.XAI_API_KEY!,
  model: "grok-4.1-fast-reasoning",
  baseUrl: "https://api.x.ai/v1",
  maxTokens: 4096,
  temperature: 0.7,
});

const audioClient = new AudioClient("unix:///tmp/albedo-audio.sock");
const daemonClient = new DaemonClient("unix:///tmp/albedo-daemon.sock");

const orchestrator = new Orchestrator({ grok, audioClient, daemonClient, win });
await orchestrator.start();

// Cleanup on exit
process.on("beforeExit", () => {
  audioProcess.kill();
  daemonProcess.kill();
});
```

### src/bun/orchestrator.ts

```typescript
import { GrokClient } from "./grok-client";
import { AudioClient } from "./rpc/audio-client";
import { DaemonClient } from "./rpc/daemon-client";
import { ContextManager } from "./context-manager";
import type { BrowserWindow } from "electrobun/bun";

export class Orchestrator {
  private grok: GrokClient;
  private audio: AudioClient;
  private daemon: DaemonClient;
  private context: ContextManager;
  private win: BrowserWindow;
  private muted = false;

  constructor(deps: {
    grok: GrokClient;
    audioClient: AudioClient;
    daemonClient: DaemonClient;
    win: BrowserWindow;
  }) {
    this.grok = deps.grok;
    this.audio = deps.audioClient;
    this.daemon = deps.daemonClient;
    this.win = deps.win;
    this.context = new ContextManager(this.daemon);
  }

  async start() {
    // 1. Start mic capture on Rust engine
    await this.audio.startCapture({
      sampleRate: 16000,
      vadThreshold: 0.5,
    });

    // 2. Start awareness stream from Go daemon
    this.daemon.streamAwareness({ intervalMs: 5000 }, (snapshot) => {
      this.context.updateAwareness(snapshot);

      // Proactive alerts (e.g., high CPU)
      if (snapshot.metrics.cpuPercent > 90) {
        this.proactiveSpeak(
          `Seu CPU tá em ${snapshot.metrics.cpuPercent}%. Quer que eu veja o que tá consumindo?`
        );
      }
    });

    // 3. Listen for transcriptions from Rust engine
    this.audio.onTranscription(async (result) => {
      if (this.muted || !result.isFinal) return;
      await this.processUtterance(result.text);
    });

    console.log("[orchestrator] Albedo AI started");
  }

  async processUtterance(transcript: string) {
    // Update UI
    this.win.webview.rpc.emit("user-speech", transcript);

    // Build context
    const messages = await this.context.buildMessages(transcript);

    // Get tool schemas from Go daemon
    const tools = await this.daemon.listTools();

    // Stream LLM response
    let fullResponse = "";
    const sentenceBuffer: string[] = [];

    for await (const chunk of this.grok.chatStream(messages, tools)) {
      if (chunk.type === "content") {
        fullResponse += chunk.text;
        // Detect complete sentences for TTS streaming
        const sentences = this.extractSentences(fullResponse);
        for (const s of sentences) {
          if (!sentenceBuffer.includes(s)) {
            sentenceBuffer.push(s);
            await this.speakSentence(s);
          }
        }
      }

      if (chunk.type === "tool_call") {
        // Execute via Go daemon
        const result = await this.daemon.executeTool(
          chunk.name,
          chunk.arguments
        );

        // Handle screenshot tool → vision
        if (result.startsWith("[SCREENSHOT:")) {
          const b64 = this.extractScreenshotB64(result);
          this.context.setVisionData(b64);
        }
      }
    }

    // Save to conversation history
    this.context.addExchange(transcript, fullResponse);

    // Update avatar expression based on content
    const expression = this.inferExpression(fullResponse);
    this.win.webview.rpc.emit("set-expression", expression);
  }

  async speakSentence(sentence: string) {
    this.win.webview.rpc.emit("subtitle", sentence);

    const { pcmData, visemes } = await this.audio.synthesize({
      text: sentence,
      voiceId: "default",
      speed: 1.0,
    });

    // Send visemes to webview for lip sync
    this.win.webview.rpc.emit("visemes", visemes);

    // Play audio through Rust engine
    await this.audio.play(pcmData);
  }

  async proactiveSpeak(text: string) {
    if (this.muted) return;
    await this.speakSentence(text);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  private extractSentences(text: string): string[] {
    return text.match(/[^.!?]+[.!?]+/g) || [];
  }

  private inferExpression(text: string): string {
    // Simple keyword-based for MVP, could use sentiment analysis later
    if (text.match(/haha|kk|😄|engraçado/i)) return "happy";
    if (text.match(/desculp|sorry|erro/i)) return "sad";
    if (text.match(/cuidado|atenção|perigo/i)) return "alert";
    return "neutral";
  }
}
```

---

## 6. Build Pipeline

### Makefile

```makefile
.PHONY: all dev build-rust build-go build-bun clean

RUST_TARGET = audio-engine/target/release/albedo-audio
GO_TARGET   = daemon/cmd/albedo-daemon/albedo-daemon
BIN_DIR     = bin

all: build-rust build-go build-bun

# ─── Rust Audio Engine ───
build-rust:
	cd audio-engine && cargo build --release
	mkdir -p $(BIN_DIR)
	cp $(RUST_TARGET) $(BIN_DIR)/

# ─── Go Daemon ───
build-go:
	cd daemon && go build -o $(GO_TARGET) ./cmd/albedo-daemon
	cp $(GO_TARGET) $(BIN_DIR)/

# ─── Protobuf codegen ───
proto:
	# Rust
	# (handled by tonic-build in build.rs)

	# Go
	protoc --go_out=daemon/proto --go-grpc_out=daemon/proto proto/*.proto

	# TypeScript (for Bun client stubs)
	npx protoc-gen-ts --ts_out=src/bun/rpc/generated proto/*.proto

# ─── Electrobun ───
build-bun:
	bun build

# ─── Dev mode ───
dev: build-rust build-go
	# Start all processes
	$(BIN_DIR)/albedo-audio &
	$(BIN_DIR)/albedo-daemon &
	cd . && bun dev

# ─── Clean ───
clean:
	rm -rf $(BIN_DIR)
	cd audio-engine && cargo clean
	cd daemon && rm -f cmd/albedo-daemon/albedo-daemon
```

---

## 7. Language Responsibility Matrix

| Componente | Linguagem | Justificativa |
|---|---|---|
| Desktop shell + UI | TypeScript (Bun) | Electrobun native, React webview |
| LLM orchestration | TypeScript (Bun) | Async streaming, context management |
| Audio I/O + VAD | **Rust** | Low latency, `cpal` ecosystem |
| STT (Whisper) | **Rust** | `whisper-rs` (C++ bindings), zero-copy |
| TTS (Kokoro) | **Rust** | ONNX runtime, audio pipeline locality |
| Lip sync | **Rust** | Real-time DSP, viseme extraction |
| Window tracking | **Go** | Cross-platform, `robotgo` ecosystem |
| Screen capture | **Go** | `kbinani/screenshot`, fast JPEG encode |
| Tool execution | **Go** | Process management, sandboxing |
| System metrics | **Go** | `gopsutil`, native OS APIs |
| Keyboard/mouse | **Go** | `robotgo` |
| Memory/embeddings | TypeScript + **Zig** | SQLite (Bun native), embedding model via Zig FFI |
| IPC | **Protobuf/gRPC** | Type-safe, cross-language, low overhead |

---

## 8. Latency Budget

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

Feels responsive — under 1s to start responding vocally.

---

## 9. Security (daemon/security/sandbox.go)

```go
package security

import (
	"fmt"
	"strings"
	pb "albedo-ai/daemon/proto"
)

type Sandbox struct {
	// Paths the AI can read
	AllowedReadPaths []string
	// Paths the AI can write
	AllowedWritePaths []string
	// Commands that are always blocked
	BlockedCommands []string
	// Commands that need confirmation
	DangerousCommands []string
}

func NewSandbox() *Sandbox {
	home, _ := os.UserHomeDir()
	return &Sandbox{
		AllowedReadPaths: []string{
			home,
			"/tmp",
		},
		AllowedWritePaths: []string{
			filepath.Join(home, "Desktop"),
			filepath.Join(home, "Documents"),
			filepath.Join(home, "Downloads"),
			"/tmp",
		},
		BlockedCommands: []string{
			"rm -rf /", "mkfs", "dd if=", ":(){ :|:& };:",
			"shutdown", "reboot", "halt", "poweroff",
			"chmod 777", "curl | sh", "wget | sh",
		},
		DangerousCommands: []string{
			"rm", "mv", "kill", "pkill",
			"git push", "git reset --hard",
			"npm publish", "cargo publish",
		},
	}
}

func (s *Sandbox) Validate(req *pb.ToolRequest) error {
	if req.ToolName == "run_command" {
		var args struct{ Command string `json:"command"` }
		json.Unmarshal([]byte(req.ArgumentsJson), &args)
		cmd := strings.ToLower(args.Command)

		for _, blocked := range s.BlockedCommands {
			if strings.Contains(cmd, blocked) {
				return fmt.Errorf("blocked command: %s", blocked)
			}
		}

		for _, dangerous := range s.DangerousCommands {
			if strings.Contains(cmd, dangerous) {
				req.RequiresConfirmation = true
				break
			}
		}
	}

	return nil
}
```

---

## 10. Costs (Final)

| Item | Custo/mês |
|---|---|
| Grok 4.1 Fast API | **~$14** |
| Rust + Go binaries | Grátis |
| Whisper.cpp model | Grátis |
| Kokoro TTS model | Grátis |
| Electrobun | Grátis |
| Live2D (sample model) | Grátis |
| **Total** | **~$14/mês** |

---

## 11. Dev Roadmap

| Fase | Scope | Est. |
|---|---|---|
| **0. Scaffold** | Electrobun init + proto + Makefile | 1 dia |
| **1. Audio MVP** | Rust: mic → VAD → Whisper → gRPC | 1 semana |
| **2. TTS** | Rust: Kokoro + playback + visemes | 3-4 dias |
| **3. Orchestrator** | Bun: Grok streaming + context | 3-4 dias |
| **4. Avatar** | React: Live2D + lip sync + subtitles | 1 semana |
| **5. Daemon** | Go: awareness + basic tools | 1 semana |
| **6. Integration** | Wire everything, end-to-end flow | 3-4 dias |
| **7. Polish** | Personality, expressions, proactive | Ongoing |

MVP conversacional (voz ↔ voz) em ~3 semanas.
Full featured em ~6-8 semanas part-time.
