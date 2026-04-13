use albedo_audio::tts;
use albedo_audio::phonemizer;

fn main() {
    let engine = tts::KokoroEngine::new(
        "assets/voices/kokoro-v1_0.onnx",
        "assets/voices/voices.bin",
    ).unwrap();

    let text = "Phase two test.";
    let (tokens, phonemes) = engine.tokenize(text);
    
    println!("Text: {}", text);
    println!("Phonemes ({}): {:?}", phonemes.len(), phonemes);
    println!("Tokens ({}): {:?}", tokens.len(), tokens);
    
    // Show espeak-ng raw output for comparison
    let p = phonemizer::create_phonemizer();
    let raw = p.phonemize("hello", "en");
    println!("\nRaw phonemes for 'hello': {:?}", raw);
}
