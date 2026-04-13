use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use anyhow::{Result, Context};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SupportedStreamConfigRange;
use rubato::{FftFixedInOut, Resampler};

pub struct CaptureConfig {
    pub device_id: Option<String>,
    pub sample_rate: u32,
    #[allow(dead_code)]
    pub vad_threshold: f32,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            device_id: None,
            sample_rate: 16000,
            vad_threshold: 0.5,
        }
    }
}

pub struct CaptureHandle {
    pub device_name: String,
    shutdown_tx: oneshot::Sender<()>,
    _thread: std::thread::JoinHandle<()>,
}

pub fn start_capture(
    config: CaptureConfig,
    audio_tx: mpsc::Sender<Vec<f32>>,
) -> Result<CaptureHandle> {
    let host = cpal::default_host();

    let device = if let Some(ref id) = config.device_id {
        host.input_devices()
            .context("Failed to enumerate input devices")?
            .find(|d: &cpal::Device| d.name().map(|n| n == *id).unwrap_or(false))
            .with_context(|| format!("Input device '{}' not found", id))?
    } else {
        host.default_input_device()
            .context("No default input device available")?
    };

    let device_name = device.name().unwrap_or_default();
    let target_rate = config.sample_rate;

    let supported_config = device
        .supported_input_configs()
        .context("Failed to query supported input configs")?
        .filter(|c: &SupportedStreamConfigRange| c.channels() <= 2)
        .filter(|c: &SupportedStreamConfigRange| c.sample_format() == cpal::SampleFormat::F32)
        .min_by_key(|c: &SupportedStreamConfigRange| {
            (c.min_sample_rate().0 as i64 - target_rate as i64).abs()
        })
        .context("No supported f32 input config found")?;

    let native_rate = target_rate
        .max(supported_config.min_sample_rate().0)
        .min(supported_config.max_sample_rate().0);

    let stream_config = supported_config
        .with_sample_rate(cpal::SampleRate(native_rate))
        .config();

    let needs_resample = native_rate != target_rate;
    let channels = stream_config.channels;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let (cb_tx, cb_rx) = std_mpsc::sync_channel::<Vec<f32>>(256);
    let (setup_tx, setup_rx) = std_mpsc::channel::<Result<()>>();

    let rt_handle = tokio::runtime::Handle::try_current()
        .context("start_capture must be called within a Tokio runtime")?;

    let device_name_log = device_name.clone();
    let thread_handle = std::thread::Builder::new()
        .name("albedo-audio-capture".into())
        .spawn(move || {
            let mut resampler: Option<FftFixedInOut<f32>> = if needs_resample {
                match FftFixedInOut::new(
                    native_rate as usize,
                    target_rate as usize,
                    1024,
                    1,
                ) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        let _ = setup_tx.send(Err(anyhow::anyhow!(
                            "Failed to create resampler: {}",
                            e
                        )));
                        return;
                    }
                }
            } else {
                None
            };
            let mut resample_buffer: Vec<f32> = Vec::new();

            let stream = match device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mono: Vec<f32> = if channels > 1 {
                        data.chunks(channels as usize)
                            .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                            .collect()
                    } else {
                        data.to_vec()
                    };

                    if let Some(ref mut rs) = resampler {
                        resample_buffer.extend_from_slice(&mono);
                        let needed = rs.input_frames_next();
                        while resample_buffer.len() >= needed {
                            let chunk: Vec<f32> = resample_buffer.drain(..needed).collect();
                            let input = [chunk];
                            if let Ok(output) = rs.process(&input, None) {
                                if let Some(resampled) = output.into_iter().next() {
                                    for batch in resampled.chunks(512) {
                                        let _ = cb_tx.try_send(batch.to_vec());
                                    }
                                }
                            }
                        }
                    } else {
                        for batch in mono.chunks(512) {
                            let _ = cb_tx.try_send(batch.to_vec());
                        }
                    }
                },
                |err| {
                    tracing::error!("Audio capture error: {}", err);
                },
                None,
            ) {
                Ok(s) => s,
                Err(e) => {
                    let _ = setup_tx.send(Err(anyhow::anyhow!(
                        "Failed to build input stream: {}",
                        e
                    )));
                    return;
                }
            };

            if let Err(e) = stream.play() {
                let _ = setup_tx.send(Err(anyhow::anyhow!(
                    "Failed to start capture stream: {}",
                    e
                )));
                return;
            }

            tracing::info!(
                "Audio capture started on '{}' at {} Hz",
                device_name_log,
                native_rate
            );
            let _ = setup_tx.send(Ok(()));

            rt_handle.block_on(async move {
                tokio::pin!(shutdown_rx);
                loop {
                    tokio::select! {
                        _ = &mut shutdown_rx => {
                            tracing::info!("Capture shutdown signal received");
                            break;
                        }
                        _ = tokio::time::sleep(Duration::from_millis(5)) => {
                            while let Ok(samples) = cb_rx.try_recv() {
                                if audio_tx.send(samples).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
            });

            drop(stream);
            tracing::info!("Audio capture stopped");
        })
        .context("Failed to spawn capture thread")?;

    setup_rx
        .recv()
        .context("Capture thread panicked during setup")??;

    Ok(CaptureHandle {
        device_name,
        shutdown_tx,
        _thread: thread_handle,
    })
}

pub fn stop_capture(handle: CaptureHandle) {
    let _ = handle.shutdown_tx.send(());
    let _ = handle._thread.join();
}
