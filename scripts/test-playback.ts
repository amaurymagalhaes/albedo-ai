import { AudioClient } from "../src/bun/rpc/audio-client";

const client = new AudioClient("unix:///tmp/albedo-audio.sock");
await client.connect();
console.log("Connected to audio engine");

// Get TTS audio via HTTP
const resp = await fetch("http://localhost:9880/synthesize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Albedo está falando! Você consegue me ouvir?", speed: 1.0 }),
});

if (!resp.ok) {
  console.error("TTS failed:", resp.status);
  process.exit(1);
}

const wavBuf = new Uint8Array(await resp.arrayBuffer());
const view = new DataView(wavBuf.buffer);
const sampleRate = view.getUint32(24, true);
const dataLen = view.getUint32(40, true);
const pcmData = wavBuf.slice(44, 44 + dataLen);

console.log(`TTS: ${pcmData.length} PCM bytes, ${sampleRate} Hz, ${(dataLen/2/sampleRate).toFixed(1)}s`);

// Clear any existing playback
await client.clearPlayback();

// Enqueue PCM
const result = await client.enqueuePCM(pcmData, sampleRate);
console.log(`enqueuePCM OK: ${result.samplesEnqueued} samples, ${result.durationMs.toFixed(0)}ms`);

// Wait for playback to drain
try {
  await client.waitForDrain(10000);
  console.log("Playback drained");
} catch {
  console.log("Drain timeout or not available");
}
process.exit(0);
