use hound::{WavSpec, WavWriter};
use std::path::Path;

fn main() {
    let out = Path::new("tests/fixtures/hello_world.wav");
    if out.exists() {
        std::fs::remove_file(out).unwrap();
    }

    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(out, spec).unwrap();

    let duration_secs: f64 = 2.0;
    let freq: f64 = 440.0;
    let num_samples = (spec.sample_rate as f64 * duration_secs) as usize;

    for i in 0..num_samples {
        let t = i as f64 / spec.sample_rate as f64;
        let sample = (t * freq * 2.0 * std::f64::consts::PI).sin();
        let amplitude = i16::MAX as f64 * 0.5;
        let val = (sample * amplitude) as i16;
        writer.write_sample(val).unwrap();
    }

    writer.finalize().unwrap();
    println!("Generated {}", out.display());
}
