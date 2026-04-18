export interface TTSResult {
  pcmData: Uint8Array;
  sampleRate: number;
  durationMs: number;
}

export class OmniVoiceClient {
  private baseUrl: string;
  private instructions: string;

  constructor(baseUrl: string, instructions?: string) {
    this.baseUrl = baseUrl;
    this.instructions = instructions ?? "female, young adult, moderate pitch, american accent";
  }

  async synthesize(text: string, speed = 1.0): Promise<TTSResult> {
    const url = `${this.baseUrl}/synthesize`;
    console.log(`[tts-client] POST ${url} (text=${text.slice(0, 40)})`);
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, speed, instructions: this.instructions }),
        });

        if (!res.ok) {
          throw new Error(`TTS server error: ${res.status} ${await res.text()}`);
        }

        const wavBuf = await res.arrayBuffer();
        const wav = new Uint8Array(wavBuf);

        const sampleRate = new DataView(wavBuf).getUint32(24, true);
        const dataLen = new DataView(wavBuf).getUint32(40, true);
        const pcmData = wav.slice(44, 44 + dataLen);
        const numSamples = dataLen / 2;
        const durationMs = (numSamples / sampleRate) * 1000;

        return { pcmData, sampleRate, durationMs };
      } catch (err: any) {
        console.warn(`[tts-client] attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        } else {
          throw err;
        }
      }
    }
    throw new Error("TTS synthesize failed after all retries");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
