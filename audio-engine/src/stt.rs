pub struct WhisperEngine;
impl WhisperEngine {
    pub fn new(_model_path: &str) -> Result<Self, Box<dyn std::error::Error>> { Ok(WhisperEngine) }
    pub async fn transcribe(&self, _samples: &[f32]) -> String { String::new() }
}
