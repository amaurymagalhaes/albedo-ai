# Phase 1: Audio MVP — Implementation Plan

**Project:** Albedo AI  
**Phase:** 1 of 7  
**Estimated Duration:** 1 week  
**Owner:** Rust audio engine (`audio-engine/`)  
**Status:** Not started

---

## Table of Contents

1. [Objective](#1-objective)
2. [Prerequisites](#2-prerequisites)
3. [Step-by-Step Tasks](#3-step-by-step-tasks)
4. [Module Breakdown](#4-module-breakdown)
5. [Audio Pipeline Flow](#5-audio-pipeline-flow)
6. [gRPC Server Implementation](#6-grpc-server-implementation)
7. [Model Loading](#7-model-loading)
8. [Testing Strategy](#8-testing-strategy)
9. [Validation Criteria](#9-validation-criteria)
10. [Performance Targets](#10-performance-targets)
11. [Risks and Notes](#11-risks-and-notes)

---

## 1. Objective

Deliver a standalone Rust binary (`albedo-audio`) that:

- Captures microphone input continuously via `cpal`
- Runs real-time Voice Activity Detection via the Silero VAD ONNX model to detect speech segments and discard silence
- Transcribes detected speech segments using Whisper (whisper.cpp via `whisper-rs`)
- Exposes a gRPC server on a Unix socket (`/tmp/albedo-audio.sock`) with three operations: `StreamSTT`, `StartCapture`, and `StopCapture`

At the end of this phase the Bun orchestrator (Phase 3) can connect to the gRPC server and receive real-time transcription results from the user's microphone. No TTS, no playback, no lip sync — those are Phase 2. This is the minimal viable audio input pipeline.

---

## 2. Prerequisites

### 2.1 Phase 0 Complete

Phase 0 (Scaffold) must be done before starting Phase 1:

- `audio-engine/Cargo.toml` exists with the dependency block from the architecture spec
- `proto/audio.proto` is committed and matches the spec in `albedo-ai.md` section 2
- `audio-engine/build.rs` exists and invokes `tonic-build` to compile `audio.proto`
- The top-level `Makefile` has a working `build-rust` target
- `assets/` directory structure exists: `assets/whisper/` and `assets/voices/` and `assets/models/`

### 2.2 System Dependencies

The following must be installed on the build machine before `cargo build` will succeed:

| Dependency | Purpose | Install |
|---|---|---|
| `libclang` / `clang` | Required by `whisper-rs` bindgen | `apt install libclang-dev` / `brew install llvm` |
| ALSA dev headers (Linux) | Required by `cpal` on Linux | `apt install libasound2-dev` |
| `pkg-config` | Library discovery | `apt install pkg-config` |
| `cmake` | whisper.cpp build system | `apt install cmake` |
| `protoc` | Protobuf compiler | `apt install protobuf-compiler` |

On macOS, CoreAudio is used by `cpal` and requires no extra headers. On Windows, WASAPI is used.

### 2.3 Model Files

Two model files must be downloaded and placed at the correct paths before running the binary:

**Whisper ggml-base.en model**

```
assets/whisper/ggml-base.bin
```

Download from the official Hugging Face mirror:

```bash
wget -P assets/whisper/ \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

Size: ~142 MB. For multilingual support use `ggml-base.bin`; for English-only STT `ggml-base.en.bin` is slightly faster.

**Silero VAD ONNX model**

```
assets/vad/silero_vad.onnx
```

```bash
mkdir -p assets/vad
wget -P assets/vad/ \
  https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
```

Size: ~2 MB. This is the v5 ONNX model. Do not use the JIT (.pt) version — the ONNX model is used via `ort`.

### 2.4 Cargo.toml Must Include

Confirm these dependencies are in `audio-engine/Cargo.toml` before proceeding:

```toml
[dependencies]
tonic       = "0.13"
prost       = "0.13"
tokio       = { version = "1", features = ["full"] }
cpal        = "0.15"
whisper-rs  = "0.14"
ort         = { version = "2.0", features = ["load-dynamic"] }
ndarray     = "0.16"
rubato      = "0.16"
hound       = "3.5"
tracing     = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
anyhow      = "1"
tokio-stream = "0.1"

[build-dependencies]
tonic-build = "0.13"
```

The `ort` crate uses the `load-dynamic` feature, which loads the ONNX Runtime shared library at runtime from the system path rather than downloading or statically linking it at compile time. This matches Phase 2 (TTS) and is better for distribution. **`libonnxruntime.so` (Linux), `libonnxruntime.dylib` (macOS), or `onnxruntime.dll` (Windows) must be installed on the system or pointed to via the `ORT_DYLIB_PATH` environment variable.**

---

## 3. Step-by-Step Tasks

### Task 1 — Set up `build.rs` for protobuf codegen

**File:** `audio-engine/build.rs`

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(&["../proto/audio.proto"], &["../proto/"])?;
    Ok(())
}
```

Run `cargo build` — this will fail on missing crates but will confirm the proto compilation works. Generated code lands in `target/debug/build/albedo-audio-*/out/albedo.audio.rs` and is included via the `tonic::include_proto!` macro.

Verify: `cargo build 2>&1 | grep -v "^error"` should show proto compilation lines.

---

### Task 2 — Implement `audio_capture.rs`

**File:** `audio-engine/src/audio_capture.rs`

This module owns the `cpal` input stream. Because `cpal` streams are `!Send`, the capture loop must run on its own dedicated OS thread and communicate with the async Tokio runtime through a channel.

Steps:

1. Define `CaptureHandle` struct holding a `tokio::sync::oneshot::Sender<()>` for shutdown and the device name string.
2. Implement `start_capture(config: CaptureConfig, tx: mpsc::Sender<Vec<f32>>) -> anyhow::Result<CaptureHandle>`:
   - Enumerate `cpal` input devices; select by `config.device_id` or fall back to the default input device.
   - Build an `InputStreamConfig` targeting `config.sample_rate` (default 16000 Hz), mono, f32 sample format.
   - If the device's native sample rate differs from 16000, instantiate a `rubato::FftFixedInOut` resampler and apply it inside the data callback.
   - Spawn a `std::thread` to own the `cpal::Stream` (required because streams are not `Send`). The thread calls `stream.play()` and blocks on the shutdown signal.
   - Inside the `cpal` data callback, collect samples and send batches (e.g., 512 samples per message) through the `mpsc::Sender<Vec<f32>>`.
3. Implement `stop_capture(handle: CaptureHandle)`: sends the shutdown signal; the stream thread drops the `cpal::Stream`, which stops capture.
4. Use a `static OnceLock<CaptureHandle>` or an `Arc<Mutex<Option<CaptureHandle>>>` stored in `AlbedoAudioEngine` to manage the single active capture session.

---

### Task 3 — Implement `vad.rs`

**File:** `audio-engine/src/vad.rs`

The Silero VAD model expects 16 kHz mono audio in 30 ms, 60 ms, or 100 ms windows. The `ort` crate is used to run the ONNX session.

Steps:

1. Define `VadEngine` struct:
   ```rust
   pub struct VadEngine {
       session: ort::Session,
       h: Array3<f32>,  // hidden state (1, 1, 64)
       c: Array3<f32>,  // cell state (1, 1, 64)
       sample_rate: i64,
       threshold: f32,
   }
   ```
2. Implement `VadEngine::new(model_path: &str, threshold: f32) -> anyhow::Result<Self>`:
   - Build the ONNX session: `ort::Session::builder()?.commit_from_file(model_path)?`
   - Initialize `h` and `c` as zero arrays of shape `[1, 1, 64]` (Silero v5 state shape).
   - Set `sample_rate = 16000i64`.
3. Implement `VadEngine::is_speech(&mut self, samples: &[f32]) -> anyhow::Result<bool>`:
   - Pad or slice `samples` to exactly 512 samples (32 ms at 16 kHz) — the model's minimum chunk size.
   - Construct the four input tensors required by Silero v5:
     - `input`: shape `[1, num_samples]` (f32)
     - `sr`: scalar i64 = 16000
     - `h`: shape `[1, 1, 64]` (f32)
     - `c`: shape `[1, 1, 64]` (f32)
   - Run inference: `session.run(inputs)?`
   - Extract `output` (speech probability scalar), `hn` (new hidden state), `cn` (new cell state).
   - Update `self.h = hn`, `self.c = cn` to maintain LSTM state across calls.
   - Return `output > self.threshold`.
4. Implement `VadEngine::reset(&mut self)`: zeroes `h` and `c` — call this when capture stops.

**Chunk sizing note:** Process 512-sample chunks (32 ms) for minimum latency. Larger chunks (1024 = 64 ms) reduce ONNX call overhead at the cost of latency. For MVP, 512 is correct.

---

### Task 4 — Implement `stt.rs`

**File:** `audio-engine/src/stt.rs`

Uses `whisper-rs` which wraps whisper.cpp via Rust FFI.

Steps:

1. Define `WhisperEngine`:
   ```rust
   pub struct WhisperEngine {
       ctx: Arc<WhisperContext>,
   }
   ```
   The `Arc` allows cloning for use inside spawned tasks.

2. Implement `WhisperEngine::new(model_path: &str) -> anyhow::Result<Self>`:
   ```rust
   let params = WhisperContextParameters::default();
   let ctx = WhisperContext::new_with_params(model_path, params)?;
   Ok(Self { ctx: Arc::new(ctx) })
   ```

3. Implement `WhisperEngine::transcribe(&self, samples: &[f32]) -> anyhow::Result<String>`:
   - Create a `WhisperState` from the context: `self.ctx.create_state()?`
   - Build `FullParams`:
     ```rust
     let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
     params.set_language(Some("auto"));
     params.set_print_progress(false);
     params.set_print_realtime(false);
     params.set_print_special(false);
     params.set_single_segment(false);
     params.set_no_context(true);    // stateless per utterance
     params.set_n_threads(4);        // tune per hardware
     ```
   - Run: `state.full(params, samples)?`
   - Collect segments:
     ```rust
     let num_segments = state.full_n_segments()?;
     let text = (0..num_segments)
         .map(|i| state.full_get_segment_text(i).unwrap_or_default())
         .collect::<Vec<_>>()
         .join(" ")
         .trim()
         .to_string();
     ```
   - Return the assembled text.

4. Because `whisper-rs` is CPU-bound and blocks the thread, wrap the call in `tokio::task::spawn_blocking`:
   ```rust
   pub async fn transcribe_async(&self, samples: Vec<f32>) -> anyhow::Result<String> {
       let engine = self.clone();
       tokio::task::spawn_blocking(move || engine.transcribe(&samples)).await?
   }
   ```

5. Note: `WhisperContext` is not `Send + Sync` by default in some versions. If the compiler rejects the `Arc<WhisperContext>`, wrap in `Arc<Mutex<WhisperContext>>` and lock in `transcribe`. For `whisper-rs 0.14`, `WhisperContext` is thread-safe (`Send + Sync`).

---

### Task 5 — Implement `main.rs` and the gRPC server

**File:** `audio-engine/src/main.rs`

This is the binary entrypoint. It initialises the models, builds the `AlbedoAudioEngine` struct, and starts the Tonic gRPC server.

Steps:

1. Add the protobuf module import and service trait import:
   ```rust
   pub mod audio_proto {
       tonic::include_proto!("albedo.audio");
   }
   use audio_proto::audio_engine_server::{AudioEngine, AudioEngineServer};
   use audio_proto::*;
   ```

2. Define `AlbedoAudioEngine`:
   ```rust
   pub struct AlbedoAudioEngine {
       whisper: stt::WhisperEngine,
       vad: Arc<Mutex<vad::VadEngine>>,
       capture_tx: Arc<Mutex<Option<mpsc::Sender<Vec<f32>>>>>,
       capture_handle: Arc<Mutex<Option<audio_capture::CaptureHandle>>>,
   }
   ```

3. Implement `#[tonic::async_trait] impl AudioEngine for AlbedoAudioEngine` — see Section 6 for full detail on `StreamSTT`, `StartCapture`, and `StopCapture`.

4. In `#[tokio::main] async fn main()`:
   - Init tracing: `tracing_subscriber::fmt::init()`
   - Resolve model paths relative to the binary or from environment variables:
     ```rust
     let whisper_path = std::env::var("WHISPER_MODEL")
         .unwrap_or_else(|_| "assets/whisper/ggml-base.bin".to_string());
     let vad_path = std::env::var("VAD_MODEL")
         .unwrap_or_else(|_| "assets/vad/silero_vad.onnx".to_string());
     ```
   - Load models (fail fast with clear error messages if files are missing).
   - Determine socket path:
     ```rust
     #[cfg(unix)]
     let addr = "unix:///tmp/albedo-audio.sock";
     #[cfg(not(unix))]
     let addr = "[::1]:50051";
     ```
   - On Unix, delete the socket file before binding: `let _ = std::fs::remove_file("/tmp/albedo-audio.sock");`
   - Build and serve:
     ```rust
     Server::builder()
         .add_service(AudioEngineServer::new(engine))
         .serve(addr.parse()?)
         .await?;
     ```

---

### Task 6 — Write `proto/audio.proto` (confirm from spec)

Verify that `proto/audio.proto` matches the spec exactly. For Phase 1 the only fields that matter are `AudioChunk`, `TranscriptionResult`, `CaptureConfig`, `CaptureStatus`, and `Empty`. The `Synthesize`, `StartLoopback`, and `StopLoopback` RPCs must be present in the proto (they are part of the service contract) but their Rust implementations will return `Status::unimplemented` in Phase 1.

---

### Task 7 — Wire capture pipeline to StreamSTT

This is the integration task that connects all four modules. See Section 6 for the full design. The critical wiring is:

1. `StartCapture` RPC: creates an `mpsc::channel` for raw audio, starts `audio_capture`, stores the sender end.
2. `StreamSTT` RPC: spawns a task that reads from the raw audio channel, runs VAD on each chunk, accumulates speech samples, and calls `WhisperEngine::transcribe_async` when VAD returns to silence.
3. `StopCapture` RPC: calls `audio_capture::stop` and clears the channel sender.

---

### Task 8 — Manual smoke test

```bash
# Terminal 1: build and run
cd audio-engine && cargo build && \
  WHISPER_MODEL=../assets/whisper/ggml-base.bin \
  VAD_MODEL=../assets/vad/silero_vad.onnx \
  ./target/debug/albedo-audio

# Terminal 2: minimal gRPC test client (grpcurl)
grpcurl -plaintext \
  -unix /tmp/albedo-audio.sock \
  albedo.audio.AudioEngine/StartCapture \
  '{"sample_rate": 16000, "vad_threshold": 0.5}'

# Speak into microphone for 5 seconds, then:
grpcurl -plaintext \
  -unix /tmp/albedo-audio.sock \
  albedo.audio.AudioEngine/StopCapture '{}'
```

For `StreamSTT`, use the integration test described in Section 8.

---

## 4. Module Breakdown

### `audio_capture.rs`

**Purpose:** Owns the `cpal` input stream. Provides a simple start/stop API that produces a stream of `Vec<f32>` PCM batches at 16 kHz mono.

**Key types:**

```rust
pub struct CaptureConfig {
    pub device_id: Option<String>,
    pub sample_rate: u32,       // Target: 16000
    pub vad_threshold: f32,
}

pub struct CaptureHandle {
    pub device_name: String,
    shutdown_tx: oneshot::Sender<()>,
    _thread: std::thread::JoinHandle<()>,
}
```

**Key functions:**

```rust
// Start capture; sends 512-sample f32 batches through `audio_tx`
pub fn start_capture(
    config: CaptureConfig,
    audio_tx: mpsc::Sender<Vec<f32>>,
) -> anyhow::Result<CaptureHandle>

// Signal the stream thread to stop and wait for join
pub fn stop_capture(handle: CaptureHandle)
```

**Internal flow:**
- Calls `cpal::default_host().default_input_device()` or selects by ID
- Negotiates the closest supported config to 16 kHz mono f32
- If native rate differs, creates a `rubato::FftFixedInOut` resampler; each cpal callback resamples before sending
- The cpal stream and resampler are owned by the background thread; `shutdown_tx` signals it to exit

---

### `vad.rs`

**Purpose:** Wraps the Silero VAD ONNX model. Classifies 512-sample chunks as speech or silence. Maintains LSTM hidden/cell state across consecutive chunks.

**Key types:**

```rust
pub struct VadEngine {
    session: ort::Session,
    h: Array3<f32>,        // LSTM hidden state [1, 1, 64]
    c: Array3<f32>,        // LSTM cell state [1, 1, 64]
    sample_rate: i64,
    pub threshold: f32,
}
```

**Key functions:**

```rust
// Load ONNX model from path
pub fn new(model_path: &str, threshold: f32) -> anyhow::Result<Self>

// Classify a 512-sample chunk; updates internal LSTM state
pub fn is_speech(&mut self, samples: &[f32]) -> anyhow::Result<bool>

// Zero LSTM state; call between capture sessions
pub fn reset(&mut self)
```

**Critical detail:** VAD state must persist across chunk calls within a single utterance. When `StopCapture` is called, call `reset()` so the next `StartCapture` begins with a clean LSTM state.

---

### `stt.rs`

**Purpose:** Wraps whisper.cpp via `whisper-rs`. Takes a `Vec<f32>` (complete speech segment at 16 kHz) and returns a transcription string. Stateless per call.

**Key types:**

```rust
pub struct WhisperEngine {
    ctx: Arc<WhisperContext>,  // Thread-safe whisper.cpp context
}
```

**Key functions:**

```rust
// Load ggml model from path; expensive — call once at startup
pub fn new(model_path: &str) -> anyhow::Result<Self>

// Synchronous transcription; runs on the calling thread
pub fn transcribe(&self, samples: &[f32]) -> anyhow::Result<String>

// Async wrapper; offloads to a blocking thread pool
pub async fn transcribe_async(&self, samples: Vec<f32>) -> anyhow::Result<String>
```

**Parameters tuning:**
- `set_n_threads(4)` — adjust to `num_cpus::get() / 2` for production
- `set_language(Some("auto"))` — use `"en"` for English-only to skip language detection overhead (~20 ms)
- `set_no_context(true)` — treat each utterance independently; avoids hallucinations from previous segments bleeding into context
- `set_single_segment(false)` — allow multiple segments for longer utterances

---

### `main.rs`

**Purpose:** Binary entrypoint. Initialises all engines, owns the shared state, implements the `AudioEngine` gRPC service trait, and starts the Tonic server.

**Key types:**

```rust
pub struct AlbedoAudioEngine {
    whisper: stt::WhisperEngine,
    vad: Arc<Mutex<vad::VadEngine>>,
    // Channel sender end: used by StreamSTT to receive raw PCM from capture
    capture_tx: Arc<Mutex<Option<mpsc::Sender<Vec<f32>>>>>,
    // Handle: used to stop the capture thread on StopCapture
    capture_handle: Arc<Mutex<Option<audio_capture::CaptureHandle>>>,
}
```

**Key functions:**

```rust
// Tonic gRPC entrypoint
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>>

// Trait impl methods:
async fn stream_stt(...)  -> Result<Response<Self::StreamSTTStream>, Status>
async fn start_capture(...) -> Result<Response<CaptureStatus>, Status>
async fn stop_capture(...)  -> Result<Response<CaptureStatus>, Status>
// Phase 2 stubs (return Unimplemented):
async fn synthesize(...)
async fn start_loopback(...)
async fn stop_loopback(...)
```

---

## 5. Audio Pipeline Flow

```
Microphone hardware
        │
        │  OS audio driver (ALSA / CoreAudio / WASAPI)
        ▼
┌─────────────────────────────────────────────────────────┐
│  cpal input stream  (audio_capture.rs)                  │
│                                                         │
│  • Callback fires every ~10 ms (device-dependent)       │
│  • Native format → resample to f32 16 kHz mono if needed│
│  • Batches 512 samples (~32 ms) into Vec<f32>           │
│  • Sends via mpsc::Sender<Vec<f32>>                     │
└───────────────────────────┬─────────────────────────────┘
                            │  mpsc channel (non-blocking)
                            ▼
┌─────────────────────────────────────────────────────────┐
│  VAD loop  (vad.rs, inside StreamSTT task)              │
│                                                         │
│  For each 512-sample chunk:                             │
│  • Run Silero ONNX inference (~2–5 ms)                  │
│  • Output: speech_prob (f32)                            │
│  • speech_prob > threshold → is_speech = true           │
│  • Maintain start-of-speech / end-of-speech edge detect │
└──────────────┬─────────────────────┬────────────────────┘
               │ is_speech = true    │ is_speech = false
               ▼                     ▼
     ┌──────────────────┐   ┌──────────────────────────┐
     │ Accumulate into  │   │ If buffer non-empty:     │
     │ speech_buffer    │   │   → trigger transcription│
     │ (Vec<f32>)       │   │   → clear buffer         │
     └──────────────────┘   └────────────┬─────────────┘
                                         │ complete utterance
                                         ▼
                         ┌───────────────────────────────┐
                         │  Whisper transcription        │
                         │  (stt.rs, spawn_blocking)     │
                         │                               │
                         │  • whisper.cpp full() call    │
                         │  • ~150–300 ms for base model │
                         │  • Returns text string        │
                         └───────────────┬───────────────┘
                                         │ TranscriptionResult
                                         ▼
                         ┌───────────────────────────────┐
                         │  gRPC response stream         │
                         │  (main.rs, StreamSTT)         │
                         │                               │
                         │  TranscriptionResult {        │
                         │    text: "...",               │
                         │    confidence: 0.95,          │
                         │    is_final: true,            │
                         │    timestamp_ms: ...,         │
                         │  }                            │
                         └───────────────────────────────┘
                                         │
                                         ▼
                              Bun orchestrator (Phase 3)
```

### Speech edge detection

A simple state machine prevents spurious short gaps from triggering premature transcription:

```
States: SILENCE → SPEECH → POST_SPEECH → (SILENCE or back to SPEECH)

SILENCE     → SPEECH:      When 3 consecutive chunks are speech (avoid click noise)
SPEECH      → POST_SPEECH: When 1 chunk is silence
POST_SPEECH → SILENCE:     When 8 consecutive chunks are silence (~256 ms of silence)
                           → triggers transcription flush
POST_SPEECH → SPEECH:      When next chunk is speech again (mid-utterance pause)
```

This prevents a short breath or hesitation from splitting one utterance into two separate Whisper calls.

---

## 6. gRPC Server Implementation

### 6.1 `StartCapture`

```
Client → StartCapture(CaptureConfig) → Server
                                     ← CaptureStatus
```

**Lifecycle:**

1. Check if a capture session is already active. If so, return an `AlreadyExists` status error.
2. Create a bounded `mpsc::channel::<Vec<f32>>(256)` — the sender goes to `audio_capture::start_capture`, the receiver is stored in a shared `Arc<Mutex<Option<mpsc::Receiver<Vec<f32>>>>>` accessible by `StreamSTT`.
3. Call `audio_capture::start_capture(config, audio_tx)` — this spawns the capture thread and returns a `CaptureHandle`.
4. Store the `CaptureHandle` in `self.capture_handle`.
5. Return `CaptureStatus { active: true, device_name: handle.device_name }`.

**Error cases:**
- No input device found → `Status::not_found("No input device available")`
- cpal stream build error → `Status::internal(err.to_string())`

### 6.2 `StopCapture`

```
Client → StopCapture(Empty) → Server
                            ← CaptureStatus
```

**Lifecycle:**

1. Take the `CaptureHandle` from `self.capture_handle` (replace with `None`).
2. If no handle, return `CaptureStatus { active: false, device_name: "" }` — idempotent, no error.
3. Call `audio_capture::stop_capture(handle)` — this signals the stream thread and waits for it to join.
4. Drop the channel sender (stored in `self.capture_tx`). This causes the receiver side (in any active `StreamSTT` task) to see `RecvError::Disconnected` and terminate cleanly.
5. Call `vad.reset()` to clear LSTM state.
6. Return `CaptureStatus { active: false, device_name: "" }`.

### 6.3 `StreamSTT` (bidirectional streaming)

This is the primary RPC. It is a **server-streaming RPC** in the current proto definition (client sends `AudioChunk` stream, server sends `TranscriptionResult` stream). However, the actual design uses the server's internal capture pipeline rather than the client's audio chunks for the Phase 1 implementation. There are two valid interpretations:

**Option A (Proto-literal):** Client streams `AudioChunk` messages → server decodes and runs VAD+STT. This matches the proto exactly and is fully testable with a WAV file client.

**Option B (Capture-driven):** Server reads from internal capture pipeline; `StreamSTT` is just a subscription channel. Client sends an empty stream or a single "start" message.

**Phase 1 uses Option A** — it is cleaner, testable without a mic, and aligns exactly with the proto definition. The orchestrator will stream audio chunks it receives from `StartCapture`'s side channel. In Phase 3, `StartCapture` and `StreamSTT` will be co-ordinated by the Bun client.

**Server-side implementation:**

```rust
type StreamSTTStream = ReceiverStream<Result<TranscriptionResult, Status>>;

async fn stream_stt(
    &self,
    request: Request<tonic::Streaming<AudioChunk>>,
) -> Result<Response<Self::StreamSTTStream>, Status> {
    let mut inbound = request.into_inner();
    let (tx, rx) = mpsc::channel::<Result<TranscriptionResult, Status>>(32);
    let whisper = self.whisper.clone();
    let vad = self.vad.clone();

    tokio::spawn(async move {
        let mut speech_buffer: Vec<f32> = Vec::new();
        let mut silence_count: u32 = 0;
        let mut speech_count: u32 = 0;
        let mut last_transcription: String = String::new();

        const SPEECH_ONSET: u32 = 3;    // consecutive speech chunks to transition SILENCE → SPEECH
        const SILENCE_END: u32 = 8;     // consecutive silence chunks to flush in POST_SPEECH (~256 ms)
        const MAX_BUFFER_SAMPLES: usize = 30 * 16000; // 30-second hard cap at 16 kHz
        let mut state = VadState::Silence;

        // Helper: flush speech_buffer to Whisper and send result downstream.
        // Filters out Whisper hallucinations and repeated transcriptions.
        macro_rules! flush_buffer {
            ($buf:expr, $ts:expr) => {{
                let buf = $buf;
                let ts = $ts;
                let tx2 = tx.clone();
                let w2 = whisper.clone();
                let last = last_transcription.clone();
                tokio::spawn(async move {
                    match w2.transcribe_async(buf).await {
                        Ok(text) => {
                            // Hallucination filter: skip empty, whitespace-only, artifact
                            // strings, results shorter than 3 chars, and exact repeats.
                            let trimmed = text.trim();
                            let is_artifact = matches!(
                                trimmed,
                                "[BLANK_AUDIO]" | "(music)" | "(inaudible)" | "[BLANK_AUDIO] "
                            ) || trimmed.starts_with('[') && trimmed.ends_with(']')
                              || trimmed.starts_with('(') && trimmed.ends_with(')');
                            if trimmed.is_empty()
                                || trimmed.len() < 3
                                || is_artifact
                                || trimmed == last.trim()
                            {
                                return; // discard hallucination or repeat
                            }
                            let _ = tx2.send(Ok(TranscriptionResult {
                                text: trimmed.to_string(),
                                confidence: 0.9,
                                is_final: true,
                                timestamp_ms: ts,
                            })).await;
                        }
                        Err(e) => {
                            let _ = tx2.send(Err(
                                Status::internal(e.to_string())
                            )).await;
                        }
                    }
                });
            }};
        }

        while let Ok(Some(chunk)) = inbound.message().await {
            // Decode f32le PCM from bytes
            let samples: Vec<f32> = chunk.pcm_data
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();

            // Run VAD
            let is_speech = {
                let mut v = vad.lock().await;
                v.is_speech(&samples).unwrap_or(false)
            };

            // 3-state VAD machine:
            //   SILENCE     — waiting for speech onset (requires SPEECH_ONSET consecutive
            //                 speech frames before transitioning to SPEECH)
            //   SPEECH      — accumulating audio; stays here while speech continues
            //   POST_SPEECH — detected silence after speech; waits SILENCE_END consecutive
            //                 silence frames before flushing to Whisper. Returns to SPEECH
            //                 immediately on any speech frame, preventing mid-utterance
            //                 pauses from triggering premature Whisper calls.
            match state {
                VadState::Silence => {
                    if is_speech {
                        speech_count += 1;
                        speech_buffer.extend_from_slice(&samples);
                        if speech_count >= SPEECH_ONSET {
                            state = VadState::Speech;
                        }
                    } else {
                        speech_count = 0;
                        speech_buffer.clear();
                    }
                }
                VadState::Speech => {
                    speech_buffer.extend_from_slice(&samples);
                    if !is_speech {
                        silence_count = 1;
                        state = VadState::PostSpeech;
                    } else {
                        // 30-second max buffer cap: force flush if buffer grows too large
                        // (e.g., continuous monologue with no silence). Prevents unbounded
                        // memory growth.
                        if speech_buffer.len() >= MAX_BUFFER_SAMPLES {
                            let buf = std::mem::take(&mut speech_buffer);
                            let ts = chunk.timestamp_ms;
                            flush_buffer!(buf, ts);
                            state = VadState::Silence;
                            silence_count = 0;
                            speech_count = 0;
                        }
                    }
                }
                VadState::PostSpeech => {
                    if is_speech {
                        // Mid-utterance pause: return to SPEECH without flushing
                        speech_buffer.extend_from_slice(&samples);
                        silence_count = 0;
                        state = VadState::Speech;
                    } else {
                        silence_count += 1;
                        if silence_count >= SILENCE_END {
                            // End of utterance confirmed: flush to Whisper
                            let buf = std::mem::take(&mut speech_buffer);
                            let ts = chunk.timestamp_ms;
                            flush_buffer!(buf, ts);
                            state = VadState::Silence;
                            silence_count = 0;
                            speech_count = 0;
                        }
                    }
                }
            }
        }

        // Stream ended: flush any remaining buffer
        if !speech_buffer.is_empty() {
            if let Ok(text) = whisper.transcribe_async(speech_buffer).await {
                let trimmed = text.trim();
                let is_artifact = matches!(
                    trimmed,
                    "[BLANK_AUDIO]" | "(music)" | "(inaudible)"
                ) || trimmed.starts_with('[') && trimmed.ends_with(']')
                  || trimmed.starts_with('(') && trimmed.ends_with(')');
                if !trimmed.is_empty()
                    && trimmed.len() >= 3
                    && !is_artifact
                    && trimmed != last_transcription.trim()
                {
                    let _ = tx.send(Ok(TranscriptionResult {
                        text: trimmed.to_string(),
                        confidence: 0.9,
                        is_final: true,
                        timestamp_ms: 0,
                    })).await;
                }
            }
        }
    });

    Ok(Response::new(ReceiverStream::new(rx)))
}

enum VadState { Silence, Speech, PostSpeech }
```

### 6.4 gRPC server binding

On Unix, Tonic supports Unix domain sockets natively via the `tokio::net::UnixListener`. The `Server::builder().serve_with_incoming(...)` pattern is used:

```rust
#[cfg(unix)]
{
    use tokio::net::UnixListener;
    use tokio_stream::wrappers::UnixListenerStream;

    let socket_path = "/tmp/albedo-audio.sock";
    let _ = std::fs::remove_file(socket_path);
    let uds = UnixListener::bind(socket_path)?;
    let stream = UnixListenerStream::new(uds);

    Server::builder()
        .add_service(AudioEngineServer::new(engine))
        .serve_with_incoming(stream)
        .await?;
}

#[cfg(not(unix))]
{
    let addr = "[::1]:50051".parse()?;
    Server::builder()
        .add_service(AudioEngineServer::new(engine))
        .serve(addr)
        .await?;
}
```

The `tokio-stream` crate must be in `Cargo.toml` for `UnixListenerStream`.

---

## 7. Model Loading

### 7.1 Whisper model loading

`whisper-rs` calls into whisper.cpp's C API. The model is memory-mapped at load time:

```rust
// In stt.rs
use whisper_rs::{WhisperContext, WhisperContextParameters};

let params = WhisperContextParameters::default();
let ctx = WhisperContext::new_with_params(model_path, params)
    .map_err(|e| anyhow::anyhow!("Failed to load Whisper model from {}: {:?}", model_path, e))?;
```

**Load time:** ~1–2 seconds for `ggml-base.bin` on a modern CPU. This is done once at startup, not per request.

**Memory usage:** ~142 MB for `ggml-base.bin` (model size ≈ RAM footprint since it maps the file).

**GPU acceleration:** whisper.cpp supports CUDA, Metal, and OpenCL. For Phase 1, CPU-only is sufficient and avoids build complexity. GPU can be enabled later by building whisper.cpp with the appropriate backend:
```toml
# Cargo.toml - add when GPU needed:
whisper-rs = { version = "0.14", features = ["cuda"] }
```

**Configuration to confirm at load:**

```rust
// Validate the file exists before attempting to load (gives a clearer error)
if !std::path::Path::new(model_path).exists() {
    anyhow::bail!(
        "Whisper model not found at '{}'. \
         Download with: wget -P assets/whisper/ \
         https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        model_path
    );
}
```

### 7.2 Silero VAD ONNX model loading

Uses `ort` (ONNX Runtime Rust bindings):

```rust
// In vad.rs
use ort::{Session, SessionBuilder};

let session = SessionBuilder::new()?
    .with_intra_threads(1)?    // VAD is small; 1 thread is fine
    .commit_from_file(model_path)?;
```

**Load time:** ~50 ms for `silero_vad.onnx` (~2 MB model).

**ONNX Runtime version:** `ort` v2.x targets ONNX Runtime 1.19.x. The `load-dynamic` feature in `Cargo.toml` loads the library from the system at runtime (consistent with Phase 2 TTS). Ensure the installed ONNX Runtime version matches the version `ort` v2.x expects (1.19.x). Set `ORT_DYLIB_PATH` if the library is not on the default linker path.

**Input/output tensor names for Silero VAD v5:**

| Tensor | Name | Shape | Dtype |
|---|---|---|---|
| Input | `input` | `[1, num_samples]` | f32 |
| Sample rate | `sr` | `[]` (scalar) | i64 |
| Hidden state | `h` | `[1, 1, 64]` | f32 |
| Cell state | `c` | `[1, 1, 64]` | f32 |
| Output (speech prob) | `output` | `[1, 1]` | f32 |
| New hidden state | `hn` | `[1, 1, 64]` | f32 |
| New cell state | `cn` | `[1, 1, 64]` | f32 |

Verify tensor names against the actual model if inference fails:

```python
# Quick check in Python
import onnxruntime as rt
sess = rt.InferenceSession("assets/vad/silero_vad.onnx")
for i in sess.get_inputs(): print(i.name, i.shape, i.type)
for o in sess.get_outputs(): print(o.name, o.shape, o.type)
```

**Configuration to confirm at load:**

```rust
if !std::path::Path::new(model_path).exists() {
    anyhow::bail!(
        "Silero VAD model not found at '{}'. \
         Download with: wget -P assets/vad/ \
         https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
        model_path
    );
}
```

---

## 8. Testing Strategy

### 8.1 Unit tests

**`audio_capture.rs` — device enumeration test**

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn test_default_device_available() {
        let host = cpal::default_host();
        let device = host.default_input_device();
        assert!(device.is_some(), "No default input device found");
        println!("Default mic: {}", device.unwrap().name().unwrap_or_default());
    }
}
```

Run with: `cargo test test_default_device_available -- --nocapture`

This test is intentionally simple — it verifies the system has a mic and cpal can see it. On CI machines without audio hardware, this test should be gated with `#[cfg(not(ci))]` or skipped.

**`vad.rs` — model load and inference test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vad_loads() {
        let vad = VadEngine::new("../assets/vad/silero_vad.onnx", 0.5);
        assert!(vad.is_ok(), "VAD model failed to load: {:?}", vad.err());
    }

    #[test]
    fn test_vad_silence() {
        let mut vad = VadEngine::new("../assets/vad/silero_vad.onnx", 0.5).unwrap();
        // All-zero samples = silence
        let silence = vec![0.0f32; 512];
        let result = vad.is_speech(&silence).unwrap();
        assert!(!result, "Expected silence for zero samples");
    }

    #[test]
    fn test_vad_state_resets() {
        let mut vad = VadEngine::new("../assets/vad/silero_vad.onnx", 0.5).unwrap();
        // Run a few chunks to dirty LSTM state
        for _ in 0..10 {
            let _ = vad.is_speech(&vec![0.0f32; 512]);
        }
        vad.reset();
        // After reset, h and c should be zero
        assert!(vad.h.iter().all(|&x| x == 0.0));
        assert!(vad.c.iter().all(|&x| x == 0.0));
    }
}
```

Run with: `cargo test --lib -- vad::tests`

**`stt.rs` — model load test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_whisper_loads() {
        let engine = WhisperEngine::new("../assets/whisper/ggml-base.bin");
        assert!(engine.is_ok(), "Whisper failed to load: {:?}", engine.err());
    }

    #[test]
    fn test_transcribe_silence() {
        let engine = WhisperEngine::new("../assets/whisper/ggml-base.bin").unwrap();
        // 3 seconds of silence
        let silence = vec![0.0f32; 16000 * 3];
        let result = engine.transcribe(&silence).unwrap();
        // Whisper may return empty string or hallucinate slightly — acceptable
        println!("Silence transcription: '{}'", result);
    }

    #[test]
    fn test_hallucination_filter() {
        // Verify that known Whisper artifact strings are correctly identified as
        // hallucinations and would be discarded by the filter in stream_stt.
        let artifacts = &[
            "[BLANK_AUDIO]",
            "(music)",
            "(inaudible)",
            "  ",   // whitespace only
            "ok",   // fewer than 3 chars
            "",     // empty
        ];
        for s in artifacts {
            let trimmed = s.trim();
            let is_artifact = matches!(trimmed, "[BLANK_AUDIO]" | "(music)" | "(inaudible)")
                || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                || (trimmed.starts_with('(') && trimmed.ends_with(')'));
            let should_discard = trimmed.is_empty() || trimmed.len() < 3 || is_artifact;
            assert!(
                should_discard,
                "Expected '{}' to be discarded by hallucination filter", s
            );
        }
    }
}
```

Note: `test_whisper_loads` takes ~2 seconds due to model loading. Mark with `#[ignore]` if needed for fast CI and run explicitly with `cargo test -- --ignored`.

### 8.2 Integration test — WAV file transcription

Create `audio-engine/tests/wav_transcription.rs`:

```rust
use std::path::PathBuf;
use albedo_audio::stt::WhisperEngine;
use albedo_audio::vad::VadEngine;

#[tokio::test]
async fn test_wav_file_transcription() {
    let wav_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hello_world.wav");

    // Load a known-good WAV: 16 kHz mono f32
    let mut reader = hound::WavReader::open(&wav_path)
        .expect("test fixture not found — add tests/fixtures/hello_world.wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16000, "Test WAV must be 16 kHz");
    assert_eq!(spec.channels, 1, "Test WAV must be mono");

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => {
            reader.samples::<f32>().map(|s| s.unwrap()).collect()
        }
        hound::SampleFormat::Int => {
            reader.samples::<i16>()
                .map(|s| s.unwrap() as f32 / i16::MAX as f32)
                .collect()
        }
    };

    let engine = WhisperEngine::new("../assets/whisper/ggml-base.bin")
        .expect("Whisper model not found");

    let text = engine.transcribe_async(samples).await
        .expect("Transcription failed");

    println!("Transcription result: '{}'", text);
    assert!(!text.is_empty(), "Transcription should not be empty for a voice recording");
    // Loose check — exact wording depends on model and audio quality
    assert!(
        text.to_lowercase().contains("hello"),
        "Expected 'hello' in transcription, got: '{}'", text
    );
}
```

**To create the test fixture:**

```bash
# Record a short WAV (requires sox)
sox -n -r 16000 -c 1 audio-engine/tests/fixtures/hello_world.wav \
  synth 2 sin 440 2>/dev/null

# Or use a real recording:
# Record yourself saying "Hello world" for 2 seconds
rec -r 16000 -c 1 -b 16 -e signed-integer \
  audio-engine/tests/fixtures/hello_world.wav trim 0 2
```

Alternatively, download a pre-made sample from Mozilla Common Voice.

### 8.3 gRPC integration test

Create `audio-engine/tests/grpc_integration.rs`:

```rust
// Starts the full gRPC server in a background task, connects a client,
// and streams a WAV file through StreamSTT.

#[tokio::test]
async fn test_stream_stt_with_wav() {
    // Start server on a test-only socket
    let socket = "/tmp/albedo-audio-test.sock";
    // ... (spawn server, connect client, stream chunks, collect results)
    // See full implementation in integration test
}
```

This test is marked `#[ignore]` by default (requires model files) and run explicitly:

```bash
cargo test --test grpc_integration -- --ignored --nocapture
```

### 8.4 Manual mic test

The simplest end-to-end test:

```bash
# 1. Build and run the server
cargo run -- \
  WHISPER_MODEL=../assets/whisper/ggml-base.bin \
  VAD_MODEL=../assets/vad/silero_vad.onnx

# 2. In another terminal, use grpcurl to call StartCapture
grpcurl -plaintext -unix /tmp/albedo-audio.sock \
  albedo.audio.AudioEngine/StartCapture \
  '{"sample_rate":16000,"vad_threshold":0.5}'

# 3. Open a StreamSTT stream (this will receive results in real time)
# Since the proto is client-streaming, use a custom test client (below)

# 4. Stop capture
grpcurl -plaintext -unix /tmp/albedo-audio.sock \
  albedo.audio.AudioEngine/StopCapture '{}'
```

For full StreamSTT testing, write a minimal Bun/Node.js test client:

```typescript
// tools/test-stt.ts
import { createChannel, createClient } from "nice-grpc";

const channel = createChannel("unix:///tmp/albedo-audio.sock");
// ... stream audio chunks from mic or WAV file, print results
```

---

## 9. Validation Criteria

Phase 1 is complete when **all** of the following pass:

1. **Build succeeds without warnings** on the target platform:
   ```bash
   cd audio-engine && cargo build 2>&1 | grep -E "^error" | wc -l
   # Must output: 0
   ```

2. **Unit tests pass:**
   ```bash
   cargo test --lib -- --nocapture
   # All tests: ok
   ```

3. **WAV integration test passes** with a real voice recording:
   ```bash
   cargo test --test wav_transcription -- --nocapture
   # test test_wav_file_transcription ... ok
   ```

4. **gRPC server starts and accepts connections:**
   ```bash
   ./target/debug/albedo-audio &
   grpcurl -plaintext -unix /tmp/albedo-audio.sock list albedo.audio.AudioEngine
   # Must list: StartCapture, StopCapture, StreamSTT, Synthesize, StartLoopback, StopLoopback
   ```

5. **StartCapture / StopCapture lifecycle works:**
   ```bash
   grpcurl -plaintext -unix /tmp/albedo-audio.sock \
     albedo.audio.AudioEngine/StartCapture '{"sample_rate":16000}'
   # Returns: { "active": true, "deviceName": "<mic name>" }

   grpcurl -plaintext -unix /tmp/albedo-audio.sock \
     albedo.audio.AudioEngine/StopCapture '{}'
   # Returns: { "active": false }
   ```

6. **End-to-end mic test:** Speak a clear sentence into the microphone while `StreamSTT` is active. The transcription text is printed to stdout via the test client within 2 seconds of finishing speaking.

   Expected output format:
   ```
   [StreamSTT] "Hello, this is a test of the audio engine."
   ```

7. **Hallucination filter:** Feed 3 seconds of silence through `StreamSTT`. No `TranscriptionResult` should be emitted. Known artifact strings (`[BLANK_AUDIO]`, `(music)`, `(inaudible)`) must be suppressed and not forwarded to the gRPC response stream.

8. **30-second buffer cap:** Stream more than 30 seconds of continuous speech (no silence pauses) through `StreamSTT`. The implementation must force-flush to Whisper at the 30-second mark and reset the buffer, rather than accumulating audio indefinitely. Verify via log output (`tracing::debug!`) that the forced flush occurs and that memory usage does not grow unboundedly during long monologues.

---

## 10. Performance Targets

These targets apply to `ggml-base.bin` on a typical development machine (modern x86-64 CPU, no GPU acceleration):

| Metric | Target | Measurement method |
|---|---|---|
| VAD latency per chunk | < 10 ms | `std::time::Instant` around `vad.is_speech()` |
| VAD end-of-speech detection | < 100 ms after last speech sample | Time from last speech chunk to transcription trigger |
| STT latency (3s utterance, base model) | < 300 ms | Time from `transcribe()` call to return |
| STT latency (5s utterance, base model) | < 500 ms | Same |
| Memory usage (idle, models loaded) | < 400 MB RSS | `/proc/<pid>/status` or `ps aux` |
| gRPC `StartCapture` call latency | < 50 ms | Client-side measurement |
| CPU usage during VAD-only (no speech) | < 5% single core | `top` during idle capture |
| CPU usage during STT inference | < 80% of N threads | `top` during transcription |

**Measurement snippet for VAD:**

```rust
// In vad.rs is_speech():
let t0 = std::time::Instant::now();
let output = self.session.run(inputs)?;
tracing::debug!("VAD inference: {:?}", t0.elapsed());
```

Enable timing in dev builds only — remove from release.

---

## 11. Risks and Notes

### 11.1 whisper-rs build complexity

**Risk (High):** `whisper-rs` compiles whisper.cpp from source via a `cc` build script. This is the most likely source of build failures.

**Common failures and fixes:**

| Error | Cause | Fix |
|---|---|---|
| `libclang not found` | Missing clang for bindgen | `apt install libclang-dev` (Linux) or `brew install llvm` + set `LIBCLANG_PATH` |
| `cmake: command not found` | Missing cmake | `apt install cmake` |
| `ld: library not found for -lc++` | macOS SDK issue | `xcode-select --install` |
| `undefined symbol: ggml_...` | Stale build cache | `cargo clean && cargo build` |
| Linker errors on Windows | MSVC vs MinGW mismatch | Use MSVC toolchain: `rustup default stable-x86_64-pc-windows-msvc` |

**Mitigation:** Pin `whisper-rs = "0.14"` exactly (not `"0.14.*"`). The crate's build script changes between minor versions.

### 11.2 cpal platform differences

**Risk (Medium):** `cpal` behavior varies significantly across platforms:

- **Linux (ALSA):** Default device enumeration is reliable but sample format may be `i16` (not `f32`). Always use `cpal::SupportedStreamConfigRange` and negotiate the best config, then resample/convert in the callback.
- **Linux (PulseAudio/PipeWire):** `cpal` uses ALSA under PulseAudio via the ALSA-PulseAudio bridge. May require `ALSA_CARD=default` or specific device names. PipeWire's native ALSA compatibility layer usually works without changes.
- **macOS (CoreAudio):** Very reliable. Default sample rate may be 44100 Hz — rubato resampling required.
- **Windows (WASAPI):** Two modes: shared (uses system mixer, may not support 16 kHz) and exclusive (direct device access, supports 16 kHz). Phase 1 uses shared mode.

**Mitigation:** Always enumerate supported configs and select the closest match, then resample. Never assume 16 kHz is supported natively.

### 11.3 Silero VAD ONNX model version mismatch

**Risk (Low):** Silero has released v1 through v5 of the VAD model, each with different tensor names and shapes. The implementation in this plan targets v5 (the `silero_vad.onnx` from the repo's current `main` branch).

**Mitigation:** Always download from the canonical URL specified in Section 2.3. If the model was obtained from elsewhere, verify tensor shapes with the Python snippet in Section 7.2.

### 11.4 Thread safety of WhisperContext

**Risk (Medium):** `WhisperContext` in `whisper-rs 0.14` implements `Send + Sync`, but older versions do not. If the compiler reports `WhisperContext is not Send`, wrap in `Arc<Mutex<WhisperContext>>` and only call `transcribe` while holding the lock. This means concurrent STT calls will serialize — acceptable for Phase 1.

**Mitigation:** For production, maintain a pool of `WhisperContext` instances (one per CPU core) to allow parallel inference.

### 11.5 Latency from blocking STT on async runtime

**Risk (Low):** `whisper.cpp` inference is CPU-bound and takes 150–300 ms. Running it directly on a Tokio async task would block the runtime thread, starving other async tasks.

**Mitigation (already addressed):** The implementation wraps the call in `tokio::task::spawn_blocking`, which runs it on Tokio's dedicated blocking thread pool (defaults to 512 threads). This keeps the async runtime responsive.

### 11.6 Audio buffer growth with long silences

**Risk (Low):** If the VAD threshold is set too low or the user has continuous background noise, `speech_buffer` may grow indefinitely.

**Mitigation:** Add a maximum buffer size guard:

```rust
const MAX_SPEECH_SAMPLES: usize = 16000 * 30; // 30 seconds max
if speech_buffer.len() > MAX_SPEECH_SAMPLES {
    tracing::warn!("Speech buffer exceeded 30s, forcing transcription flush");
    // Force flush
}
```

### 11.7 gRPC Unix socket cleanup on crash

**Risk (Low):** If the process crashes, `/tmp/albedo-audio.sock` is not cleaned up. On the next start, binding the socket will fail with `Address already in use`.

**Mitigation (already addressed):** The `main()` function calls `std::fs::remove_file("/tmp/albedo-audio.sock")` before binding, ignoring the error if the file doesn't exist.

### 11.8 Edition 2024 compatibility

**Risk (Low):** `Cargo.toml` specifies `edition = "2024"`. As of Rust 1.85, this is stable. Ensure `rustup update stable` is run before building if the toolchain is older. The `whisper-rs` and `ort` crates are built with their own editions, so this only affects the `albedo-audio` crate's own code.

---

*End of Phase 1 implementation plan. Proceed to Phase 2 (TTS) once all validation criteria in Section 9 are satisfied.*
