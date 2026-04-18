pub mod audio_capture;
pub mod audio_playback;
pub mod lipsync;
pub mod loopback;
pub mod phonemizer;
pub mod stt;
pub mod tts;
pub mod vad;

pub mod audio_proto {
    tonic::include_proto!("albedo.audio");
}

use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, broadcast};
use tonic::{Request, Response, Status};
use tokio_stream::wrappers::ReceiverStream;
use audio_proto::audio_engine_server::AudioEngine;
use audio_proto::*;
use cpal::traits::{DeviceTrait, HostTrait};

enum VadState {
    Silence,
    Speech,
    PostSpeech,
}

pub struct AlbedoAudioEngine {
    pub stt: Box<dyn stt::SttBackend>,
    pub vad: Arc<Mutex<vad::VadEngine>>,
    pub kokoro: Arc<tts::KokoroEngine>,
    pub playback: Arc<Mutex<audio_playback::PlaybackEngine>>,
    pub capture_tx: Arc<Mutex<Option<mpsc::Sender<Vec<f32>>>>>,
    pub capture_handle: Arc<Mutex<Option<audio_capture::CaptureHandle>>>,
    pub capture_rx: Arc<Mutex<Option<mpsc::Receiver<Vec<f32>>>>>,
    pub transcription_tx: broadcast::Sender<TranscriptionResult>,
    pub level_tx: broadcast::Sender<AudioLevel>,
    pub ptt_buffer: Arc<Mutex<Vec<f32>>>,
    pub ptt_recording: Arc<Mutex<bool>>,
}

#[tonic::async_trait]
impl AudioEngine for AlbedoAudioEngine {
    type StreamSTTStream = ReceiverStream<Result<TranscriptionResult, Status>>;
    type WatchTranscriptionsStream = ReceiverStream<Result<TranscriptionResult, Status>>;
    type WatchAudioLevelStream = ReceiverStream<Result<AudioLevel, Status>>;

    async fn stream_stt(
        &self,
        request: Request<tonic::Streaming<AudioChunk>>,
    ) -> Result<Response<Self::StreamSTTStream>, Status> {
        let mut inbound = request.into_inner();
        let (tx, rx) = mpsc::channel::<Result<TranscriptionResult, Status>>(32);
        let stt = self.stt.clone();
        let vad = self.vad.clone();

        tokio::spawn(async move {
            let mut speech_buffer: Vec<f32> = Vec::new();
            let mut silence_count: u32 = 0;
            let mut speech_count: u32 = 0;
            let last_transcription: String = String::new();
            let mut state = VadState::Silence;

            const SPEECH_ONSET: u32 = 3;
            const SILENCE_END: u32 = 8;
            const MAX_BUFFER_SAMPLES: usize = 30 * 16000;

            while let Ok(Some(chunk)) = inbound.message().await {
                let samples: Vec<f32> = chunk.pcm_data
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();

                if samples.is_empty() {
                    continue;
                }

                let is_speech = {
                    let mut v = vad.lock().await;
                    v.is_speech(&samples).unwrap_or(false)
                };

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
                        } else if speech_buffer.len() >= MAX_BUFFER_SAMPLES {
                            let buf = std::mem::take(&mut speech_buffer);
                            let ts = chunk.timestamp_ms;
                            let tx2 = tx.clone();
                            let s2 = stt.clone();
                            let last = last_transcription.clone();
                            tokio::spawn(async move {
                                match stt::transcribe_async(s2, buf).await {
                                    Ok(text) => {
                                        let trimmed = text.trim();
                                        if should_send(trimmed, &last) {
                                            let _ = tx2.send(Ok(TranscriptionResult {
                                                text: trimmed.to_string(),
                                                confidence: 0.9,
                                                is_final: true,
                                                timestamp_ms: ts,
                                            })).await;
                                        }
                                    }
                                    Err(e) => {
                                        let _ = tx2.send(Err(Status::internal(e.to_string()))).await;
                                    }
                                }
                            });
                            state = VadState::Silence;
                            silence_count = 0;
                            speech_count = 0;
                        }
                    }
                    VadState::PostSpeech => {
                        if is_speech {
                            speech_buffer.extend_from_slice(&samples);
                            silence_count = 0;
                            state = VadState::Speech;
                        } else {
                            silence_count += 1;
                            if silence_count >= SILENCE_END {
                                let buf = std::mem::take(&mut speech_buffer);
                                let ts = chunk.timestamp_ms;
                                let tx2 = tx.clone();
                                let s2 = stt.clone();
                                let last = last_transcription.clone();
                                tokio::spawn(async move {
                                    match stt::transcribe_async(s2, buf).await {
                                        Ok(text) => {
                                            let trimmed = text.trim();
                                            if should_send(trimmed, &last) {
                                                let _ = tx2.send(Ok(TranscriptionResult {
                                                    text: trimmed.to_string(),
                                                    confidence: 0.9,
                                                    is_final: true,
                                                    timestamp_ms: ts,
                                                })).await;
                                            }
                                        }
                                        Err(e) => {
                                            let _ = tx2.send(Err(Status::internal(e.to_string()))).await;
                                        }
                                    }
                                });
                                state = VadState::Silence;
                                silence_count = 0;
                                speech_count = 0;
                            }
                        }
                    }
                }
            }

            if !speech_buffer.is_empty() {
                let tx2 = tx.clone();
                let s2 = stt.clone();
                match stt::transcribe_async(s2, speech_buffer).await {
                    Ok(text) => {
                        let trimmed = text.trim();
                        if should_send(trimmed, &last_transcription) {
                            let _ = tx2.send(Ok(TranscriptionResult {
                                text: trimmed.to_string(),
                                confidence: 0.9,
                                is_final: true,
                                timestamp_ms: 0,
                            })).await;
                        }
                    }
                    Err(e) => {
                        let _ = tx2.send(Err(Status::internal(e.to_string()))).await;
                    }
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn watch_transcriptions(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<Self::WatchTranscriptionsStream>, Status> {
        let mut rx = self.transcription_tx.subscribe();
        let (tx, out_rx) = mpsc::channel::<Result<TranscriptionResult, Status>>(32);

        tokio::spawn(async move {
            while let Ok(result) = rx.recv().await {
                if tx.send(Ok(result)).await.is_err() {
                    break;
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(out_rx)))
    }

    async fn start_capture(
        &self,
        request: Request<CaptureConfig>,
    ) -> Result<Response<CaptureStatus>, Status> {
        let proto_config = request.into_inner();

        {
            let handle = self.capture_handle.lock().await;
            if handle.is_some() {
                return Err(Status::already_exists("Capture session already active"));
            }
        }

        // Clear PTT buffer for fresh recording
        self.ptt_buffer.lock().await.clear();
        *self.ptt_recording.lock().await = true;

        let (audio_tx, audio_rx) = mpsc::channel::<Vec<f32>>(256);
        let config = audio_capture::CaptureConfig {
            device_id: if proto_config.device_id.is_empty() {
                None
            } else {
                Some(proto_config.device_id)
            },
            sample_rate: if proto_config.sample_rate == 0 {
                16000
            } else {
                proto_config.sample_rate
            },
            vad_threshold: if proto_config.vad_threshold == 0.0 {
                0.5
            } else {
                proto_config.vad_threshold
            },
        };

        let audio_tx_clone = audio_tx.clone();
        let handle = audio_capture::start_capture(config, audio_tx)
            .map_err(|e| Status::internal(e.to_string()))?;

        let device_name = handle.device_name.clone();
        let capture_rx = audio_rx;

        *self.capture_handle.lock().await = Some(handle);
        *self.capture_tx.lock().await = Some(audio_tx_clone);
        *self.capture_rx.lock().await = None;

        let stt = self.stt.clone();
        let vad = self.vad.clone();
        let bcast = self.transcription_tx.clone();
        let level_tx = self.level_tx.clone();
        let ptt_buffer = self.ptt_buffer.clone();
        let ptt_recording = self.ptt_recording.clone();

        tokio::spawn(async move {
            let mut rx = capture_rx;

            let mut speech_buffer: Vec<f32> = Vec::new();
            let mut silence_count: u32 = 0;
            let mut speech_count: u32 = 0;
            let mut state = VadState::Silence;

            const SPEECH_ONSET: u32 = 3;
            const SILENCE_END: u32 = 8;
            const MAX_BUFFER_SAMPLES: usize = 30 * 16000;

            while let Some(samples) = rx.recv().await {
                if samples.is_empty() {
                    continue;
                }

                let is_speech = {
                    let mut v = vad.lock().await;
                    let result = v.is_speech(&samples);
                    if let Ok(speech) = result {
                        if speech {
                            tracing::info!("VAD: speech detected");
                        }
                        speech
                    } else {
                        false
                    }
                };
                let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
                let rms = (sum_sq / samples.len() as f32).sqrt().min(1.0);
                let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max).min(1.0);
                let _ = level_tx.send(AudioLevel {
                    rms,
                    peak,
                    is_speech,
                });

                {
                    let recording = ptt_recording.lock().await;
                    if *recording {
                        let mut buf = ptt_buffer.lock().await;
                        buf.extend_from_slice(&samples);
                    }
                }

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
                        } else if speech_buffer.len() >= MAX_BUFFER_SAMPLES {
                            let buf = std::mem::take(&mut speech_buffer);
                            let s2 = stt.clone();
                            let bcast2 = bcast.clone();
                            tokio::spawn(async move {
                                match stt::transcribe_async(s2, buf).await {
                                    Ok(text) => {
                                        let trimmed = text.trim().to_string();
                                        if !trimmed.is_empty() {
                                            let result = TranscriptionResult {
                                                text: trimmed,
                                                confidence: 0.9,
                                                is_final: true,
                                                timestamp_ms: 0,
                                            };
                                            let _ = bcast2.send(result);
                                        }
                                    }
                                    Err(_) => {}
                                }
                            });
                            state = VadState::Silence;
                            silence_count = 0;
                            speech_count = 0;
                        }
                    }
                    VadState::PostSpeech => {
                        if is_speech {
                            speech_buffer.extend_from_slice(&samples);
                            silence_count = 0;
                            state = VadState::Speech;
                        } else {
                            silence_count += 1;
                            if silence_count >= SILENCE_END {
                                let buf = std::mem::take(&mut speech_buffer);
                                let s2 = stt.clone();
                                let bcast2 = bcast.clone();
                                tokio::spawn(async move {
                                    match stt::transcribe_async(s2, buf).await {
                                        Ok(text) => {
                                            let trimmed = text.trim().to_string();
                                            if !trimmed.is_empty() {
                                                let result = TranscriptionResult {
                                                    text: trimmed,
                                                    confidence: 0.9,
                                                    is_final: true,
                                                    timestamp_ms: 0,
                                                };
                                                let _ = bcast2.send(result);
                                            }
                                        }
                                        Err(_) => {}
                                    }
                                });
                                state = VadState::Silence;
                                silence_count = 0;
                                speech_count = 0;
                            }
                        }
                    }
                }
            }
        });

        Ok(Response::new(CaptureStatus {
            active: true,
            device_name,
        }))
    }

    async fn stop_capture(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<CaptureStatus>, Status> {
        let handle = self.capture_handle.lock().await.take();
        if let Some(h) = handle {
            audio_capture::stop_capture(h);
        }

        self.capture_tx.lock().await.take();
        self.capture_rx.lock().await.take();

        {
            let mut v = self.vad.lock().await;
            v.reset();
        }

        Ok(Response::new(CaptureStatus {
            active: false,
            device_name: String::new(),
        }))
    }

    async fn list_devices(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<DeviceList>, Status> {
        let host = cpal::default_host();

        // ─── INPUT DEVICES ─────────────────────────────────────────────
        let default_input_name = host.default_input_device().and_then(|d| d.name().ok());
        let mut seen = std::collections::HashSet::new();
        let mut inputs = Vec::new();

        // PipeWire/PulseAudio sources via pactl
        if let Ok(output) = std::process::Command::new("pactl")
            .args(["list", "short", "sources"]).output()
        {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() < 2 { continue; }
                let id = parts[1];
                if id.contains(".monitor") || !id.starts_with("alsa_input.") { continue; }
                let name = friendly_name(id);
                if seen.insert(name.clone()) {
                    inputs.push(DeviceInfo { id: id.to_string(), name, is_default: false });
                }
            }
        }

        // ALSA (cpal) input devices
        if let Ok(iter) = host.input_devices() {
            for d in iter {
                let raw: String = match d.name() { Ok(n) => n, Err(_) => continue };
                if raw.starts_with("hw:") || raw.starts_with("dsnoop:") || raw.starts_with("iec958:")
                    || raw.starts_with("surround") || raw.starts_with("front:")
                    || raw.starts_with("sysdefault:") || raw.starts_with("plughw:") { continue; }
                let name = if raw == "pipewire" { "PipeWire".into() } else if raw == "pulse" { "PulseAudio".into() } else { raw.clone() };
                if seen.insert(name.clone()) {
                    inputs.push(DeviceInfo { id: raw.clone(), name, is_default: default_input_name.as_ref() == Some(&raw) });
                }
            }
        }

        // ─── OUTPUT DEVICES ────────────────────────────────────────────
        let default_output_name = host.default_output_device().and_then(|d| d.name().ok());
        seen.clear();
        let mut outputs = Vec::new();

        // PipeWire sinks via pactl
        if let Ok(out) = std::process::Command::new("pactl")
            .args(["list", "short", "sinks"]).output()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() < 2 { continue; }
                let id = parts[1];
                if !id.starts_with("alsa_output.") { continue; }
                let name = friendly_sink_name(id);
                if seen.insert(name.clone()) {
                    outputs.push(DeviceInfo { id: id.to_string(), name, is_default: false });
                }
            }
        }

        // ALSA output devices
        if let Ok(iter) = host.output_devices() {
            for d in iter {
                let raw: String = match d.name() { Ok(n) => n, Err(_) => continue };
                if raw.starts_with("hw:") || raw.starts_with("dsnoop:") || raw.starts_with("iec958:")
                    || raw.starts_with("surround") || raw.starts_with("front:")
                    || raw.starts_with("sysdefault:") || raw.starts_with("plughw:") { continue; }
                let name = if raw == "pipewire" { "PipeWire".into() } else if raw == "pulse" { "PulseAudio".into() } else { raw.clone() };
                if seen.insert(name.clone()) {
                    outputs.push(DeviceInfo { id: raw.clone(), name, is_default: default_output_name.as_ref() == Some(&raw) });
                }
            }
        }

        Ok(Response::new(DeviceList { inputs, outputs }))
    }

    async fn set_ptt_recording(
        &self,
        request: Request<PttRecordingRequest>,
    ) -> Result<Response<PttRecordingResponse>, Status> {
        let req = request.into_inner();
        let recording = req.recording;

        if recording {
            // Start recording: clear buffer and set flag
            self.ptt_buffer.lock().await.clear();
            *self.ptt_recording.lock().await = true;
            tracing::info!("[ptt] Recording started");
        } else {
            // Stop recording: just clear flag, buffer stays for force_transcribe
            *self.ptt_recording.lock().await = false;
            let buffered = self.ptt_buffer.lock().await.len();
            tracing::info!("[ptt] Recording stopped ({} samples buffered)", buffered);
        }

        let buffered = self.ptt_buffer.lock().await.len();
        Ok(Response::new(PttRecordingResponse {
            recording,
            buffered_samples: buffered as u64,
        }))
    }

    async fn set_output_device(
        &self,
        request: Request<SetDeviceRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        let device_id = req.device_id;

        // If it's a PipeWire sink, set it as default via pactl
        if device_id.starts_with("alsa_output.") {
            let _ = std::process::Command::new("pactl")
                .args(["set-default-sink", &device_id])
                .status();
        }

        // Recreate playback engine with new default
        match audio_playback::PlaybackEngine::new() {
            Ok(new_engine) => {
                let mut playback = self.playback.lock().await;
                *playback = new_engine;
                Ok(Response::new(Empty {}))
            }
            Err(e) => Err(Status::internal(format!("Failed to create playback: {:?}", e))),
        }
    }

    async fn watch_audio_level(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<Self::WatchAudioLevelStream>, Status> {
        let mut rx = self.level_tx.subscribe();
        let (tx, out_rx) = mpsc::channel::<Result<AudioLevel, Status>>(64);

        tokio::spawn(async move {
            while let Ok(level) = rx.recv().await {
                if tx.send(Ok(level)).await.is_err() {
                    break;
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(out_rx)))
    }

    async fn force_transcribe(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<TranscriptionResult>, Status> {
        // Stop PTT recording if still active
        {
            let mut rec = self.ptt_recording.lock().await;
            *rec = false;
        }

        // Take the buffer
        let samples = {
            let mut buf = self.ptt_buffer.lock().await;
            std::mem::take(&mut *buf)
        };

        if samples.len() < 8000 {
            return Ok(Response::new(TranscriptionResult {
                text: String::new(),
                confidence: 0.0,
                is_final: true,
                timestamp_ms: 0,
            }));
        }

        eprintln!("[force-transcribe] Transcribing {} samples ({:.1}s)",
            samples.len(), samples.len() as f32 / 16000.0);

        let backend = self.stt.clone();
        match stt::transcribe_ptt_async(backend, samples).await {
            Ok(text) => {
                eprintln!("[force-transcribe] Result: {:?}", text);
                Ok(Response::new(TranscriptionResult {
                    text,
                    confidence: 1.0,
                    is_final: true,
                    timestamp_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                }))
            }
            Err(e) => {
                Err(Status::internal(format!("Transcription failed: {:?}", e)))
            }
        }
    }

    async fn synthesize(
        &self,
        request: Request<SynthesizeRequest>,
    ) -> Result<Response<SynthesizeResponse>, Status> {
        let req = request.into_inner();

        if req.text.is_empty() {
            return Ok(Response::new(SynthesizeResponse {
                pcm_data: Vec::new(),
                visemes: Vec::new(),
            }));
        }

        let voice_id = if req.voice_id.is_empty() {
            "af_bella".to_string()
        } else {
            req.voice_id
        };

        let speed = if req.speed <= 0.0 { 1.0 } else { req.speed };
        let text = req.text.clone();
        let kokoro = Arc::clone(&self.kokoro);

        let (f32_samples, phoneme_events) =
            tokio::task::spawn_blocking(move || {
                kokoro.synthesize_internal(&text, &voice_id, speed)
            })
            .await
            .map_err(|e| {
                tracing::error!("[tts] synthesize task panicked: {}", e);
                Status::internal(e.to_string())
            })?
            .map_err(|e| {
                tracing::error!("[tts] synthesize error: {}", e);
                Status::internal(e.to_string())
            })?;

        let duration_ms = (f32_samples.len() as f64 / 24000.0) * 1000.0;
        tracing::info!(
            "[tts] synthesized '{}' -> {} samples ({:.0}ms)",
            req.text.chars().take(30).collect::<String>(),
            f32_samples.len(),
            duration_ms
        );

        if std::env::var("ALBEDO_DUMP_TTS").is_ok() {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 24000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            if let Ok(mut writer) = hound::WavWriter::create("/tmp/albedo-tts-debug.wav", spec) {
                for &s in &f32_samples {
                    let pcm = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    let _ = writer.write_sample(pcm);
                }
                let _ = writer.finalize();
            }
            tracing::info!("[tts] dumped debug WAV to /tmp/albedo-tts-debug.wav");
        }

        let visemes = lipsync::extract_visemes(&phoneme_events);
        let pcm_data = tts::f32_to_pcm16(&f32_samples);

        {
            let mut playback = self.playback.lock().await;
            let before = playback.is_empty();
            playback.enqueue(&f32_samples);
            tracing::info!(
                "[playback] enqueued {} samples (was_empty={}, playback_rate={})",
                f32_samples.len(),
                before,
                playback.sample_rate(),
            );
        }

        Ok(Response::new(SynthesizeResponse { pcm_data, visemes }))
    }

    async fn start_loopback(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<CaptureStatus>, Status> {
        Err(Status::unimplemented("StartLoopback is not yet implemented"))
    }

    async fn stop_loopback(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<CaptureStatus>, Status> {
        Err(Status::unimplemented("StopLoopback is not yet implemented"))
    }

    async fn clear_playback(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<Empty>, Status> {
        let mut playback = self.playback.lock().await;
        playback.clear();
        Ok(Response::new(Empty {}))
    }

    async fn wait_for_drain(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<Empty>, Status> {
        loop {
            let empty = {
                let playback = self.playback.lock().await;
                playback.is_empty()
            };
            if empty {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Ok(Response::new(Empty {}))
    }

    async fn enqueue_pcm(
        &self,
        request: Request<EnqueuePcmRequest>,
    ) -> Result<Response<EnqueuePcmResponse>, Status> {
        let req = request.into_inner();
        let pcm_data = req.pcm_data;
        let sample_rate = if req.sample_rate > 0 { req.sample_rate } else { 24000 };

        if pcm_data.is_empty() {
            return Ok(Response::new(EnqueuePcmResponse {
                samples_enqueued: 0,
                duration_ms: 0.0,
            }));
        }

        let f32_samples: Vec<f32> = pcm_data
            .chunks_exact(2)
            .map(|chunk| {
                let pcm = i16::from_le_bytes([chunk[0], chunk[1]]);
                pcm as f32 / i16::MAX as f32
            })
            .collect();

        let count = f32_samples.len();
        let duration_ms = (count as f64 / sample_rate as f64) * 1000.0;

        {
            let mut playback = self.playback.lock().await;
            playback.enqueue(&f32_samples);
        }

        tracing::info!(
            "[playback] enqueue_pcm: {} samples ({:.0}ms) from external TTS",
            count,
            duration_ms
        );

        Ok(Response::new(EnqueuePcmResponse {
            samples_enqueued: count as u32,
            duration_ms,
        }))
    }
}

fn should_send(trimmed: &str, last: &str) -> bool {
    if trimmed.is_empty() || trimmed.len() < 3 {
        return false;
    }
    let is_artifact = matches!(
        trimmed,
        "[BLANK_AUDIO]" | "(music)" | "(inaudible)" | "[BLANK_AUDIO] "
    ) || (trimmed.starts_with('[') && trimmed.ends_with(']'))
      || (trimmed.starts_with('(') && trimmed.ends_with(')'));
    if is_artifact {
        return false;
    }
    if trimmed == last.trim() {
        return false;
    }
    true
}

fn friendly_name(id: &str) -> String {
    if id.contains("HyperX") || id.contains("QuadCast") {
        "HyperX QuadCast S".into()
    } else if id.contains("G733") || id.contains("Headset") {
        "G733 Headset".into()
    } else if id.contains("Webcam") || id.contains("C922") {
        "Webcam (C922)".into()
    } else if id.contains("Generic") || id.contains("pci-") {
        "Motherboard Audio".into()
    } else {
        id.to_string()
    }
}

fn friendly_sink_name(id: &str) -> String {
    if id.contains("G733") || id.contains("Headset") {
        "G733 Headset".into()
    } else if id.contains("HyperX") || id.contains("QuadCast") {
        "HyperX QuadCast S".into()
    } else if id.contains("hdmi") {
        "HDMI Output".into()
    } else if id.contains("Generic") || id.contains("pci-") {
        "Motherboard Audio".into()
    } else {
        id.to_string()
    }
}
