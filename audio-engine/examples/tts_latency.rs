use albedo_audio::tts;
use std::time::Instant;

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

fn main() {
    println!("Loading Kokoro model...");
    let engine = tts::KokoroEngine::new(&kokoro_path(), &voices_path())
        .expect("failed to load Kokoro model");

    println!("Warmup inference...");
    let _ = engine.synthesize("warmup", "af_bella", 1.0);

    let sentences = [
        "The weather today is quite pleasant.",
        "Hello, I am Albedo.",
        "Phase two test.",
    ];

    for sentence in &sentences {
        let start = Instant::now();
        let result = engine.synthesize(sentence, "af_bella", 1.0);
        let elapsed = start.elapsed();

        match result {
            Ok((pcm, visemes)) => {
                let audio_secs = pcm.len() as f64 / (22050.0 * 2.0);
                let status = if elapsed.as_millis() < 150 {
                    "OK"
                } else {
                    "SLOW"
                };
                println!(
                    "[{}] {:?} → {:.0}ms (audio: {:.2}s, {} visemes)",
                    status,
                    sentence,
                    elapsed.as_millis(),
                    audio_secs,
                    visemes.len(),
                );
            }
            Err(e) => {
                println!("[FAIL] {:?} → error: {}", sentence, e);
            }
        }
    }
}
