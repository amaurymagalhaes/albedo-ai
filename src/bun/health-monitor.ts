import { EventEmitter } from "events";
import { spawn } from "child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { config } from "./config";

interface HealthStatus {
  tts: "ok" | "down" | "unknown";
  audioEngine: "ok" | "down" | "unknown";
  daemon: "ok" | "down" | "unknown";
  whisper: "ok" | "down" | "unknown";
  capture: "ok" | "down" | "unknown";
}

export class HealthMonitor extends EventEmitter {
  private ttsUrl: string;
  private ttsProcess: ReturnType<typeof spawn> | null = null;
  private ttsRestarts = 0;
  private maxTtsRestarts = 5;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastStatus: HealthStatus = {
    tts: "unknown",
    audioEngine: "unknown",
    daemon: "unknown",
    whisper: "unknown",
    capture: "unknown",
  };

  constructor(ttsUrl: string) {
    super();
    this.ttsUrl = ttsUrl;
  }

  /** Run initial health checks and auto-fix what's broken */
  async diagnoseAndFix(): Promise<HealthStatus> {
    console.log("[health] Running startup diagnostics...");

    const status = await this.checkAll();
    this.lastStatus = status;
    this.logStatus(status);

    // Auto-fix TTS if down
    if (status.tts === "down") {
      console.log("[health] TTS server is down, attempting restart...");
      await this.restartTts();
      // Re-check
      const ttsOk = await this.checkTts();
      status.tts = ttsOk ? "ok" : "down";
      if (ttsOk) {
        console.log("[health] ✅ TTS server restarted successfully");
      } else {
        console.error("[health] ❌ TTS server restart failed");
      }
    }

    // Report
    const allOk = Object.values(status).every(s => s === "ok" || s === "unknown");
    if (allOk) {
      console.log("[health] ✅ All services healthy");
    } else {
      const issues = Object.entries(status)
        .filter(([, v]) => v === "down")
        .map(([k]) => k);
      console.warn(`[health] ⚠️ Issues: ${issues.join(", ")}`);
    }

    this.emit("health-check", status);
    return status;
  }

  /** Start periodic monitoring (every 30s) */
  startMonitoring(intervalMs = 30000): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(async () => {
      const status = await this.checkAll();
      const changed = JSON.stringify(status) !== JSON.stringify(this.lastStatus);
      this.lastStatus = status;

      if (changed) {
        this.logStatus(status);
        this.emit("health-check", status);
      }

      // Auto-heal TTS
      if (status.tts === "down" && this.ttsRestarts < this.maxTtsRestarts) {
        console.log("[health] TTS went down during runtime, restarting...");
        await this.restartTts();
      }
    }, intervalMs);
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async checkAll(): Promise<HealthStatus> {
    const [tts, audioEngine, daemon] = await Promise.all([
      this.checkTts(),
      this.checkSocket(config.audioSocketPath),
      this.checkSocket(config.daemonSocketPath),
    ]);

    return {
      tts: tts ? "ok" : "down",
      audioEngine: audioEngine ? "ok" : "down",
      daemon: daemon ? "ok" : "down",
      whisper: "unknown", // checked indirectly via audioEngine
      capture: "unknown", // checked indirectly via audioEngine
    };
  }

  private async checkTts(): Promise<boolean> {
    try {
      const url = this.ttsUrl.replace(/\/$/, "") + "/synthesize";
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "", speed: 1.0 }),
        signal: AbortSignal.timeout(3000),
      });
      // Empty text returns 400 which means server is alive and API key works
      // 500 means server is up but API key / backend is broken
      return resp.status !== 500;
    } catch {
      return false;
    }
  }

  private async checkSocket(socketPath: string): Promise<boolean> {
    const fsPath = socketPath.startsWith("unix://")
      ? socketPath.slice("unix://".length)
      : socketPath;
    return existsSync(fsPath);
  }

  async restartTts(): Promise<boolean> {
    // Kill existing
    try {
      Bun.spawnSync(["pkill", "-f", "python3 scripts/tts/server.py"], { stderr: "ignore" });
    } catch {}

    await new Promise(r => setTimeout(r, 1000));

    // Start fresh
    const projectRoot = config.projectRoot;
    let apiKey = process.env.ELEVENLABS_API_KEY || "";
    if (!apiKey) {
      try {
        const envContent = readFileSync(join(projectRoot, ".env"), "utf-8");
        const match = envContent.match(/ELEVENLABS_API_KEY=(.+)/);
        if (match) apiKey = match[1].trim();
      } catch {}
    }

    if (!apiKey) {
      console.error("[health] Cannot restart TTS: no API key");
      return false;
    }

    const port = parseInt(this.ttsUrl.match(/:(\d+)/)?.[1] || "9880", 10);

    return new Promise((resolve) => {
      try {
        this.ttsProcess = spawn("python3", [
          "scripts/tts/server.py",
          "--port", String(port),
          "--api-key", apiKey,
        ], {
          cwd: projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });

        this.ttsProcess.stdout?.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          if (line) console.log(`[tts-server] ${line}`);
        });

        this.ttsProcess.stderr?.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          if (line) console.error(`[tts-server] ${line}`);
        });

        this.ttsProcess.on("exit", (code) => {
          console.warn(`[health] TTS server exited with code ${code}`);
          this.ttsProcess = null;
        });

        // Wait for it to be ready
        let attempts = 0;
        const checkReady = setInterval(async () => {
          attempts++;
          const ok = await this.checkTts();
          if (ok) {
            clearInterval(checkReady);
            this.ttsRestarts++;
            console.log(`[health] TTS server ready (restart #${this.ttsRestarts})`);
            resolve(true);
          } else if (attempts >= 15) {
            clearInterval(checkReady);
            console.error("[health] TTS server failed to start within 15s");
            resolve(false);
          }
        }, 1000);
      } catch (err: any) {
        console.error("[health] Failed to spawn TTS server:", err.message);
        resolve(false);
      }
    });
  }

  getStatus(): HealthStatus {
    return { ...this.lastStatus };
  }

  private logStatus(status: HealthStatus): void {
    const icons: Record<string, string> = { ok: "✅", down: "❌", unknown: "❓" };
    const lines = Object.entries(status).map(
      ([k, v]) => `  ${icons[v]} ${k}: ${v}`
    );
    console.log(`[health] Status:\n${lines.join("\n")}`);
  }
}
