import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";

const AUDIO_SOCK = "/tmp/albedo-mock-audio.sock";

const packageDef = protoLoader.loadSync(
  path.resolve(import.meta.dir, "../../proto/audio.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
);
const proto = grpc.loadPackageDefinition(packageDef) as any;

const server = new grpc.Server();

server.addService(proto.albedo.audio.AudioEngine.service, {
  startCapture: (_call: any, callback: any) => {
    callback(null, { active: true, device_name: "mock-mic" });
  },
  stopCapture: (_call: any, callback: any) => {
    callback(null, { active: false, device_name: "" });
  },
  synthesize: (call: any, callback: any) => {
    const text: string = call.request.text ?? "";
    const sampleRate = 16000;
    const durationSec = Math.max(0.5, text.length * 0.05);
    const numSamples = Math.floor(sampleRate * durationSec);
    const pcmData = Buffer.alloc(numSamples * 4);
    const visemes = [
      { shape: "A", start_ms: 0, duration_ms: Math.floor(durationSec * 1000), weight: 0.8 },
    ];

    callback(null, {
      pcm_data: pcmData,
      visemes,
    });
  },
  watchTranscriptions: (call: any) => {
    const phrases = [
      "Hello, can you hear me?",
      "What time is it?",
      "Tell me a joke.",
      "How's the weather today?",
      "What can you do?",
    ];
    let idx = 0;

    const sendNext = () => {
      if (call.cancelled) return;
      call.write({
        text: phrases[idx % phrases.length],
        confidence: 0.95,
        is_final: true,
        timestamp_ms: Date.now(),
      });
      idx++;
      setTimeout(sendNext, 5000);
    };

    setTimeout(sendNext, 2000);

    call.on("cancelled", () => {
      console.log("[mock-audio] transcription stream cancelled");
    });
  },
  streamSTT: (call: any) => {
    call.on("data", () => {});
    call.on("end", () => {
      call.write({
        text: "mock transcription",
        confidence: 0.9,
        is_final: true,
        timestamp_ms: Date.now(),
      });
      call.end();
    });
  },
  startLoopback: (_call: any, callback: any) => {
    callback(null, { active: true, device_name: "mock-loopback" });
  },
  stopLoopback: (_call: any, callback: any) => {
    callback(null, { active: false, device_name: "" });
  },
});

try {
  const fs = await import("fs");
  try { fs.unlinkSync(AUDIO_SOCK); } catch {}
} catch {}

server.bindAsync(
  `unix://${AUDIO_SOCK}`,
  grpc.credentials.createInsecure(),
  (err, port) => {
    if (err) {
      console.error("[mock-audio] failed to start:", err);
      process.exit(1);
    }
    console.log(`[mock-audio] listening on unix://${AUDIO_SOCK}`);
    server.start();
  }
);
