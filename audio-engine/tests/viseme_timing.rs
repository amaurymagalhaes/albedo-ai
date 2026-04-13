use albedo_audio::lipsync;

#[test]
fn test_viseme_coverage() {
    let phonemes = vec![
        "h".to_string(),
        "ɛ".to_string(),
        "l".to_string(),
        "oʊ".to_string(),
        "_".to_string(),
        "w".to_string(),
        "ɜ".to_string(),
        "l".to_string(),
        "d".to_string(),
    ];
    let total_ms = 1200u32;
    let events = lipsync::phonemes_to_events(&phonemes, total_ms);
    let visemes = lipsync::extract_visemes(&events);

    let last = visemes.last().unwrap();
    assert_eq!(
        last.start_ms + last.duration_ms,
        total_ms,
        "Visemes must cover full audio duration"
    );

    for pair in visemes.windows(2) {
        let a = &pair[0];
        let b = &pair[1];
        assert_eq!(
            a.start_ms + a.duration_ms,
            b.start_ms,
            "Visemes must not overlap: {:?} -> {:?}",
            a,
            b
        );
    }

    for v in &visemes {
        assert!(
            v.weight >= 0.0 && v.weight <= 1.0,
            "Weight must be in [0, 1], got {}",
            v.weight
        );
    }
}

#[test]
fn test_phoneme_to_shape_completeness() {
    let test_phonemes = ["æ", "e", "i", "ɔ", "u", "f", "v", "θ", "m", "h", "_"];
    for p in &test_phonemes {
        let shape = lipsync::phoneme_to_shape(p);
        assert!(!shape.is_empty(), "phoneme '{}' mapped to empty shape", p);
    }
}

#[test]
fn test_shape_weights() {
    assert_eq!(lipsync::shape_weight("A"), 1.0);
    assert_eq!(lipsync::shape_weight("O"), 1.0);
    assert_eq!(lipsync::shape_weight("E"), 0.85);
    assert_eq!(lipsync::shape_weight("I"), 0.85);
    assert_eq!(lipsync::shape_weight("U"), 0.85);
    assert_eq!(lipsync::shape_weight("MBP"), 0.6);
    assert_eq!(lipsync::shape_weight("F"), 0.6);
    assert_eq!(lipsync::shape_weight("TH"), 0.5);
    assert_eq!(lipsync::shape_weight("rest"), 0.0);
}

#[test]
fn test_merge_consecutive() {
    use albedo_audio::audio_proto::Viseme;

    let visemes = vec![
        Viseme {
            shape: "A".to_string(),
            start_ms: 0,
            duration_ms: 100,
            weight: 1.0,
        },
        Viseme {
            shape: "A".to_string(),
            start_ms: 100,
            duration_ms: 100,
            weight: 1.0,
        },
        Viseme {
            shape: "E".to_string(),
            start_ms: 200,
            duration_ms: 100,
            weight: 0.85,
        },
        Viseme {
            shape: "A".to_string(),
            start_ms: 300,
            duration_ms: 100,
            weight: 1.0,
        },
    ];

    let merged = lipsync::merge_consecutive(visemes, 20);
    assert_eq!(
        merged.len(),
        3,
        "Should merge consecutive same-shape visemes"
    );
    assert_eq!(merged[0].duration_ms, 200);
    assert_eq!(merged[1].duration_ms, 100);
    assert_eq!(merged[2].duration_ms, 100);
}

#[test]
fn test_empty_phonemes() {
    let events = lipsync::phonemes_to_events(&[], 1000);
    assert!(events.is_empty());

    let events = lipsync::phonemes_to_events(&["a".to_string()], 0);
    assert!(events.is_empty());
}

#[test]
fn test_stressed_phonemes_map() {
    assert_eq!(lipsync::phoneme_to_shape("ˈa"), "A");
    assert_eq!(lipsync::phoneme_to_shape("ˈɛ"), "E");
    assert_eq!(lipsync::phoneme_to_shape("ˈi"), "I");
    assert_eq!(lipsync::phoneme_to_shape("ˈɔ"), "O");
    assert_eq!(lipsync::phoneme_to_shape("ˈu"), "U");
    assert_eq!(lipsync::phoneme_to_shape("ˈf"), "F");
    assert_eq!(lipsync::phoneme_to_shape("ˈθ"), "TH");
    assert_eq!(lipsync::phoneme_to_shape("ˈm"), "MBP");
    assert_eq!(lipsync::phoneme_to_shape("ˈh"), "rest");
}
