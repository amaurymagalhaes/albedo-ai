import { createRoot } from "react-dom/client";
import { Electroview } from "electrobun/view";
import type { SettingsRPCSchema } from "../../rpc-schema";
import { initRpc } from "./hooks/useSettingsRpc";
import "./styles/Settings.css";
import App from "./App";

const rpc = Electroview.defineRPC<SettingsRPCSchema>({
  handlers: { messages: {} },
});

new Electroview({ rpc });

initRpc({
  addMessageListener(name, handler) {
    (rpc.addMessageListener as any)(name, handler);
  },
  removeMessageListener(name, handler) {
    (rpc.removeMessageListener as any)(name, handler);
  },
  send(name, payload) {
    (rpc.send as any)(name, payload);
  },
  sendProxy: rpc.sendProxy as any,
  request: rpc.request as any,
});

createRoot(document.getElementById("root")!).render(<App />);
