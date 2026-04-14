import { BrowserWindow } from "electrobun";
import { BrowserView } from "electrobun";
import { ProcessManager } from "./process-manager";
import { AudioClient } from "./rpc/audio-client";
import { DaemonClient } from "./rpc/daemon-client";
import { Orchestrator } from "./orchestrator";
import { GrokClient } from "./grok-client";
import { config } from "./config";
import type { AlbedoRPCSchema } from "../rpc-schema";

let bootComplete = false;

const rpc = BrowserView.defineRPC<AlbedoRPCSchema>({
  handlers: {
    messages: {
      "webview-ready": () => {
        console.log("[index] Webview ready");
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
    },
  },
});

const win = new BrowserWindow({
  title: "Albedo AI",
  url: "views://mainview/index.html",
  frame: { width: 420, height: 650, x: 0, y: 0 },
  titleBarStyle: "hidden",
  rpc,
} as any);

win.setAlwaysOnTop(true);

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
  config,
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

  await audioClient.connect();
  await daemonClient.connect();

  bootComplete = true;
  await orchestrator.start();
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
        action: () => rpc.send("open-settings", {}),
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

boot().catch((err) => {
  console.error("[index] Boot failed:", err);
  shutdown(1);
});

export {};
