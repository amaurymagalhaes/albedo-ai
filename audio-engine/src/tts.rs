use crate::lipsync::PhonemeEvent;
use crate::phonemizer;
use anyhow::{bail, Context, Result};
use ndarray::{Array1, Array2};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use rubato::{FftFixedInOut, Resampler};
use std::collections::HashMap;

pub struct KokoroConfig {
    pub sample_rate: u32,
    pub max_tokens: usize,
    pub vocab: HashMap<String, i64>,
}

impl Default for KokoroConfig {
    fn default() -> Self {
        let mut vocab = HashMap::new();
        vocab.insert("$".to_string(), 0);
        vocab.insert("a".to_string(), 2);
        vocab.insert("aɪ".to_string(), 3);
        vocab.insert("aʊ".to_string(), 4);
        vocab.insert("b".to_string(), 5);
        vocab.insert("ç".to_string(), 6);
        vocab.insert("d".to_string(), 7);
        vocab.insert("ð".to_string(), 8);
        vocab.insert("ɛ".to_string(), 9);
        vocab.insert("eɪ".to_string(), 10);
        vocab.insert("f".to_string(), 11);
        vocab.insert("ɡ".to_string(), 12);
        vocab.insert("h".to_string(), 13);
        vocab.insert("i".to_string(), 14);
        vocab.insert("ɪ".to_string(), 15);
        vocab.insert("dʒ".to_string(), 16);
        vocab.insert("k".to_string(), 17);
        vocab.insert("l".to_string(), 18);
        vocab.insert("m".to_string(), 19);
        vocab.insert("n".to_string(), 20);
        vocab.insert("ŋ".to_string(), 21);
        vocab.insert("oʊ".to_string(), 22);
        vocab.insert("ɔ".to_string(), 23);
        vocab.insert("ɔɪ".to_string(), 24);
        vocab.insert("p".to_string(), 25);
        vocab.insert("ɹ".to_string(), 26);
        vocab.insert("ʃ".to_string(), 27);
        vocab.insert("s".to_string(), 28);
        vocab.insert("t".to_string(), 29);
        vocab.insert("θ".to_string(), 30);
        vocab.insert("tʃ".to_string(), 31);
        vocab.insert("ʌ".to_string(), 32);
        vocab.insert("u".to_string(), 33);
        vocab.insert("ʊ".to_string(), 34);
        vocab.insert("v".to_string(), 35);
        vocab.insert("w".to_string(), 36);
        vocab.insert("j".to_string(), 37);
        vocab.insert("z".to_string(), 38);
        vocab.insert("ʒ".to_string(), 39);
        vocab.insert("ˈa".to_string(), 40);
        vocab.insert("ˈaɪ".to_string(), 41);
        vocab.insert("ˈaʊ".to_string(), 42);
        vocab.insert("ˈb".to_string(), 43);
        vocab.insert("ˈç".to_string(), 44);
        vocab.insert("ˈd".to_string(), 45);
        vocab.insert("ˈð".to_string(), 46);
        vocab.insert("ˈɛ".to_string(), 47);
        vocab.insert("ˈeɪ".to_string(), 48);
        vocab.insert("ˈf".to_string(), 49);
        vocab.insert("ˈɡ".to_string(), 50);
        vocab.insert("ˈh".to_string(), 51);
        vocab.insert("ˈi".to_string(), 52);
        vocab.insert("ˈɪ".to_string(), 53);
        vocab.insert("ˈdʒ".to_string(), 54);
        vocab.insert("ˈk".to_string(), 55);
        vocab.insert("ˈl".to_string(), 56);
        vocab.insert("ˈm".to_string(), 57);
        vocab.insert("ˈn".to_string(), 58);
        vocab.insert("ˈŋ".to_string(), 59);
        vocab.insert("ˈoʊ".to_string(), 60);
        vocab.insert("ˈɔ".to_string(), 61);
        vocab.insert("ˈɔɪ".to_string(), 62);
        vocab.insert("ˈp".to_string(), 63);
        vocab.insert("ˈɹ".to_string(), 64);
        vocab.insert("ˈʃ".to_string(), 65);
        vocab.insert("ˈs".to_string(), 66);
        vocab.insert("ˈt".to_string(), 67);
        vocab.insert("ˈθ".to_string(), 68);
        vocab.insert("ˈtʃ".to_string(), 69);
        vocab.insert("ˈʌ".to_string(), 70);
        vocab.insert("ˈu".to_string(), 71);
        vocab.insert("ˈʊ".to_string(), 72);
        vocab.insert("ˈv".to_string(), 73);
        vocab.insert("ˈw".to_string(), 74);
        vocab.insert("ˈj".to_string(), 75);
        vocab.insert("ˈz".to_string(), 76);
        vocab.insert("ˈʒ".to_string(), 77);
        vocab.insert("_".to_string(), 78);

        KokoroConfig {
            sample_rate: 24000,
            max_tokens: 512,
            vocab,
        }
    }
}

pub struct KokoroEngine {
    session: std::sync::Mutex<Session>,
    voice_embeddings: HashMap<String, Vec<f32>>,
    config: KokoroConfig,
    phonemizer: Box<dyn phonemizer::Phonemizer>,
}

impl KokoroEngine {
    pub fn new(model_path: &str, voices_path: &str) -> Result<Self> {
        if !std::path::Path::new(model_path).exists() {
            bail!(
                "Kokoro TTS model not found at '{}'. \
                 Download the Kokoro v0.19 ONNX model and place it in the assets directory.",
                model_path
            );
        }

        let session = Session::builder()
            .map_err(|e| anyhow::anyhow!("Failed to create ONNX session builder: {:?}", e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| anyhow::anyhow!("Failed to set optimization level: {:?}", e))?
            .with_intra_threads(2)
            .map_err(|e| anyhow::anyhow!("Failed to set intra threads: {:?}", e))?
            .commit_from_file(model_path)
            .map_err(|e| anyhow::anyhow!("Failed to load Kokoro TTS model: {:?}", e))?;

        tracing::info!(
            "Kokoro TTS session created. Inputs: {:?}, Outputs: {:?}",
            session
                .inputs()
                .iter()
                .map(|i| i.name())
                .collect::<Vec<_>>(),
            session
                .outputs()
                .iter()
                .map(|o| o.name())
                .collect::<Vec<_>>()
        );

        let voice_embeddings = if std::path::Path::new(voices_path).exists() {
            load_voices(voices_path)?
        } else {
            tracing::warn!(
                "Voice embeddings file not found at '{}', using empty voice map",
                voices_path
            );
            HashMap::new()
        };

        let phonemizer = phonemizer::create_phonemizer();

        Ok(Self {
            session: std::sync::Mutex::new(session),
            voice_embeddings,
            config: KokoroConfig::default(),
            phonemizer,
        })
    }

    pub fn synthesize_internal(
        &self,
        text: &str,
        voice_id: &str,
        speed: f32,
    ) -> Result<(Vec<f32>, Vec<PhonemeEvent>)> {
        if text.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }

        let lang = if voice_id.starts_with('b') {
            "pt"
        } else {
            "en"
        };
        let phonemes = self.phonemizer.phonemize(text, lang);

        let mut tokens: Vec<i64> = Vec::new();
        let mut phoneme_strings: Vec<String> = Vec::new();
        for p in &phonemes {
            if let Some(&id) = self.config.vocab.get(p) {
                tokens.push(id);
                phoneme_strings.push(p.clone());
            }
        }

        tokens.push(1);

        let pad_len = self.config.max_tokens.saturating_sub(tokens.len());
        tokens.extend(std::iter::repeat(0).take(pad_len));

        let style = match self.voice_embeddings.get(voice_id) {
            Some(emb) => emb.clone(),
            None => {
                tracing::warn!("Voice '{}' not found, defaulting to 'af_bella'", voice_id);
                self.voice_embeddings
                    .get("af_bella")
                    .cloned()
                    .unwrap_or_else(|| vec![0.0f32; 256])
            }
        };

        let speed = if speed <= 0.0 {
            1.0f32
        } else {
            speed.clamp(0.5, 2.0)
        };

        let audio = self.run_inference(&tokens, &style, speed)?;
        let resampled = resample_24k_to_22k(audio)?;
        let phoneme_events = self.build_phoneme_events(&phoneme_strings, resampled.len());

        Ok((resampled, phoneme_events))
    }

    pub fn synthesize(
        &self,
        text: &str,
        voice_id: &str,
        speed: f32,
    ) -> Result<(Vec<u8>, Vec<crate::audio_proto::Viseme>)> {
        let (samples, phoneme_events) = self.synthesize_internal(text, voice_id, speed)?;
        let visemes = crate::lipsync::extract_visemes(&phoneme_events);
        let pcm_bytes = f32_to_pcm16(&samples);
        Ok((pcm_bytes, visemes))
    }

    pub fn tokenize(&self, text: &str) -> (Vec<i64>, Vec<String>) {
        let phonemes = self.phonemizer.phonemize(text, "en");
        let mut token_ids = Vec::new();
        let mut phoneme_strings = Vec::new();
        for p in &phonemes {
            if let Some(&id) = self.config.vocab.get(p) {
                token_ids.push(id);
                phoneme_strings.push(p.clone());
            }
        }
        (token_ids, phoneme_strings)
    }

    fn run_inference(&self, tokens: &[i64], style: &[f32], speed: f32) -> Result<Vec<f32>> {
        let seq_len = tokens.len();
        let tokens_array = Array2::from_shape_vec((1, seq_len), tokens.to_vec())
            .map_err(|e| anyhow::anyhow!("Failed to create tokens array: {:?}", e))?;
        let style_array = Array2::from_shape_vec((1, 256), style.to_vec())
            .map_err(|e| anyhow::anyhow!("Failed to create style array: {:?}", e))?;
        let speed_array = Array1::from_vec(vec![speed]);

        let tokens_tensor = Tensor::from_array(tokens_array)
            .map_err(|e| anyhow::anyhow!("Failed to create tokens tensor: {:?}", e))?;
        let style_tensor = Tensor::from_array(style_array)
            .map_err(|e| anyhow::anyhow!("Failed to create style tensor: {:?}", e))?;
        let speed_tensor = Tensor::from_array(speed_array)
            .map_err(|e| anyhow::anyhow!("Failed to create speed tensor: {:?}", e))?;

        let mut session = self.session.lock().unwrap();
        let outputs = session
            .run(ort::inputs![
                "tokens" => tokens_tensor,
                "style" => style_tensor,
                "speed" => speed_tensor
            ])
            .map_err(|e| anyhow::anyhow!("Kokoro TTS inference failed: {:?}", e))?;

        let (_, output_data) = outputs["audio"]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("Failed to extract audio output: {:?}", e))?;

        Ok(output_data.to_vec())
    }

    fn build_phoneme_events(&self, phonemes: &[String], total_samples: usize) -> Vec<PhonemeEvent> {
        if phonemes.is_empty() || total_samples == 0 {
            return Vec::new();
        }

        let total_ms = ((total_samples as f64 / 22050.0) * 1000.0) as u32;
        let silence_duration_ms: u32 = 60;

        let silence_count = phonemes.iter().filter(|p| p.as_str() == "_").count() as u32;
        let non_silence_count = phonemes.len() as u32 - silence_count;
        let total_silence_ms = silence_count * silence_duration_ms;
        let available_ms = total_ms.saturating_sub(total_silence_ms);
        let per_phoneme_ms = if non_silence_count > 0 {
            available_ms / non_silence_count
        } else {
            0
        };

        let mut events = Vec::with_capacity(phonemes.len());
        let mut start_ms: u32 = 0;

        for (i, phoneme) in phonemes.iter().enumerate() {
            let duration_ms = if i == phonemes.len() - 1 {
                total_ms.saturating_sub(start_ms)
            } else if phoneme.as_str() == "_" {
                silence_duration_ms
            } else {
                per_phoneme_ms
            };

            events.push(PhonemeEvent {
                phoneme: phoneme.clone(),
                start_ms,
                duration_ms,
            });

            start_ms += duration_ms;
        }

        events
    }
}

fn load_voices(path: &str) -> Result<HashMap<String, Vec<f32>>> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open voices file: {}", path))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("Failed to read voices zip: {}", path))?;

    let mut voices = HashMap::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();

        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf)?;

        if buf.len() < 10 {
            continue;
        }

        if !(buf[0] == 0x93
            && buf[1] == b'N'
            && buf[2] == b'U'
            && buf[3] == b'M'
            && buf[4] == b'P'
            && buf[5] == b'Y')
        {
            continue;
        }

        let major = buf[6];
        let data_start = if major == 1 {
            let header_len = u16::from_le_bytes(buf[8..10].try_into().unwrap()) as usize;
            10 + header_len
        } else {
            let header_len = u32::from_le_bytes(buf[8..12].try_into().unwrap()) as usize;
            12 + header_len
        };

        if data_start + 256 * 4 > buf.len() {
            continue;
        }

        let voice_name = name.trim_end_matches(".npy").to_string();
        let mut embedding = Vec::with_capacity(256);
        for j in 0..256 {
            let off = data_start + j * 4;
            let val = f32::from_le_bytes(buf[off..off + 4].try_into().unwrap());
            embedding.push(val);
        }

        voices.insert(voice_name, embedding);
    }

    tracing::info!("[tts] loaded {} voice embeddings", voices.len());
    Ok(voices)
}

pub fn f32_to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let pcm = (clamped * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&pcm.to_le_bytes());
    }
    bytes
}

fn resample_24k_to_22k(samples: Vec<f32>) -> Result<Vec<f32>> {
    let mut resampler = FftFixedInOut::<f32>::new(24000, 22050, 1024, 1)
        .map_err(|e| anyhow::anyhow!("Failed to create resampler: {:?}", e))?;

    let chunk_size = resampler.input_frames_next();
    let mut output = Vec::new();
    let mut pos = 0;

    while pos < samples.len() {
        let remaining = samples.len() - pos;
        let take = chunk_size.min(remaining);
        let mut chunk = vec![0.0f32; chunk_size];
        chunk[..take].copy_from_slice(&samples[pos..pos + take]);

        let input_channels = vec![chunk];
        let result = resampler
            .process(&input_channels, None)
            .map_err(|e| anyhow::anyhow!("Resample error: {:?}", e))?;

        if let Some(channel_data) = result.first() {
            output.extend_from_slice(channel_data);
        }

        pos += take;
    }

    let ratio = 22050.0 / 24000.0;
    let expected_len = (samples.len() as f64 * ratio).round() as usize;
    output.truncate(expected_len);

    Ok(output)
}
