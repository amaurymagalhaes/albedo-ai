import { BrowserWindow } from "electrobun";
import { BrowserView } from "electrobun";
import { config } from "./config";
import { Orchestrator } from "./orchestrator";
import type { AlbedoRPCSchema } from "../rpc-schema";

const rpc = BrowserView.defineRPC<AlbedoRPCSchema>({
  handlers: {
    messages: {
      "webview-ready": () => {
        console.log("[main] Webview ready");
        orchestrator.start();
      },
      "chat-message": ({ text }) => {
        orchestrator.processUtterance(text);
      },
      "setting-changed": ({ key, value }) => {
        config.set(key, value as string | number | boolean);
      },
    },
  },
});

const win = new BrowserWindow({
  title: "Albedo AI",
  url: "views://mainview/index.html",
  frame: { width: 420, height: 650, x: 0, y: 0 },
  transparent: true,
  titleBarStyle: "hidden",
  passthrough: true,
  rpc,
} as any);

win.setAlwaysOnTop(true);

const orchestrator = new Orchestrator(rpc);

export {};
