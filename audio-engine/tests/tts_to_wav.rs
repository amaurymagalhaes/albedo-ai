use albedo_audio::tts;

fn kokoro_path() -> String {
    std::env::var("KOKORO_MODEL").unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("voices")
            .join("kokoro-v1_0.onnx")
            .to_string_lossy()
            .into_owned()
    })
}

fn voices_path() -> String {
    std::env::var("VOICES_BIN").unwrap_or_else(|_| {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("voices")
            .join("voices.bin")
            .to_string_lossy()
            .into_owned()
    })
}

#[tokio::test]
#[ignore]
async fn test_synthesize_to_wav() {
    let engine = tts::KokoroEngine::new(&kokoro_path(), &voices_path())
        .expect("failed to load Kokoro model");

    let (pcm_bytes, visemes) = engine
        .synthesize("Hello, I am Albedo.", "af_bella", 1.0)
        .expect("synthesis failed");

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 22_050,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create("/tmp/test_output.wav", spec).unwrap();
    for chunk in pcm_bytes.chunks(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
        writer.write_sample(sample).unwrap();
    }
    writer.finalize().unwrap();

    assert!(!pcm_bytes.is_empty(), "PCM data should not be empty");
    assert!(!visemes.is_empty(), "Should have at least one viseme");
    assert!(pcm_bytes.len() > 22_050 * 2, "Should be at least 1 second of audio");

    println!("Output written to /tmp/test_output.wav");
    println!("Visemes: {:?}", visemes);
}
