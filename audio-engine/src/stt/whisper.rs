use anyhow::{bail, Result};
use std::sync::Arc;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::SttBackend;

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
        let mut params = WhisperContextParameters::default();
        params.use_gpu = true;
        params.gpu_device = 0;
        let ctx = WhisperContext::new_with_params(model_path, params).map_err(|e| {
            anyhow::anyhow!("Failed to load Whisper model from {}: {:?}", model_path, e)
        })?;
        Ok(Self { ctx: Arc::new(ctx) })
    }

    fn transcribe_with_language(&self, samples: &[f32], language: Option<&str>) -> Result<String> {
        let (text, _) = self.transcribe_with_lang_id(samples, language)?;
        Ok(text)
    }

    fn transcribe_with_lang_id(
        &self,
        samples: &[f32],
        language: Option<&str>,
    ) -> Result<(String, i32)> {
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| anyhow::anyhow!("Failed to create Whisper state: {:?}", e))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(language);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_single_segment(false);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_n_threads(4);
        params.set_initial_prompt("Albedo é uma assistente virtual. O nome dela é Albedo.");

        state
            .full(params, samples)
            .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {:?}", e))?;

        let lang_id = state.full_lang_id_from_state().unwrap_or(-1);

        let num_segments = state
            .full_n_segments()
            .map_err(|e| anyhow::anyhow!("Failed to get segment count: {:?}", e))?;

        let text = (0..num_segments)
            .map(|i| state.full_get_segment_text(i).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string();

        Ok((text, lang_id))
    }

    fn trim_silence(samples: &[f32], threshold: f32) -> Vec<f32> {
        if samples.is_empty() {
            return Vec::new();
        }

        let window = 512;
        let mut start = 0;
        let mut end = samples.len();

        for i in (0..samples.len().saturating_sub(window)).step_by(window) {
            let rms: f32 =
                samples[i..i + window].iter().map(|s| s * s).sum::<f32>() / window as f32;
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

    fn looks_like_hallucination(text: &str) -> bool {
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.len() < 2 {
            return true;
        }
        let artifacts = [
            "thank you",
            "thanks for watching",
            "subscribe",
            "please subscribe",
            "♪",
            "[BLANK_AUDIO]",
            "(music)",
            "(inaudible)",
            "over and out",
            "the end",
        ];
        let lower = trimmed.to_lowercase();
        for artifact in &artifacts {
            if lower == *artifact || lower.starts_with(artifact) {
                return true;
            }
        }
        let latin: f32 = trimmed.matches(|c: char| c.is_ascii_alphabetic()).count() as f32;
        let total: f32 = trimmed.chars().filter(|c| c.is_alphabetic()).count() as f32;
        if total > 3.0 && latin / total < 0.4 {
            return true;
        }
        let words: Vec<&str> = lower.split_whitespace().collect();
        if words.len() >= 4 {
            let unique: std::collections::HashSet<&str> = words.iter().copied().collect();
            if unique.len() <= 2 {
                return true;
            }
        }
        false
    }
}

impl SttBackend for WhisperEngine {
    fn transcribe(&self, samples: &[f32]) -> Result<String> {
        self.transcribe_with_language(samples, Some("auto"))
    }

    fn transcribe_ptt(&self, samples: &[f32]) -> Result<String> {
        let trimmed = Self::trim_silence(samples, 0.008);
        if trimmed.len() < 8000 {
            return Ok(String::new());
        }

        let (text, lang_id) = self.transcribe_with_lang_id(&trimmed, Some("auto"))?;

        if Self::looks_like_hallucination(&text) {
            return Ok(String::new());
        }

        const LANG_PORTUGUESE: i32 = 10;
        if lang_id != LANG_PORTUGUESE && !text.is_empty() {
            let has_pt_indicators = text.contains("ã")
                || text.contains("ç")
                || text.contains("é")
                || text.contains("á")
                || text.contains("ê")
                || text.contains("tá")
                || text.contains("não")
                || text.contains("né")
                || text.contains("pô")
                || text.contains("né")
                || text.contains("bem")
                || text.contains("tudo")
                || text.contains("olha")
                || text.contains("velho")
                || text.contains("não")
                || text.contains("estou")
                || text.contains("jogando");

            if has_pt_indicators {
                eprintln!("[whisper] Auto-detect chose lang_id={}, but text has Portuguese indicators. Re-running with pt.", lang_id);
                let (text_pt, _) = self.transcribe_with_lang_id(&trimmed, Some("pt"))?;
                if !text_pt.is_empty() && !Self::looks_like_hallucination(&text_pt) {
                    return Ok(text_pt);
                }
            }
        }

        Ok(text)
    }

    fn clone_boxed(&self) -> Box<dyn SttBackend> {
        Box::new(WhisperEngine {
            ctx: Arc::clone(&self.ctx),
        })
    }
}
