import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { EventEmitter } from "events";

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

export class AudioClient extends EventEmitter {
  private client: any;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private address: string) {
    super();
    this.connect();
  }

  private connect(): void {
    this.client?.close();

    const packageDef = protoLoader.loadSync(
      path.resolve(import.meta.dir, "../../../proto/audio.proto"),
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      }
    );
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    this.client = new proto.albedo.audio.AudioEngine(
      this.address,
      grpc.credentials.createInsecure(),
      {
        "grpc.keepalive_time_ms": 30_000,
        "grpc.keepalive_timeout_ms": 10_000,
        "grpc.keepalive_permit_without_calls": 1,
        "grpc.http2.max_pings_without_data": 0,
      }
    );

    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit("error", new Error(`AudioClient: failed after ${this.maxReconnectAttempts} reconnect attempts`));
      return;
    }

    const delay = Math.min(100 * Math.pow(2, this.reconnectAttempts), 5000);
    this.reconnectAttempts++;
    console.warn(`[audio-client] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      try {
        this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client?.close();
    this.client = null;
  }

  async startCapture(config: {
    sampleRate: number;
    vadThreshold: number;
  }): Promise<{ active: boolean; deviceName: string }> {
    return new Promise((resolve, reject) => {
      this.client.startCapture(
        {
          sample_rate: config.sampleRate,
          vad_threshold: config.vadThreshold,
        },
        (err: grpc.ServiceError | null, response: any) => {
          if (err) reject(err);
          else
            resolve({
              active: response.active,
              deviceName: response.device_name,
            });
        }
      );
    });
  }

  async stopCapture(): Promise<{ active: boolean; deviceName: string }> {
    return new Promise((resolve, reject) => {
      this.client.stopCapture(
        {},
        (err: grpc.ServiceError | null, response: any) => {
          if (err) reject(err);
          else
            resolve({
              active: response.active,
              deviceName: response.device_name,
            });
        }
      );
    });
  }

  async synthesize(req: {
    text: string;
    voiceId: string;
    speed: number;
  }): Promise<SynthesizeResult> {
    return new Promise((resolve, reject) => {
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
    });
  }

  onTranscription(
    cb: (result: TranscriptionEvent) => void
  ): () => void {
    const call = this.client.watchTranscriptions({});
    call.on("data", (result: any) => {
      cb({
        text: result.text,
        isFinal: result.is_final,
        timestampMs: Number(result.timestamp_ms),
      });
    });
    call.on("error", (err: Error) => {
      console.warn("[audio-client] transcription stream error:", err.message);
      this.emit("error", err);
    });

    return () => {
      try {
        call.cancel();
      } catch {}
    };
  }
}
