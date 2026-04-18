import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { existsSync } from "fs";
import { EventEmitter } from "events";
import { config } from "../config";

export interface TranscriptionEvent {
  text: string;
  isFinal: boolean;
  timestampMs: number;
}

export interface SynthesizeResult {
  pcmData: Uint8Array;
  visemes: Array<{
    shape: string;
    startMs: number;
    durationMs: number;
    weight: number;
  }>;
}

const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY = 100;

export class AudioClient extends EventEmitter {
  private client: any = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptionCb: ((result: TranscriptionEvent) => void) | null = null;
  private transcriptionCancel: (() => void) | null = null;
  private captureActive = false;
  private rawPcmChunks: Float32Array[] = [];
  private isRecordingRaw = false;

  constructor(private socketPath: string) {
    super();
  }

  async connect(): Promise<void> {
    this.client?.close();

    const protoPath = this.resolveProto("audio.proto");
    const packageDef = protoLoader.loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      }
    );
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    this.client = new proto.albedo.audio.AudioEngine(
      this.socketPath,
      grpc.credentials.createInsecure(),
      {
        "grpc.keepalive_time_ms": 30_000,
        "grpc.keepalive_timeout_ms": 10_000,
        "grpc.keepalive_permit_without_calls": 1,
        "grpc.http2.max_pings_without_data": 0,
      }
    );

    this.connected = true;
    this.reconnectAttempts = 0;
    console.log("[audio-client] connected to", this.socketPath);

    if (this.transcriptionCb) {
      this.registerTranscriptionStream(this.transcriptionCb);
    }
  }

  private resolveProto(filename: string): string {
    const candidates = [
      path.resolve(import.meta.dir, "../../../proto", filename),
      path.resolve(import.meta.dir, "../proto", filename),
      path.resolve(config.projectRoot, "proto", filename),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    throw new Error(`Cannot find ${filename} — checked: ${candidates.join(", ")}`);
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.transcriptionCancel) {
      this.transcriptionCancel();
      this.transcriptionCancel = null;
    }
    if (this.captureActive) {
      try {
        await this.stopCapture();
      } catch {}
    }
    this.client?.close();
    this.client = null;
    this.connected = false;
    console.log("[audio-client] disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      await Promise.race([
        new Promise<{ active: boolean; deviceName: string }>((resolve, reject) => {
          this.client.stopCapture({}, (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else resolve({ active: response.active, deviceName: response.device_name });
          });
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000)
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async play(_pcmData: Uint8Array): Promise<void> {
    console.log("[audio-client] play() is a no-op; playback is handled internally after synthesize");
  }

  async startCapture(config: {
    sampleRate: number;
    vadThreshold: number;
    deviceId?: string;
    sttBackend?: string;
    sttLanguage?: string;
  }): Promise<{ active: boolean; deviceName: string }> {
    return this.withReconnect(() =>
      new Promise((resolve, reject) => {
        this.client.startCapture(
          {
            sample_rate: config.sampleRate,
            vad_threshold: config.vadThreshold,
            device_id: config.deviceId || "",
            stt_backend: config.sttBackend || "",
            stt_language: config.sttLanguage || "",
          },
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else {
              this.captureActive = true;
              resolve({
                active: response.active,
                deviceName: response.device_name,
              });
            }
          }
        );
      })
    );
  }

  async stopCapture(): Promise<{ active: boolean; deviceName: string }> {
    return this.withReconnect(() =>
      new Promise((resolve, reject) => {
        this.client.stopCapture(
          {},
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else {
              this.captureActive = false;
              resolve({
                active: response.active,
                deviceName: response.device_name,
              });
            }
          }
        );
      })
    );
  }

  async listDevices(): Promise<{
    inputs: Array<{ id: string; name: string; isDefault: boolean }>;
    outputs: Array<{ id: string; name: string; isDefault: boolean }>;
  }> {
    return this.withReconnect(() =>
      new Promise((resolve, reject) => {
        this.client.listDevices(
          {},
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else {
              resolve({
                inputs: (response.inputs ?? []).map((d: any) => ({
                  id: d.id, name: d.name, isDefault: d.is_default,
                })),
                outputs: (response.outputs ?? []).map((d: any) => ({
                  id: d.id, name: d.name, isDefault: d.is_default,
                })),
              });
            }
          }
        );
      })
    );
  }

  async synthesize(req: {
    text: string;
    voiceId: string;
    speed: number;
  }): Promise<SynthesizeResult> {
    return this.withReconnect(() =>
      new Promise((resolve, reject) => {
        this.client.synthesize(
          {
            text: req.text,
            voice_id: req.voiceId,
            speed: req.speed,
          },
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else
              resolve({
                pcmData: response.pcm_data,
                visemes: (response.visemes ?? []).map((v: any) => ({
                  shape: v.shape,
                  startMs: v.start_ms,
                  durationMs: v.duration_ms,
                  weight: v.weight,
                })),
              });
          }
        );
      })
    );
  }

  async clearPlayback(): Promise<void> {
    return this.withReconnect(() =>
      new Promise((resolve, reject) => {
        this.client.clearPlayback(
          {},
          (err: grpc.ServiceError | null) => {
            if (err) reject(err);
            else resolve();
          }
        );
      })
    );
  }

  async waitForDrain(): Promise<void> {
    return this.withReconnect(() =>
      new Promise((resolve, reject) => {
        this.client.waitForDrain(
          {},
          (err: grpc.ServiceError | null) => {
            if (err) reject(err);
            else resolve();
          }
        );
      })
    );
  }

  async enqueuePCM(pcmData: Uint8Array, sampleRate: number): Promise<{ samplesEnqueued: number; durationMs: number }> {
    return this.withReconnect(() =>
      new Promise((resolve, reject) => {
        this.client.enqueuePcm(
          { pcm_data: pcmData, sample_rate: sampleRate },
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else resolve({
              samplesEnqueued: response.samples_enqueued,
              durationMs: response.duration_ms,
            });
          }
        );
      })
    );
  }

  onTranscription(
    cb: (result: TranscriptionEvent) => void
  ): () => void {
    this.transcriptionCb = cb;
    this.registerTranscriptionStream(cb);

    return () => {
      this.transcriptionCb = null;
      if (this.transcriptionCancel) {
        this.transcriptionCancel();
        this.transcriptionCancel = null;
      }
    };
  }

  private registerTranscriptionStream(
    cb: (result: TranscriptionEvent) => void
  ): void {
    if (this.transcriptionCancel) {
      this.transcriptionCancel();
      this.transcriptionCancel = null;
    }

    const call = this.client.watchTranscriptions({});
    call.on("data", (result: any) => {
      cb({
        text: result.text,
        isFinal: result.is_final,
        timestampMs: Number(result.timestamp_ms),
      });
    });
    call.on("error", (err: any) => {
      console.warn("[audio-client] transcription stream error:", err.message);
      if (err.code === 12) {
        console.warn("[audio-client] WatchTranscriptions not available — transcription will not work until the audio engine is updated");
        return;
      }
      if (this.isUnavailableError(err)) {
        this.scheduleReconnect();
      }
    });

    this.transcriptionCancel = () => {
      try {
        call.cancel();
      } catch {}
    };
  }

  close(): void {
    this.disconnect();
  }

  private async withReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (this.isUnavailableError(err)) {
        console.warn("[audio-client] gRPC call failed, attempting reconnect:", err.message);
        await this.attemptReconnect();
        return fn();
      }
      throw err;
    }
  }

  private isUnavailableError(err: any): boolean {
    if (!err) return false;
    const code = err.code;
    return (
      code === grpc.status.UNAVAILABLE ||
      code === grpc.status.DEADLINE_EXCEEDED
    );
  }

  private async attemptReconnect(): Promise<void> {
    for (let i = 0; i < RECONNECT_MAX_ATTEMPTS; i++) {
      const delay = RECONNECT_BASE_DELAY * Math.pow(4, i);
      console.log(`[audio-client] reconnect attempt ${i + 1}/${RECONNECT_MAX_ATTEMPTS} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await this.connect();
        return;
      } catch (err: any) {
        console.warn(`[audio-client] reconnect attempt ${i + 1} failed:`, err.message);
      }
    }
    this.connected = false;
    this.emit("error", new Error(`[audio-client] failed after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`));
    throw new Error(`[audio-client] failed after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.connected = false;
      this.emit("error", new Error(`[audio-client] failed after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`));
      return;
    }

    const delay = RECONNECT_BASE_DELAY * Math.pow(4, this.reconnectAttempts);
    this.reconnectAttempts++;
    console.warn(`[audio-client] scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  watchAudioLevel(
    cb: (level: { rms: number; peak: number; isSpeech: boolean }) => void
  ): () => void {
    let cancelled = false;
    const call = this.client.watchAudioLevel({});
    call.on("data", (msg: any) => {
      cb({
        rms: msg.rms,
        peak: msg.peak,
        isSpeech: msg.is_speech,
      });
    });
    call.on("error", () => { if (!cancelled) cancelled = true; });
    return () => {
      cancelled = true;
      call.cancel();
    };
  }

  /** Stop capture and return raw PCM buffer */
  async stopCaptureRaw(): Promise<Float32Array> {
    await this.stopCapture();
    return new Float32Array(0);
  }

  /** Force-transcribe the PTT buffer (no VAD) */
  async forceTranscribe(): Promise<string> {
    console.log("[audio-client] Calling ForceTranscribe RPC...");
    return new Promise((resolve, reject) => {
      this.client.forceTranscribe({}, (err: any, result: any) => {
        if (err) {
          console.error("[audio-client] ForceTranscribe error:", err.message);
          reject(err);
        } else {
          console.log("[audio-client] ForceTranscribe result:", result.text);
          resolve(result.text ?? "");
        }
      });
    });
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.setOutputDevice({ device_id: deviceId }, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Toggle PTT recording without stopping capture */
  async setPttRecording(recording: boolean): Promise<{ recording: boolean; bufferedSamples: number }> {
    return new Promise((resolve, reject) => {
      this.client.setPttRecording({ recording }, (err: any, response: any) => {
        if (err) reject(err);
        else resolve({
          recording: response.recording,
          bufferedSamples: Number(response.buffered_samples ?? 0),
        });
      });
    });
  }
}
