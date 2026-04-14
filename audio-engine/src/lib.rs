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

enum VadState {
    Silence,
    Speech,
    PostSpeech,
}

pub struct AlbedoAudioEngine {
    pub whisper: stt::WhisperEngine,
    pub vad: Arc<Mutex<vad::VadEngine>>,
    pub kokoro: Arc<tts::KokoroEngine>,
    pub playback: Arc<Mutex<audio_playback::PlaybackEngine>>,
    pub capture_tx: Arc<Mutex<Option<mpsc::Sender<Vec<f32>>>>>,
    pub capture_handle: Arc<Mutex<Option<audio_capture::CaptureHandle>>>,
    pub capture_rx: Arc<Mutex<Option<mpsc::Receiver<Vec<f32>>>>>,
    pub transcription_tx: broadcast::Sender<TranscriptionResult>,
}

#[tonic::async_trait]
impl AudioEngine for AlbedoAudioEngine {
    type StreamSTTStream = ReceiverStream<Result<TranscriptionResult, Status>>;
    type WatchTranscriptionsStream = ReceiverStream<Result<TranscriptionResult, Status>>;

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
                            let w2 = whisper.clone();
                            let last = last_transcription.clone();
                            tokio::spawn(async move {
                                match w2.transcribe_async(buf).await {
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
                                let w2 = whisper.clone();
                                let last = last_transcription.clone();
                                tokio::spawn(async move {
                                    match w2.transcribe_async(buf).await {
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
                let w2 = whisper.clone();
                match w2.transcribe_async(speech_buffer).await {
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

        let whisper = self.whisper.clone();
        let vad = self.vad.clone();
        let bcast = self.transcription_tx.clone();

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
                            let w2 = whisper.clone();
                            let bcast2 = bcast.clone();
                            tokio::spawn(async move {
                                match w2.transcribe_async(buf).await {
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
                                let w2 = whisper.clone();
                                let bcast2 = bcast.clone();
                                tokio::spawn(async move {
                                    match w2.transcribe_async(buf).await {
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

        let visemes = lipsync::extract_visemes(&phoneme_events);
        let pcm_data = tts::f32_to_pcm16(&f32_samples);

        {
            let mut playback = self.playback.lock().await;
            playback.enqueue(&f32_samples);
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
