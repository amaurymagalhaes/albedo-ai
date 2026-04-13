export type VisemeShape = "A" | "E" | "I" | "O" | "U" | "rest" | "B" | "F" | "TH" | "S";

export interface Viseme {
  shape: VisemeShape | (string & {});
  startMs: number;
  durationMs: number;
  weight: number;
}

export type ExpressionName = "neutral" | "happy" | "sad" | "alert";

export interface MainToViewEvents {
  "user-speech": { text: string };
  "subtitle": { text: string };
  "visemes": { visemes: Viseme[] };
  "set-expression": { expression: ExpressionName };
  "speaking-state": { speaking: boolean };
  "tool-call-start": { name: string; args: string };
  "tool-call-result": { name: string; result: string; success: boolean };
  "tool-confirmation-request": { name: string; args: string; dangerous: boolean };
  "process-status": { name: string; status: string; attempt?: number };
  "fatal-error": { message: string; detail: string };
  "open-settings": {};
}

export interface ViewToMainEvents {
  "chat-message": { text: string };
  "setting-changed": { key: string; value: unknown };
  "webview-ready": void;
  "tool-confirmation-response": { approved: boolean };
}
