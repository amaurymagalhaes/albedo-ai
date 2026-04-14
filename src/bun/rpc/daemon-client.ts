import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { existsSync } from "fs";
import { EventEmitter } from "events";
import { config } from "../config";

export interface AwarenessSnapshot {
  activeWindow: {
    title: string;
    appName: string;
    appPath: string;
    pid: number;
  } | null;
  metrics: {
    cpuPercent: number;
    ramPercent: number;
    diskPercent: number;
    networkMbpsIn: number;
    networkMbpsOut: number;
  } | null;
  clipboardContent: string;
  recentNotifications: string[];
  timestampMs: number;
}

export interface ToolResult {
  success: boolean;
  result: string;
  error: string;
}

export interface ToolSchemaDef {
  name: string;
  description: string;
  parametersJsonSchema: string;
  dangerous: boolean;
}

export interface ScreenCaptureResult {
  imageData: Uint8Array;
  ocrText: string;
  width: number;
  height: number;
}

export class DaemonClient extends EventEmitter {
  private client: any;
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessCall: any = null;
  private awarenessConfig: {
    intervalMs: number;
    includeClipboard: boolean;
    includeScreenOcr: boolean;
  } | null = null;
  private awarenessCallback: ((snapshot: AwarenessSnapshot) => void) | null = null;

  constructor(private socketPath: string) {
    super();
  }

  async connect(): Promise<void> {
    this.client?.close();

    const protoPath = this.resolveProto("daemon.proto");
    const packageDef = protoLoader.loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      }
    );
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    this.client = new proto.albedo.daemon.Daemon(
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
    console.log("[daemon-client] connected to", this.socketPath);
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
    this.stopAwarenessStream();
    this.client?.close();
    this.client = null;
    this.connected = false;
    console.log("[daemon-client] disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          this.client.getAwareness({}, (err: grpc.ServiceError | null) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000)
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit(
        "error",
        new Error(
          `DaemonClient: failed after ${this.maxReconnectAttempts} reconnect attempts`
        )
      );
      return;
    }

    const delay = Math.min(100 * Math.pow(2, this.reconnectAttempts), 5000);
    this.reconnectAttempts++;
    console.warn(
      `[daemon-client] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        if (this.awarenessConfig && this.awarenessCallback) {
          this.streamAwareness(this.awarenessConfig, this.awarenessCallback);
        }
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  close(): void {
    this.stopAwarenessStream();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client?.close();
    this.client = null;
    this.connected = false;
  }

  async getAwareness(): Promise<AwarenessSnapshot> {
    return this.withRetry(() =>
      new Promise<AwarenessSnapshot>((resolve, reject) => {
        this.client.getAwareness(
          {},
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else resolve(this.parseAwareness(response));
          }
        );
      })
    );
  }

  streamAwareness(
    config: { intervalMs: number; includeClipboard: boolean; includeScreenOcr: boolean },
    cb: (snapshot: AwarenessSnapshot) => void
  ): void {
    this.stopAwarenessStream();
    this.awarenessConfig = config;
    this.awarenessCallback = cb;

    const startStream = () => {
      this.awarenessCall = this.client.streamAwareness({
        interval_ms: config.intervalMs,
        include_clipboard: config.includeClipboard,
        include_screen_ocr: config.includeScreenOcr,
      });

      this.awarenessCall.on("data", (snapshot: any) => {
        cb(this.parseAwareness(snapshot));
      });

      this.awarenessCall.on("error", (err: Error) => {
        console.warn(
          "[daemon-client] awareness stream error:",
          err.message
        );
        setTimeout(() => {
          if (this.client) startStream();
        }, 2000);
      });
    };

    startStream();
  }

  stopAwarenessStream(): void {
    if (this.awarenessCall) {
      try {
        this.awarenessCall.cancel();
      } catch {}
      this.awarenessCall = null;
    }
  }

  async captureScreen(req: {
    region: string;
    format: string;
    quality: number;
    includeOcr: boolean;
  }): Promise<ScreenCaptureResult> {
    return this.withRetry(() =>
      new Promise<ScreenCaptureResult>((resolve, reject) => {
        this.client.captureScreen(
          {
            region: req.region,
            format: req.format,
            quality: req.quality,
            include_ocr: req.includeOcr,
          },
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else
              resolve({
                imageData: response.image_data,
                ocrText: response.ocr_text,
                width: response.width,
                height: response.height,
              });
          }
        );
      })
    );
  }

  async executeTool(
    toolName: string,
    argumentsJson: string
  ): Promise<ToolResult> {
    return this.withRetry(() =>
      new Promise<ToolResult>((resolve, reject) => {
        this.client.executeTool(
          {
            tool_name: toolName,
            arguments_json: argumentsJson,
            requires_confirmation: false,
          },
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else
              resolve({
                success: response.success,
                result: response.result,
                error: response.error,
              });
          }
        );
      })
    );
  }

  async listTools(): Promise<ToolSchemaDef[]> {
    return this.withRetry(() =>
      new Promise<ToolSchemaDef[]>((resolve, reject) => {
        this.client.listTools({}, (err: grpc.ServiceError | null, response: any) => {
          if (err) reject(err);
          else
            resolve(
              (response.tools ?? []).map((t: any) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters_json_schema,
                dangerous: t.dangerous,
              }))
            );
        });
      })
    );
  }

  private parseAwareness(raw: any): AwarenessSnapshot {
    return {
      activeWindow: raw.active_window
        ? {
            title: raw.active_window.title ?? "",
            appName: raw.active_window.app_name ?? "",
            appPath: raw.active_window.app_path ?? "",
            pid: raw.active_window.pid ?? 0,
          }
        : null,
      metrics: raw.metrics
        ? {
            cpuPercent: raw.metrics.cpu_percent ?? 0,
            ramPercent: raw.metrics.ram_percent ?? 0,
            diskPercent: raw.metrics.disk_percent ?? 0,
            networkMbpsIn: raw.metrics.network_mbps_in ?? 0,
            networkMbpsOut: raw.metrics.network_mbps_out ?? 0,
          }
        : null,
      clipboardContent: raw.clipboard_content ?? "",
      recentNotifications: raw.recent_notifications ?? [],
      timestampMs: Number(raw.timestamp_ms ?? 0),
    };
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;
    const maxRetries = 3;
    const backoffs = [100, 400, 1600];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        this.reconnectAttempts = 0;
        return result;
      } catch (err: any) {
        lastError = err;
        const isTransient =
          err?.code === grpc.status.UNAVAILABLE ||
          err?.code === 14;
        if (!isTransient || attempt >= maxRetries) throw err;

        this.connected = false;
        const delay = backoffs[attempt];
        console.warn(
          `[daemon-client] call failed (UNAVAILABLE), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((r) => setTimeout(r, delay));

        try {
          await this.connect();
          if (this.awarenessConfig && this.awarenessCallback) {
            this.streamAwareness(this.awarenessConfig, this.awarenessCallback);
          }
          console.log("[daemon-client] reconnected successfully");
        } catch {
          console.warn("[daemon-client] reconnect attempt failed");
        }
      }
    }

    throw lastError;
  }
}
