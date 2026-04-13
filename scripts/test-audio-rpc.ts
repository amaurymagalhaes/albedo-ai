import { AudioClient } from "../src/bun/rpc/audio-client";

const client = new AudioClient("unix:///tmp/albedo-mock-audio.sock");

try {
  const status = await client.startCapture({ sampleRate: 16000, vadThreshold: 0.5 });
  console.log("CaptureStatus:", status);

  console.log("Listening for transcriptions (press Ctrl+C to exit)...");
  client.onTranscription((result) => {
    console.log(`[transcription] isFinal=${result.isFinal}: "${result.text}"`);
  });

  await Bun.sleep(12000);
} catch (err) {
  console.error("Error:", err);
} finally {
  client.close();
}
