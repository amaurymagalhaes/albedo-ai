# Tech Lead Review: Albedo AI Implementation Plans

**Reviewer:** Senior Tech Lead (AI-assisted)
**Date:** 2026-04-13
**Documents reviewed:** `albedo-ai.md` (architecture spec) + Phases 0–6 implementation plans
**Verdict:** Plans are solid — above-average quality for a personal project. Several cross-cutting issues require resolution before work begins.

---

## 1. Executive Summary

These plans are well above the threshold for "start building." The architecture spec is coherent, the language-responsibility matrix is sensible, and the phase decomposition follows a logical dependency order. The per-phase documents are unusually detailed — they include real code skeletons, module interfaces, data-flow diagrams, and testability sections that most plans skip.

**What is genuinely good:**
- The protobuf definitions are stable and internally consistent across all phases.
- The latency budget is realistic (780ms to first audio) and the sentence-streaming approach for TTS is the right call.
- The VAD state machine (Section 5 of Phase 1) is thoughtfully specified — the SPEECH_ONSET / SILENCE_END counters are production-grade.
- Phase 6 elevates the entire project: the `ProcessManager` design, socket-readiness polling, restart logic, and graceful shutdown sequence are all production quality.
- Error handling in Phase 6 is thorough across all failure modes (process crash, gRPC disconnect, API failures, bad config).

**What needs work before starting:**
- The `StreamSTT` RPC contract is broken between Phases 1 and 3 (see Section 3).
- The `ort` crate version inconsistency between Phase 1 and Phase 2 is a build blocker.
- The Phase 0 `build.rs` `out_dir` instruction conflicts with idiomatic `tonic::include_proto!` usage.
- The Kokoro phonemization dependency (`espeak-phonemizer`) is underspecified and risky.
- Phase 3 quietly adds new RPCs to `audio.proto` without updating Phase 0/1.

**Confidence level:** 75% that a developer of intermediate Rust/Go/TypeScript experience can execute these plans as written without major architectural pivots. The remaining 25% is concentrated in the Kokoro/phonemizer integration (Phase 2), the Live2D asset procurement (Phase 4), and the `StreamSTT` redesign.

---

## 2. Cross-Phase Consistency Audit

### 2.1 Protobuf Definitions

The proto definitions in the architecture spec (`albedo-ai.md`) and Phase 0 are identical — this is correct. Both files match on all field numbers, types, and service methods. However, there are two latent problems:

**Cargo.toml `out_dir` conflict:** Phase 0's `build.rs` specifies `.out_dir("src/generated")`, which places generated files in the crate source tree. Phase 1's `build.rs` removes this and uses the standard `OUT_DIR` environment variable with the idiomatic `tonic::include_proto!` macro. Phase 0 acknowledges this inconsistency in a note but does not resolve it definitively. The generated code directory must be decided once and stuck with; mismatches will cause `cargo check` to fail when Phase 1 overwrites `build.rs`.

**Recommendation:** Adopt the Phase 1 approach (no `.out_dir` override) as the canonical form from Phase 0 onward. Delete the Phase 0 alternative.

**`go_package` option:** Phase 0's proto files include `option go_package = "albedo-ai/daemon/proto;proto"` on `audio.proto`. This generates Go bindings for the audio service inside the daemon's proto package — which is correct for the current architecture but creates a minor oddity (the Go daemon gets generated client code for the audio service it does not use). Not a bug, but worth noting.

### 2.2 `StreamSTT` Contract Mismatch — Critical

This is the most significant interface inconsistency across all phases.

**Phase 1** (Section 6.3) explicitly chooses "Option A (Proto-literal)" for `StreamSTT`: the Bun client streams `AudioChunk` messages, and the Rust server processes them. Phase 1 states the orchestrator "will stream audio chunks it receives from `StartCapture`'s side channel." This implies the Bun process must somehow relay raw PCM over gRPC, which it cannot do efficiently.

**Phase 3** then contradicts this. The `AudioClient.onTranscription()` implementation calls `this.client.watchTranscriptions({})` — a **new, unspecified RPC** (`WatchTranscriptions`) that does not exist in either the architecture spec or Phase 0's `audio.proto`. Phase 3 also proposes adding `PlayAudio(stream AudioChunk) returns (PlayStatus)` to handle PCM relay.

**Phase 6** follows Phase 3's model, with `AudioClient.onTranscription()` using the `WatchTranscriptions` subscription pattern. The `play(pcmData)` method also implies `PlayAudio` exists.

**Net result:** Two new RPCs are required but never formally added to `proto/audio.proto`: `WatchTranscriptions(Empty) returns (stream TranscriptionResult)` and `PlayAudio(stream AudioChunk) returns (PlayStatus)`. Without them, the TypeScript gRPC stub generation will not produce the methods the orchestrator calls.

**`PlayAudio` is also conceptually wrong.** The Rust engine already plays audio internally via `PlaybackEngine.enqueue()` after `Synthesize()`. Having the Bun process relay PCM bytes back over gRPC to be played by Rust doubles the data transfer. Phase 2 correctly handles playback server-side; the `play()` method in the TypeScript client should be removed or replaced with a no-op if playback is confirmed to be internal.

### 2.3 Dependency Version Inconsistencies

| Dependency | Phase 0 / Arch Spec | Phase 1 | Phase 2 | Phase 5 |
|---|---|---|---|---|
| `ort` | `"2.0"` with no feature | `"2.0", features = ["download-binaries"]` | `"2.0", features = ["load-dynamic"]` | N/A |
| `google.golang.org/grpc` | N/A | `"v1.65.0"` (Phase 0) | N/A | `"v1.64.0"` |
| `google.golang.org/protobuf` | N/A | `"v1.34.2"` (Phase 0) | N/A | `"v1.34.1"` |
| `github.com/go-vgo/robotgo` | N/A | `"v0.110.5"` (Phase 0) | N/A | `"v0.110.3"` |
| `github.com/shirou/gopsutil/v3` | N/A | `"v3.24.5"` (Phase 0) | N/A | `"v3.24.4"` |

**`ort` feature flag conflict is a build blocker.** `download-binaries` and `load-dynamic` are mutually exclusive approaches. `download-binaries` fetches and statically links the ORT shared library at compile time. `load-dynamic` defers to a system-installed ORT. Choosing the wrong one for the deployment target will cause a runtime crash. One must be chosen and applied consistently across Phase 1 (VAD) and Phase 2 (TTS) since both use the same `ort` crate in the same Cargo workspace.

**Go module version drift** across Phase 0 and Phase 5 is minor but will cause `go mod tidy` surprises. Standardize on the Phase 0 versions (they are newer).

### 2.4 File Path References

All file paths referenced across phases are internally consistent with the Phase 0 directory structure. No path mismatches found. Notable cross-phase path assumptions that must hold:

- Phase 2 expects `assets/voices/kokoro-v0_19.onnx` and `assets/voices/voices.bin`. Phase 6's prerequisites list `assets/voices/default.onnx`. These are **different filenames**. Phase 6 must be updated to match Phase 2's file names.
- Phase 1 expects `assets/vad/silero_vad.onnx`, which is a directory (`assets/vad/`) not present in Phase 0's `mkdir -p` commands. Phase 0 creates `assets/voices/`, `assets/whisper/`, and `assets/models/`, but not `assets/vad/`. This will cause Phase 1's model-loading code to fail at startup.

### 2.5 `@grpc/grpc-js` Version Discrepancy

Phase 0's `package.json` specifies `@grpc/grpc-js: ^1.11.1`. Phase 3's Task 1 instructs updating to `^1.10.0`. These are compatible (1.10.0 < 1.11.1), but the instruction is confusing — Phase 3 "downgrades" a version already established in Phase 0. Phase 3 should simply confirm the dependency is present, not replace it.

### 2.6 `Cargo.toml` Edition Discrepancy

Architecture spec specifies `edition = "2024"`. Phase 0's generated `Cargo.toml` correctly uses `edition = "2021"` (noting that Rust 2024 edition was stabilized in Rust 1.85). This needs explicit coordination: if edition 2024 is desired, the minimum Rust version stated in Phase 0's prerequisites (1.78.0) is too low — it must be ≥1.85.0.

---

## 3. Architecture Gaps

### 3.1 The "How Does `StreamSTT` Actually Work?" Gap

Reiterating from Section 2.2 because it is architectural, not just an API mismatch. After `StartCapture` is called on the Rust side, the Rust process owns the microphone and runs VAD+Whisper internally. The Bun orchestrator has no stream of audio chunks to send to `StreamSTT` — it just wants transcription results.

The gap: there is no agreed mechanism for the Rust process to push completed transcriptions to the Bun orchestrator. Phase 1 says "the orchestrator will coordinate StartCapture and StreamSTT" without specifying how. Phase 3 invents `WatchTranscriptions` as the solution but never updates `audio.proto` or `build.rs`.

**Required resolution before Phase 1:** Add `rpc WatchTranscriptions(Empty) returns (stream TranscriptionResult)` to `proto/audio.proto`. Implement it in Phase 1 alongside `StreamSTT`. The TypeScript client uses `WatchTranscriptions` for its subscription; `StreamSTT` remains available for testing with pre-recorded audio.

### 3.2 AudioChunk `timestamp_ms` Field Missing

The `AudioChunk` protobuf message (in both the spec and Phase 0) defines only three fields: `pcm_data`, `sample_rate`, and `is_speech`. However, Phase 1's `stream_stt` implementation reads `chunk.timestamp_ms`:

```rust
timestamp_ms: chunk.timestamp_ms,
```

This field does not exist in `AudioChunk`. The `TranscriptionResult` has `timestamp_ms` (correct), but `AudioChunk` does not. The Rust code will fail to compile as written.

**Fix:** Either add `uint64 timestamp_ms = 4` to `AudioChunk` in `audio.proto`, or derive the timestamp from `std::time::SystemTime::now()` in the Rust server rather than from the incoming chunk.

### 3.3 Double-Decode Bug in Phase 2's `synthesize` Handler

Phase 2's `synthesize` gRPC handler (Section 8) calls:
```rust
let samples = tts::pcm16_to_f32(&pcm_data);
self.playback.enqueue(&samples);
```

This converts i16 PCM bytes back to f32 for playback, but `f32_to_pcm16` was already applied. Meanwhile `KokoroEngine.synthesize_internal()` returns `Vec<f32>` natively. The handler should pass the original f32 samples to `playback.enqueue()` directly, not round-trip through i16. A `pcm16_to_f32` function must also be defined (it is referenced but never specified).

**Fix in `main.rs` synthesize handler:**
```rust
let (f32_samples, phoneme_events) = self.kokoro.synthesize_internal(...).await?;
let visemes = lipsync::extract_visemes(&phoneme_events);
let pcm_data = tts::f32_to_pcm16(&f32_samples);
self.playback.enqueue(&f32_samples); // not &pcm16_to_f32(&pcm_data)
```

### 3.4 No `PlayStatus` Message Definition

Phase 3 proposes `rpc PlayAudio(stream AudioChunk) returns (PlayStatus)` but `PlayStatus` is never defined as a protobuf message. Even if this RPC is implemented, it will fail proto compilation.

### 3.5 Collector.Start() Never Called

Phase 5's `Collector` struct has a `Start()` method that launches background goroutines for window/clipboard/metrics polling. Phase 5's `main.go` skeleton calls `awareness.NewCollector()` but never calls `collector.Start()`. Without it, `Snapshot()` will return stale or zero-value data indefinitely.

**Fix in `daemon/cmd/albedo-daemon/main.go`:**
```go
collector := awareness.NewCollector()
collector.Start()
```

### 3.6 Tool Confirmation Flow Has No Proto Support

Phase 6 (Section 5c) describes a confirmation gate for dangerous tools: the orchestrator emits `tool-confirmation-request` to the webview and awaits `tool-confirmation-response`. This is implemented as a webview RPC exchange.

However, the `ToolRequest` protobuf message has a `requires_confirmation` field that is set by the sandbox and interpreted by the orchestrator. The flow described in Phase 6 bypasses the sandbox's decision — the sandbox sets `requires_confirmation = true`, but the orchestrator independently checks `ToolSchema.dangerous`. These are two separate flag sources that can diverge.

**Gap:** The sandbox sets `requires_confirmation` on the incoming `ToolRequest` object in Go, but since gRPC is unary (request-response), this mutated field is not sent back to the caller. The orchestrator only receives the `ToolResponse`. The confirmation decision must be made entirely on the Bun side based on `ToolSchema.dangerous`, which means the Go-side `requires_confirmation` mutation in `sandbox.go` has no effect on the caller.

### 3.7 `assets/vad/` Directory Not Created in Phase 0

As noted in Section 2.4, Phase 0 does not create the `assets/vad/` directory. Phase 1 downloads the Silero model to `assets/vad/silero_vad.onnx`. The download will succeed (wget creates the directory), but the Phase 0 validation criteria ("empty placeholder files exist for every module") will silently omit the VAD model path.

---

## 4. Technical Risk Assessment

Ranked by severity (Critical → Low), with affected phases, likelihood, impact, and mitigation.

### Risk 1 — Kokoro Phonemizer: CRITICAL

**Description:** Phase 2 specifies `espeak-phonemizer = "0.1"` as a Rust crate for grapheme-to-phoneme conversion. This crate depends on `espeak-ng` being installed as a system library. On macOS, `espeak-ng` is not in Homebrew mainline; on Windows it requires manual installation. The crate itself may be unmaintained or non-existent at `0.1` on crates.io.

**Affected phases:** 2 (TTS), and transitively 3, 4, 6.

**Likelihood:** High — the dependency chain is fragile.

**Impact:** Critical — no working TTS means the entire voice pipeline is blocked.

**Mitigation:** Before Phase 2 begins, verify the crate exists on crates.io and test compilation on the target platform. Prepare a fallback: a bundled static phoneme table (CMU dict or similar) that maps English words to ARPAbet/IPA without requiring a system library. The linear timing model in Phase 2's viseme extraction already tolerates imprecise phoneme data, so degraded phonemization is acceptable for MVP.

### Risk 2 — `ort` Build Complexity: HIGH

**Description:** ONNX Runtime's Rust bindings (`ort`) have historically had build issues across versions, platforms, and feature flag combinations. The `download-binaries` vs `load-dynamic` split means different deployment behaviors on dev machines vs production. The VAD model (Phase 1) and TTS model (Phase 2) both use `ort` — a build failure here blocks two phases.

**Affected phases:** 1, 2.

**Likelihood:** Medium-High.

**Impact:** High — both VAD and TTS are non-functional until resolved.

**Mitigation:** Pin `ort` to a single version and feature flag in Phase 0. Test a "hello world" ONNX inference on the target platform before writing any domain code. Document the exact `libonnxruntime.so` path and version required on each supported OS.

### Risk 3 — Live2D Model Procurement: HIGH

**Description:** Phase 4 requires `.moc3` model files, expression JSONs, and a physics file. The plan suggests using free sample models from Live2D's site. However, a usable "Albedo" character that matches the project's persona does not exist as a free asset. Creating or commissioning a custom model is outside the technical scope of these plans. Using a sample model (Haru, Hiyori) means the avatar will not visually match the "Albedo AI" branding.

**Affected phases:** 4.

**Likelihood:** High (getting a suitable model is non-trivial).

**Impact:** High — Phase 4 is blocked without model files.

**Mitigation:** Explicitly scope Phase 4 to work with any compatible sample model. Budget time or money for custom model work as a post-MVP concern. Add a validation step in Phase 0 or Phase 4 prerequisites that confirms model files are physically present before Phase 4 begins.

### Risk 4 — `StreamSTT` Redesign: HIGH

**Description:** As described in Section 3.1, the `StreamSTT` contract is inconsistent between Phase 1 and Phase 3. Resolving this requires a proto change, a new Rust RPC implementation, and updated TypeScript client code.

**Affected phases:** 1, 3, 6.

**Likelihood:** Certain (it is already broken as written).

**Impact:** High — the voice pipeline cannot function without this resolved.

**Mitigation:** Fix before Phase 1 begins. See Section 3.1 for the specific change required.

### Risk 5 — Electrobun Maturity: HIGH

**Description:** Electrobun is at version `0.0.45`. The `0.0.x` version range signals pre-alpha stability. APIs may change between minor versions. The webview RPC mechanism (`electrobun.rpc`), the Zig bindings, and the build pipeline are all relatively unproven at scale. The plans reference `electrobun/bun` imports and `electrobun/config` that may not match the actual published API.

**Affected phases:** 0, 4, 6.

**Likelihood:** Medium.

**Impact:** High — if Electrobun's RPC API differs from the spec, every webview event breaks.

**Mitigation:** In Phase 0, write a minimal Electrobun "hello world" that exercises the RPC channel before building any domain code. Pin the Electrobun version and do not upgrade mid-project.

### Risk 6 — Whisper STT Latency on CPU: MEDIUM

**Description:** The latency budget allocates 300ms for Whisper STT (`ggml-base.bin`). This is realistic on a modern CPU (e.g., Intel i7 or Apple M-series) for short utterances (2–5 seconds). For longer utterances (>10 seconds), whisper.cpp on CPU can take 1–2 seconds, breaking the 780ms total budget. The plan uses `set_n_threads(4)` which is hardcoded, not adaptive.

**Affected phases:** 1, 6.

**Likelihood:** Medium (depends on hardware and utterance length).

**Impact:** Medium — latency degrades, but the pipeline still functions.

**Mitigation:** Use `ggml-base.en.bin` for English-only mode (faster). Add adaptive thread count based on `num_cpus::get() / 2`. Add a maximum utterance length cap (e.g., 30 seconds) that forces a flush at the VAD layer.

### Risk 7 — `pixi-live2d-display` PixiJS v7 Lock-In: MEDIUM

**Description:** Phase 4 explicitly prohibits PixiJS v8 and locks to `pixi-live2d-display@0.4.x` + `pixi.js@7.4.x`. As of early 2026, PixiJS v8 has been stable for over a year and the v7 branch receives only security patches. The plugin ecosystem for v7 is stagnant.

**Affected phases:** 4.

**Likelihood:** Low (the current versions work; the risk is long-term maintenance).

**Impact:** Medium — future feature work on the avatar layer will be constrained.

**Mitigation:** Accept the version lock for MVP. Add a tech-debt note to evaluate `@guansss/pixi-live2d-display` (the actively maintained v8 fork) after MVP ships.

### Risk 8 — Sandbox Security is String-Matching Only: MEDIUM

**Description:** The `sandbox.go` implementation uses `strings.Contains()` to match against a blocklist. This is trivially bypassable: `RM   -RF /`, `r\nm -rf /`, command substitution, aliases, etc. The plan presents this as a security feature.

**Affected phases:** 5, 6.

**Likelihood:** High that the sandbox can be bypassed.

**Impact:** Medium — acceptable for personal use, not for a shared deployment.

**Mitigation:** Document clearly in the security section that the sandbox is a UI-level convenience guardrail for accidental commands, not a security boundary. For personal-use desktop AI, this is acceptable. Add a note that the confirmation gate (Phase 6) is the real last line of defense.

### Risk 9 — `better-sqlite3` Native Module in Bun: MEDIUM

**Description:** `better-sqlite3` is a Node.js native addon that requires compilation against the Bun-compatible headers. Bun has its own built-in SQLite (`bun:sqlite`) that is faster and requires no native compilation. Phase 3 uses `better-sqlite3` instead of `bun:sqlite`, adding a native dependency that may cause build failures under Bun.

**Affected phases:** 3, 6.

**Likelihood:** Medium — Bun's Node.js native addon compatibility is imperfect.

**Impact:** Medium — memory persistence fails if the import fails.

**Mitigation:** Replace `better-sqlite3` with `bun:sqlite` in Phase 3. The API is nearly identical for basic CRUD operations. This is a straightforward change.

### Risk 10 — `VecDeque<f32>` Mutex Lock in cpal Callback: LOW

**Description:** Phase 2's `PlaybackEngine` uses an `Arc<Mutex<VecDeque<f32>>>` shared between the Tokio async context and the cpal audio callback thread. The cpal data callback is real-time audio code — taking a mutex lock in a real-time callback can cause audio glitches if the mutex is contended.

**Affected phases:** 2.

**Likelihood:** Low (under normal load, contention is rare).

**Impact:** Low — occasional audio pops or glitches.

**Mitigation:** Replace `Mutex<VecDeque<f32>>` with a lock-free SPSC ring buffer (e.g., `rtrb` crate). Alternatively, use `std::sync::atomic` flags with a backing buffer of fixed size. This is a real-time audio best practice.

---

## 5. Dependency Chain Analysis

### 5.1 Phase Ordering Assessment

The stated ordering (0 → 1 → 2 → 3 → 4 → 5 → 6) is correct and necessary with one observation: Phase 5 (Go Daemon) has no dependency on Phases 1–4. It only requires Phase 0. The plan acknowledges this implicitly (Phase 3 notes that "a stub gRPC server" is sufficient) but does not formalize it.

### 5.2 Parallelization Opportunities

| Parallel Track A | Parallel Track B | Synchronization Point |
|---|---|---|
| Phase 1 (Rust STT) | Phase 5 (Go Daemon) | Phase 6 (both needed) |
| Phase 2 (Rust TTS) | Phase 4 (React Avatar) | Phase 6 (both needed) |
| Phase 3 (Orchestrator) | Phase 4 (Avatar stub) | Phase 6 |

A two-person team could parallelize as:
- **Track A:** Phase 0 → Phase 1 → Phase 2 → Phase 3
- **Track B:** Phase 0 → Phase 5 → Phase 4

Both tracks converge at Phase 6. This would reduce calendar time by approximately 2 weeks on the architecture's estimated 6–8 weeks total.

### 5.3 Critical Path Items

The following items block the most downstream work:

1. **Proto finalization** (Phase 0) — blocks all gRPC code in Phases 1, 3, 5.
2. **`WatchTranscriptions` RPC addition** (fix before Phase 1) — blocks Phase 3's onTranscription callback.
3. **Kokoro ONNX model availability** (Phase 2 prerequisite) — blocks Phase 2 entirely; no model = no TTS = no voice output.
4. **Live2D model asset procurement** (Phase 4 prerequisite) — blocks Phase 4 entirely.
5. **`ort` build verification** (Phase 1 day 0) — blocks both VAD (Phase 1) and TTS (Phase 2).

---

## 6. Per-Phase Feedback

### Phase 0: Scaffold

**Strengths:**
- Comprehensive directory skeleton with explicit `touch` commands.
- Both proto files are fully specified here, not just referenced.
- The `build.rs` `out_dir` conflict is noted inline (even if not resolved).
- Makefile includes a proper `proto` dependency on directory creation.
- `.gitignore` correctly excludes model files and generated proto code.

**Weaknesses:**
- Does not create `assets/vad/` directory (blocker for Phase 1).
- Cargo `edition = "2024"` in arch spec vs `edition = "2021"` in Phase 0 — never resolved.
- Phase 0's Rust stubs use `pub async fn start(_config: CaptureConfig)` but Phase 1 defines `start_capture(config: CaptureConfig, audio_tx: mpsc::Sender<Vec<f32>>)`. The stub signatures will cause Phase 1 to fail compilation until stubs are replaced entirely.
- `protoc-gen-ts` is invoked inconsistently: Phase 0 Makefile uses `bun x protoc-gen-ts` while Phase 3 uses `npx grpc_tools_node_protoc`. Pick one and document why.

**Recommendations:**
1. Add `mkdir -p assets/vad` to Step 3.
2. Decide on Rust edition once and commit it to a note in Phase 0. If 2024, bump minimum Rust version to 1.85.
3. Remove Phase 0's stub function bodies entirely (replace with `todo!()` or `unimplemented!()`) so they compile but are obviously placeholders. The current stubs have wrong signatures.
4. Standardize on `@protobuf-ts/plugin` for TypeScript codegen and document it as the single canonical approach.

---

### Phase 1: Audio MVP

**Strengths:**
- The VAD state machine (SILENCE/SPEECH/POST_SPEECH with hysteresis) is excellent production-grade design.
- The `cpal` non-`Send` stream threading model is handled correctly (dedicated OS thread with channel bridging).
- `spawn_blocking` for Whisper is the right call.
- Model path validation with actionable error messages (including the download command) is developer-friendly.
- The Silero v5 tensor name table is extremely useful and saves debugging time.

**Weaknesses:**
- `chunk.timestamp_ms` referenced in `stream_stt` but not in `AudioChunk` proto (compilation error).
- Uses `Arc<Mutex<vad::VadEngine>>` — but `VadEngine` maintains LSTM state, making concurrent calls incorrect. The lock prevents data races, but the state machine in `stream_stt` and the VAD state must be co-located. If multiple `StreamSTT` calls are open simultaneously, they would share a single VAD state incorrectly.
- No mention of Whisper hallucination filtering. Whisper often outputs `[BLANK_AUDIO]`, `(music)`, `(inaudible)` or repetitions for short silence segments. These should be filtered before sending `TranscriptionResult`.
- The `VadState` enum is defined locally in `stream_stt` but not re-used in the state machine doc. The POST_SPEECH state described in Section 5 is more sophisticated than the two-state enum in Section 6.3.

**Recommendations:**
1. Add `uint64 timestamp_ms = 4` to `AudioChunk` in `audio.proto` before Phase 1 begins.
2. Add Whisper hallucination filter: skip transcription results matching `/^\s*\[.+\]\s*$/` or that are shorter than 3 characters.
3. Implement the full three-state VAD machine (SILENCE / SPEECH / POST_SPEECH) as described in Section 5 — not the two-state version in Section 6.3. They contradict each other.
4. Add a maximum buffer duration guard (e.g., 30 seconds) to force a flush on long monologues before `speech_buffer` grows unbounded.

---

### Phase 2: TTS

**Strengths:**
- The Kokoro integration is well-researched: ONNX graph input/output names, voice embedding loading, supported voice IDs, and the decision to use linear timing as a fallback for visemes are all sound.
- The 24kHz → 22050Hz resampling is correctly handled with `rubato`.
- Continuous cpal output stream (started once, not per utterance) avoids re-initialization latency.
- The `f32_to_pcm16` conversion function is specified precisely.
- `load-dynamic` feature flag and the rationale are documented.

**Weaknesses:**
- `espeak-phonemizer` dependency is risky (see Risk 1). No fallback is specified.
- `ort` feature flag (`load-dynamic`) conflicts with Phase 1's (`download-binaries`). Must be reconciled.
- `KokoroEngine.synthesize()` public API returns `Result<(Vec<u8>, Vec<Viseme>)>` but `synthesize_internal()` returns `Result<(Vec<f32>, Vec<PhonemeEvent>)>`. The `main.rs` synthesize handler then calls a `pcm16_to_f32` that is never defined.
- Phase 2 sets `ort::Environment` explicitly (old v1 API), but `ort` v2 removed the global `Environment` — `Session::builder()` is called directly. The code sample in Section 5 uses the old API.
- The `rubato::FftFixedInOut` constructor takes `chunk_size` as third argument, but Phase 2 passes `samples.len().min(2048)` which is the full batch size, not a processing chunk size. This may cause a mismatch in the resampler's expected input/output lengths.

**Recommendations:**
1. Replace `espeak-phonemizer` with a bundled ARPAbet dictionary lookup for MVP. Keep espeak as an optional enhancement.
2. Unify `ort` feature flag. `load-dynamic` is better for distribution; use it in both Phase 1 and Phase 2.
3. Fix the `ort::Environment` API usage to match `ort` v2.x (no global environment needed).
4. Fix `rubato` usage: `FftFixedInOut::new(24000, 22050, CHUNK_SIZE, 1)` where `CHUNK_SIZE` is a fixed process size (e.g., 1024), not the total sample length. Process in a loop.
5. Add the `pcm16_to_f32` function definition to `tts.rs` (it is called but never defined).

---

### Phase 3: Orchestrator

**Strengths:**
- The sentence detection algorithm with abbreviation handling is well-specified.
- The TTS queue with `ttsRunning` flag ensures in-order speech without concurrent synthesis calls.
- `AbortController` for interrupting in-flight Grok requests is the correct mechanism.
- Tool call depth cap (3 rounds) prevents infinite tool loops.
- The `fetchWithRetry` with exponential backoff handles transient API failures well.
- Token budget management with history trimming by pairs (user+assistant) is correct.

**Weaknesses:**
- Uses `WatchTranscriptions` RPC which is not in `audio.proto` — must be added (see Section 3.1).
- `onTranscription` callback is set up but the `AudioClient.connect()` flow never subscribes to the `StreamSTT` or `WatchTranscriptions` stream during `orchestrator.start()`. The connection between `startCapture` and `onTranscription` is implicit and undocumented.
- Uses `better-sqlite3` instead of Bun's native `bun:sqlite` — see Risk 9.
- The `extractSentences` regex in the arch spec (`/[^.!?]+[.!?]+/g`) is replaced by Phase 6's cursor-based `extractNewSentences` but Phase 3's spec still uses the buggy regex version. Phase 3 should use the Phase 6 version.
- `SentenceDetector.feed()` has a bug: when the abbreviation-skip path is taken, `this.buffer = this.buffer.slice(endIdx)` and then `continue` — but `match.index` was computed on the original buffer. After slicing, the loop re-executes `SENTENCE_END.exec(this.buffer)` which creates a new match object at the new buffer start. This is correct behavior but the loop should use `lastIndex` reset or reconstruct from scratch to avoid index confusion with the sticky regex.
- Model name inconsistency: arch spec uses `"grok-4.1-fast-reasoning"`, Phase 3 uses `"grok-4-fast"`. Use the correct xAI model name at time of implementation.

**Recommendations:**
1. Add `WatchTranscriptions` to `audio.proto` (P0).
2. Replace `better-sqlite3` with `bun:sqlite` (P1).
3. Adopt the cursor-based `extractNewSentences` from Phase 6 directly in Phase 3 (P1).
4. Document the startup sequence inside `orchestrator.start()`: explicitly show that `audio.onTranscription()` is set up after `audio.startCapture()` returns.
5. Add a `listToolsCache` with a TTL (the plan mentions "cached, refreshed every 60s" in the flow diagram but the code does not implement it) (P2).

---

### Phase 4: Avatar

**Strengths:**
- The `useRPC.ts` hook is well-designed with cleanup on unmount.
- `useImperativeHandle` for `Avatar.tsx` to expose `setVisemes`/`setExpression` without prop drilling is the right React pattern.
- The viseme-to-Live2D parameter mapping table is specific and implementable.
- `backgroundAlpha: 0` for transparent WebGL canvas is called out explicitly.
- The drag-to-move requirement for frameless windows is covered.
- CSP requirements for Live2D WASM are documented.

**Weaknesses:**
- Live2D model asset procurement is left entirely unresolved (see Risk 3). No guidance on where to get an "Albedo" model or how to adapt a sample model.
- The `main.tsx` file is referenced as the React entry point but Phase 0 created `src/views/mainview/index.html` pointing to no specific entry script. The electrobun bundler must know to use `main.tsx` as the bundle entry — this needs a note in `electrobun.config.ts`.
- `pixi-live2d-display` requires the Cubism Core WASM runtime (`live2dcubismcore.min.js`). This file's distribution terms are restrictive (Live2D Proprietary Software License). The plan instructs placing it at `src/views/mainview/vendor/` — this path must be bundled by Electrobun, which requires a `staticFiles` or `assets` configuration entry.
- Phase 4 defines `MainToWebviewEvents` with a `visemes` event typed as `{ visemes: Viseme[] }`. Phase 6 defines the same event as just `{ visemes: Viseme[] }` in `MainToViewEvents`. These are compatible but the type names differ (`MainToWebviewEvents` vs `MainToViewEvents`). Use one canonical definition.
- The `Subtitles.tsx` fade-out after "4 seconds of no update" is not synchronized with the TTS queue. A sentence may still be playing when the 4-second timer fires and the subtitle disappears. Tie the subtitle visibility to a "speaking" state flag rather than a timer.

**Recommendations:**
1. Add a Phase 4 hard prerequisite: model files must be placed at `assets/models/albedo/` before Day 2 begins. Provide a fallback plan (use Hiyori sample model) if a custom model is not ready.
2. Update `electrobun.config.ts` to bundle `src/views/mainview/vendor/` as static assets.
3. Create a single `src/shared/rpc-types.ts` in Phase 4 and use it in both the webview and main process, resolving the `MainToWebviewEvents` vs `MainToViewEvents` naming split.
4. Replace the 4-second subtitle timer with a `isSpeaking` state driven by TTS start/end events.

---

### Phase 5: Go Daemon

**Strengths:**
- Platform detection for window tracking is complete across Linux/macOS/Windows.
- The `Collector` goroutine design (separate loops for metrics, clipboard, window) is correct and prevents one slow subsystem from blocking another.
- gopsutil usage is idiomatic and well-specified.
- The tool registry's error philosophy (always return `ToolResponse{Success: false}`, never a gRPC-level error) is the right design.
- Security sandbox documentation is honest about its limitations.
- The `golang.design/x/clipboard` selection for clipboard monitoring is a good pick (cross-platform, no exec dependency).

**Weaknesses:**
- `Collector.Start()` is never called in `main.go` (see Section 3.5 — concrete bug).
- `metrics.go` calls `cpu.Percent(time.Second, false)` and `net.IOCounters` with a 1-second sleep inside `CollectMetrics()`. This means a single `Snapshot()` call could block for 2 seconds (CPU sample + network delta). The cached approach described in the spec mitigates this only if `Start()` is called. Without it, the first `GetAwareness` RPC would hang for 2 seconds.
- `CaptureActiveWindowJPEG` depends on `xdotool getwindowgeometry` which is Linux X11-only. On Wayland, this will fail silently, returning a zero-rect capture. No Wayland fallback is specified.
- `run_command` tool uses `"sh", "-c"` on Unix and `"cmd", "/c"` on Windows. On modern Windows, PowerShell 7 is preferred for consistent behavior. More importantly, there is no `PATH` sanitization — the `sh` binary itself must be present, which is not guaranteed on all Linux container environments.
- Phase 5's `grpc` dependency version (`v1.64.0`) differs from Phase 0 (`v1.65.0`). Will cause `go mod tidy` to resolve to the newer version, which may break the Phase 0 commit.

**Recommendations:**
1. Add `collector.Start()` call in `main.go` before `grpcServer.Serve()` (P0 — this is a correctness bug).
2. Add a Wayland detection guard in `CaptureActiveWindowJPEG` that falls back to full-screen capture when `WAYLAND_DISPLAY` is set.
3. Standardize Go dependency versions to match Phase 0 exactly (P1).
4. Add a `signal.NotifyContext` for SIGTERM/SIGINT in `main.go` to enable `grpcServer.GracefulStop()` (Phase 6 mentions this but Phase 5 does not implement it).

---

### Phase 6: Integration

**Strengths:**
- This is the strongest document in the set. The `ProcessManager` design is production-grade.
- Socket-readiness polling with a configurable timeout is the right approach (replaces the `Bun.sleep(1000)` hack from the arch spec).
- The complete startup and shutdown sequences are fully specified.
- Error handling tables are exhaustive and match expected failure modes.
- The integration test script is immediately runnable.
- The end-to-end pipeline trace (Sections Step 1–5) is the best documentation of the full data flow anywhere in the plans.
- The config file merge strategy (env → file → defaults) is the right precedence.

**Weaknesses:**
- `assets/voices/default.onnx` in the prerequisites does not match Phase 2's `kokoro-v0_19.onnx` + `voices.bin` filenames. This will cause the integration smoke test to fail at the TTS assertion.
- `ProcessManager.shutdown()` has a bug: `await Bun.file(mp.socketPath).exists() && fs.unlinkSync(mp.socketPath)` mixes `Bun.file().exists()` (returns a `Promise<boolean>`) with `&&` short-circuit logic. The `fs.unlinkSync` will always be called because a Promise is truthy. Use `if (await Bun.file(mp.socketPath).exists()) { ... }`.
- The `orchestrator.stop()` method is called in shutdown but never defined in Phase 3 or Phase 6. It must be added to `Orchestrator` to `stopCapture`, cancel the awareness stream, and flush the TTS queue.
- The `tray.setIcon(path)` calls for state transitions (listening/thinking/speaking) are described but not wired to the orchestrator state machine. The orchestrator has no mechanism to call `tray.setIcon` since it does not hold a reference to `Tray`. This requires passing the tray reference into the orchestrator or using an event emitter pattern.
- The model name `grok-4.1-fast-reasoning` in the arch spec is used in Phase 6, while Phase 3 uses `grok-4-fast`. Verify the correct model name against the xAI API documentation at implementation time.

**Recommendations:**
1. Fix `assets/voices/default.onnx` to `assets/voices/kokoro-v0_19.onnx` + `assets/voices/voices.bin` in the prerequisites section (P0).
2. Fix the `ProcessManager.shutdown()` socket cleanup logic (P1).
3. Define `Orchestrator.stop()` in Phase 3 with clear contract (P1).
4. Pass a typed event emitter from `index.ts` to `Orchestrator` for tray state updates, or expose tray state as an event on the orchestrator (P2).

---

## 7. Integration Concerns

### 7.1 End-to-End Latency Budget

The 780ms budget breakdown from the architecture spec:

| Stage | Budgeted | Realistic | Risk |
|---|---|---|---|
| VAD detection | 100ms | 70–100ms | Low |
| Whisper STT (base model, ~3s utterance) | 300ms | 150–400ms | Medium |
| Context build + tool list | 20ms | 10–30ms | Low |
| Grok first token (streaming) | 200ms | 150–400ms | Medium |
| TTS synthesis (Kokoro, ~10 word sentence) | 150ms | 200–400ms | High |
| Audio play | 10ms | 5–20ms | Low |
| **Total** | **780ms** | **585–1350ms** | |

The budget is optimistic on TTS. Kokoro ONNX on CPU for a 10-word sentence synthesizes approximately 2–3 seconds of audio, which takes 200–400ms on a modern CPU. The budget's 150ms target is aggressive and will be missed on slower hardware.

**More importantly:** The 780ms budget misses one cost: the gRPC round-trip for `Synthesize`. The Rust engine processes TTS and starts playback locally, but it must still return the `SynthesizeResponse` to Bun before the orchestrator knows the audio has started. On a Unix socket this adds <1ms, but the gRPC framing overhead can add 5–15ms on each call. Not a problem in practice.

**Where the budget actually holds up:** The sentence-streaming design is the critical optimization. Grok begins streaming tokens; the first complete sentence is extracted after perhaps 100–300ms of token generation for short responses. That sentence immediately goes to TTS while Grok continues generating. By the time the first sentence's audio plays, Grok may have generated 2–3 more sentences. The perceived latency is Grok's first-token time + TTS for the first sentence — approximately 350–800ms, which is acceptable.

### 7.2 Error Propagation Across Process Boundaries

| Scenario | Propagation | Handled? |
|---|---|---|
| Rust panic in `synthesize` | gRPC `Status::internal` → Bun catch → orchestrator try/catch → webview error event | Yes (Phase 6) |
| Go daemon `ExecuteTool` error | `ToolResponse{success: false, error: ...}` → orchestrator → fed back to Grok | Yes (Phase 5) |
| Grok API 429 | `fetchWithRetry` backoff → orchestrator catch → spoken fallback | Yes (Phase 3) |
| Grok API 401 | No retry → user-facing message | Yes (Phase 6) |
| Rust audio process crash mid-utterance | ProcessManager detects exit → `AudioClient` channel failure → orchestrator gRPC error → try/catch | Partially — the in-flight `speakSentence` gRPC call will throw; the TTS queue is never cleared. Add `ttsQueue = []` in the gRPC error handler. |
| Silero ONNX inference error | `anyhow::Error` → `Status::internal` — but VAD is called inside the StreamSTT task with `unwrap_or(false)`. Silently treated as silence. | Silent failure — acceptable but should log. |
| Webview crash / reload | Orchestrator continues emitting RPC events to a dead channel | Not handled. Electrobun's `win.webview.rpc.emit` likely no-ops on a dead webview, but this should be confirmed. |

### 7.3 Resource Management

**Memory:**
- Whisper model: ~142MB resident. Stays loaded for the process lifetime. Acceptable.
- Kokoro model: ~310MB. Also resident. Combined with Whisper: ~450MB for the audio process.
- `speech_buffer: Vec<f32>` in `stream_stt` is unbounded. For a 60-second monologue at 16kHz: 60 * 16000 * 4 bytes = ~3.84MB. Fine in practice, but the 30-second cap mentioned in Phase 1 recommendations is important.
- SQLite WAL mode is correctly enabled. The database file will grow indefinitely — no rotation or size cap is specified. For a personal assistant accumulating daily conversations, 1 year of data could be 50–500MB. Add a retention policy (e.g., keep last 90 days) in `memory.ts`.

**File handles:**
- `cpal` input and output streams hold OS audio device handles. They are correctly managed inside their respective structs with proper Drop behavior.
- gRPC channels in the TypeScript client are not explicitly closed between reconnects — the old `grpc.Client` is replaced but not `.close()`d. Add `this.client?.close()` before creating a new client in the `connect()` method.

**Socket files:**
- Phase 6 handles cleanup correctly on the Bun side. The Go daemon removes the socket at startup. The Rust engine does the same. Stale socket handling is covered.

---

## 8. Recommended Changes (Priority Ordered)

### P0 — Must fix before writing any Phase 1 code

1. **Add `WatchTranscriptions` and `PlayAudio`-or-delete to `proto/audio.proto`.** Decide whether `PlayAudio` is needed (it probably is not — playback is internal to Rust). If not needed, remove it from Phase 3's AudioClient. If needed, define `PlayStatus` message and add to proto. Either way, add `WatchTranscriptions(Empty) returns (stream TranscriptionResult)` to the `AudioEngine` service.

2. **Add `uint64 timestamp_ms = 4` to `AudioChunk` in `proto/audio.proto`** (or remove the reference in Phase 1's `stream_stt` and use `SystemTime::now()`).

3. **Add `assets/vad/` to Phase 0's directory creation script** (`mkdir -p assets/vad`).

4. **Resolve `ort` feature flag conflict.** Choose one: `load-dynamic` (better for distribution). Apply it in both Phase 1's Cargo.toml dependency and Phase 2's. Remove `download-binaries` from Phase 1.

5. **Fix Phase 6 prerequisites: replace `assets/voices/default.onnx` with `assets/voices/kokoro-v0_19.onnx` + `assets/voices/voices.bin`.**

6. **Add `collector.Start()` call to Phase 5's `main.go`** before `grpcServer.Serve()`.

7. **Resolve `build.rs` `out_dir` split.** Phase 0 should use the idiomatic approach (no `.out_dir()` override) to match Phase 1.

### P1 — Fix during implementation (before the affected phase is complete)

8. **Replace `better-sqlite3` with `bun:sqlite`** in Phase 3's `memory.ts`. Update `package.json` and remove the `better-sqlite3` dependency.

9. **Fix the double-decode bug in Phase 2's `synthesize` handler** (pass `f32_samples` to `playback.enqueue()`, not the result of round-tripping through `pcm16_to_f32`).

10. **Fix `ort` v2 API usage in Phase 2.** Remove the `Environment::builder()` wrapper — it does not exist in `ort` v2. Use `Session::builder()` directly.

11. **Fix `rubato` resampler usage in Phase 2.** Use a fixed chunk size (e.g., 1024 samples) and process in a loop rather than passing the full batch as the chunk size.

12. **Implement full 3-state VAD machine (SILENCE/SPEECH/POST_SPEECH)** in Phase 1's `stream_stt` to match the state machine spec in Section 5. Remove the 2-state simplification from Section 6.3.

13. **Add Whisper hallucination filter** in Phase 1: skip empty strings and strings matching `[BLANK_AUDIO]`, `(music)`, repetitions, or results shorter than 3 characters.

14. **Adopt cursor-based `extractNewSentences`** from Phase 6 directly in Phase 3 instead of the regex variant.

15. **Define `Orchestrator.stop()`** in Phase 3 (called by Phase 6's shutdown sequence but never specified).

16. **Add `collector.Start()` call to `main.go` and `signal.NotifyContext` for graceful stop** in Phase 5.

17. **Standardize Go dependency versions** to Phase 0 values across Phase 5's `go get` commands.

18. **Fix `ProcessManager.shutdown()` socket cleanup** in Phase 6 (async/await bug with `Bun.file().exists() && fs.unlinkSync()`).

### P2 — Nice to have / post-MVP improvements

19. **Replace `Mutex<VecDeque<f32>>` in `PlaybackEngine`** with a lock-free SPSC ring buffer (`rtrb` crate) for glitch-free real-time audio.

20. **Add `espeak-phonemizer` fallback**: bundle a static CMU pronouncing dictionary for English as a pure-Rust fallback when `espeak-ng` is unavailable. Keep `espeak-ng` as an optional runtime enhancement.

21. **Add SQLite retention policy in `memory.ts`**: delete conversations older than 90 days on startup.

22. **Add `this.client?.close()` before reconnect** in both `AudioClient` and `DaemonClient` gRPC connection management.

23. **Add `isSpeaking` guard in the orchestrator** to prevent proactive TTS alerts from interrupting an in-progress response.

24. **Tie subtitle visibility to `isSpeaking` state** rather than a fixed 4-second timer in `Subtitles.tsx`.

25. **Add a `listToolsCache` with 60-second TTL** in the orchestrator so `daemon.listTools()` is not called on every utterance.

26. **Add maximum buffer duration cap** (30 seconds) in Phase 1's VAD loop to force flush on long monologues.

27. **Evaluate `pixi-live2d-display` v8 fork** (`@guansss/pixi-live2d-display`) after MVP ships; add it to the post-MVP backlog.

28. **Implement tray icon state updates** by wiring an event emitter from `Orchestrator` to `index.ts` for `listening/thinking/speaking/error` state transitions.

---

*End of tech lead review.*
