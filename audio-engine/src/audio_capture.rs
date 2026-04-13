use crate::audio_proto::CaptureConfig;
pub async fn start(_config: CaptureConfig) -> Result<(), Box<dyn std::error::Error>> { Ok(()) }
pub async fn stop() {}
