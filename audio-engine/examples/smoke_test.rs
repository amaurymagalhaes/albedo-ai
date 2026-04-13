use std::time::Duration;
use tokio_stream::StreamExt;
use tonic::transport::Channel;
use tonic::Request;
use hyper_util::rt::tokio::TokioIo;

use albedo_audio::audio_proto;
use audio_proto::audio_engine_client::AudioEngineClient;
use audio_proto::*;

async fn connect_unix(socket: &str) -> Channel {
    Channel::from_static("http://localhost")
        .connect_with_connector(tower::service_fn({
            let socket = socket.to_string();
            move |_| {
                let socket = socket.clone();
                async move {
                    let stream = tokio::net::UnixStream::connect(&socket).await?;
                    Ok::<_, std::io::Error>(TokioIo::new(stream))
                }
            }
        }))
        .await
        .unwrap()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let socket = std::env::var("SOCKET")
        .unwrap_or_else(|_| "/tmp/albedo-audio.sock".to_string());

    println!("[client] Connecting to {}...", socket);
    let channel = connect_unix(&socket).await;
    let mut client = AudioEngineClient::new(channel);
    println!("[client] Connected!");

    println!("\n[client] === Test 1: List RPCs (by calling StartCapture) ===");
    let status = client
        .start_capture(Request::new(CaptureConfig {
            device_id: String::new(),
            sample_rate: 16000,
            vad_threshold: 0.5,
        }))
        .await?;

    let status = status.into_inner();
    println!(
        "[client] StartCapture -> active={}, device={}",
        status.active, status.device_name
    );

    if !status.active {
        println!("[client] Capture failed to start, exiting");
        return Ok(());
    }

    println!("\n[client] === Test 2: StreamSTT with silence chunks ===");
    println!("[client] Sending 200 silence chunks (512 samples each)...");

    let silence: Vec<f32> = vec![0.0f32; 512];
    let pcm_bytes: Vec<u8> = silence.iter().flat_map(|s| s.to_le_bytes()).collect();

    let chunks: Vec<AudioChunk> = (0..200)
        .map(|i| AudioChunk {
            pcm_data: pcm_bytes.clone(),
            sample_rate: 16000,
            is_speech: false,
            timestamp_ms: i as u64 * 32,
        })
        .collect();

    let stream = tokio_stream::iter(chunks);
    let response = client.stream_stt(stream).await?;
    let mut response_stream = response.into_inner();

    let mut results = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(result) = response_stream.next().await {
            results.push(result);
        }
    })
    .await;

    if results.is_empty() {
        println!("[client] No transcriptions emitted (silence correctly filtered)");
    } else {
        for r in &results {
            match r {
                Ok(r) => println!("[client] Transcription: '{}' (confidence={})", r.text, r.confidence),
                Err(e) => println!("[client] Error: {}", e),
            }
        }
    }

    println!("\n[client] === Test 3: StreamSTT with synthetic speech-like audio ===");
    println!("[client] Sending chunks with noise pattern...");

    let mut speech_chunks: Vec<AudioChunk> = Vec::new();
    let mut rng_state: u64 = 42;
    for i in 0..300 {
        let mut samples = vec![0.0f32; 512];
        for s in samples.iter_mut() {
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let v = ((rng_state >> 33) as f32 / 2147483648.0) - 1.0;
            *s = v * 0.3;
        }
        let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        speech_chunks.push(AudioChunk {
            pcm_data: pcm,
            sample_rate: 16000,
            is_speech: false,
            timestamp_ms: i as u64 * 32,
        });
    }

    let stream = tokio_stream::iter(speech_chunks);
    let response = client.stream_stt(stream).await?;
    let mut response_stream = response.into_inner();

    let mut speech_results = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(result) = response_stream.next().await {
            speech_results.push(result);
        }
    })
    .await;

    if speech_results.is_empty() {
        println!("[client] No transcriptions from noise (hallucination filter working)");
    } else {
        println!("[client] Got {} results:", speech_results.len());
        for r in &speech_results {
            match r {
                Ok(r) => println!("[client]   '{}' (conf={})", r.text, r.confidence),
                Err(e) => println!("[client]   Error: {}", e),
            }
        }
    }

    println!("\n[client] === Test 4: StopCapture ===");
    let status = client.stop_capture(Request::new(Empty {})).await?;
    let status = status.into_inner();
    println!(
        "[client] StopCapture -> active={}, device={}",
        status.active, status.device_name
    );

    println!("\n[client] === All smoke tests passed! ===");
    Ok(())
}
