pub mod whisper;
pub mod qwen3;

use anyhow::Result;

pub trait SttBackend: Send + Sync + 'static {
    fn transcribe(&self, samples: &[f32]) -> Result<String>;
    fn transcribe_ptt(&self, samples: &[f32]) -> Result<String>;
    fn clone_boxed(&self) -> Box<dyn SttBackend>;
}

impl Clone for Box<dyn SttBackend> {
    fn clone(&self) -> Self {
        self.clone_boxed()
    }
}

pub async fn transcribe_async(backend: Box<dyn SttBackend>, samples: Vec<f32>) -> Result<String> {
    tokio::task::spawn_blocking(move || backend.transcribe(&samples))
        .await?
}

pub async fn transcribe_ptt_async(backend: Box<dyn SttBackend>, samples: Vec<f32>) -> Result<String> {
    tokio::task::spawn_blocking(move || backend.transcribe_ptt(&samples))
        .await?
}

pub fn create_backend(backend_name: &str) -> Result<Box<dyn SttBackend>> {
    match backend_name {
        "qwen3" => {
            let model_path = std::env::var("QWEN3_ASR_MODEL")
                .unwrap_or_else(|_| "assets/stt/qwen3-asr-1.7b.onnx".to_string());
            tracing::info!("Loading Qwen3-ASR model from: {}", model_path);
            Ok(Box::new(qwen3::Qwen3AsrEngine::new(&model_path)?))
        }
        _ => {
            let model_path = std::env::var("WHISPER_MODEL")
                .unwrap_or_else(|_| {
                    let turbo = "assets/whisper/ggml-large-v3-turbo.bin";
                    let medium = "assets/whisper/ggml-medium.bin";
                    if std::path::Path::new(turbo).exists() {
                        turbo.to_string()
                    } else if std::path::Path::new(medium).exists() {
                        tracing::warn!("Turbo model not found, falling back to medium");
                        medium.to_string()
                    } else {
                        turbo.to_string()
                    }
                });
            tracing::info!("Loading Whisper model from: {}", model_path);
            Ok(Box::new(whisper::WhisperEngine::new(&model_path)?))
        }
    }
}
