use crate::audio_proto::Viseme;
pub struct KokoroEngine;
impl KokoroEngine {
    pub fn new(_model_path: &str) -> Result<Self, Box<dyn std::error::Error>> { Ok(KokoroEngine) }
    pub async fn synthesize(&self, _text: &str, _voice_id: &str, _speed: f32)
        -> Result<(Vec<u8>, Vec<Viseme>), Box<dyn std::error::Error>>
    {
        Ok((Vec::new(), Vec::new()))
    }
}
