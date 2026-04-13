import { AudioClient } from "../src/bun/rpc/audio-client";
import { DaemonClient } from "../src/bun/rpc/daemon-client";
import { GrokClient } from "../src/bun/grok-client";
import { config } from "../src/bun/config";

async function testAudio() {
  console.log("── Audio Engine ──");
  const c = new AudioClient(config.audioSocketPath);
  await c.connect();

  const status = await c.startCapture({
    sampleRate: 16000,
    vadThreshold: 0.5,
  });
  console.assert(status.active, "startCapture should return active=true");
  console.log("  Capture started:", status.deviceName);
  await c.stopCapture();

  const resp = await c.synthesize({
    text: "Hello world",
    voiceId: config.defaultVoiceId,
    speed: config.defaultVoiceSpeed,
  });
  console.assert(resp.pcmData.length > 0, "synthesize should return audio bytes");
  console.assert(resp.visemes.length > 0, "synthesize should return visemes");
  console.log(`  TTS: ${resp.pcmData.length} bytes, ${resp.visemes.length} visemes ✓`);

  await c.disconnect();
}

async function testDaemon() {
  console.log("── Go Daemon ──");
  const c = new DaemonClient(config.daemonSocketPath);
  await c.connect();

  const snap = await c.getAwareness();
  console.assert(snap.timestampMs > 0, "awareness snapshot must have timestamp");
  console.log(
    `  Awareness: active window="${snap.activeWindow?.title ?? "none"}" CPU=${snap.metrics?.cpuPercent.toFixed(1) ?? "N/A"}% ✓`
  );

  const tools = await c.listTools();
  console.assert(tools.length >= 5, "daemon must expose at least 5 tools");
  console.log(`  Tools: ${tools.map((t) => t.name).join(", ")} ✓`);

  const result = await c.executeTool(
    "read_file",
    JSON.stringify({ path: "/etc/hostname" })
  );
  console.assert(result.success, "read_file should succeed");
  console.log(`  Tool exec: read_file → "${result.result.trim()}" ✓`);

  await c.disconnect();
}

async function testGrok() {
  console.log("── Grok API ──");
  const g = new GrokClient({
    apiKey: config.openrouterApiKey,
    model: config.llmModel,
    baseUrl: config.llmBaseUrl,
    maxTokens: 64,
    temperature: 0,
  });
  let tokens = "";
  for await (const chunk of g.chatStream(
    [{ role: "user", content: "Say only: integration test ok" }],
    []
  )) {
    if (chunk.type === "content") tokens += chunk.text;
  }
  console.assert(tokens.length > 0, "Grok must return tokens");
  console.log(`  Grok response: "${tokens.trim()}" ✓`);
}

console.log("Albedo AI Integration Test");
console.log(
  "Note: assumes albedo-audio and albedo-daemon are already running\n"
);

try {
  await testAudio();
  await testDaemon();
  await testGrok();
  console.log("\nAll checks passed.");
} catch (err) {
  console.error("\nTest failed:", err);
  process.exit(1);
}
