import { BrowserWindow } from "electrobun";
import { BrowserView, GlobalShortcut } from "electrobun";
import { existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ProcessManager } from "./process-manager";
import { AudioClient } from "./rpc/audio-client";
import { DaemonClient } from "./rpc/daemon-client";
import { Orchestrator } from "./orchestrator";
import { GrokClient } from "./grok-client";
import { HealthMonitor } from "./health-monitor";
import { config } from "./config";
import { discoverAvatars } from "./avatar-discovery";
import type { AlbedoRPCSchema, SettingsRPCSchema } from "../rpc-schema";

let bootComplete = false;

// ─── Avatar discovery ───────────────────────────────────────────────────
const modelsDir = join(config.projectRoot, "assets", "models");
let availableAvatars = discoverAvatars(modelsDir);
console.log(`[avatar-discovery] Found ${availableAvatars.length} avatar(s):`, availableAvatars.map((a) => `${a.name} (${a.format})`).join(", "));

let selectedAvatarId = (config.get("selected-avatar-id") as string) ?? availableAvatars[0]?.id ?? "default";

function getSelectedAvatar() {
  return availableAvatars.find((a) => a.id === selectedAvatarId) ?? availableAvatars[0] ?? null;
}

const rpc = BrowserView.defineRPC<AlbedoRPCSchema>({
  handlers: {
    messages: {
      "webview-ready": () => {
        console.log("[index] Webview ready");
        // Send saved UI state to webview
        const savedScale = (config.get("avatar-scale") as number) ?? 1.0;
        const savedX = (config.get("avatar-offset-x") as number) ?? 0;
        const savedY = (config.get("avatar-offset-y") as number) ?? 0;
        rpc.send("avatar-scale", { scale: savedScale });
        rpc.send("avatar-position", { x: savedX, y: savedY });
        // Send avatar list and current selection
        rpc.send("avatar-list", { avatars: availableAvatars });
        const sel = getSelectedAvatar();
        if (sel) {
          rpc.send("avatar-changed", { id: sel.id, name: sel.name, format: sel.format, path: sel.path });
        }
        if (bootComplete) {
          orchestrator.start().catch((err) => {
            console.error("[index] Orchestrator start failed:", err);
          });
        }
      },
      "chat-message": ({ text }) => {
        orchestrator.processUtterance(text).catch((err) => {
          console.error("[index] processUtterance failed:", err);
        });
      },
      "setting-changed": ({ key, value }) => {
        config.set(key, value as string | number | boolean);
      },
      "tool-confirmation-response": ({ approved }) => {
        orchestrator.handleConfirmationResponse(approved);
      },
      "window-drag-start": () => {
        startWindowDrag();
      },
      "window-drag-stop": () => {
        stopAllDrag();
      },
      "drag-stop": () => {
        stopAllDrag();
      },
      "drag-start": () => {
        startAvatarDrag();
      },
      "set-avatar-scale": ({ scale }) => {
        config.set("avatar-scale", scale);
      },
      "list-audio-devices": async () => {
        try {
          const { inputs, outputs } = await audioClient.listDevices();
          rpc.send("audio-devices", { inputs, outputs });
        } catch (err: any) {
          console.warn("[index] listDevices failed:", err.message);
        }
      },
      "set-output-device": async ({ deviceId }: { deviceId: string }) => {
        try {
          if (deviceId.startsWith("alsa_output.")) {
            Bun.spawnSync(["pactl", "set-default-sink", deviceId]);
            console.log("[index] Set PipeWire default sink:", deviceId);
          }
          await audioClient.setOutputDevice(deviceId.startsWith("alsa_output.") ? "pipewire" : deviceId);
          config.set("output-device-id", deviceId);
        } catch (err: any) {
          console.warn("[index] set-output-device failed:", err.message);
        }
      },
      "set-audio-device": async ({ deviceId }) => {
        try {
          // If it's a PipeWire source ID, set it as default via pactl
          if (deviceId.startsWith("alsa_input.")) {
            const proc = Bun.spawn(["pactl", "set-default-source", deviceId]);
            await proc.exited;
            console.log("[index] Set PipeWire default source:", deviceId);
            deviceId = "pipewire";
          }
          const wasMuted = orchestrator.isMuted();
          if (!wasMuted) orchestrator.setMuted(true);
          config.set("audio-device-id", deviceId);
          if (!wasMuted) orchestrator.setMuted(false);
          rpc.send("current-device", { id: deviceId, name: deviceId });
        } catch (err: any) {
          console.warn("[index] set-audio-device failed:", err.message);
        }
      },
      "toggle-settings": () => {
        if (settingsWindow) {
          closeSettingsWindow();
        } else {
          openSettingsWindow();
        }
      },
      "list-avatars": () => {
        rpc.send("avatar-list", { avatars: availableAvatars });
      },
      "select-avatar": ({ id }) => {
        const avatar = availableAvatars.find((a) => a.id === id);
        if (!avatar) {
          console.warn("[index] Avatar not found:", id);
          return;
        }
        selectedAvatarId = id;
        config.set("selected-avatar-id", id);
        rpc.send("avatar-changed", { id: avatar.id, name: avatar.name, format: avatar.format, path: avatar.path });
        console.log(`[index] Avatar changed to: ${avatar.name} (${avatar.format})`);
      },
    },
  },
});

// ─── X11 Drag via xdotool polling ────────────────────────────────────────
let dragInterval: ReturnType<typeof setInterval> | null = null;
let lastMouseX = 0;
let lastMouseY = 0;
let lastMoveTime = 0;
let avatarOffsetX = (config.get("avatar-offset-x") as number) ?? 0;
let avatarOffsetY = (config.get("avatar-offset-y") as number) ?? 0;
let dragStartMouseX = 0;
let dragStartMouseY = 0;
let dragStarted = false;

function stopAllDrag() {
  if (dragInterval) { clearInterval(dragInterval); dragInterval = null; }
}

function startWindowDrag() {
  const loc = Bun.spawnSync(["xdotool", "getmouselocation", "--shell"]);
  const out = loc.stdout?.toString() ?? "";
  lastMouseX = parseInt(out.match(/X=(\d+)/)?.[1] ?? "0");
  lastMouseY = parseInt(out.match(/Y=(\d+)/)?.[1] ?? "0");
  lastMoveTime = Date.now();
  if (dragInterval) clearInterval(dragInterval);
  dragInterval = setInterval(() => {
    const loc = Bun.spawnSync(["xdotool", "getmouselocation", "--shell"]);
    const out = loc.stdout?.toString() ?? "";
    const mx = parseInt(out.match(/X=(\d+)/)?.[1] ?? "0");
    const my = parseInt(out.match(/Y=(\d+)/)?.[1] ?? "0");
    const dx = mx - lastMouseX;
    const dy = my - lastMouseY;
    if (dx !== 0 || dy !== 0) {
      lastMouseX = mx;
      lastMouseY = my;
      lastMoveTime = Date.now();
      win.setPosition(win.frame.x + dx, win.frame.y + dy);
    } else if (Date.now() - lastMoveTime > 300) {
      // Auto-stop: no movement for 300ms means mouse was released
      if (dragInterval) { clearInterval(dragInterval); dragInterval = null; }
    }
  }, 16);
}

function startAvatarDrag() {
  const loc = Bun.spawnSync(["xdotool", "getmouselocation", "--shell"]);
  const out = loc.stdout?.toString() ?? "";
  dragStartMouseX = parseInt(out.match(/X=(\d+)/)?.[1] ?? "0");
  dragStartMouseY = parseInt(out.match(/Y=(\d+)/)?.[1] ?? "0");
  lastMouseX = dragStartMouseX;
  lastMouseY = dragStartMouseY;
  lastMoveTime = Date.now();
  dragStarted = false;
  if (dragInterval) clearInterval(dragInterval);
  dragInterval = setInterval(() => {
    const loc = Bun.spawnSync(["xdotool", "getmouselocation", "--shell"]);
    const out = loc.stdout?.toString() ?? "";
    const mx = parseInt(out.match(/X=(\d+)/)?.[1] ?? "0");
    const my = parseInt(out.match(/Y=(\d+)/)?.[1] ?? "0");
    const dx = mx - lastMouseX;
    const dy = my - lastMouseY;
    if (dx !== 0 || dy !== 0) {
      // Don't start actual drag until mouse moves 3px (distinguish click from drag)
      if (!dragStarted) {
        const totalDx = mx - dragStartMouseX;
        const totalDy = my - dragStartMouseY;
        if (Math.abs(totalDx) < 3 && Math.abs(totalDy) < 3) return;
        dragStarted = true;
      }
      lastMouseX = mx;
      lastMouseY = my;
      lastMoveTime = Date.now();
      avatarOffsetX = Math.max(-200, Math.min(200, avatarOffsetX + dx));
      avatarOffsetY = Math.max(-300, Math.min(300, avatarOffsetY + dy));
      rpc.send("avatar-position", { x: avatarOffsetX, y: avatarOffsetY });
    } else if (Date.now() - lastMoveTime > 300) {
      // Auto-stop when no movement (mouse released without triggering mouseup)
      if (dragInterval) { clearInterval(dragInterval); dragInterval = null; }
      // Save avatar position on drag end
      config.set("avatar-offset-x", avatarOffsetX);
      config.set("avatar-offset-y", avatarOffsetY);
    }
  }, 16);
}

const WIN_W = 420;
const WIN_H = 650;

const win = new BrowserWindow({
  title: "Albedo AI",
  url: "views://mainview/index.html",
  frame: { width: WIN_W, height: WIN_H, x: 0, y: 0 },
  titleBarStyle: "hidden",
  transparent: true,
  renderer: "cef",
  rpc,
} as any);

win.setAlwaysOnTop(true);

try {
  win.on("close", () => {
    shutdown(0);
  });
} catch {}

// Move to primary monitor's bottom-right after a short delay
setTimeout(() => {
  try {
    const xrandr = Bun.spawnSync(["xrandr", "--current"]);
    const xout = xrandr.stdout?.toString() ?? "";
    const m = xout.match(/connected\s+primary\s+(\d+)x(\d+)\+(\d+)\+(\d+)/);
    if (m) {
      const monW = parseInt(m[1]);
      const monH = parseInt(m[2]);
      const monX = parseInt(m[3]);
      const monY = parseInt(m[4]);
      const px = monX + monW - WIN_W;
      const py = monY + monH - WIN_H;
      win.setPosition(px, py);
      console.log(`[index] Positioned at ${px},${py} (monitor ${monX},${monY} ${monW}x${monH})`);
    }
  } catch {}
}, 500);

// ─── Settings Window ───────────────────────────────────────────────────
let settingsWindow: BrowserWindow | null = null;
let settingsRpc: any = null;

function handleSettingChange(key: string, value: unknown) {
  config.set(key, value as string | number | boolean);
  if (key === "show-subtitles") {
    rpc.send("setting-update", { key, value });
  }
  if (key === "avatar-scale") {
    rpc.send("avatar-scale", { scale: value as number });
  }
}

function openSettingsWindow() {
  if (settingsWindow) {
    (settingsWindow as any).focus?.();
    return;
  }

  settingsRpc = BrowserView.defineRPC<SettingsRPCSchema>({
    handlers: {
      messages: {
        "settings-ready": () => {
          settingsRpc.send("settings-data", {
            voiceSpeed: (config.get("voice-speed") as number) ?? 1.0,
            muted: (config.get("muted") as boolean) ?? false,
            showSubtitles: (config.get("show-subtitles") as boolean) ?? true,
            avatarScale: (config.get("avatar-scale") as number) ?? 1.0,
            audioDeviceId: (config.get("audio-device-id") as string) ?? "default",
          });
        },
        "setting-changed": ({ key, value }) => {
          handleSettingChange(key, value);
        },
        "list-audio-devices": async () => {
          try {
            const devices = await audioClient.listDevices();
            settingsRpc.send("audio-devices", { devices });
          } catch (err: any) {
            console.warn("[settings] listDevices failed:", err.message);
          }
        },
        "set-audio-device": async ({ deviceId }) => {
          try {
            if (deviceId.startsWith("alsa_input.")) {
              const proc = Bun.spawn(["pactl", "set-default-source", deviceId]);
              await proc.exited;
              console.log("[settings] Set PipeWire default source:", deviceId);
              deviceId = "pipewire";
            }
            const wasMuted = orchestrator.isMuted();
            if (!wasMuted) orchestrator.setMuted(true);
            config.set("audio-device-id", deviceId);
            if (!wasMuted) orchestrator.setMuted(false);
            settingsRpc.send("current-device", { id: deviceId, name: deviceId });
          } catch (err: any) {
            console.warn("[settings] set-audio-device failed:", err.message);
          }
        },
        "set-avatar-scale": ({ scale }) => {
          config.set("avatar-scale", scale);
          rpc.send("avatar-scale", { scale });
        },
        "close-settings": () => {
          closeSettingsWindow();
        },
      },
    },
  });

  const mainFrame = win.frame;
  const SETTINGS_W = 380;
  const SETTINGS_H = 420;
  const sx = mainFrame.x + (mainFrame.width - SETTINGS_W) / 2;
  const sy = mainFrame.y + (mainFrame.height - SETTINGS_H) / 2;

  settingsWindow = new BrowserWindow({
    title: "Albedo AI Settings",
    url: "views://settings/index.html",
    frame: { width: SETTINGS_W, height: SETTINGS_H, x: Math.round(sx), y: Math.round(sy) },
    titleBarStyle: "default",
    transparent: false,
    renderer: "cef",
    rpc: settingsRpc,
  } as any);

  settingsWindow.setAlwaysOnTop(true);

  try {
    settingsWindow.on("close", () => {
      settingsWindow = null;
      settingsRpc = null;
    });
  } catch {}
}

function closeSettingsWindow() {
  if (settingsWindow) {
    try { settingsWindow.close(); } catch {}
    settingsWindow = null;
    settingsRpc = null;
  }
}


const pm = new ProcessManager(config);
const audioClient = new AudioClient(config.audioSocketPath);
const daemonClient = new DaemonClient(config.daemonSocketPath);

const grok = new GrokClient({
  apiKey: config.openrouterApiKey,
  model: config.llmModel,
  baseUrl: config.llmBaseUrl,
  maxTokens: config.llmMaxTokens,
  temperature: config.llmTemperature,
});

const orchestrator = new Orchestrator({
  audioClient,
  daemonClient,
  grokClient: grok,
  rpc,
  config: {
    ...config,
    get deviceId() { return config.get("audio-device-id"); },
  },
});

async function boot() {
  pm.on("crash", ({ name }) => {
    console.warn(`[index] Process ${name} crashed`);
    rpc.send("process-status", { name, status: "crashed" });
  });
  pm.on("restarting", ({ name, restartCount }) => {
    rpc.send("process-status", { name, status: "restarting", attempt: restartCount });
  });
  pm.on("ready", ({ name }) => {
    console.log(`[index] Process ${name} ready`);
    rpc.send("process-status", { name, status: "ready" });
    if (name === "albedo-audio") audioClient.connect().catch(console.error);
    if (name === "albedo-daemon") daemonClient.connect().catch(console.error);
  });
  pm.on("fatal-crash", ({ name }) => {
    rpc.send("fatal-error", { message: `${name} crashed repeatedly and cannot be recovered.`, detail: "" });
  });

  try {
    await pm.start();
  } catch (err) {
    console.error("[index] Failed to start native processes:", err);
    rpc.send("fatal-error", { message: "Failed to start audio engine or daemon.", detail: String(err) });
    return;
  }

  try {
    await audioClient.connect();
    await daemonClient.connect();
    console.log("[index] pre-flight clients connected");
  } catch (err: any) {
    console.error("[index] Pre-flight connect failed:", err.message);
    rpc.send("fatal-error", { message: "Falha ao conectar com os serviços nativos.", detail: err.message });
    return;
  }

  try {
    await orchestrator.start();
  } catch (err: any) {
    console.error("[index] Orchestrator boot failed:", err.message);
    rpc.send("fatal-error", { message: "Failed to initialize assistant services.", detail: err.message });
    return;
  }

  bootComplete = true;

  // ─── Health Check: verify all services are healthy ──────────────
  const ttsUrl = process.env.ALBEDO_TTS_URL ?? "http://localhost:9880";
  const health = new HealthMonitor(ttsUrl);
  const status = await health.diagnoseAndFix();

  // Start periodic monitoring
  health.startMonitoring(30000);
  health.on("health-check", (s) => {
    // If TTS went down and was auto-healed, notify
    if (s.tts === "ok") {
      rpc.send("process-status", { name: "tts-server", status: "ready" });
    } else if (s.tts === "down") {
      rpc.send("process-status", { name: "tts-server", status: "crashed" });
    }
  });

  // Log health status
  try {
    const { appendFileSync, mkdirSync } = require("fs");
    const { join } = require("path");
    const { homedir } = require("os");
    const logDir = join(homedir(), ".config", "albedo-ai", "logs");
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, event: "health_check", ...status }) + "\n";
    appendFileSync(join(logDir, `session-${ts.replace(/[:.]/g, "-").slice(0, 19)}.log`), line);
  } catch (err: any) {
    console.warn("[health] Failed to write health log:", err.message);
  }
}

let tray: any = null;
try {
  const ElectrobunBun = await import("electrobun/bun");
  const Tray = ElectrobunBun.Tray;
  tray = new (Tray as any)({
    icon: "assets/icons/tray-idle.png",
    tooltip: "Albedo AI",
    menu: [
      {
        label: "Show / Hide",
        action: () => { try { (win as any).isVisible() ? (win as any).hide() : (win as any).show(); } catch {} },
      },
      {
        label: "Mute",
        type: "checkbox",
        checked: false,
        action: (checked: boolean) => orchestrator.setMuted(checked),
      },
      { type: "separator" },
      {
        label: "Settings",
        action: () => openSettingsWindow(),
      },
      { type: "separator" },
      {
        label: "Quit",
        action: () => shutdown(0),
      },
    ],
  });

  orchestrator.on("state-change", (state: string) => {
    try {
      const iconMap: Record<string, string> = {
        listening: "assets/icons/tray-listening.png",
        thinking: "assets/icons/tray-thinking.png",
        speaking: "assets/icons/tray-speaking.png",
        idle: "assets/icons/tray-idle.png",
        error: "assets/icons/tray-error.png",
      };
      tray.setIcon(iconMap[state] ?? iconMap.idle);
      tray.setTooltip(`Albedo AI — ${state}`);
    } catch {}
  });
} catch {
  console.log("[index] Tray not available in this Electrobun version");
}

async function shutdown(code: number) {
  console.log("[index] Shutting down...");
  closeSettingsWindow();
  try {
    await orchestrator.stop();
    await audioClient.disconnect();
    await daemonClient.disconnect();
    await pm.shutdown();
  } catch (err) {
    console.error("[index] Error during shutdown:", err);
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (err) => {
  console.error("[index] Uncaught exception:", err);
  shutdown(1);
});

// ─── Push-to-Talk (toggle with Alt+Space) ──────────────────────────────
let pttActive = false;
let audioLevelUnsub: (() => void) | null = null;
try {
  const registered = GlobalShortcut.register("Alt+Space", () => {
    pttActive = !pttActive;
    if (pttActive) {
      console.log("[ptt] STARTED listening (unmuting)");
      rpc.send("ptt-state", { active: true });
      orchestrator.setMuted(false);
      // Subscribe to audio levels
      audioLevelUnsub = audioClient.watchAudioLevel((level) => {
        rpc.send("audio-level", level);
      });
    } else {
      console.log("[ptt] STOPPED listening (muting)");
      rpc.send("ptt-state", { active: false });
      // Stop audio level stream
      if (audioLevelUnsub) { audioLevelUnsub(); audioLevelUnsub = null; }
      rpc.send("audio-level", { rms: 0, peak: 0, isSpeech: false });
      // Finalize: stop capture, then force-transcribe the recorded buffer
      orchestrator.finalizePtt();
    }
  });
  if (registered) {
    console.log("[ptt] Alt+Space registered — press to toggle listening");
  } else {
    console.warn("[ptt] Failed to register Alt+Space");
  }
} catch (err) {
  console.warn("[ptt] GlobalShortcut not available:", err);
}

boot().then(() => {
  // Start in PTT mode (muted) — user presses Alt+Space to talk
  setTimeout(() => orchestrator.setMuted(true), 1000);
  // Apply saved audio devices
  const savedDevice = config.get("audio-device-id");
  if (savedDevice && savedDevice !== "default" && savedDevice.startsWith("alsa_input.")) {
    try {
      Bun.spawnSync(["pactl", "set-default-source", savedDevice]);
      console.log("[index] Restored PipeWire source:", savedDevice);
    } catch {}
  }
  const savedOutput = config.get("output-device-id") as string;
  if (savedOutput && savedOutput !== "default" && savedOutput.startsWith("alsa_output.")) {
    try {
      Bun.spawnSync(["pactl", "set-default-sink", savedOutput]);
      console.log("[index] Restored PipeWire sink:", savedOutput);
    } catch {}
  }
}).catch((err) => {
  console.error("[index] Boot failed:", err);
  shutdown(1);
});

// ─── CEF SingletonLock cleanup on startup ───────────────────────────────
try {
  const cefDir = `${process.env.HOME}/.cache/ai.albedo.app/dev/CEF`;
  if (existsSync(cefDir)) {
    for (const file of readdirSync(cefDir)) {
      if (file.startsWith("Singleton")) {
        try { unlinkSync(`${cefDir}/${file}`); } catch {}
      }
    }
    console.log("[index] Cleaned CEF Singleton files");
  }
} catch {}

export {};
