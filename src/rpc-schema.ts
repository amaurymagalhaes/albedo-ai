import type { RPCSchema } from "electrobun/view";
import type { Viseme, ExpressionName } from "./views/mainview/types/rpc";

export interface AlbedoRPCSchema {
  bun: RPCSchema<{
    messages: {
      "chat-message": { text: string };
      "setting-changed": { key: string; value: unknown };
      "webview-ready": void;
    };
  }>;
  webview: RPCSchema<{
    messages: {
      "user-speech": { text: string };
      subtitle: { text: string };
      visemes: { visemes: Viseme[] };
      "set-expression": { expression: ExpressionName };
      "open-settings": void;
      "speaking-state": { speaking: boolean };
    };
  }>;
}
