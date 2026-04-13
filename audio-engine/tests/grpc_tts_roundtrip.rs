use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tonic::transport::Server;
use tonic::{Request, Response, Status};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};

use albedo_audio::{audio_playback, tts, audio_proto};
use audio_proto::audio_engine_client::AudioEngineClient;
use audio_proto::audio_engine_server::{AudioEngine, AudioEngineServer};
use audio_proto::*;

fn kokoro_path() -> String {
    std::env::var("KOKORO_MODEL").unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("voices")
            .join("kokoro-v1_0.onnx")
            .to_string_lossy()
            .into_owned()
    })
}

fn voices_path() -> String {
    std::env::var("VOICES_BIN").unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("voices")
            .join("voices.bin")
            .to_string_lossy()
            .into_owned()
    })
}

struct TtsOnlyEngine {
    kokoro: Arc<tts::KokoroEngine>,
    playback: Arc<Mutex<audio_playback::PlaybackEngine>>,
}

#[tonic::async_trait]
impl AudioEngine for TtsOnlyEngine {
    type StreamSTTStream = ReceiverStream<Result<TranscriptionResult, Status>>;
    type WatchTranscriptionsStream = ReceiverStream<Result<TranscriptionResult, Status>>;

    async fn stream_stt(
        &self,
        _: Request<tonic::Streaming<AudioChunk>>,
    ) -> Result<Response<Self::StreamSTTStream>, Status> {
        Err(Status::unimplemented("STT not available in TTS-only mode"))
    }

    async fn watch_transcriptions(
        &self,
        _: Request<Empty>,
    ) -> Result<Response<Self::WatchTranscriptionsStream>, Status> {
        Err(Status::unimplemented("WatchTranscriptions not available"))
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
            tokio::task::spawn_blocking(move || kokoro.synthesize_internal(&text, &voice_id, speed))
                .await
                .map_err(|e| Status::internal(e.to_string()))?
                .map_err(|e| Status::internal(e.to_string()))?;

        let visemes = albedo_audio::lipsync::extract_visemes(&phoneme_events);
        let pcm_data = tts::f32_to_pcm16(&f32_samples);

        {
            let mut playback = self.playback.lock().await;
            playback.enqueue(&f32_samples);
        }

        Ok(Response::new(SynthesizeResponse { pcm_data, visemes }))
    }

    async fn start_capture(
        &self,
        _: Request<CaptureConfig>,
    ) -> Result<Response<CaptureStatus>, Status> {
        Err(Status::unimplemented("Capture not available in TTS-only mode"))
    }

    async fn stop_capture(
        &self,
        _: Request<Empty>,
    ) -> Result<Response<CaptureStatus>, Status> {
        Err(Status::unimplemented("Capture not available in TTS-only mode"))
    }

    async fn start_loopback(
        &self,
        _: Request<Empty>,
    ) -> Result<Response<CaptureStatus>, Status> {
        Err(Status::unimplemented("Loopback not available"))
    }

    async fn stop_loopback(
        &self,
        _: Request<Empty>,
    ) -> Result<Response<CaptureStatus>, Status> {
        Err(Status::unimplemented("Loopback not available"))
    }
}

async fn start_tts_server() -> u16 {
    let kokoro = tts::KokoroEngine::new(&kokoro_path(), &voices_path()).unwrap();
    let playback = audio_playback::PlaybackEngine::new().unwrap();

    let engine = TtsOnlyEngine {
        kokoro: Arc::new(kokoro),
        playback: Arc::new(Mutex::new(playback)),
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        Server::builder()
            .add_service(AudioEngineServer::new(engine))
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await
            .unwrap();
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    port
}

#[tokio::test]
async fn test_grpc_synthesize_roundtrip() {
    let port = start_tts_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let response = client
        .synthesize(SynthesizeRequest {
            text: "Hello, this is a gRPC roundtrip test.".to_string(),
            voice_id: "af_bella".to_string(),
            speed: 1.0,
        })
        .await
        .unwrap()
        .into_inner();

    assert!(
        !response.pcm_data.is_empty(),
        "PCM data should not be empty"
    );
    assert!(
        !response.visemes.is_empty(),
        "Should produce visemes for lip sync"
    );
    assert_eq!(
        response.pcm_data.len() % 2,
        0,
        "PCM must be even-length (16-bit samples)"
    );

    println!(
        "[roundtrip] pcm_bytes={}, visemes={}",
        response.pcm_data.len(),
        response.visemes.len()
    );
}

#[tokio::test]
async fn test_grpc_empty_text_returns_empty() {
    let port = start_tts_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let response = client
        .synthesize(SynthesizeRequest {
            text: "".to_string(),
            voice_id: "af_bella".to_string(),
            speed: 1.0,
        })
        .await
        .unwrap()
        .into_inner();

    assert!(response.pcm_data.is_empty(), "Empty text → empty PCM");
    assert!(response.visemes.is_empty(), "Empty text → no visemes");
}

#[tokio::test]
async fn test_grpc_multiple_sequential_calls() {
    let port = start_tts_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let sentences = [
        "First sentence.",
        "Second sentence, a bit longer than the first.",
        "Third.",
    ];

    for (i, text) in sentences.iter().enumerate() {
        let response = client
            .synthesize(SynthesizeRequest {
                text: text.to_string(),
                voice_id: "af_bella".to_string(),
                speed: 1.0,
            })
            .await
            .unwrap()
            .into_inner();

        assert!(
            !response.pcm_data.is_empty(),
            "Call {} should produce audio for '{}'",
            i + 1,
            text
        );
        println!(
            "[roundtrip] call {}: '{}' → {} bytes, {} visemes",
            i + 1,
            text,
            response.pcm_data.len(),
            response.visemes.len()
        );
    }
}

#[tokio::test]
async fn test_grpc_default_voice_fallback() {
    let port = start_tts_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let response = client
        .synthesize(SynthesizeRequest {
            text: "Testing with default voice.".to_string(),
            voice_id: "".to_string(),
            speed: 0.0,
        })
        .await
        .unwrap()
        .into_inner();

    assert!(
        !response.pcm_data.is_empty(),
        "Should work with empty voice_id (falls back to default)"
    );
}

#[tokio::test]
async fn test_grpc_unknown_voice_still_works() {
    let port = start_tts_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let response = client
        .synthesize(SynthesizeRequest {
            text: "Unknown voice test.".to_string(),
            voice_id: "nonexistent_voice".to_string(),
            speed: 1.0,
        })
        .await
        .unwrap()
        .into_inner();

    assert!(
        !response.pcm_data.is_empty(),
        "Should fall back to af_bella for unknown voice"
    );
}

#[tokio::test]
async fn test_grpc_stt_returns_unimplemented() {
    let port = start_tts_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let result = client
        .start_capture(Request::new(CaptureConfig {
            device_id: String::new(),
            sample_rate: 16000,
            vad_threshold: 0.5,
        }))
        .await;

    assert!(result.is_err(), "STT methods should return UNIMPLEMENTED");
    let err = result.unwrap_err();
    assert_eq!(err.code(), tonic::Code::Unimplemented);
}

#[tokio::test]
async fn test_grpc_synthesize_latency() {
    let port = start_tts_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let warmup = client
        .synthesize(SynthesizeRequest {
            text: "Warmup.".to_string(),
            voice_id: "af_bella".to_string(),
            speed: 1.0,
        })
        .await
        .unwrap();
    drop(warmup);

    let sentences = [
        "Hello.",
        "How are you today?",
        "This is a longer sentence to test synthesis performance.",
        "The quick brown fox jumps over the lazy dog.",
    ];

    println!("\n[gRPC latency]");
    println!("{:<50} {:>10} {:>10} {:>10}", "Sentence", "Total(ms)", "PCM", "Visemes");
    println!("{}", "-".repeat(82));

    for text in &sentences {
        let start = Instant::now();
        let response = client
            .synthesize(SynthesizeRequest {
                text: text.to_string(),
                voice_id: "af_bella".to_string(),
                speed: 1.0,
            })
            .await
            .unwrap()
            .into_inner();
        let elapsed = start.elapsed();

        println!(
            "{:<50} {:>8.1}ms {:>8}B {:>8}",
            if text.len() > 47 { format!("{}...", &text[..44]) } else { text.to_string() },
            elapsed.as_secs_f64() * 1000.0,
            response.pcm_data.len(),
            response.visemes.len()
        );

        assert!(!response.pcm_data.is_empty());
    }
}
