use crate::lipsync::PhonemeEvent;
use crate::phonemizer;
use anyhow::{bail, Context, Result};
use ndarray::{Array1, Array2};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use std::collections::HashMap;

pub struct KokoroConfig {
    pub sample_rate: u32,
    pub max_tokens: usize,
    pub vocab: HashMap<char, i64>,
}

impl Default for KokoroConfig {
    fn default() -> Self {
        let entries: Vec<(char, i64)> = vec![
            (';', 1),
            (':', 2),
            (',', 3),
            ('.', 4),
            ('!', 5),
            ('?', 6),
            ('—', 9),
            ('…', 10),
            ('"', 11),
            ('(', 12),
            (')', 13),
            ('\u{201c}', 14),
            ('\u{201d}', 15),
            (' ', 16),
            ('\u{303}', 17),
            ('ʣ', 18),
            ('ʥ', 19),
            ('ʦ', 20),
            ('ʨ', 21),
            ('ᵝ', 22),
            ('ꭧ', 23),
            ('A', 24),
            ('I', 25),
            ('O', 31),
            ('Q', 33),
            ('S', 35),
            ('T', 36),
            ('W', 39),
            ('Y', 41),
            ('ᵊ', 42),
            ('a', 43),
            ('b', 44),
            ('c', 45),
            ('d', 46),
            ('e', 47),
            ('f', 48),
            ('h', 50),
            ('i', 51),
            ('j', 52),
            ('k', 53),
            ('l', 54),
            ('m', 55),
            ('n', 56),
            ('o', 57),
            ('p', 58),
            ('q', 59),
            ('r', 60),
            ('s', 61),
            ('t', 62),
            ('u', 63),
            ('v', 64),
            ('w', 65),
            ('x', 66),
            ('y', 67),
            ('z', 68),
            ('ɑ', 69),
            ('ɐ', 70),
            ('ɒ', 71),
            ('æ', 72),
            ('β', 75),
            ('ɔ', 76),
            ('ɕ', 77),
            ('ç', 78),
            ('ɖ', 80),
            ('ð', 81),
            ('ʤ', 82),
            ('ə', 83),
            ('ɚ', 85),
            ('ɛ', 86),
            ('ɜ', 87),
            ('ɟ', 90),
            ('ɡ', 92),
            ('ɥ', 99),
            ('ɨ', 101),
            ('ɪ', 102),
            ('ʝ', 103),
            ('ɯ', 110),
            ('ɰ', 111),
            ('ŋ', 112),
            ('ɳ', 113),
            ('ɲ', 114),
            ('ɴ', 115),
            ('ø', 116),
            ('ɸ', 118),
            ('θ', 119),
            ('œ', 120),
            ('ɹ', 123),
            ('ɾ', 125),
            ('ɻ', 126),
            ('ʁ', 128),
            ('ɽ', 129),
            ('ʂ', 130),
            ('ʃ', 131),
            ('ʈ', 132),
            ('ʧ', 133),
            ('ʊ', 135),
            ('ʋ', 136),
            ('ʌ', 138),
            ('ɣ', 139),
            ('ɤ', 140),
            ('χ', 142),
            ('ʎ', 143),
            ('ʒ', 147),
            ('ʔ', 148),
            ('ˈ', 156),
            ('ˌ', 157),
            ('ː', 158),
            ('ʰ', 162),
            ('ʲ', 164),
            ('↓', 169),
            ('→', 171),
            ('↗', 172),
            ('↘', 173),
            ('ᵻ', 177),
        ];

        let mut vocab = HashMap::new();
        for (c, id) in entries {
            vocab.insert(c, id);
        }

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
                 Download the Kokoro ONNX model and place it in the assets directory.",
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
        let ipa = self.phonemizer.phonemize(text, lang);

        let tokens = self.tokenize(&ipa);

        if tokens.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }

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

        let phoneme_strings: Vec<String> = ipa
            .chars()
            .filter(|c| c.is_alphabetic() || !c.is_ascii())
            .map(|c| c.to_string())
            .collect();
        let phoneme_events = self.build_phoneme_events(&phoneme_strings, audio.len());

        Ok((audio, phoneme_events))
    }

    pub fn tts_sample_rate(&self) -> u32 {
        24000
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

    pub fn tokenize(&self, ipa: &str) -> Vec<i64> {
        ipa.chars()
            .filter_map(|c| self.config.vocab.get(&c).copied())
            .collect()
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

        let total_ms = ((total_samples as f64 / 24000.0) * 1000.0) as u32;
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
