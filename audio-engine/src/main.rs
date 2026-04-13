use std::sync::Arc;
use tokio::sync::Mutex;
use tonic::transport::Server;
use albedo_audio::{AlbedoAudioEngine, audio_proto, stt, vad};
use audio_proto::audio_engine_server::AudioEngineServer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let whisper_path = std::env::var("WHISPER_MODEL")
        .unwrap_or_else(|_| "assets/whisper/ggml-base.bin".to_string());
    let vad_path = std::env::var("VAD_MODEL")
        .unwrap_or_else(|_| "assets/vad/silero_vad.onnx".to_string());

    tracing::info!("Loading Whisper model from: {}", whisper_path);
    let whisper = stt::WhisperEngine::new(&whisper_path)?;

    tracing::info!("Loading VAD model from: {}", vad_path);
    let vad_engine = vad::VadEngine::new(&vad_path, 0.5)?;

    let engine = AlbedoAudioEngine {
        whisper,
        vad: Arc::new(Mutex::new(vad_engine)),
        capture_tx: Arc::new(Mutex::new(None)),
        capture_handle: Arc::new(Mutex::new(None)),
        capture_rx: Arc::new(Mutex::new(None)),
    };

    #[cfg(unix)]
    {
        use tokio::net::UnixListener;
        use tokio_stream::wrappers::UnixListenerStream;

        let socket_path = "/tmp/albedo-audio.sock";
        let _ = std::fs::remove_file(socket_path);
        let uds = UnixListener::bind(socket_path)?;
        let stream = UnixListenerStream::new(uds);

        tracing::info!("Starting gRPC server on {}", socket_path);
        Server::builder()
            .add_service(AudioEngineServer::new(engine))
            .serve_with_incoming(stream)
            .await?;
    }

    #[cfg(not(unix))]
    {
        let addr = "[::1]:50051".parse()?;
        tracing::info!("Starting gRPC server on {}", addr);
        Server::builder()
            .add_service(AudioEngineServer::new(engine))
            .serve(addr)
            .await?;
    }

    Ok(())
}
