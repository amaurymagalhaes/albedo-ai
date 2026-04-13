use std::path::PathBuf;

fn model_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("assets")
}

fn whisper_path() -> String {
    std::env::var("WHISPER_MODEL")
        .unwrap_or_else(|_| model_dir().join("whisper").join("ggml-base.bin").to_string_lossy().into_owned())
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

#[tokio::test]
#[ignore]
async fn test_wav_file_transcription() {
    let wav_path = fixtures_dir().join("hello_world.wav");
    assert!(
        wav_path.exists(),
        "Test fixture not found at {:?}. Create with: sox -n -r 16000 -c 1 {}",
        wav_path,
        wav_path.display()
    );

    let mut reader = hound::WavReader::open(&wav_path).expect("Failed to open WAV file");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16000, "Test WAV must be 16 kHz, got {}", spec.sample_rate);
    assert_eq!(spec.channels, 1, "Test WAV must be mono, got {} channels", spec.channels);

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => {
            reader.samples::<f32>().map(|s| s.unwrap()).collect()
        }
        hound::SampleFormat::Int => {
            reader.samples::<i16>()
                .map(|s| s.unwrap() as f32 / i16::MAX as f32)
                .collect()
        }
    };

    assert!(!samples.is_empty(), "WAV file contains no samples");

    let engine = albedo_audio::stt::WhisperEngine::new(&whisper_path())
        .expect("Whisper model failed to load");

    let text = engine.transcribe_async(samples).await
        .expect("Transcription failed");

    println!("Transcription: '{}'", text);
    assert!(!text.trim().is_empty(), "Transcription should not be empty");
}
