use anyhow::{bail, Result};
use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;

pub struct VadEngine {
    session: Session,
    state: Array3<f32>,
    sample_rate: i64,
    pub threshold: f32,
}

impl VadEngine {
    pub fn new(model_path: &str, threshold: f32) -> Result<Self> {
        if !std::path::Path::new(model_path).exists() {
            bail!(
                "Silero VAD model not found at '{}'. \
                 Download with: wget -P assets/vad/ \
                 https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
                model_path
            );
        }

        let session = Session::builder()
            .map_err(|e| anyhow::anyhow!("Failed to create ONNX session builder: {:?}", e))?
            .with_intra_threads(1)
            .map_err(|e| anyhow::anyhow!("Failed to set ONNX intra threads: {:?}", e))?
            .commit_from_file(model_path)
            .map_err(|e| anyhow::anyhow!("Failed to load Silero VAD model: {:?}", e))?;

        let state = ndarray::Array3::zeros((2, 1, 128));

        Ok(Self {
            session,
            state,
            sample_rate: 16000,
            threshold,
        })
    }

    pub fn is_speech(&mut self, samples: &[f32]) -> Result<bool> {
        let chunk_size = 512;
        let mut padded = vec![0.0f32; chunk_size];
        let copy_len = samples.len().min(chunk_size);
        padded[..copy_len].copy_from_slice(&samples[..copy_len]);

        // VAD debug logging removed — was flooding stdout
        let input_array = ndarray::Array2::from_shape_vec((1, chunk_size), padded)?;
        let sr_array = ndarray::array![self.sample_rate];
        let state_array = self.state.clone();

        let input_tensor = Tensor::from_array(input_array)
            .map_err(|e| anyhow::anyhow!("Failed to create input tensor: {:?}", e))?;
        let sr_tensor = Tensor::from_array(sr_array)
            .map_err(|e| anyhow::anyhow!("Failed to create sr tensor: {:?}", e))?;
        let state_tensor = Tensor::from_array(state_array)
            .map_err(|e| anyhow::anyhow!("Failed to create state tensor: {:?}", e))?;

        let outputs = self
            .session
            .run(ort::inputs![
                "input" => input_tensor,
                "sr" => sr_tensor,
                "state" => state_tensor
            ])
            .map_err(|e| anyhow::anyhow!("VAD inference failed: {:?}", e))?;

        let (_, output_data) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("Failed to extract VAD output: {:?}", e))?;
        let speech_prob = output_data.first().copied().unwrap_or(0.0);

        let (_, state_data) = outputs["stateN"]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("Failed to extract state: {:?}", e))?;
        self.state = ndarray::Array3::from_shape_vec((2, 1, 128), state_data.to_vec())
            .map_err(|e| anyhow::anyhow!("Unexpected state shape: {:?}", e))?;

        Ok(speech_prob > self.threshold)
    }

    pub fn reset(&mut self) {
        self.state = ndarray::Array3::zeros((2, 1, 128));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_path() -> String {
        std::env::var("VAD_MODEL").unwrap_or_else(|_| "assets/vad/silero_vad.onnx".to_string())
    }

    #[test]
    fn test_vad_loads() {
        let vad = VadEngine::new(&model_path(), 0.5);
        assert!(vad.is_ok(), "VAD model failed to load: {:?}", vad.err());
    }

    #[test]
    fn test_vad_silence() {
        let mut vad = VadEngine::new(&model_path(), 0.5).unwrap();
        let silence = vec![0.0f32; 512];
        let result = vad.is_speech(&silence).unwrap();
        assert!(!result, "Expected silence for zero samples");
    }

    #[test]
    fn test_vad_state_resets() {
        let mut vad = VadEngine::new(&model_path(), 0.5).unwrap();
        for _ in 0..10 {
            let _ = vad.is_speech(&vec![0.0f32; 512]);
        }
        vad.reset();
        assert!(vad.state.iter().all(|&x| x == 0.0));
    }
}
