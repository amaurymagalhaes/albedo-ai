use crate::audio_proto::Viseme;

pub struct PhonemeEvent {
    pub phoneme: String,
    pub start_ms: u32,
    pub duration_ms: u32,
}

pub fn phoneme_to_shape(phoneme: &str) -> &'static str {
    match phoneme {
        "_" | "h" | "ˈh" | "ŋ" | "ˈŋ" => "rest",
        "æ" | "ɑ" | "a" | "ˈæ" | "ˈɑ" | "ˈa" => "A",
        "ɛ" | "ɪ" | "e" | "ˈɛ" | "ˈɪ" | "ˈe" => "E",
        "i" | "iː" | "ˈi" => "I",
        "ɔ" | "o" | "oʊ" | "ˈɔ" | "ˈo" | "ˈoʊ" => "O",
        "u" | "uː" | "ʊ" | "ˈu" | "ˈʊ" => "U",
        "f" | "v" | "ˈf" | "ˈv" => "F",
        "θ" | "ð" | "ˈθ" | "ˈð" => "TH",
        "m" | "b" | "p" | "ˈm" | "ˈb" | "ˈp" => "MBP",
        _ => "rest",
    }
}

pub fn shape_weight(shape: &str) -> f32 {
    match shape {
        "A" | "O" => 1.0,
        "E" | "I" | "U" => 0.85,
        "MBP" | "F" => 0.6,
        "TH" => 0.5,
        "rest" => 0.0,
        _ => 0.0,
    }
}

pub fn phonemes_to_events(phonemes: &[String], total_ms: u32) -> Vec<PhonemeEvent> {
    if phonemes.is_empty() || total_ms == 0 {
        return Vec::new();
    }

    let silence_duration = 60u32;
    let is_silence = |p: &str| p == "_" || p == "$";

    let non_silence_count = phonemes.iter().filter(|p| !is_silence(p)).count();
    let silence_count = phonemes.len() - non_silence_count;

    let per_event = if non_silence_count == 0 {
        total_ms / (phonemes.len() as u32)
    } else {
        let total_silence_ms = (silence_count as u32) * silence_duration;
        let remaining = total_ms.saturating_sub(total_silence_ms);
        remaining / (non_silence_count as u32)
    };

    let mut events = Vec::with_capacity(phonemes.len());
    let mut start_ms = 0u32;

    for (i, phoneme) in phonemes.iter().enumerate() {
        let duration = if i == phonemes.len() - 1 {
            total_ms.saturating_sub(start_ms)
        } else if is_silence(phoneme) {
            silence_duration
        } else if non_silence_count == 0 {
            per_event
        } else {
            per_event
        };

        events.push(PhonemeEvent {
            phoneme: phoneme.clone(),
            start_ms,
            duration_ms: duration,
        });

        start_ms += duration;
    }

    events
}

pub fn extract_visemes(events: &[PhonemeEvent]) -> Vec<Viseme> {
    let visemes: Vec<Viseme> = events
        .iter()
        .map(|e| {
            let shape = phoneme_to_shape(&e.phoneme).to_string();
            Viseme {
                weight: shape_weight(&shape),
                shape,
                start_ms: e.start_ms,
                duration_ms: e.duration_ms,
            }
        })
        .collect();

    merge_consecutive(visemes, 20)
}

pub fn merge_consecutive(visemes: Vec<Viseme>, gap_ms: u32) -> Vec<Viseme> {
    let mut merged: Vec<Viseme> = Vec::new();

    for v in visemes {
        if let Some(last) = merged.last_mut() {
            let end_of_last = last.start_ms + last.duration_ms;
            let gap = v.start_ms.saturating_sub(end_of_last);

            if last.shape == v.shape && gap < gap_ms {
                last.duration_ms += v.duration_ms + gap;
            } else {
                merged.push(v);
            }
        } else {
            merged.push(v);
        }
    }

    merged
}
