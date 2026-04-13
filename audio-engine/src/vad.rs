use anyhow::{bail, Result};
use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;

pub struct VadEngine {
    session: Session,
    h: Array3<f32>,
    c: Array3<f32>,
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

        let h = Array3::zeros((1, 1, 64));
        let c = Array3::zeros((1, 1, 64));

        Ok(Self {
            session,
            h,
            c,
            sample_rate: 16000,
            threshold,
        })
    }

    pub fn is_speech(&mut self, samples: &[f32]) -> Result<bool> {
        let chunk_size = 512;
        let mut padded = vec![0.0f32; chunk_size];
        let copy_len = samples.len().min(chunk_size);
        padded[..copy_len].copy_from_slice(&samples[..copy_len]);

        let input_array = ndarray::Array2::from_shape_vec((1, chunk_size), padded)?;
        let sr_array = ndarray::array![self.sample_rate];

        let input_tensor = Tensor::from_array(input_array)
            .map_err(|e| anyhow::anyhow!("Failed to create input tensor: {:?}", e))?;
        let sr_tensor = Tensor::from_array(sr_array)
            .map_err(|e| anyhow::anyhow!("Failed to create sr tensor: {:?}", e))?;
        let h_tensor = Tensor::from_array(self.h.clone())
            .map_err(|e| anyhow::anyhow!("Failed to create h tensor: {:?}", e))?;
        let c_tensor = Tensor::from_array(self.c.clone())
            .map_err(|e| anyhow::anyhow!("Failed to create c tensor: {:?}", e))?;

        let outputs = self
            .session
            .run(ort::inputs![
                "input" => input_tensor,
                "sr" => sr_tensor,
                "h" => h_tensor,
                "c" => c_tensor
            ])
            .map_err(|e| anyhow::anyhow!("VAD inference failed: {:?}", e))?;

        let (_, output_data) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("Failed to extract VAD output: {:?}", e))?;
        let speech_prob = output_data.first().copied().unwrap_or(0.0);

        let (_, hn_data) = outputs["hn"]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("Failed to extract hidden state: {:?}", e))?;
        self.h = ndarray::Array3::from_shape_vec((1, 1, 64), hn_data.to_vec())
            .map_err(|e| anyhow::anyhow!("Unexpected hn shape: {:?}", e))?;

        let (_, cn_data) = outputs["cn"]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("Failed to extract cell state: {:?}", e))?;
        self.c = ndarray::Array3::from_shape_vec((1, 1, 64), cn_data.to_vec())
            .map_err(|e| anyhow::anyhow!("Unexpected cn shape: {:?}", e))?;

        Ok(speech_prob > self.threshold)
    }

    pub fn reset(&mut self) {
        self.h = Array3::zeros((1, 1, 64));
        self.c = Array3::zeros((1, 1, 64));
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
        assert!(vad.h.iter().all(|&x| x == 0.0));
        assert!(vad.c.iter().all(|&x| x == 0.0));
    }
}
