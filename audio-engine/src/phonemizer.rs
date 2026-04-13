pub trait Phonemizer: Send + Sync {
    fn phonemize(&self, text: &str, lang: &str) -> Vec<String>;
}

pub struct EspeakPhonemizer;

impl EspeakPhonemizer {
    pub fn new() -> Result<Self, String> {
        let output = std::process::Command::new("espeak-ng")
            .args(["--ipa=3", "-q", "-v", "en", "test"])
            .output()
            .map_err(|e| format!("espeak-ng not found: {}", e))?;

        if !output.status.success() {
            return Err("espeak-ng command failed".to_string());
        }
        Ok(Self)
    }
}

impl Phonemizer for EspeakPhonemizer {
    fn phonemize(&self, text: &str, lang: &str) -> Vec<String> {
        let voice = match lang {
            "pt" | "pt-BR" | "pt-br" | "pt_BR" => "pt-br",
            _ => "en",
        };

        let normalized = normalize_text(text);
        let words: Vec<&str> = normalized.split_whitespace().collect();
        let mut all_phonemes = Vec::new();

        for (i, word) in words.iter().enumerate() {
            if i > 0 {
                all_phonemes.push("_".to_string());
            }
            let output = std::process::Command::new("espeak-ng")
                .args(["--ipa=3", "-q", "-v", voice])
                .arg(word)
                .output();

            match output {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let word_phonemes = parse_ipa(stdout.trim());
                    if word_phonemes.is_empty() {
                        all_phonemes.push(word.to_string());
                    } else {
                        all_phonemes.extend(word_phonemes);
                    }
                }
                Err(_) => {
                    all_phonemes.push(word.to_string());
                }
            }
        }

        all_phonemes
    }
}

fn parse_ipa(ipa: &str) -> Vec<String> {
    let mut result = Vec::new();
    let chars: Vec<char> = ipa.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() || c == ',' || c == '.' || c == '!' || c == '?' || c == ':' || c == ';'
        {
            i += 1;
            continue;
        }

        if c == 'ˈ' || c == 'ˌ' {
            let stress = c;
            if i + 1 < chars.len() {
                let next = chars[i + 1];
                let mut sym = String::from(stress);
                sym.push(next);
                if i + 2 < chars.len() {
                    let mut combined = sym.clone();
                    combined.push(chars[i + 2]);
                    if is_valid_digraph(&combined) {
                        sym = combined;
                        i += 3;
                    } else {
                        i += 2;
                    }
                } else {
                    i += 2;
                }
                result.push(sym);
            } else {
                i += 1;
            }
            continue;
        }

        let mut sym = String::from(c);
        if i + 1 < chars.len() {
            let mut combined = sym.clone();
            combined.push(chars[i + 1]);
            if is_valid_digraph(&combined) {
                sym = combined;
                i += 2;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
        result.push(sym);
    }

    result
}

fn is_valid_digraph(s: &str) -> bool {
    matches!(
        s,
        "aɪ" | "aʊ"
            | "dʒ"
            | "eɪ"
            | "oʊ"
            | "ɔɪ"
            | "tʃ"
            | "ˈaɪ"
            | "ˈaʊ"
            | "ˈdʒ"
            | "ˈeɪ"
            | "ˈoʊ"
            | "ˈɔɪ"
            | "ˈtʃ"
            | "ɛ̃"
            | "ɐ̃"
            | "õ"
            | "ẽ"
            | "ĩ"
            | "ũ"
            | "ˈa"
            | "ˈe"
            | "ˈi"
            | "ˈo"
            | "ˈu"
    )
}

fn normalize_text(text: &str) -> String {
    let mut result = text.to_lowercase();
    result = result.replace('$', " dollars ");
    result = result.replace('%', " percent ");
    result = result.replace('&', " and ");
    result = result.replace('@', " at ");
    result = result.replace('#', " number ");
    result = result.replace('+', " plus ");
    result = result.replace('=', " equals ");

    let abbreviations = [
        ("mr.", "mister"),
        ("mrs.", "missus"),
        ("ms.", "miss"),
        ("dr.", "doctor"),
        ("prof.", "professor"),
        ("sr.", "senior"),
        ("jr.", "junior"),
        ("st.", "street"),
        ("ave.", "avenue"),
        ("etc.", "et cetera"),
        ("vs.", "versus"),
        ("inc.", "incorporated"),
        ("ltd.", "limited"),
    ];

    for (abbr, expanded) in &abbreviations {
        result = result.replace(abbr, expanded);
    }

    result = expand_numbers(&result);

    let mut cleaned = String::with_capacity(result.len());
    for c in result.chars() {
        if c.is_alphanumeric() || c == ' ' || c == '\'' || c == '-' || !c.is_ascii() {
            cleaned.push(c);
        } else {
            cleaned.push(' ');
        }
    }

    let words: Vec<&str> = cleaned.split_whitespace().collect();
    words.join(" ")
}

fn expand_numbers(text: &str) -> String {
    let ones = [
        "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    ];
    let teens = [
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    let tens = [
        "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];

    let mut result = String::new();
    let mut current_num = String::new();

    let flush_num = |num_str: &str| -> String {
        if num_str.is_empty() {
            return String::new();
        }
        if let Ok(n) = num_str.parse::<u64>() {
            number_to_words(n, &ones, &teens, &tens)
        } else {
            num_str.to_string()
        }
    };

    for c in text.chars() {
        if c.is_ascii_digit() {
            current_num.push(c);
        } else {
            if !current_num.is_empty() {
                result.push_str(&flush_num(&current_num));
                result.push(' ');
                current_num.clear();
            }
            result.push(c);
        }
    }
    if !current_num.is_empty() {
        result.push_str(&flush_num(&current_num));
    }

    result
}

fn number_to_words(n: u64, ones: &[&str; 10], teens: &[&str; 10], tens: &[&str; 10]) -> String {
    if n == 0 {
        return "zero".to_string();
    }

    let mut parts = Vec::new();
    let mut remaining = n;

    if remaining >= 1_000_000_000 {
        parts.push(number_to_words(
            remaining / 1_000_000_000,
            ones,
            teens,
            tens,
        ));
        parts.push("billion".to_string());
        remaining %= 1_000_000_000;
    }
    if remaining >= 1_000_000 {
        parts.push(number_to_words(remaining / 1_000_000, ones, teens, tens));
        parts.push("million".to_string());
        remaining %= 1_000_000;
    }
    if remaining >= 1_000 {
        parts.push(number_to_words(remaining / 1_000, ones, teens, tens));
        parts.push("thousand".to_string());
        remaining %= 1_000;
    }
    if remaining >= 100 {
        parts.push(ones[(remaining / 100) as usize].to_string());
        parts.push("hundred".to_string());
        remaining %= 100;
    }
    if remaining >= 20 {
        parts.push(tens[(remaining / 10) as usize].to_string());
        remaining %= 10;
        if remaining > 0 {
            parts.push(ones[remaining as usize].to_string());
        }
    } else if remaining >= 10 {
        parts.push(teens[(remaining - 10) as usize].to_string());
    } else if remaining > 0 {
        parts.push(ones[remaining as usize].to_string());
    }

    parts.join(" ")
}

pub fn create_phonemizer() -> Box<dyn Phonemizer> {
    match EspeakPhonemizer::new() {
        Ok(p) => {
            tracing::info!("[tts] using espeak-ng phonemizer");
            Box::new(p)
        }
        Err(e) => {
            panic!(
                "[tts] espeak-ng is required for phonemization but was not found: {}\n\
                 Install with: sudo apt install espeak-ng  (Debian/Ubuntu)\n\
                 Or:           brew install espeak-ng       (macOS)",
                e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_text() {
        assert_eq!(normalize_text("Hello, World!"), "hello world");
        assert_eq!(normalize_text("Mr. Smith"), "mister smith");
        assert_eq!(normalize_text("100"), "one hundred");
        assert_eq!(normalize_text("test$"), "test dollars");
    }

    #[test]
    fn test_number_expansion() {
        assert_eq!(expand_numbers("42"), "forty two");
        assert_eq!(expand_numbers("7"), "seven");
        assert_eq!(expand_numbers("0"), "zero");
        assert!(expand_numbers("I have 3 cats").contains("three"));
    }

    #[test]
    fn test_parse_ipa() {
        let ph = parse_ipa("həˈloʊ");
        assert!(!ph.is_empty());
    }
}
