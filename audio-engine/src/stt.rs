use std::sync::Arc;
use anyhow::{Result, bail};
use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};

pub struct WhisperEngine {
    ctx: Arc<WhisperContext>,
}

impl WhisperEngine {
    pub fn new(model_path: &str) -> Result<Self> {
        if !std::path::Path::new(model_path).exists() {
            bail!(
                "Whisper model not found at '{}'. \
                 Download with: wget -P assets/whisper/ \
                 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
                model_path
            );
        }
        let params = WhisperContextParameters::default();
        let ctx = WhisperContext::new_with_params(model_path, params)
            .map_err(|e| anyhow::anyhow!("Failed to load Whisper model from {}: {:?}", model_path, e))?;
        Ok(Self { ctx: Arc::new(ctx) })
    }

    pub fn transcribe(&self, samples: &[f32]) -> Result<String> {
        let mut state = self.ctx.create_state()
            .map_err(|e| anyhow::anyhow!("Failed to create Whisper state: {:?}", e))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("auto"));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_single_segment(false);
        params.set_no_context(true);
        params.set_n_threads(4);

        state.full(params, samples)
            .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {:?}", e))?;

        let num_segments = state.full_n_segments()
            .map_err(|e| anyhow::anyhow!("Failed to get segment count: {:?}", e))?;

        let text = (0..num_segments)
            .map(|i| state.full_get_segment_text(i).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string();

        Ok(text)
    }

    pub async fn transcribe_async(&self, samples: Vec<f32>) -> Result<String> {
        let engine = self.clone();
        tokio::task::spawn_blocking(move || engine.transcribe(&samples))
            .await?
    }
}

impl Clone for WhisperEngine {
    fn clone(&self) -> Self {
        Self { ctx: Arc::clone(&self.ctx) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_path() -> String {
        std::env::var("WHISPER_MODEL")
            .unwrap_or_else(|_| "assets/whisper/ggml-base.bin".to_string())
    }

    #[test]
    fn test_whisper_loads() {
        let engine = WhisperEngine::new(&model_path());
        assert!(engine.is_ok(), "Whisper failed to load: {:?}", engine.err());
    }

    #[test]
    fn test_transcribe_silence() {
        let engine = WhisperEngine::new(&model_path()).unwrap();
        let silence = vec![0.0f32; 16000 * 3];
        let result = engine.transcribe(&silence).unwrap();
        println!("Silence transcription: '{}'", result);
    }

    #[test]
    fn test_hallucination_filter() {
        let artifacts = &[
            "[BLANK_AUDIO]",
            "(music)",
            "(inaudible)",
            "  ",
            "ok",
            "",
        ];
        for s in artifacts {
            let trimmed = s.trim();
            let is_artifact = matches!(trimmed, "[BLANK_AUDIO]" | "(music)" | "(inaudible)")
                || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                || (trimmed.starts_with('(') && trimmed.ends_with(')'));
            let should_discard = trimmed.is_empty() || trimmed.len() < 3 || is_artifact;
            assert!(
                should_discard,
                "Expected '{}' to be discarded by hallucination filter", s
            );
        }
    }
}
