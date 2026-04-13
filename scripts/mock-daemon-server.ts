import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";

const DAEMON_SOCK = "/tmp/albedo-mock-daemon.sock";

const packageDef = protoLoader.loadSync(
  path.resolve(import.meta.dir, "../../proto/daemon.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
);
const proto = grpc.loadPackageDefinition(packageDef) as any;

const server = new grpc.Server();

server.addService(proto.albedo.daemon.Daemon.service, {
  getAwareness: (_call: any, callback: any) => {
    callback(null, {
      active_window: { title: "Terminal", app_name: "Alacritty", app_path: "/usr/bin/alacritty", pid: 1234 },
      metrics: { cpu_percent: 23.5, ram_percent: 45.2, disk_percent: 60.0, network_mbps_in: 1.2, network_mbps_out: 0.5, top_processes: [] },
      clipboard_content: "mock clipboard",
      recent_notifications: ["Notification 1", "Notification 2"],
      timestamp_ms: Date.now(),
    });
  },
  streamAwareness: (call: any) => {
    const sendSnapshot = () => {
      if (call.cancelled) return;
      call.write({
        active_window: { title: "Terminal", app_name: "Alacritty", app_path: "/usr/bin/alacritty", pid: 1234 },
        metrics: { cpu_percent: Math.random() * 50, ram_percent: 40 + Math.random() * 20, disk_percent: 60.0, network_mbps_in: Math.random() * 5, network_mbps_out: Math.random() * 2, top_processes: [] },
        clipboard_content: "",
        recent_notifications: [],
        timestamp_ms: Date.now(),
      });
      setTimeout(sendSnapshot, 5000);
    };
    sendSnapshot();
    call.on("cancelled", () => {});
  },
  captureScreen: (_call: any, callback: any) => {
    callback(null, {
      image_data: Buffer.alloc(0),
      ocr_text: "mock screen text",
      width: 1920,
      height: 1080,
    });
  },
  executeTool: (call: any, callback: any) => {
    const toolName = call.request.tool_name;
    const argsJson = call.request.arguments_json;
    console.log(`[mock-daemon] executeTool: ${toolName}(${argsJson})`);
    callback(null, {
      success: true,
      result: `Mock result for ${toolName}`,
      error: "",
    });
  },
  listTools: (_call: any, callback: any) => {
    callback(null, {
      tools: [
        {
          name: "get_time",
          description: "Get the current time",
          parameters_json_schema: JSON.stringify({ type: "object", properties: { timezone: { type: "string" } } }),
          dangerous: false,
        },
        {
          name: "screenshot",
          description: "Take a screenshot",
          parameters_json_schema: JSON.stringify({ type: "object", properties: { region: { type: "string", enum: ["full", "active_window"] } } }),
          dangerous: false,
        },
        {
          name: "open_app",
          description: "Open an application",
          parameters_json_schema: JSON.stringify({ type: "object", properties: { app_name: { type: "string" } }, required: ["app_name"] }),
          dangerous: true,
        },
      ],
    });
  },
});

try {
  const fs = await import("fs");
  try { fs.unlinkSync(DAEMON_SOCK); } catch {}
} catch {}

server.bindAsync(
  `unix://${DAEMON_SOCK}`,
  grpc.credentials.createInsecure(),
  (err, port) => {
    if (err) {
      console.error("[mock-daemon] failed to start:", err);
      process.exit(1);
    }
    console.log(`[mock-daemon] listening on unix://${DAEMON_SOCK}`);
    server.start();
  }
);
