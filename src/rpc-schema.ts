import type { RPCSchema } from "electrobun/view";
import type { Viseme, ExpressionName } from "./shared/rpc-types";

export interface AlbedoRPCSchema {
  bun: RPCSchema<{
    messages: {
      "chat-message": { text: string };
      "setting-changed": { key: string; value: unknown };
      "webview-ready": void;
      "tool-confirmation-response": { approved: boolean };
    };
  }>;
  webview: RPCSchema<{
    messages: {
      "user-speech": { text: string };
      "subtitle": { text: string };
      "visemes": { visemes: Viseme[] };
      "set-expression": { expression: ExpressionName };
      "speaking-state": { speaking: boolean };
      "open-settings": {};
      "tool-call-start": { name: string; args: string };
      "tool-call-result": { name: string; result: string; success: boolean };
      "tool-confirmation-request": { name: string; args: string; dangerous: boolean };
      "process-status": { name: string; status: string; attempt?: number };
      "fatal-error": { message: string; detail: string };
    };
  }>;
}
