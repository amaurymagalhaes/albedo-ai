import { createRoot } from "react-dom/client";
import { Electroview } from "electrobun/view";
import { initRpc } from "./hooks/useRPC";
import type { AlbedoRPCSchema } from "../../rpc-schema";
import "./styles/global.css";
import App from "./App";

const rpc = Electroview.defineRPC<AlbedoRPCSchema>({
  handlers: {
    messages: {},
  },
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
