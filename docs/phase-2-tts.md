# Phase 2: TTS — Implementation Plan

**Project:** Albedo AI  
**Phase:** 2 of 7  
**Estimated duration:** 3–4 days  
**Author:** Engineering  
**Last updated:** 2026-04-13

---

## Table of Contents

1. [Objective](#objective)
2. [Prerequisites](#prerequisites)
3. [Step-by-Step Tasks](#step-by-step-tasks)
4. [Module Breakdown](#module-breakdown)
5. [Kokoro Integration](#kokoro-integration)
6. [Viseme Extraction](#viseme-extraction)
7. [Audio Playback](#audio-playback)
8. [gRPC Synthesize Endpoint](#grpc-synthesize-endpoint)
9. [Testing Strategy](#testing-strategy)
10. [Validation Criteria](#validation-criteria)
11. [Performance Targets](#performance-targets)
12. [Risks and Notes](#risks-and-notes)

---

## Objective

Phase 2 delivers the complete text-to-speech pipeline inside `albedo-audio` (the Rust binary). By the end of this phase, the system can:

- Accept a text string via the `Synthesize` gRPC RPC.
- Run Kokoro TTS inference via ONNX Runtime to produce raw PCM audio.
- Extract per-phoneme viseme timing data from the synthesis output.
- Play the synthesized audio through the system speaker via `cpal`.
- Return the raw PCM bytes and viseme sequence to the caller in a single `SynthesizeResponse`.

This is the voice output half of the conversational loop. Phase 1 gave Albedo the ability to hear; Phase 2 gives it the ability to speak. The gRPC contract established in `proto/audio.proto` is already frozen, so this phase is entirely contained within `audio-engine/`.

---

## Prerequisites

### Phase 1 complete

The following must already be working before starting Phase 2:

- `audio-engine/src/main.rs` — gRPC server bootstraps, binds to `unix:///tmp/albedo-audio.sock`, and serves `AudioEngineServer`.
- `audio-engine/src/vad.rs` — `VadEngine` compiles and is instantiated in `AlbedoAudioEngine`.
- `audio-engine/src/stt.rs` — `WhisperEngine` compiles and is instantiated in `AlbedoAudioEngine`.
- `audio-engine/src/audio_capture.rs` — mic capture via `cpal` works.
- `proto/audio.proto` — compiled to Rust via `tonic-build` in `audio-engine/build.rs`.
- `audio-engine/Cargo.toml` — contains all Phase 1 dependencies; `ort` and `hound` must already be listed.

### Kokoro ONNX model files

The following files must be present before running any TTS tests:

| File | Location | Notes |
|---|---|---|
| `kokoro-v0_19.onnx` | `assets/voices/kokoro-v0_19.onnx` | Main inference graph |
| `voices.bin` | `assets/voices/voices.bin` | Voice embedding table (all voices) |
| `config.json` | `assets/voices/config.json` | Model metadata (sample rate, tokens) |

These files are downloaded from the [Kokoro ONNX releases](https://github.com/thewh1teagle/kokoro-onnx/releases). The canonical release provides a single `.onnx` file (~310 MB) and a `voices.bin` (~5 MB).

### Cargo dependencies confirmed

The following crates must be in `audio-engine/Cargo.toml` before Phase 2 work begins:

```toml
ort = { version = "2.0", features = ["load-dynamic"] }
hound = "3.5"
rubato = "0.16"
cpal = "0.15"
```

`ort` requires the ONNX Runtime shared library (`libonnxruntime.so` / `onnxruntime.dll`) to be available at runtime. See [Risks and Notes](#risks-and-notes).

---

## Step-by-Step Tasks

### Day 1 — Kokoro engine and model loading

**Task 1.1 — Create `audio-engine/src/tts.rs` skeleton**

Create the file with the `KokoroEngine` struct, associated constructor, and stub for `synthesize`. The module must be declared in `main.rs` as `mod tts;`.

File: `audio-engine/src/tts.rs`

```rust
pub struct KokoroEngine { /* ... */ }

impl KokoroEngine {
    pub fn new(model_path: &str, voices_path: &str) -> Result<Self, Box<dyn std::error::Error>> { todo!() }
    pub async fn synthesize(&self, text: &str, voice_id: &str, speed: f32)
        -> Result<(Vec<u8>, Vec<Viseme>), Box<dyn std::error::Error>> { todo!() }
}
```

**Task 1.2 — Implement `KokoroEngine::new`**

Load the ONNX session via `ort::Session::builder()`. Load the voice embedding table from `voices.bin`. Store both in the struct fields. Validate that the session's input/output names match the expected Kokoro graph signature.

**Task 1.3 — Implement the text-to-token pipeline**

Write `fn tokenize(text: &str) -> Vec<i64>` in `tts.rs`. Kokoro uses a phoneme-based tokenizer. The implementation must:

1. Normalize the text (lowercase, strip non-ASCII punctuation, expand abbreviations).
2. Convert graphemes to phonemes using the `espeak-phonemizer` crate or a bundled phoneme table.
3. Map each phoneme to an integer token ID from the Kokoro vocabulary embedded in `config.json`.
4. Return a `Vec<i64>` padded/truncated to the model's max sequence length (512 tokens).

**Task 1.4 — Implement ONNX inference in `synthesize`**

Run the session with the token tensor and voice embedding tensor. Collect the output mel-spectrogram or raw audio tensor. If Kokoro v0.19 produces a raw waveform (f32 samples at 24 000 Hz), no vocoder step is needed — copy the output tensor directly to a `Vec<f32>`.

**Task 1.5 — Resample to 22 050 Hz using `rubato`**

The internal Kokoro sample rate is 24 000 Hz. The rest of the pipeline (cpal output, WAV export, PCM returned over gRPC) standardizes on 22 050 Hz. Use `rubato::FftFixedInOut` to resample. Store the resampled `Vec<f32>` for downstream consumers.

**Task 1.6 — Convert f32 samples to i16 PCM bytes**

The `SynthesizeResponse.pcm_data` field carries raw 16-bit little-endian PCM at 22 050 Hz mono. Write `fn f32_to_pcm16(samples: &[f32]) -> Vec<u8>` that clamps each sample to `[-1.0, 1.0]`, multiplies by `i16::MAX as f32`, and packs as 2-byte LE.

---

### Day 2 — Phoneme extraction and viseme mapping

**Task 2.1 — Create `audio-engine/src/lipsync.rs`**

Declare the module in `main.rs` as `mod lipsync;`. The module is responsible only for viseme extraction — it receives the phoneme sequence (with timing offsets) produced during tokenization and maps them to mouth shapes.

File: `audio-engine/src/lipsync.rs`

**Task 2.2 — Define the `PhonemeEvent` intermediate type**

```rust
pub struct PhonemeEvent {
    pub phoneme: String,   // IPA symbol, e.g. "æ", "p", "s"
    pub start_ms: u32,
    pub duration_ms: u32,
}
```

This type is internal to the Rust crate. The gRPC `Viseme` message is the external representation.

**Task 2.3 — Implement `fn phonemes_from_tokens`**

During tokenization (Task 1.3), preserve the phoneme string alongside each token ID. After ONNX inference, use the attention/duration predictor outputs (if available in the Kokoro graph) or a simple linear timing model to assign `start_ms`/`duration_ms` to each phoneme. The linear model divides total audio duration evenly across non-silence phonemes as a fallback.

**Task 2.4 — Build the viseme mapping table**

Define a static mapping from IPA phoneme symbols to the 9 canonical viseme shapes used by the Live2D avatar:

| Viseme shape | Example phonemes |
|---|---|
| `"rest"` | silence, `h` |
| `"A"` | `æ`, `a`, `ɑ` |
| `"E"` | `e`, `ɛ`, `ɪ` |
| `"I"` | `i`, `iː` |
| `"O"` | `ɔ`, `o`, `oʊ` |
| `"U"` | `u`, `uː`, `ʊ` |
| `"F"` | `f`, `v` |
| `"TH"` | `θ`, `ð` |
| `"MBP"` | `m`, `b`, `p` |

Store this as a `phf::Map<&'static str, &'static str>` using the `phf` crate (already a transitive dependency) or a plain `match` expression.

**Task 2.5 — Implement `fn extract_visemes(events: &[PhonemeEvent]) -> Vec<Viseme>`**

Map each `PhonemeEvent` through the table from Task 2.4. Merge consecutive events that share the same viseme shape to reduce chatter (threshold: merge if gap < 20 ms). Populate the `weight` field as `1.0` for vowels and `0.6` for consonants.

The `Viseme` struct here is the proto-generated type from `audio_proto::Viseme`, used directly.

---

### Day 3 — Audio playback

**Task 3.1 — Create `audio-engine/src/audio_playback.rs`**

Declare the module in `main.rs` as `mod audio_playback;`. This module owns the `cpal` output stream and a ring buffer for incoming PCM chunks.

**Task 3.2 — Implement `PlaybackEngine`**

```rust
pub struct PlaybackEngine {
    stream: cpal::Stream,
    sender: Arc<Mutex<VecDeque<f32>>>,
}

impl PlaybackEngine {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> { todo!() }
    pub fn enqueue(&self, samples: &[f32]) { todo!() }
    pub fn is_empty(&self) -> bool { todo!() }
}
```

**Task 3.3 — Set up the cpal output stream**

In `PlaybackEngine::new`:

1. Use `cpal::default_host()` and `host.default_output_device()`.
2. Query supported configs; prefer `SampleFormat::F32` at 22 050 Hz mono. Fall back to 44 100 Hz stereo if necessary (upmix mono to stereo, upsample with `rubato`).
3. Build the stream with a data callback that drains from the `VecDeque<f32>` ring buffer. When the buffer is empty, write zeros (silence) to avoid underrun clicks.
4. Call `stream.play()` immediately — the stream runs continuously in the background.

**Task 3.4 — Implement `enqueue`**

Lock the `VecDeque`, extend it with the incoming samples. This is called from the `synthesize` path after ONNX inference completes. Because synthesis is CPU-bound and happens before enqueue, the audio is available in full before playback begins — no streaming decode is needed for Phase 2.

**Task 3.5 — Wire `PlaybackEngine` into `AlbedoAudioEngine`**

Add a `playback: audio_playback::PlaybackEngine` field to `AlbedoAudioEngine` in `main.rs`. Initialize it in `main()`. Call `playback.enqueue(&samples)` at the end of `synthesize` after the PCM bytes have been computed but before returning the response. Playback and the gRPC response are thus issued concurrently — the caller receives the data the moment synthesis is done, and audio starts playing immediately.

---

### Day 4 — Integration, wiring, and cleanup

**Task 4.1 — Update `main.rs` constructor**

Change `KokoroEngine::new` call signature to accept separate `model_path` and `voices_path`:

```rust
kokoro: tts::KokoroEngine::new(
    "assets/voices/kokoro-v0_19.onnx",
    "assets/voices/voices.bin",
)?,
playback: audio_playback::PlaybackEngine::new()?,
```

**Task 4.2 — Connect lipsync in the `synthesize` handler**

The `synthesize` method on `KokoroEngine` must return phoneme events alongside the audio waveform. Update the return type to `(Vec<f32>, Vec<PhonemeEvent>)` internally, then in the gRPC handler:

```rust
let (samples, phoneme_events) = self.kokoro.synthesize_internal(...).await?;
let visemes = lipsync::extract_visemes(&phoneme_events);
let pcm_bytes = tts::f32_to_pcm16(&samples);
self.playback.enqueue(&samples);
```

**Task 4.3 — Handle the `speed` parameter**

Kokoro supports speed via a scalar multiplier on the duration predictor. Pass `req.speed` (default `1.0`, range `0.5`–`2.0`) to the ONNX session as a scalar input if the model graph exposes it, or apply post-hoc time-stretching via `rubato` if it does not.

**Task 4.4 — Add graceful error handling**

All ONNX errors, missing model files, and cpal device failures must return `Status::internal(...)` from the gRPC handler rather than panicking. Log errors to stderr with a `[tts]` prefix.

**Task 4.5 — Verify Cargo.toml is complete**

Ensure `audio-engine/Cargo.toml` has all new dependencies:

```toml
[dependencies]
ort = { version = "2.0", features = ["load-dynamic"] }
rubato = "0.16"
hound = "3.5"
cpal = "0.15"
# optional for phonemization
espeak-phonemizer = "0.1"   # or bundled phoneme table
```

---

## Module Breakdown

### `audio-engine/src/tts.rs` — `KokoroEngine`

**Key types:**

```rust
pub struct KokoroEngine {
    session: ort::Session,              // ONNX inference session (thread-safe)
    voice_embeddings: HashMap<String, Vec<f32>>, // voice_id → embedding vector
    config: KokoroConfig,               // sample_rate, max_len, vocab
}

pub struct KokoroConfig {
    pub sample_rate: u32,               // 24_000 Hz (native Kokoro rate)
    pub max_tokens: usize,              // 512
    pub vocab: HashMap<String, i64>,    // phoneme → token id
}
```

**Key functions:**

| Function | Signature | Purpose |
|---|---|---|
| `new` | `(model_path: &str, voices_path: &str) -> Result<Self>` | Load ONNX session and voice table |
| `synthesize` | `(text, voice_id, speed) -> Result<(Vec<u8>, Vec<Viseme>)>` | Full pipeline; public API |
| `synthesize_internal` | `(text, voice_id, speed) -> Result<(Vec<f32>, Vec<PhonemeEvent>)>` | Returns f32 samples + phoneme events |
| `tokenize` | `(text: &str) -> (Vec<i64>, Vec<String>)` | Text → token IDs + phoneme strings |
| `run_inference` | `(tokens, voice_emb, speed) -> Result<Vec<f32>>` | ONNX session run |
| `f32_to_pcm16` | `(samples: &[f32]) -> Vec<u8>` | f32 → i16 LE bytes |

**Data flow:**

```
text: &str
  └─ tokenize()
       ├─ phoneme strings: Vec<String>   ─── forwarded to lipsync
       └─ token ids: Vec<i64>
            └─ run_inference(tokens, voice_emb, speed)
                 └─ raw_samples: Vec<f32> @ 24 000 Hz
                      └─ resample to 22 050 Hz (rubato)
                           └─ resampled_samples: Vec<f32>
                                ├─ f32_to_pcm16() → pcm_bytes: Vec<u8>  (→ gRPC response)
                                └─ enqueue(resampled_samples)            (→ cpal playback)
```

---

### `audio-engine/src/lipsync.rs` — viseme extraction

**Key types:**

```rust
pub struct PhonemeEvent {
    pub phoneme: String,    // IPA symbol
    pub start_ms: u32,
    pub duration_ms: u32,
}
```

The output type is the proto-generated `audio_proto::Viseme`:

```rust
// (generated, from proto/audio.proto)
pub struct Viseme {
    pub shape: String,       // "A", "E", "I", "O", "U", "F", "TH", "MBP", "rest"
    pub start_ms: u32,
    pub duration_ms: u32,
    pub weight: f32,
}
```

**Key functions:**

| Function | Signature | Purpose |
|---|---|---|
| `phonemes_to_events` | `(phonemes: &[String], total_ms: u32) -> Vec<PhonemeEvent>` | Assign timing to phonemes |
| `extract_visemes` | `(events: &[PhonemeEvent]) -> Vec<Viseme>` | Map phonemes → viseme shapes |
| `merge_consecutive` | `(visemes: Vec<Viseme>, gap_ms: u32) -> Vec<Viseme>` | Collapse same-shape neighbours |
| `phoneme_to_shape` | `(phoneme: &str) -> &'static str` | Static IPA → shape lookup |

**Data flow:**

```
phonemes: Vec<String>  +  total audio duration (ms)
  └─ phonemes_to_events()
       └─ events: Vec<PhonemeEvent>
            └─ extract_visemes()
                 └─ raw_visemes: Vec<Viseme>
                      └─ merge_consecutive(gap_ms=20)
                           └─ visemes: Vec<Viseme>  (→ SynthesizeResponse)
```

---

### `audio-engine/src/audio_playback.rs` — cpal output

**Key types:**

```rust
pub struct PlaybackEngine {
    _stream: cpal::Stream,                   // must stay alive
    buffer: Arc<Mutex<VecDeque<f32>>>,       // shared with stream callback
    sample_rate: u32,                        // configured output rate
}
```

**Key functions:**

| Function | Signature | Purpose |
|---|---|---|
| `new` | `() -> Result<Self>` | Init cpal host, device, stream |
| `enqueue` | `(&self, samples: &[f32])` | Push samples into ring buffer |
| `is_empty` | `(&self) -> bool` | Check if playback queue is drained |
| `drain` | `(&self)` | Block until buffer is empty (for tests) |

**Data flow:**

```
resampled_samples: Vec<f32>
  └─ enqueue()
       └─ VecDeque<f32> (ring buffer, Mutex-protected)
            └─ cpal data callback (runs on audio thread, ~every 10 ms)
                 └─ fill output_buffer from VecDeque
                      └─ zeros if VecDeque is empty (silence padding)
```

---

## Kokoro Integration

### Model loading via `ort`

```rust
use ort::{Environment, Session, SessionBuilder, Value};

fn load_session(model_path: &str) -> Result<Session, ort::Error> {
    let environment = Environment::builder()
        .with_name("albedo-tts")
        .with_log_level(ort::LoggingLevel::Warning)
        .build()?
        .into_arc();

    SessionBuilder::new(&environment)?
        .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
        .with_intra_threads(2)?
        .commit_from_file(model_path)
}
```

The `ort` v2 API wraps the C API of ONNX Runtime. `load-dynamic` feature flag is required so that the `.so`/`.dll` is loaded at runtime rather than linked at compile time — this simplifies distribution.

### Inference pipeline

The Kokoro v0.19 ONNX graph expects three inputs:

| Input name | Shape | Type | Description |
|---|---|---|---|
| `tokens` | `[1, seq_len]` | `i64` | Phoneme token IDs |
| `style` | `[1, 256]` | `f32` | Voice style embedding |
| `speed` | `[1]` | `f32` | Speed multiplier |

And produces one output:

| Output name | Shape | Type | Description |
|---|---|---|---|
| `audio` | `[1, num_samples]` | `f32` | Raw waveform at 24 000 Hz |

```rust
async fn run_inference(
    session: &Session,
    tokens: &[i64],
    style: &[f32],
    speed: f32,
) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let seq_len = tokens.len();

    let tokens_tensor = Value::from_array(([1, seq_len], tokens.to_owned()))?;
    let style_tensor  = Value::from_array(([1, 256usize], style.to_owned()))?;
    let speed_tensor  = Value::from_array(([1usize], vec![speed]))?;

    let outputs = session.run(ort::inputs![
        "tokens" => tokens_tensor,
        "style"  => style_tensor,
        "speed"  => speed_tensor,
    ]?)?;

    let audio_view = outputs["audio"].try_extract_tensor::<f32>()?;
    Ok(audio_view.as_slice().unwrap().to_owned())
}
```

### Audio format

| Property | Value |
|---|---|
| Internal (ONNX output) | 24 000 Hz, f32, mono |
| Pipeline standard | 22 050 Hz, f32, mono |
| gRPC wire format | 22 050 Hz, i16 LE, mono |
| cpal output | device-native (22 050 or 44 100 Hz) |

Resampling from 24 000 → 22 050 Hz uses `rubato::FftFixedInOut`:

```rust
use rubato::{FftFixedInOut, Resampler};

fn resample_24k_to_22k(samples: Vec<f32>) -> Result<Vec<f32>, rubato::ResampleError> {
    let mut resampler = FftFixedInOut::<f32>::new(
        24_000,   // in_rate
        22_050,   // out_rate
        samples.len().min(2048),
        1,        // channels
    )?;
    let waves_in = vec![samples];
    let waves_out = resampler.process(&waves_in, None)?;
    Ok(waves_out.into_iter().next().unwrap())
}
```

### Voice selection

The `voices.bin` file contains a binary table of 54 pre-computed style embeddings. Each entry is a 256-dimensional f32 vector. The `voice_id` field in `SynthesizeRequest` is a string key such as `"af_bella"`, `"am_adam"`, `"bf_emma"`.

The `KokoroEngine` constructor loads all embeddings into a `HashMap<String, Vec<f32>>`. The `synthesize` method looks up the requested `voice_id`; if not found, it falls back to `"af_bella"` (the default female voice) and logs a warning.

Supported voices in Kokoro v0.19:

- American English female: `af`, `af_bella`, `af_sarah`, `af_nicole`, `af_sky`
- American English male: `am_adam`, `am_michael`
- British English female: `bf_emma`, `bf_isabella`
- British English male: `bm_george`, `bm_lewis`

---

## Viseme Extraction

### Strategy

Kokoro does not expose attention maps or duration predictor outputs in its public ONNX graph. The viseme timing strategy for Phase 2 therefore uses a **linear distribution model** as a reliable baseline, which can be upgraded in a later phase if the graph is extended.

**Linear distribution model:**

1. After tokenization, collect the ordered list of phonemes (including silence markers `_` for pauses).
2. Measure the total audio duration in milliseconds: `total_ms = (num_samples as f32 / 22_050.0 * 1000.0) as u32`.
3. Count the number of non-silence phonemes (`n_phonemes`).
4. Assign equal duration to each: `base_duration_ms = total_ms / n_phonemes`.
5. Silence tokens (at word boundaries) receive a fixed 60 ms.
6. `start_ms` of each event is the cumulative sum of previous durations.

This model is accurate to within ±30 ms per phoneme for normal speech rates, which is sufficient for Live2D lip sync perception.

### Viseme protobuf message

The canonical `Viseme` message from `proto/audio.proto`:

```protobuf
message Viseme {
  string shape = 1;        // "A", "E", "I", "O", "U", "F", "TH", "MBP", "rest"
  uint32 start_ms = 2;
  uint32 duration_ms = 3;
  float weight = 4;        // 0.0–1.0, drives blend shape intensity
}
```

The `weight` field maps as follows:

- Open vowels (`A`, `O`): `1.0`
- Mid/close vowels (`E`, `I`, `U`): `0.85`
- Labial consonants (`MBP`, `F`): `0.6`
- Dental/alveolar (`TH`): `0.5`
- `rest` / silence: `0.0`

### Timing data

The `start_ms` and `duration_ms` fields are absolute millisecond offsets from the beginning of the audio clip returned in the same `SynthesizeResponse`. The TypeScript orchestrator receives both the PCM bytes and the viseme array in one response and drives the Live2D avatar in real time by scheduling viseme transitions against `performance.now()` or `AudioContext.currentTime`.

---

## Audio Playback

### cpal output stream

The stream is initialized once at engine startup and runs continuously. It does not restart per-utterance. This avoids the ~50 ms latency spike of re-opening an audio device.

```rust
fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<VecDeque<f32>>>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    device.build_output_stream(
        config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            let mut buf = buffer.lock().unwrap();
            for sample in data.iter_mut() {
                *sample = buf.pop_front().unwrap_or(0.0);
            }
        },
        |err| eprintln!("[playback] stream error: {}", err),
        None,
    )
}
```

### Buffering strategy

The ring buffer (`VecDeque<f32>`) holds pre-computed samples. Because Phase 2 synthesizes a complete sentence before playback begins (no streaming decode), the buffer is filled in one shot before any audio is consumed by the cpal callback. This eliminates buffer underruns during normal operation.

Sizing guidelines:

- Minimum buffer capacity: 1 second of audio = 22 050 samples.
- Typical sentence audio: 2–5 seconds = 44 100–110 250 samples.
- `VecDeque` grows dynamically; no fixed capacity is needed.

If the same `PlaybackEngine` is enqueued while already playing (e.g., the orchestrator sends two sentences in rapid succession), samples are simply appended to the tail of the deque. The stream callback consumes them in FIFO order, producing seamless back-to-back speech.

### Synchronization with viseme timing

The `SynthesizeResponse` is returned to the gRPC caller the moment PCM bytes are ready — before `enqueue` drains. The caller (TypeScript orchestrator) receives both `pcm_data` and `visemes` atomically. It must then:

1. Note the wall-clock time `t0 = performance.now()` when `play()` is invoked.
2. Schedule each viseme at `t0 + viseme.start_ms`.

On the Rust side, `playback.enqueue()` is called synchronously inside the `synthesize` handler before the gRPC `Response` is returned. This means the audio starts playing within one cpal callback period (~10 ms) of the response being dispatched to the client. The client-side `t0` assignment must happen as close to the `play()` call as possible to keep visemes in sync.

In Phase 4 (Avatar), a more precise synchronization mechanism using `AudioContext.currentTime` will be introduced. For Phase 2, the linear timing model and wall-clock scheduling are sufficient to demonstrate correct lip movement.

---

## gRPC Synthesize Endpoint

### RPC definition (from `proto/audio.proto`)

```protobuf
rpc Synthesize(SynthesizeRequest) returns (SynthesizeResponse);

message SynthesizeRequest {
  string text     = 1;
  string voice_id = 2;
  float  speed    = 3;
}

message SynthesizeResponse {
  bytes          pcm_data = 1;    // i16 LE, 22 050 Hz, mono
  repeated Viseme visemes = 2;
}
```

### Request/response flow

```
Client (Bun AudioClient)
  │
  ├─ SynthesizeRequest { text, voice_id, speed }
  │
  ▼
audio-engine (Rust gRPC server)
  │
  ├─ synthesize() handler in main.rs
  │    ├─ kokoro.synthesize_internal(text, voice_id, speed)
  │    │    ├─ tokenize(text) → (token_ids, phonemes)
  │    │    ├─ lookup voice embedding from voices.bin
  │    │    ├─ run_inference(tokens, style, speed) → Vec<f32> @ 24 kHz
  │    │    ├─ resample 24 kHz → 22 050 Hz (rubato)
  │    │    └─ return (Vec<f32>, Vec<PhonemeEvent>)
  │    │
  │    ├─ lipsync::extract_visemes(phoneme_events) → Vec<Viseme>
  │    ├─ tts::f32_to_pcm16(samples) → Vec<u8>
  │    ├─ playback.enqueue(samples)     ← audio starts playing NOW
  │    └─ return SynthesizeResponse { pcm_data, visemes }
  │
  ▼
Client receives SynthesizeResponse
  ├─ pcm_data → may be stored or discarded (audio is already playing)
  └─ visemes  → scheduled against AudioContext for lip sync
```

### Handler implementation (in `main.rs`)

```rust
async fn synthesize(
    &self,
    request: Request<SynthesizeRequest>,
) -> Result<Response<SynthesizeResponse>, Status> {
    let req = request.into_inner();

    let voice_id = if req.voice_id.is_empty() {
        "af_bella".to_string()
    } else {
        req.voice_id.clone()
    };

    let speed = if req.speed <= 0.0 { 1.0 } else { req.speed };

    let (pcm_data, visemes) = self
        .kokoro
        .synthesize(&req.text, &voice_id, speed)
        .await
        .map_err(|e| {
            eprintln!("[tts] synthesize error: {}", e);
            Status::internal(e.to_string())
        })?;

    // Enqueue for immediate playback (non-blocking)
    let samples = tts::pcm16_to_f32(&pcm_data);
    self.playback.enqueue(&samples);

    Ok(Response::new(SynthesizeResponse { pcm_data, visemes }))
}
```

### Default field handling

| Field | Default behavior |
|---|---|
| `voice_id` empty | Fall back to `"af_bella"` |
| `speed` = 0.0 | Treated as `1.0` |
| `speed` out of range | Clamped to `[0.5, 2.0]` |
| `text` empty | Return empty `SynthesizeResponse` (no error) |

---

## Testing Strategy

### Test 1 — Text-to-WAV file test

**File:** `audio-engine/tests/tts_to_wav.rs`

```rust
#[tokio::test]
async fn test_synthesize_to_wav() {
    let engine = KokoroEngine::new(
        "assets/voices/kokoro-v0_19.onnx",
        "assets/voices/voices.bin",
    ).expect("failed to load Kokoro model");

    let (pcm_bytes, visemes) = engine
        .synthesize("Hello, I am Albedo.", "af_bella", 1.0)
        .await
        .expect("synthesis failed");

    // Write to WAV for manual inspection
    let mut writer = hound::WavWriter::create(
        "/tmp/test_output.wav",
        hound::WavSpec {
            channels: 1,
            sample_rate: 22_050,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    ).unwrap();
    for chunk in pcm_bytes.chunks(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
        writer.write_sample(sample).unwrap();
    }
    writer.finalize().unwrap();

    // Assertions
    assert!(!pcm_bytes.is_empty(), "PCM data should not be empty");
    assert!(!visemes.is_empty(), "Should have at least one viseme");
    assert!(pcm_bytes.len() > 22_050 * 2, "Should be at least 1 second of audio");

    println!("Output written to /tmp/test_output.wav");
    println!("Visemes: {:?}", visemes);
}
```

Run with: `cargo test --manifest-path audio-engine/Cargo.toml tts_to_wav -- --nocapture`

Manually listen to `/tmp/test_output.wav` to verify intelligibility.

### Test 2 — Playback integration test

**File:** `audio-engine/tests/tts_playback.rs`

```rust
#[tokio::test]
async fn test_synthesize_and_play() {
    let engine = KokoroEngine::new(
        "assets/voices/kokoro-v0_19.onnx",
        "assets/voices/voices.bin",
    ).unwrap();
    let playback = PlaybackEngine::new().unwrap();

    let (pcm_bytes, _) = engine
        .synthesize("Testing audio playback.", "af_bella", 1.0)
        .await
        .unwrap();

    let samples = tts::pcm16_to_f32(&pcm_bytes);
    let duration_ms = (samples.len() as f32 / 22_050.0 * 1000.0) as u64;

    playback.enqueue(&samples);

    // Wait for playback to complete
    tokio::time::sleep(Duration::from_millis(duration_ms + 500)).await;

    assert!(playback.is_empty(), "Buffer should be drained after playback");
}
```

This test requires a connected audio output device. It is excluded from CI (`#[cfg(not(ci))]`) and run manually.

### Test 3 — Viseme timing validation

**File:** `audio-engine/tests/viseme_timing.rs`

```rust
#[test]
fn test_viseme_coverage() {
    let phonemes = vec![
        "h".to_string(), "ɛ".to_string(), "l".to_string(),
        "oʊ".to_string(), "_".to_string(), "w".to_string(),
        "ɜ".to_string(), "l".to_string(), "d".to_string(),
    ];
    let total_ms = 1200u32;
    let events = phonemes_to_events(&phonemes, total_ms);
    let visemes = extract_visemes(&events);

    // Visemes must span the full audio duration
    let last = visemes.last().unwrap();
    assert_eq!(last.start_ms + last.duration_ms, total_ms,
        "Visemes must cover full audio duration");

    // No overlap
    for pair in visemes.windows(2) {
        let a = &pair[0];
        let b = &pair[1];
        assert_eq!(a.start_ms + a.duration_ms, b.start_ms,
            "Visemes must not overlap");
    }

    // All weights in range
    for v in &visemes {
        assert!(v.weight >= 0.0 && v.weight <= 1.0,
            "Weight must be in [0, 1]");
    }
}

#[test]
fn test_phoneme_to_shape_completeness() {
    // Ensure no phoneme returns an empty shape
    let test_phonemes = ["æ", "e", "i", "ɔ", "u", "f", "v", "θ", "m", "h", "_"];
    for p in test_phonemes {
        let shape = phoneme_to_shape(p);
        assert!(!shape.is_empty(), "phoneme '{}' mapped to empty shape", p);
    }
}
```

### Test 4 — gRPC end-to-end test

**File:** `audio-engine/tests/grpc_synthesize.rs`

```rust
#[tokio::test]
async fn test_grpc_synthesize_roundtrip() {
    // Start server in background
    let server = tokio::spawn(async {
        start_test_server("127.0.0.1:50099").await
    });

    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut client = AudioEngineClient::connect("http://127.0.0.1:50099")
        .await
        .unwrap();

    let response = client.synthesize(SynthesizeRequest {
        text: "Phase two test.".to_string(),
        voice_id: "af_bella".to_string(),
        speed: 1.0,
    }).await.unwrap().into_inner();

    assert!(!response.pcm_data.is_empty());
    assert!(!response.visemes.is_empty());

    // PCM must be even-length (16-bit samples)
    assert_eq!(response.pcm_data.len() % 2, 0);

    server.abort();
}
```

### Test 5 — Latency measurement

**File:** `audio-engine/tests/tts_latency.rs`

```rust
#[tokio::test]
async fn test_synthesis_latency_under_150ms() {
    let engine = KokoroEngine::new(
        "assets/voices/kokoro-v0_19.onnx",
        "assets/voices/voices.bin",
    ).unwrap();

    // Warm up (first inference may JIT-compile ONNX graph)
    let _ = engine.synthesize("warmup", "af_bella", 1.0).await.unwrap();

    let start = std::time::Instant::now();
    let _ = engine.synthesize(
        "The weather today is quite pleasant.",
        "af_bella",
        1.0,
    ).await.unwrap();
    let elapsed = start.elapsed();

    println!("TTS latency: {:?}", elapsed);
    assert!(elapsed.as_millis() < 150,
        "TTS latency {} ms exceeds 150 ms target", elapsed.as_millis());
}
```

---

## Validation Criteria

The phase is considered complete when all of the following are true:

1. **Compilation:** `cargo build --release` in `audio-engine/` succeeds with no errors.

2. **WAV output:** Running the text-to-WAV test produces a `/tmp/test_output.wav` file that plays back intelligible English speech at 22 050 Hz.

3. **Viseme structure:** The gRPC `SynthesizeResponse` contains a non-empty `visemes` array where viseme intervals are contiguous (no gaps, no overlaps) and cover the full audio duration.

4. **Playback:** Running the playback test produces audible speech through the system speaker without clicking, crackling, or silence.

5. **gRPC roundtrip:** A client can send `SynthesizeRequest { text: "Hello from Albedo.", voice_id: "af_bella", speed: 1.0 }` and receive a `SynthesizeResponse` with valid `pcm_data` and `visemes` within 200 ms (network overhead included).

6. **Latency:** The synthesis latency benchmark passes (inference-only time < 150 ms for a sentence of 8–12 words on a mid-range CPU).

7. **Voice selection:** Requesting `voice_id: "am_adam"` produces a noticeably different voice timbre than `"af_bella"`.

8. **Error handling:** Sending `text: ""` returns an empty `SynthesizeResponse` with no gRPC error. Sending an unknown `voice_id` logs a warning and falls back to the default voice.

---

## Performance Targets

| Metric | Target | Measurement method |
|---|---|---|
| TTS inference latency (sentence, ~8 words) | < 150 ms | `test_synthesis_latency_under_150ms` |
| Audio output latency (enqueue → first sample) | < 15 ms | cpal callback period |
| Memory footprint (ONNX session + voices) | < 600 MB RSS | `valgrind massif` or `/proc/self/status` |
| Resampling time (24 k → 22 050 Hz, 3 s clip) | < 5 ms | `std::time::Instant` |
| Viseme extraction time | < 2 ms | `std::time::Instant` |
| PCM serialization (f32 → i16 bytes) | < 1 ms | `std::time::Instant` |

The 150 ms TTS latency target feeds into the full pipeline latency budget from `albedo-ai.md §8`:

```
TTS sentence latency (target):  150 ms
Audio play latency:              10 ms
──────────────────────────────────────
Phase 2 contribution to budget: 160 ms
```

This leaves the overall first-audio latency at approximately 780 ms end-to-end as specified.

**CPU optimization notes:**

- ONNX Runtime's `Level3` graph optimization is mandatory. It enables operator fusion and constant folding, which reduces inference time by ~30–40% on CPU compared to `Level1`.
- Set `intra_op_num_threads` to 2 in the session builder. Using all available cores causes contention with the cpal audio thread and the gRPC I/O threads.
- Pre-warm the session on startup by running a single dummy inference (1 token) before the server starts accepting requests. This forces ONNX to JIT-compile the graph, so the first real request is not penalized.

---

## Risks and Notes

### Risk 1 — ONNX Runtime shared library availability

**Risk:** `ort` v2 with `load-dynamic` requires `libonnxruntime.so.1.x.x` (Linux), `onnxruntime.dylib` (macOS), or `onnxruntime.dll` (Windows) to be present in the dynamic linker path at runtime. This is not a Cargo dependency — it must be installed separately.

**Mitigation:**
- Download the pre-built ONNX Runtime binary from [github.com/microsoft/onnxruntime/releases](https://github.com/microsoft/onnxruntime/releases) and place it in `assets/lib/` or a system path.
- Add a startup check in `main.rs` that attempts `ort::init()` before binding the gRPC port, and exits with a clear error message if the library is not found.
- Alternatively, use `ort = { version = "2.0", features = ["copy-dylibs"] }` which copies the library into the build output directory at compile time — simpler for development, but increases binary distribution size.

**Affected files:** `audio-engine/Cargo.toml`, `audio-engine/src/main.rs`

---

### Risk 2 — Kokoro ONNX input/output signature mismatch

**Risk:** The Kokoro ONNX model release version may differ from the assumed graph signature (input names `tokens`, `style`, `speed`; output name `audio`). Different release versions use different tensor names and shapes.

**Mitigation:**
- Pin a specific Kokoro ONNX release version (e.g., `kokoro-v0_19.onnx` from the `v0.2.8` release of `kokoro-onnx`).
- At startup, call `session.inputs()` and `session.outputs()` to log the actual tensor names and assert they match expectations. Fail fast with a descriptive error.
- Document the pinned model checksum in `assets/voices/README.txt` or `Cargo.lock`-equivalent manifest.

**Affected files:** `audio-engine/src/tts.rs`, `assets/voices/config.json`

---

### Risk 3 — Phonemization quality

**Risk:** The text → phoneme step is the primary source of TTS quality issues. English has many irregular pronunciations (proper nouns, abbreviations, numbers). Poor phonemization leads to robotic or incorrect speech, which directly degrades user experience.

**Mitigation:**
- Use `espeak-ng` as the phonemization backend via the `espeak-phonemizer` Rust crate. `espeak-ng` handles English irregularities, number expansion, and abbreviations.
- As a fallback (if `espeak-ng` is not installed), bundle a static pronunciation dictionary for the 10 000 most common English words (CMU Pronouncing Dictionary subset, ~200 KB).
- Add a pre-processing step that expands common patterns before phonemization: numbers → words, `$` → "dollars", `%` → "percent", URLs → "link", etc.

**Affected files:** `audio-engine/src/tts.rs`, `audio-engine/Cargo.toml`

---

### Risk 4 — cpal device configuration variability

**Risk:** `cpal` discovers the system's default output device, but the supported sample rates and formats vary by OS and driver. The assumed configuration (22 050 Hz, f32, mono) may not be supported on all hardware. Attempting to build a stream with an unsupported configuration will panic or return an error at startup.

**Mitigation:**
- Query `device.supported_output_configs()` and select the best available config using a preference order: `(f32, 22050, mono)` → `(f32, 44100, mono)` → `(f32, 44100, stereo)`.
- If the selected rate differs from 22 050 Hz, run a second `rubato` resample stage in `audio_playback.rs` before enqueuing to the ring buffer.
- If no suitable device is found (headless environment, CI), log a warning and use a no-op `NullPlaybackEngine` that discards samples silently.

**Affected files:** `audio-engine/src/audio_playback.rs`

---

### Risk 5 — Audio format conversion between f32 and i16

**Risk:** Naive f32 → i16 conversion that does not clamp correctly will produce hard clipping or integer overflow on samples slightly outside `[-1.0, 1.0]`, causing audible distortion.

**Mitigation:**
- Always clamp before casting: `(sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16`.
- Apply a soft limiter (tanh saturation) to the waveform before conversion if peak amplitude consistently exceeds 0.95 after ONNX output.

**Affected files:** `audio-engine/src/tts.rs`

---

### Risk 6 — Thread safety of `ort::Session`

**Risk:** `ort::Session` may not be `Send + Sync`. If the gRPC handler is called concurrently (multiple synthesize requests in flight), shared access to the session could cause a data race or block.

**Mitigation:**
- `ort` v2 wraps the session in an `Arc` internally and the C API is thread-safe for read-only inference. Confirm this with the upstream docs and add `unsafe impl Send for KokoroEngine {}` only if the ort docs explicitly guarantee it.
- Alternatively, wrap the session in `tokio::sync::Mutex<Session>` and hold the lock only during `session.run()`. Since TTS inference is typically <150 ms, contention under normal usage (sequential TTS calls from the orchestrator) is negligible.

**Affected files:** `audio-engine/src/tts.rs`
