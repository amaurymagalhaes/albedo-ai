use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tonic::transport::Server;
use tonic::Request;
use tokio_stream::wrappers::TcpListenerStream;

use albedo_audio::{audio_playback, stt, tts, vad, AlbedoAudioEngine, audio_proto};
use audio_proto::audio_engine_client::AudioEngineClient;
use audio_proto::audio_engine_server::AudioEngineServer;
use audio_proto::*;

fn whisper_path() -> String {
    std::env::var("WHISPER_MODEL").unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("whisper")
            .join("ggml-base.bin")
            .to_string_lossy()
            .into_owned()
    })
}

fn vad_path() -> String {
    std::env::var("VAD_MODEL").unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("vad")
            .join("silero_vad.onnx")
            .to_string_lossy()
            .into_owned()
    })
}

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

async fn start_test_server() -> u16 {
    let whisper = stt::WhisperEngine::new(&whisper_path()).unwrap();
    let vad_engine = vad::VadEngine::new(&vad_path(), 0.5).unwrap();
    let kokoro = tts::KokoroEngine::new(&kokoro_path(), &voices_path()).unwrap();
    let playback = audio_playback::PlaybackEngine::new().unwrap();

    let engine = AlbedoAudioEngine {
        whisper,
        vad: Arc::new(Mutex::new(vad_engine)),
        kokoro: Arc::new(kokoro),
        playback: Arc::new(Mutex::new(playback)),
        capture_tx: Arc::new(Mutex::new(None)),
        capture_handle: Arc::new(Mutex::new(None)),
        capture_rx: Arc::new(Mutex::new(None)),
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
#[ignore]
async fn test_grpc_synthesize_roundtrip() {
    let port = start_test_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let response = client
        .synthesize(SynthesizeRequest {
            text: "Phase two test.".to_string(),
            voice_id: "af_bella".to_string(),
            speed: 1.0,
        })
        .await
        .unwrap()
        .into_inner();

    assert!(!response.pcm_data.is_empty(), "PCM data should not be empty");
    assert!(!response.visemes.is_empty(), "Should have visemes");
    assert_eq!(response.pcm_data.len() % 2, 0, "PCM must be even-length (16-bit samples)");
}

#[tokio::test]
#[ignore]
async fn test_grpc_synthesize_empty_text() {
    let port = start_test_server().await;
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

    assert!(response.pcm_data.is_empty(), "Empty text should return empty PCM");
    assert!(response.visemes.is_empty(), "Empty text should return no visemes");
}

#[tokio::test]
#[ignore]
async fn test_grpc_synthesize_default_voice() {
    let port = start_test_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let response = client
        .synthesize(SynthesizeRequest {
            text: "Testing default voice.".to_string(),
            voice_id: "".to_string(),
            speed: 0.0,
        })
        .await
        .unwrap()
        .into_inner();

    assert!(!response.pcm_data.is_empty(), "Should work with default voice");
}
