use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tonic::transport::Server;
use tonic::Request;
use tokio_stream::wrappers::TcpListenerStream;
use tokio_stream::StreamExt;

use albedo_audio::{stt, vad, AlbedoAudioEngine, audio_proto};
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

async fn start_test_server() -> u16 {
    let whisper = stt::WhisperEngine::new(&whisper_path()).unwrap();
    let vad_engine = vad::VadEngine::new(&vad_path(), 0.5).unwrap();

    let engine = AlbedoAudioEngine {
        whisper,
        vad: Arc::new(Mutex::new(vad_engine)),
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
async fn test_start_stop_capture() {
    let port = start_test_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let status = client
        .start_capture(Request::new(CaptureConfig {
            device_id: String::new(),
            sample_rate: 16000,
            vad_threshold: 0.5,
        }))
        .await
        .unwrap()
        .into_inner();

    assert!(status.active, "Expected active after StartCapture");
    assert!(!status.device_name.is_empty(), "Expected non-empty device name");

    let status = client
        .stop_capture(Request::new(Empty {}))
        .await
        .unwrap()
        .into_inner();
    assert!(!status.active, "Expected inactive after StopCapture");
}

#[tokio::test]
#[ignore]
async fn test_double_start_capture_fails() {
    let port = start_test_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let config = CaptureConfig {
        device_id: String::new(),
        sample_rate: 16000,
        vad_threshold: 0.5,
    };

    let _ = client.start_capture(Request::new(config.clone())).await.unwrap();
    let second = client.start_capture(Request::new(config)).await;
    assert!(second.is_err(), "Expected error for double StartCapture");

    let _ = client.stop_capture(Request::new(Empty {})).await.unwrap();
}

#[tokio::test]
#[ignore]
async fn test_stream_stt_with_silence() {
    let port = start_test_server().await;
    let mut client = AudioEngineClient::connect(format!("http://127.0.0.1:{}", port))
        .await
        .unwrap();

    let silence: Vec<f32> = vec![0.0f32; 512];
    let pcm_bytes: Vec<u8> = silence.iter().flat_map(|s| s.to_le_bytes()).collect();

    let chunks: Vec<AudioChunk> = (0..100)
        .map(|i| AudioChunk {
            pcm_data: pcm_bytes.clone(),
            sample_rate: 16000,
            is_speech: false,
            timestamp_ms: i as u64 * 32,
        })
        .collect();

    let stream = tokio_stream::iter(chunks);
    let response = client.stream_stt(stream).await.unwrap();
    let mut response_stream = response.into_inner();

    let mut results = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(result) = response_stream.next().await {
            results.push(result);
        }
    })
    .await;

    let clean = results.iter().all(|r| match r {
        Ok(r) => r.text.trim().is_empty() || r.text.trim().len() < 3,
        Err(_) => false,
    });
    assert!(
        clean,
        "Silence should not produce valid transcriptions (hallucination filter)"
    );
}
