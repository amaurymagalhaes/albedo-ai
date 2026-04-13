import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { EventEmitter } from "events";

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
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessCall: any = null;

  constructor(private address: string) {
    super();
    this.connect();
  }

  private connect(): void {
    this.client?.close();

    const packageDef = protoLoader.loadSync(
      path.resolve(import.meta.dir, "../../../proto/daemon.proto"),
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      }
    );
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    this.client = new proto.albedo.daemon.Daemon(
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

    this.reconnectTimer = setTimeout(() => {
      try {
        this.connect();
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
  }

  async getAwareness(): Promise<AwarenessSnapshot> {
    return new Promise((resolve, reject) => {
      this.client.getAwareness(
        {},
        (err: grpc.ServiceError | null, response: any) => {
          if (err) reject(err);
          else resolve(this.parseAwareness(response));
        }
      );
    });
  }

  streamAwareness(
    config: { intervalMs: number; includeClipboard: boolean; includeScreenOcr: boolean },
    cb: (snapshot: AwarenessSnapshot) => void
  ): void {
    this.stopAwarenessStream();

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
    return new Promise((resolve, reject) => {
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
    });
  }

  async executeTool(
    toolName: string,
    argumentsJson: string
  ): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
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
    });
  }

  async listTools(): Promise<ToolSchemaDef[]> {
    return new Promise((resolve, reject) => {
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
    });
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
}
