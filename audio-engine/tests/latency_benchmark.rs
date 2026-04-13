use std::time::Instant;

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

const RTF_TARGET: f64 = 0.65;

struct BenchmarkResult {
    latency_ms: f64,
    audio_duration_ms: f64,
    real_time_factor: f64,
}

fn run_benchmark(engine: &tts::KokoroEngine, text: &str, voice: &str) -> BenchmarkResult {
    let start = Instant::now();
    let (pcm_bytes, _visemes) = engine.synthesize(text, voice, 1.0).unwrap();
    let elapsed = start.elapsed();

    let latency_ms = elapsed.as_secs_f64() * 1000.0;
    let num_samples = pcm_bytes.len() / 2;
    let audio_duration_ms = (num_samples as f64 / 22050.0) * 1000.0;
    let real_time_factor = if audio_duration_ms > 0.0 {
        latency_ms / audio_duration_ms
    } else {
        0.0
    };

    BenchmarkResult {
        latency_ms,
        audio_duration_ms,
        real_time_factor,
    }
}

fn print_header(title: &str) {
    println!();
    println!("=== {} ===", title);
    println!(
        "{:<50} {:>8} {:>8} {:>6} {:>6}",
        "Sentence", "Lat(ms)", "Dur(ms)", "RTF", "Pass"
    );
    println!("{}", "─".repeat(80));
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() > max {
        format!("{}...", &text[..max - 3])
    } else {
        text.to_string()
    }
}

#[test]
fn test_streaming_rtf() {
    let engine = tts::KokoroEngine::new(&kokoro_path(), &voices_path())
        .expect("Failed to load Kokoro model");

    let _ = engine.synthesize("Warmup.", "af_bella", 1.0).unwrap();

    let sentences: &[&str] = &[
        "Hi there!",
        "How are you?",
        "Sure, let me check that for you.",
        "The weather today is looking quite pleasant.",
        "I found the information you were looking for.",
        "Would you like me to open that application?",
        "Olá, como posso te ajudar?",
        "That's an interesting question.",
        "Let me think about that for a moment.",
        "I can help you with that task.",
        "The quick brown fox jumps over the lazy dog.",
        "This sentence has numbers like 42 in it!",
    ];

    print_header(&format!("Streaming RTF (target < {RTF_TARGET})"));

    let mut all_pass = true;
    let mut latencies = Vec::new();
    let mut rtfs = Vec::new();

    for text in sentences {
        let r = run_benchmark(&engine, text, "af_bella");
        let pass = r.real_time_factor < RTF_TARGET;
        if !pass {
            all_pass = false;
        }
        latencies.push(r.latency_ms);
        rtfs.push(r.real_time_factor);

        println!(
            "{:<50} {:>7.1} {:>7.1} {:>5.3} {:>6}",
            truncate(text, 47),
            r.latency_ms,
            r.audio_duration_ms,
            r.real_time_factor,
            if pass { "✓" } else { "✗" }
        );
    }

    let avg_ms = latencies.iter().sum::<f64>() / latencies.len() as f64;
    let max_ms = latencies.iter().fold(f64::MIN, |a, b| a.max(*b));
    let min_ms = latencies.iter().fold(f64::MAX, |a, b| a.min(*b));
    let avg_rtf = rtfs.iter().sum::<f64>() / rtfs.len() as f64;

    println!("{}", "─".repeat(80));
    println!(
        "Avg: {:.1}ms | Min: {:.1}ms | Max: {:.1}ms | Avg RTF: {:.3}",
        avg_ms, min_ms, max_ms, avg_rtf
    );

    assert!(
        all_pass,
        "RTF must be < {RTF_TARGET} for streaming. Avg RTF: {avg_rtf:.3}"
    );
}

#[test]
fn test_latency_consistency() {
    let engine = tts::KokoroEngine::new(&kokoro_path(), &voices_path())
        .expect("Failed to load Kokoro model");

    let _ = engine.synthesize("Warmup.", "af_bella", 1.0).unwrap();

    let text = "This is a consistency test.";
    let iterations = 20;
    let mut latencies = Vec::with_capacity(iterations);

    for _ in 0..iterations {
        let start = Instant::now();
        let (pcm, visemes) = engine.synthesize(text, "af_bella", 1.0).unwrap();
        let elapsed = start.elapsed();
        assert!(!pcm.is_empty());
        assert!(!visemes.is_empty());
        latencies.push(elapsed.as_secs_f64() * 1000.0);
    }

    let avg = latencies.iter().sum::<f64>() / latencies.len() as f64;
    let std_dev = {
        let variance: f64 =
            latencies.iter().map(|l| (l - avg).powi(2)).sum::<f64>() / latencies.len() as f64;
        variance.sqrt()
    };
    let max = latencies.iter().fold(f64::MIN, |a, b| a.max(*b));
    let min = latencies.iter().fold(f64::MAX, |a, b| a.min(*b));
    let mut sorted = latencies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95 = sorted[(sorted.len() as f64 * 0.95) as usize];

    println!("\n=== Consistency: \"{text}\" ({iterations} iters) ===");
    println!(
        "Avg: {avg:.1}ms | P95: {p95:.1}ms | StdDev: {std_dev:.1}ms | Min: {min:.1}ms | Max: {max:.1}ms"
    );

    assert!(
        std_dev < avg * 0.5,
        "Latency variance too high: std_dev={std_dev:.1}ms, avg={avg:.1}ms"
    );
}

#[test]
fn test_latency_by_voice() {
    let engine = tts::KokoroEngine::new(&kokoro_path(), &voices_path())
        .expect("Failed to load Kokoro model");

    let _ = engine.synthesize("Warmup.", "af_bella", 1.0).unwrap();

    let voices = ["af_bella", "af_nicole", "af_sarah", "bf_emma"];
    let text = "Testing voice latency across speakers.";

    println!("\n=== Voice Latency ===");
    println!(
        "{:<15} {:>10} {:>8} {:>6}",
        "Voice", "Lat(ms)", "Dur(ms)", "RTF"
    );
    println!("{}", "─".repeat(42));

    for voice in &voices {
        let r = run_benchmark(&engine, text, voice);
        println!(
            "{:<15} {:>9.1}ms {:>7.1}ms {:>5.3}",
            voice, r.latency_ms, r.audio_duration_ms, r.real_time_factor
        );
        assert!(
            r.real_time_factor < RTF_TARGET,
            "Voice '{voice}' RTF {:.3} exceeds target {RTF_TARGET}",
            r.real_time_factor
        );
    }
}
