import { EventEmitter } from "events";
import { existsSync, unlinkSync } from "fs";
import { connect } from "net";
import type { AlbedoConfig } from "./config";

interface ManagedProcess {
  name: string;
  binPath: string;
  socketPath: string;
  proc: any | null;
  restartCount: number;
  lastRestartTime: number;
}

export class ProcessManager extends EventEmitter {
  private processes: Map<string, ManagedProcess>;
  private config: AlbedoConfig;
  private shuttingDown = false;

  constructor(config: AlbedoConfig) {
    super();
    this.config = config;
    this.processes = new Map();

    this.processes.set("albedo-audio", {
      name: "albedo-audio",
      binPath: config.audioBinPath,
      socketPath: config.audioSocketPath,
      proc: null,
      restartCount: 0,
      lastRestartTime: 0,
    });

    this.processes.set("albedo-daemon", {
      name: "albedo-daemon",
      binPath: config.daemonBinPath,
      socketPath: config.daemonSocketPath,
      proc: null,
      restartCount: 0,
      lastRestartTime: 0,
    });
  }

  async start(): Promise<void> {
    const audio = this.processes.get("albedo-audio")!;
    const daemon = this.processes.get("albedo-daemon")!;

    await this.spawnProcess(audio, "[audio]");
    this.emit("spawned", { name: audio.name });
    await this.waitForSocket(audio.socketPath, 10_000);
    this.emit("ready", { name: audio.name });

    await this.spawnProcess(daemon, "[daemon]");
    this.emit("spawned", { name: daemon.name });
    await this.waitForSocket(daemon.socketPath, 10_000);
    this.emit("ready", { name: daemon.name });
  }

  private async spawnProcess(mp: ManagedProcess, tag: string): Promise<void> {
    const binPath = mp.binPath;
    const projectRoot = this.config.projectRoot;

    // Strip LD_PRELOAD inherited from CEF parent — child processes don't need CEF libs
    const cleanEnv = { ...process.env };
    delete cleanEnv.LD_PRELOAD;

    if (mp.name === "albedo-audio") {
      cleanEnv.STT_BACKEND = this.config.sttBackend;
      cleanEnv.ALBEDO_STT_LANGUAGE = this.config.sttLanguage;
    }

    const proc = Bun.spawn([binPath], {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
      env: cleanEnv,
    });

    if (proc.exitCode !== null) {
      throw new Error(`Process ${mp.name} exited immediately with code ${proc.exitCode}`);
    }

    mp.proc = proc;

    this.pipeStderr(proc, tag);

    proc.exited.then((exitCode) => {
      if (this.shuttingDown) return;

      const signal = proc.signalCode;
      if (exitCode !== 0 || signal) {
        this.emit("crash", { name: mp.name, exitCode, signal });
        this.attemptRestart(mp, tag);
      }
    });
  }

  private pipeStderr(proc: any, tag: string): void {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();

    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (line) {
            console.error(`${tag} ${line}`);
          }
        }
      }
    };

    readLoop();
  }

  private async attemptRestart(mp: ManagedProcess, tag: string): Promise<void> {
    const now = Date.now();

    if (now - mp.lastRestartTime < 60_000) {
      mp.restartCount++;
    } else {
      mp.restartCount = 1;
    }
    mp.lastRestartTime = now;

    if (mp.restartCount > this.config.maxProcessRestarts) {
      this.emit("fatal-crash", { name: mp.name, restartCount: mp.restartCount });
      return;
    }

    this.emit("restarting", { name: mp.name, restartCount: mp.restartCount });

    await new Promise((resolve) => setTimeout(resolve, this.config.processRestartDelayMs));

    if (this.shuttingDown) return;

    await this.spawnProcess(mp, tag);
    this.emit("spawned", { name: mp.name });

    try {
      await this.waitForSocket(mp.socketPath, 10_000);
      this.emit("ready", { name: mp.name });
    } catch {
      this.emit("crash", { name: mp.name, exitCode: -1, signal: null });
      this.attemptRestart(mp, tag);
    }
  }

  async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const fsPath = socketPath.startsWith("unix://")
      ? socketPath.slice("unix://".length)
      : socketPath;

    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        await tryConnect(fsPath);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    throw {
      name: "SocketTimeoutError",
      message: `Socket ${fsPath} did not become ready within ${timeoutMs}ms`,
      socketPath: fsPath,
      timeoutMs,
    };

    function tryConnect(sockPath: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const socket = connect(sockPath, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
      });
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    for (const [, mp] of this.processes) {
      if (!mp.proc) continue;

      try {
        mp.proc.kill("SIGTERM");
      } catch {}
    }

    for (const [, mp] of this.processes) {
      if (!mp.proc) continue;

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (mp.proc.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (mp.proc.exitCode === null) {
        try {
          mp.proc.kill("SIGKILL");
        } catch {}
      }
    }

    for (const [, mp] of this.processes) {
      const fsPath = mp.socketPath.startsWith("unix://")
        ? mp.socketPath.slice("unix://".length)
        : mp.socketPath;

      if (existsSync(fsPath)) {
        try {
          unlinkSync(fsPath);
        } catch {}
      }
    }

    this.emit("shutdown-complete", {});
  }

  getProcess(name: string): ManagedProcess | undefined {
    return this.processes.get(name);
  }
}
