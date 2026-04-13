# Voice Architecture: Brazilian Portuguese + Voice Cloning

**Status:** Addendum to Phase 1 (Audio MVP) and Phase 2 (TTS)
**Impact:** Replaces Kokoro English-only TTS with PT-BR Kokoro + RVC voice conversion pipeline
**Languages added:** None — entire pipeline runs in Rust via `ort` crate

---

## 1. Overview

Albedo AI speaks Brazilian Portuguese using the voice timbre of **Thay Marciano**, the Brazilian voice actress who dubs Albedo in Overlord (Seasons IV+, Dubrasil studio).

The pipeline has two stages, both running as ONNX models inside the existing Rust audio engine:

```
Text (PT-BR) → Kokoro TTS (pf_dora voice) → Raw PCM
Raw PCM → RVC v2 (Thay Marciano model) → Final PCM with her voice timbre
Final PCM → viseme extraction → cpal playback
```

No Python. No sidecars. No new processes. Single Rust binary.

---

## 2. Why This Works Without Python

| Component | ONNX Model | Rust Crate | Proven? |
|---|---|---|---|
| Kokoro TTS (PT-BR) | `kokoro-v1.0.onnx` + `pf_dora.bin` | `ort` (direct) or `tts-rs` | Yes — multiple Rust crates ship this |
| HuBERT content extractor | `vec-768-layer-12.onnx` | `ort` | Yes — `Rust-VoiceConversion` v1.0.0 |
| RMVPE pitch extractor | `rmvpe.onnx` | `ort` | Yes — same project |
| RVC generator | `thay_marciano.onnx` | `ort` | Yes — same project |

Reference implementation: [`HaruSameee/Rust-VoiceConversion`](https://github.com/HaruSameee/Rust-VoiceConversion) — a production-shipped Rust+Tauri real-time RVC engine (v1.0.0, March 2026) using exactly this three-model ONNX pipeline via `ort`.

---

## 3. Voice Actress: Thay Marciano

| Detail | Info |
|---|---|
| Full name | Thainá Marciano |
| Born | March 23, 1998 — Praia Grande, SP, Brazil |
| Character | Albedo (Overlord, Season IV+) |
| Studio | Dubrasil |
| Other roles | Ubel (Frieren), Temari (Naruto Shippuden), Carrot (One Piece) |
| Social | Instagram: `@thaymarciano` |

### Reference Audio Sources

To train the RVC model, 5-10 minutes of clean, isolated Albedo voice lines are needed.

**Extraction methods:**

1. **From the Overlord PT-BR dub** (Crunchyroll/Blu-ray)
   ```bash
   # Demux PT-BR audio track
   ffmpeg -i overlord_s4_ep01.mkv -map 0:a:1 -ac 1 -ar 16000 audio_ptbr.wav

   # Speaker diarization to isolate Albedo's lines
   # Use pyannote.audio or whisperX with --diarize flag
   ```

2. **YouTube compilations** — search `"Albedo Overlord dublado pt-br"`

3. **Podcast** — *"Call com Thay Marciano"* on Spotify (100 Fitas Podcast) — clean studio audio of her natural speaking voice

4. **Instagram reels** — `@thaymarciano` has reels where she's identified as Albedo's voice

**Audio preparation:**
- Remove background music/SFX with DeepFilterNet or RNNoise
- Resample to 16kHz mono WAV
- Trim silence, normalize volume
- Target: 5-10 minutes of clean speech across varied intonation

### Legal Position

- **Personal, non-commercial, non-distributed use** — low legal risk, widely practiced in the RVC/AI voice community
- Do not distribute the model weights or TTS output publicly
- Brazil's LGPD covers voice as biometric data, but enforcement for private projects is non-existent
- Ethical option: reach out to Thay Marciano directly — she's active at conventions and on social media

---

## 4. RVC Model Training (One-Time, Offline)

This is the **only step that touches Python**, and it's a one-time offline process. The result is an ONNX file that goes into `assets/` and Python is never needed again.

### 4.1 Train the RVC Model

```bash
# Clone RVC WebUI
git clone https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI
cd Retrieval-based-Voice-Conversion-WebUI

# Place prepared audio in the training directory
cp ~/albedo-voice-samples/*.wav datasets/thay_marciano/

# Train via WebUI or CLI
# Settings: v2 model, 40kHz, 200-1000 epochs
# Output: logs/thay_marciano/thay_marciano.pth
```

### 4.2 Export to ONNX

```bash
# In RVC WebUI directory
python tools/export_onnx.py \
  --model logs/thay_marciano/thay_marciano.pth \
  --output assets/rvc/thay_marciano.onnx

# Also download the pre-exported preprocessing models:
# HuBERT: huggingface.co/MidFord327/Hubert-Base-ONNX → vec-768-layer-12.onnx
# RMVPE: shipped in RVC WebUI → rmvpe.onnx
```

### 4.3 Verify ONNX Models

After export, verify all three models load correctly:

```bash
python -c "
import onnxruntime as ort
for m in ['vec-768-layer-12.onnx', 'rmvpe.onnx', 'thay_marciano.onnx']:
    s = ort.InferenceSession(f'assets/rvc/{m}')
    print(f'{m}: inputs={[i.name for i in s.get_inputs()]}, outputs={[o.name for o in s.get_outputs()]}')
"
```

Expected tensor shapes:

| Model | Inputs | Outputs |
|---|---|---|
| HuBERT | `source: [1, 1, N]` float32 (16kHz PCM) | `embed: [1, T, 768]` float32 |
| RMVPE | `waveform: [1, N]` float32 | `f0: [T]` float32 (Hz) |
| Generator | `phone: [1, T, 768]`, `phone_lengths: [1]`, `pitch: [1, T]` int64, `pitchf: [1, T]` float32, `ds: [1]` int64, `rnd: [1, 192, T]` float32 | `audio: [1, 1, N]` float32 |

---

## 5. Asset Layout

```
assets/
├── voices/
│   ├── kokoro-v1.0.onnx              # Kokoro TTS model (82M params, ~330MB)
│   ├── voices-v1.0.bin               # All voice embeddings
│   └── pf_dora.bin                   # PT-BR female voice (extracted from voices-v1.0.bin)
│
├── rvc/                               # NEW — voice conversion models
│   ├── hubert-base.onnx              # ContentVec feature extractor (~190MB)
│   ├── rmvpe.onnx                    # Pitch extractor (~55MB)
│   └── thay_marciano.onnx           # RVC generator (~55MB)
│
├── whisper/
│   └── ggml-large-v3-turbo.bin       # Upgraded from base for PT-BR accuracy (~1.5GB)
│
└── vad/
    └── silero_vad.onnx               # Unchanged
```

**Total model footprint:** ~2.2GB (vs ~500MB original English-only config)

---

## 6. Rust Implementation

### 6.1 New Module: `audio-engine/src/rvc.rs`

```rust
use ort::{Session, Value, TensorElementType};
use ndarray::{Array2, Array3, CowArray};

/// Three-model RVC pipeline: HuBERT → RMVPE → Generator
pub struct RvcEngine {
    hubert: Session,
    rmvpe: Session,
    generator: Session,
    sample_rate: u32,       // 40000 for RVC v2
    speaker_id: i64,        // 0 for single-speaker models
}

impl RvcEngine {
    pub fn new(
        hubert_path: &str,
        rmvpe_path: &str,
        generator_path: &str,
    ) -> anyhow::Result<Self> {
        let hubert = Session::builder()?
            .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
            .commit_from_file(hubert_path)?;

        let rmvpe = Session::builder()?
            .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
            .commit_from_file(rmvpe_path)?;

        let generator = Session::builder()?
            .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
            .commit_from_file(generator_path)?;

        Ok(Self {
            hubert,
            rmvpe,
            generator,
            sample_rate: 40000,
            speaker_id: 0,
        })
    }

    /// Convert audio from Kokoro's voice to Thay Marciano's voice
    pub fn convert(&self, pcm_16k: &[f32]) -> anyhow::Result<Vec<f32>> {
        // Step 1: Extract content features via HuBERT
        let features = self.extract_features(pcm_16k)?;

        // Step 2: Extract pitch via RMVPE
        let (pitch_int, pitch_float) = self.extract_pitch(pcm_16k)?;

        // Step 3: Generate audio with target voice timbre
        let output = self.generate(&features, &pitch_int, &pitch_float)?;

        Ok(output)
    }

    fn extract_features(&self, pcm: &[f32]) -> anyhow::Result<Array2<f32>> {
        let input = Array3::from_shape_vec(
            (1, 1, pcm.len()),
            pcm.to_vec(),
        )?;

        let outputs = self.hubert.run(
            ort::inputs!["source" => input.view()]?
        )?;

        let embed = outputs[0].try_extract_tensor::<f32>()?;
        let shape = embed.shape();
        Ok(embed.to_owned().into_shape((shape[1], shape[2]))?)
    }

    fn extract_pitch(&self, pcm: &[f32]) -> anyhow::Result<(Vec<i64>, Vec<f32>)> {
        let input = ndarray::Array2::from_shape_vec(
            (1, pcm.len()),
            pcm.to_vec(),
        )?;

        let outputs = self.rmvpe.run(
            ort::inputs!["waveform" => input.view()]?
        )?;

        let f0 = outputs[0].try_extract_tensor::<f32>()?;
        let f0_vec: Vec<f32> = f0.iter().copied().collect();

        // Convert F0 Hz to mel-scale bins (1-255) for pitch input
        let pitch_int: Vec<i64> = f0_vec.iter().map(|&f| {
            if f < 1.0 { 0 } else {
                (12.0 * (f / 440.0).log2() + 69.0).round().clamp(1.0, 255.0) as i64
            }
        }).collect();

        Ok((pitch_int, f0_vec))
    }

    fn generate(
        &self,
        features: &Array2<f32>,
        pitch_int: &[i64],
        pitch_float: &[f32],
    ) -> anyhow::Result<Vec<f32>> {
        let t = features.shape()[0];

        let phone = features.clone().into_shape((1, t, 768))?;
        let phone_lengths = ndarray::arr1(&[t as i64]).into_shape((1,))?;
        let pitch = ndarray::Array2::from_shape_vec((1, t), pitch_int.to_vec())?;
        let pitchf = ndarray::Array2::from_shape_vec((1, t), pitch_float.to_vec())?;
        let ds = ndarray::arr1(&[self.speaker_id]).into_shape((1,))?;

        // Random noise for synthesis variation
        let rnd_data: Vec<f32> = (0..192 * t)
            .map(|_| rand::random::<f32>() * 2.0 - 1.0)
            .collect();
        let rnd = ndarray::Array3::from_shape_vec((1, 192, t), rnd_data)?;

        let outputs = self.generator.run(ort::inputs![
            "phone" => phone.view(),
            "phone_lengths" => phone_lengths.view(),
            "pitch" => pitch.view(),
            "pitchf" => pitchf.view(),
            "ds" => ds.view(),
            "rnd" => rnd.view(),
        ]?)?;

        let audio = outputs[0].try_extract_tensor::<f32>()?;
        Ok(audio.iter().copied().collect())
    }
}
```

### 6.2 Updated Module: `audio-engine/src/tts.rs`

The TTS module gains a post-processing step that pipes Kokoro output through RVC:

```rust
pub struct TtsEngine {
    kokoro: KokoroEngine,
    rvc: Option<RvcEngine>,       // None = skip voice conversion
    resampler_down: Resampler,    // 22050 → 16000 (for RVC HuBERT input)
    resampler_up: Resampler,      // 40000 → 22050 (RVC output back to playback rate)
}

impl TtsEngine {
    pub async fn synthesize(
        &self,
        text: &str,
        voice_id: &str,
        speed: f32,
    ) -> anyhow::Result<(Vec<f32>, Vec<Viseme>)> {
        // Step 1: Kokoro generates PT-BR speech with pf_dora voice
        let (raw_pcm, phoneme_events) = self.kokoro
            .synthesize_internal(text, voice_id, speed)
            .await?;

        // Step 2: Extract visemes from phoneme events (before voice conversion)
        let visemes = lipsync::extract_visemes(&phoneme_events);

        // Step 3: Voice conversion (if RVC model loaded)
        let final_pcm = if let Some(ref rvc) = self.rvc {
            // Resample 22050 → 16000 for HuBERT input
            let pcm_16k = self.resampler_down.process(&raw_pcm)?;

            // Run RVC pipeline
            let converted = rvc.convert(&pcm_16k)?;

            // Resample 40000 → 22050 for playback
            self.resampler_up.process(&converted)?
        } else {
            raw_pcm
        };

        Ok((final_pcm, visemes))
    }
}
```

### 6.3 Updated `Cargo.toml` Dependencies

```toml
[dependencies]
# Existing
ort = { version = "2.0", features = ["load-dynamic"] }
tonic = "0.13"
prost = "0.13"
tokio = { version = "1", features = ["full"] }
cpal = "0.15"
whisper-rs = "0.14"
rubato = "0.16"
rtrb = "0.3"
hound = "3.5"
anyhow = "1"

# NEW — for RVC pipeline
ndarray = "0.16"
rand = "0.8"
```

No new crates beyond `ndarray` (tensor manipulation) and `rand` (noise generation for RVC synthesis). The `ort` crate already handles all ONNX inference.

### 6.4 Updated `main.rs` Initialization

```rust
// TTS engine with optional RVC voice conversion
let rvc = match RvcEngine::new(
    "assets/rvc/hubert-base.onnx",
    "assets/rvc/rmvpe.onnx",
    "assets/rvc/thay_marciano.onnx",
) {
    Ok(engine) => {
        println!("[albedo-audio] RVC loaded — voice: Thay Marciano");
        Some(engine)
    }
    Err(e) => {
        eprintln!("[albedo-audio] RVC not available ({}), using default Kokoro voice", e);
        None
    }
};

let tts = TtsEngine {
    kokoro: KokoroEngine::new("assets/voices/kokoro-v1.0.onnx", "pf_dora")?,
    rvc,
    resampler_down: Resampler::new(22050, 16000)?,
    resampler_up: Resampler::new(40000, 22050)?,
};
```

RVC is **optional** — if the model files aren't present, Albedo speaks with Kokoro's default `pf_dora` voice. This makes development easier (voice cloning can be added later without blocking the rest of the pipeline).

---

## 7. Whisper STT for Portuguese

The base Whisper model (`ggml-base.bin`) has poor Portuguese accuracy (~25% WER). Upgrade to `large-v3-turbo` for conversational PT-BR:

| Model | Size | PT-BR WER | Latency | Recommendation |
|---|---|---|---|---|
| `ggml-base.bin` | ~142MB | ~25% | ~300ms | Not recommended for PT-BR |
| `ggml-large-v3-turbo.bin` | ~1.5GB | ~9-10% | ~500ms | **Best balance** — 6x faster than large-v3 |
| `ggml-medium-ptbr.bin` (fine-tuned) | ~1.5GB | ~8-10% | ~400ms | Best if available |
| `ggml-large-v3.bin` | ~3GB | ~8% | ~1.5s | Highest accuracy, too slow |

### Configuration Change in `stt.rs`

```rust
let mut params = whisper_rs::FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
params.set_language(Some("pt"));          // Portuguese
params.set_translate(false);              // Keep in Portuguese, don't translate
params.set_no_speech_threshold(0.6);      // Slightly higher for PT-BR
params.set_n_threads(num_cpus::get() as i32 / 2);
```

---

## 8. Updated Latency Budget

```
User speaks (PT-BR)  ─── 0ms
VAD detect           ─── ~100ms   (Rust, silero-vad — unchanged)
Whisper STT          ─── ~500ms   (Rust, large-v3-turbo — slower but accurate)
Context build        ─── ~20ms    (Bun — unchanged)
Grok API             ─── ~200ms   (first token, streaming)
Kokoro TTS (pf_dora) ─── ~200ms   (Rust, ONNX — PT-BR voice)
RVC conversion       ─── ~170ms   (Rust, ONNX — 3-model pipeline)
Audio play           ─── ~10ms    (Rust, cpal)
─────────────────────────────────
Total to first audio:  ~1200ms
```

**~1.2 seconds** — slower than the original 780ms English budget, but still conversational. The sentence-streaming design mitigates perceived latency: while the first sentence plays, subsequent sentences are already being processed.

### Optimization Paths

| Optimization | Saves | Effort |
|---|---|---|
| GPU acceleration for RVC (`ort` CUDA) | ~80ms | Low — just enable CUDA execution provider |
| Whisper medium-ptbr instead of large-v3-turbo | ~100ms | Low — swap model file |
| Cache HuBERT features across sentences | ~30ms | Medium |
| Skip RVC for short utterances (<5 words) | ~170ms on those | Low |
| Overlap Kokoro + previous sentence playback | ~200ms perceived | Already in design |

With GPU: **~950ms** total. With all optimizations: **~850ms**.

---

## 9. Grok API: Portuguese System Prompt

The orchestrator's system prompt must instruct Grok to respond in Brazilian Portuguese:

```typescript
const SYSTEM_PROMPT = `Voce e Albedo, a Guardia Supervisora do Grande Tumulo de Nazarick.
Voce fala exclusivamente em portugues brasileiro.
Voce e leal, inteligente, e devotada ao seu mestre.
Responda de forma natural e conversacional, como se estivesse falando em voz alta.
Mantenha as respostas concisas — no maximo 2-3 frases por vez.
Nunca use ingles a menos que o usuario fale em ingles primeiro.`;
```

Update `context-manager.ts` to inject this as the system message.

---

## 10. Phonemization for PT-BR

Kokoro requires grapheme-to-phoneme (G2P) conversion. For Portuguese, the pipeline is:

```
Text (PT-BR) → espeak-ng (pt-br backend) → IPA phonemes → Kokoro model
```

**espeak-ng** is the standard G2P for Kokoro's non-English languages. It must be installed as a system dependency:

```bash
# Ubuntu/Debian
sudo apt install espeak-ng

# macOS
brew install espeak-ng

# Verify PT-BR
espeak-ng -v pt-br --ipa "Ola, eu sou a Albedo"
# Output: ulˈa ˈew sˈow a awbˈedu
```

From Rust, call espeak-ng as a subprocess or use the `espeak-ng-sys` crate for FFI:

```rust
use std::process::Command;

fn phonemize_ptbr(text: &str) -> anyhow::Result<String> {
    let output = Command::new("espeak-ng")
        .args(["-v", "pt-br", "--ipa", "-q", text])
        .output()?;
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}
```

---

## 11. Testing Strategy

### 11.1 TTS Quality Validation

```bash
# Test 1: Kokoro PT-BR without RVC
cargo test test_kokoro_ptbr -- --nocapture
# Generates: test_output/kokoro_ptbr.wav
# Listen: should be intelligible Portuguese with pf_dora voice

# Test 2: Kokoro PT-BR with RVC
cargo test test_kokoro_ptbr_rvc -- --nocapture
# Generates: test_output/kokoro_ptbr_rvc.wav
# Listen: should sound like Thay Marciano speaking Portuguese

# Test 3: Whisper round-trip
cargo test test_stt_ptbr -- --nocapture
# Records mic → transcribes → prints Portuguese text
```

### 11.2 RVC Model Validation

```rust
#[test]
fn test_rvc_pipeline() {
    let rvc = RvcEngine::new(
        "assets/rvc/hubert-base.onnx",
        "assets/rvc/rmvpe.onnx",
        "assets/rvc/thay_marciano.onnx",
    ).unwrap();

    // Load a test WAV (any voice, any language)
    let input = load_wav_f32("test_data/test_voice.wav", 16000);
    let output = rvc.convert(&input).unwrap();

    assert!(!output.is_empty());
    assert!(output.len() > input.len() / 2); // Sanity: output shouldn't be tiny
    save_wav_f32("test_output/rvc_converted.wav", &output, 40000);
}
```

### 11.3 End-to-End Voice Loop

```
1. Speak Portuguese into mic
2. Verify Whisper transcribes correctly (check stdout)
3. Verify Grok responds in Portuguese
4. Verify TTS speaks the response in Portuguese
5. Verify voice sounds like Thay Marciano (subjective)
6. Verify lip sync visemes are generated
7. Verify latency < 1.5s to first audio
```

---

## 12. Validation Criteria

| # | Criterion | How to verify |
|---|---|---|
| 1 | Kokoro `pf_dora` produces intelligible PT-BR | Generate WAV, listen |
| 2 | RVC ONNX models load in Rust via `ort` | Unit test passes |
| 3 | RVC converts voice timbre without distortion | A/B comparison with reference |
| 4 | Full pipeline (Kokoro → RVC) runs under 400ms | Benchmark test |
| 5 | Whisper transcribes PT-BR with <15% WER | Test with Common Voice PT samples |
| 6 | Visemes still align after RVC (timing unchanged) | Visual check with avatar |
| 7 | Graceful fallback when RVC models missing | Remove `.onnx` files, verify Kokoro-only mode |
| 8 | espeak-ng PT-BR phonemization works | Test with varied Portuguese text |
| 9 | End-to-end: speak PT-BR → hear PT-BR response | Manual QA |

---

## 13. Risks

### Risk 1: Kokoro `pf_dora` PT-BR Quality — HIGH

The `pf_dora` voice has no published quality grade. It may have accent artifacts or unnatural prosody.

**Mitigation:** Test immediately in Phase 0. If quality is unacceptable:
- Try `pm_alex` (male PT-BR voice) as baseline quality check
- Fall back to Piper PT-BR (`piper-pt_BR-faber-medium`) via sherpa-onnx — lower quality but proven
- Investigate KokoClone (zero-shot voice cloning addon for Kokoro) to create a better PT-BR base voice from Thay Marciano's audio directly

### Risk 2: RVC ONNX Tensor Shape Mismatch — MEDIUM

The HuBERT, RMVPE, and Generator models must agree on tensor shapes (frame count `T`, feature dimension 768). Different RVC model versions may expect different shapes.

**Mitigation:** Pin exact model versions. Validate tensor shapes at startup with assertions. Use the models from the `HaruSameee/Rust-VoiceConversion` project as the known-good set.

### Risk 3: Resampling Chain Quality — MEDIUM

The pipeline resamples three times: Kokoro output (22050Hz) → 16000Hz (HuBERT) → 40000Hz (RVC output) → 22050Hz (playback). Each resample can introduce artifacts.

**Mitigation:** Use high-quality `rubato` resampler with `FftFixedInOut` (sinc interpolation). Listen for artifacts in testing. If problematic, adjust Kokoro to output at 16000Hz directly (reducing one resample step).

### Risk 4: espeak-ng Availability — LOW

espeak-ng must be installed as a system dependency. Not available on all systems by default.

**Mitigation:** Already addressed in Phase 2 docs — the `CmudictPhonemizer` fallback handles English, and for Portuguese specifically, espeak-ng is the only viable G2P. Bundle it in the Electrobun installer or document it as a hard prerequisite.

### Risk 5: RVC Training Quality — LOW

Voice cloning quality depends on the reference audio quality and quantity. Extracted anime dub lines may have background music bleed.

**Mitigation:** Use the podcast audio (100 Fitas Podcast with Thay Marciano) as primary training data — it's clean studio recording of her natural voice. Supplement with cleaned anime lines. 5-10 minutes is sufficient for RVC v2.

---

## 14. Phase Impact Summary

| Phase | Change |
|---|---|
| **Phase 0** | Add `assets/rvc/` to directory scaffold. Add `ndarray`, `rand` to Cargo.toml |
| **Phase 1** | Upgrade Whisper model to `ggml-large-v3-turbo.bin`. Set language to `"pt"` |
| **Phase 2** | Add `rvc.rs` module. Update `tts.rs` with RVC post-processing. Add resampling chain |
| **Phase 3** | Update system prompt to Portuguese. Update context manager for PT-BR |
| **Phase 4** | No changes — viseme system is language-agnostic |
| **Phase 5** | No changes — daemon is language-agnostic |
| **Phase 6** | Update config defaults (language, model paths). Update smoke test for PT-BR |

---

## 15. Future: Eliminating RVC Entirely

**Qwen3-TTS** (0.6B/1.7B params) supports Portuguese and has built-in voice cloning from reference audio — no separate RVC step needed. A Rust ONNX implementation exists (`SuzukiDaishi/Qwen3-TTS-ONNX-Rust`) but is early stage (9 commits) and too slow on CPU.

When Qwen3-TTS matures or quantized variants become practical on CPU, the entire Kokoro + RVC pipeline could be replaced with a single model that does voice-cloned PT-BR TTS directly. Monitor this space post-MVP.
