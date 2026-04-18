use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rtrb::RingBuffer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const TTS_SAMPLE_RATE: u32 = 24000;

pub struct PlaybackEngine {
    _stream: cpal::Stream,
    producer: rtrb::Producer<f32>,
    sample_rate: u32,
    capacity: usize,
    clear_flag: Arc<AtomicBool>,
}

unsafe impl Send for PlaybackEngine {}
unsafe impl Sync for PlaybackEngine {}

impl PlaybackEngine {
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let device = match host.default_output_device() {
            Some(d) => d,
            None => {
                tracing::warn!("[playback] No output device available, using null playback");
                let capacity: usize = (TTS_SAMPLE_RATE as usize) * 60;
                let (producer, _consumer) = RingBuffer::new(capacity);
                return Ok(Self {
                    _stream: null_stream()?,
                    producer,
                    sample_rate: TTS_SAMPLE_RATE,
                    capacity,
                    clear_flag: Arc::new(AtomicBool::new(false)),
                });
            }
        };

        let supported: Vec<_> = device
            .supported_output_configs()
            .context("failed to query output configs")?
            .filter(|c| c.sample_format() == cpal::SampleFormat::F32)
            .collect();

        if supported.is_empty() {
            anyhow::bail!("no f32 output configs available");
        }

        let chosen = supported
            .iter()
            .find(|c| {
                c.min_sample_rate().0 <= TTS_SAMPLE_RATE && c.max_sample_rate().0 >= TTS_SAMPLE_RATE
            })
            .unwrap_or(&supported[0]);

        let sample_rate = if chosen.min_sample_rate().0 <= TTS_SAMPLE_RATE
            && chosen.max_sample_rate().0 >= TTS_SAMPLE_RATE
        {
            TTS_SAMPLE_RATE
        } else {
            tracing::warn!(
                "[playback] device doesn't support {} Hz, using native rate",
                TTS_SAMPLE_RATE
            );
            chosen
                .max_sample_rate()
                .0
                .clamp(chosen.min_sample_rate().0, chosen.max_sample_rate().0)
        };

        let stream_config = chosen
            .with_sample_rate(cpal::SampleRate(sample_rate))
            .config();
        let channels = stream_config.channels;

        let capacity: usize = (sample_rate as usize) * 60;
        let (producer, consumer) = RingBuffer::new(capacity);
        let clear_flag = Arc::new(AtomicBool::new(false));
        let clear_flag_clone = clear_flag.clone();

        let stream = build_output_stream(
            &device,
            &stream_config,
            consumer,
            channels,
            clear_flag_clone,
        )
        .context("failed to build output stream")?;
        stream.play().context("failed to start playback stream")?;

        tracing::info!("[playback] started: {} Hz, {} ch", sample_rate, channels);

        Ok(Self {
            _stream: stream,
            producer,
            sample_rate,
            capacity,
            clear_flag,
        })
    }

    pub fn enqueue(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        self.clear_flag.store(false, Ordering::SeqCst);
        if self.sample_rate == TTS_SAMPLE_RATE {
            for &s in samples {
                let _ = self.producer.push(s);
            }
        } else {
            let resampled =
                simple_resample(samples, TTS_SAMPLE_RATE as usize, self.sample_rate as usize);
            for &s in &resampled {
                let _ = self.producer.push(s);
            }
        }
    }

    pub fn clear(&mut self) {
        self.clear_flag.store(true, Ordering::SeqCst);
    }

    pub fn is_empty(&self) -> bool {
        self.producer.slots() == self.capacity
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

fn simple_resample(samples: &[f32], from_rate: usize, to_rate: usize) -> Vec<f32> {
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((samples.len() as f64) * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = (i as f64) / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;
        let s0 = samples[idx];
        let s1 = samples.get(idx + 1).copied().unwrap_or(s0);
        out.push(s0 + (s1 - s0) * frac as f32);
    }
    out
}

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut consumer: rtrb::Consumer<f32>,
    channels: u16,
    clear_flag: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    device.build_output_stream::<f32, _, _>(
        config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            if clear_flag.load(Ordering::SeqCst) {
                while consumer.pop().is_ok() {}
                clear_flag.store(false, Ordering::SeqCst);
            }
            if channels == 1 {
                for sample in data.iter_mut() {
                    *sample = consumer.pop().unwrap_or(0.0);
                }
            } else {
                for frame in data.chunks_mut(channels as usize) {
                    let s = consumer.pop().unwrap_or(0.0);
                    for out in frame.iter_mut() {
                        *out = s;
                    }
                }
            }
        },
        |err| tracing::error!("[playback] stream error: {}", err),
        None,
    )
}

fn null_stream() -> Result<cpal::Stream> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .context("no output device for null stream")?;
    let configs: Vec<_> = device
        .supported_output_configs()
        .context("failed to query configs for null stream")?
        .collect();
    if configs.is_empty() {
        bail!("no output configs for null stream");
    }
    let config = configs[0]
        .with_sample_rate(cpal::SampleRate(TTS_SAMPLE_RATE))
        .config();
    let (_producer, mut consumer) = rtrb::RingBuffer::<f32>::new(64);
    let channels = config.channels;
    Ok(device.build_output_stream::<f32, _, _>(
        &config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            for frame in data.chunks_mut(channels as usize) {
                let _ = consumer.pop();
                for out in frame.iter_mut() {
                    *out = 0.0;
                }
            }
        },
        |_| {},
        None,
    )?)
}
