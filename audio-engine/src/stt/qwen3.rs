use anyhow::{bail, Result};
use ort::session::Session;
use std::sync::Arc;

use super::SttBackend;

pub struct Qwen3AsrEngine {
    session: Arc<Session>,
}

impl Qwen3AsrEngine {
    pub fn new(model_path: &str) -> Result<Self> {
        if !std::path::Path::new(model_path).exists() {
            bail!(
                "Qwen3-ASR ONNX model not found at '{}'. \
                 Export the model to ONNX first. See: https://github.com/QwenLM/Qwen3-ASR",
                model_path
            );
        }

        tracing::info!("[qwen3-asr] Loading ONNX session from: {}", model_path);
        let session = Session::builder()?.commit_from_file(model_path)?;

        tracing::info!("[qwen3-asr] Model loaded successfully");
        Ok(Self {
            session: Arc::new(session),
        })
    }

    fn run_inference(&self, samples: &[f32]) -> Result<String> {
        tracing::info!(
            "[qwen3-asr] Running inference on {} samples ({:.1}s)",
            samples.len(),
            samples.len() as f32 / 16000.0
        );

        // TODO: Implement full ONNX inference pipeline:
        // 1. Extract log-Mel spectrogram features
        // 2. Run encoder session
        // 3. Run decoder with token generation
        // 4. Decode tokens to text

        let _ = &self.session;
        tracing::warn!("[qwen3-asr] Inference not yet implemented — returning empty string");
        Ok(String::new())
    }
}

impl SttBackend for Qwen3AsrEngine {
    fn transcribe(&self, samples: &[f32]) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        self.run_inference(samples)
    }

    fn transcribe_ptt(&self, samples: &[f32]) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let trimmed = trim_silence(samples, 0.008);
        if trimmed.len() < 8000 {
            return Ok(String::new());
        }
        self.run_inference(&trimmed)
    }

    fn clone_boxed(&self) -> Box<dyn SttBackend> {
        Box::new(Qwen3AsrEngine {
            session: Arc::clone(&self.session),
        })
    }
}

fn trim_silence(samples: &[f32], threshold: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let window = 512;
    let mut start = 0;
    let mut end = samples.len();

    for i in (0..samples.len().saturating_sub(window)).step_by(window) {
        let rms: f32 = samples[i..i + window].iter().map(|s| s * s).sum::<f32>() / window as f32;
        if rms.sqrt() > threshold {
            start = i.saturating_sub(window * 2);
            break;
        }
    }

    for i in (0..samples.len().saturating_sub(window))
        .step_by(window)
        .rev()
    {
        let rms: f32 = samples[i..i + window.min(samples.len() - i)]
            .iter()
            .map(|s| s * s)
            .sum::<f32>()
            / window.min(samples.len() - i) as f32;
        if rms.sqrt() > threshold {
            end = (i + window * 3).min(samples.len());
            break;
        }
    }

    if start >= end {
        return Vec::new();
    }

    samples[start..end].to_vec()
}
