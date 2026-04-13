use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rtrb::RingBuffer;

pub struct PlaybackEngine {
    _stream: cpal::Stream,
    producer: rtrb::Producer<f32>,
    sample_rate: u32,
    capacity: usize,
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
                let capacity: usize = 22_050 * 5;
                let (producer, _consumer) = RingBuffer::new(capacity);
                return Ok(Self {
                    _stream: null_stream()?,
                    producer,
                    sample_rate: 22050,
                    capacity,
                });
            }
        };

        let mut supported: Vec<_> = device
            .supported_output_configs()
            .context("failed to query output configs")?
            .filter(|c| c.sample_format() == cpal::SampleFormat::F32)
            .collect();

        if supported.is_empty() {
            anyhow::bail!("no f32 output configs available");
        }

        let preference = |c: &cpal::SupportedStreamConfigRange| {
            let rate = c.min_sample_rate().0;
            let ch = c.channels();
            let mono = ch == 1;
            let rate22050 = rate <= 22050 && c.max_sample_rate().0 >= 22050;
            let rate44100 = rate <= 44100 && c.max_sample_rate().0 >= 44100;
            match (
                rate22050 && mono,
                rate44100 && mono,
                rate44100 && ch == 2,
                true,
            ) {
                (true, _, _, _) => 0,
                (_, true, _, _) => 1,
                (_, _, true, _) => 2,
                _ => 3,
            }
        };

        supported.sort_by_key(preference);

        let chosen = &supported[0];
        let target_rate = if preference(chosen) <= 1 && chosen.max_sample_rate().0 >= 22050 {
            22050u32
        } else {
            44100u32.clamp(chosen.min_sample_rate().0, chosen.max_sample_rate().0)
        };

        let sample_rate = target_rate;
        let stream_config = chosen
            .with_sample_rate(cpal::SampleRate(sample_rate))
            .config();
        let channels = stream_config.channels;

        let capacity: usize = 22_050 * 5;
        let (producer, consumer) = RingBuffer::new(capacity);

        let stream = build_output_stream(&device, &stream_config, consumer, channels)
            .context("failed to build output stream")?;
        stream.play().context("failed to start playback stream")?;

        tracing::info!("[playback] started: {} Hz, {} ch", sample_rate, channels);

        Ok(Self {
            _stream: stream,
            producer,
            sample_rate,
            capacity,
        })
    }

    pub fn enqueue(&mut self, samples: &[f32]) {
        for &s in samples {
            let _ = self.producer.push(s);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.producer.slots() == self.capacity
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut consumer: rtrb::Consumer<f32>,
    channels: u16,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    device.build_output_stream::<f32, _, _>(
        config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
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
        .with_sample_rate(cpal::SampleRate(44100))
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
