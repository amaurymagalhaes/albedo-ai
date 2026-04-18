export type VisemeShape = "A" | "E" | "I" | "O" | "U" | "rest" | "B" | "F" | "TH" | "S";

export interface Viseme {
  shape: VisemeShape | (string & {});
  startMs: number;
  durationMs: number;
  weight: number;
}

export type AvatarFormat = "live2d" | "vrm";

export interface AvatarModelInfo {
  id: string;
  name: string;
  format: AvatarFormat;
  path: string;
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
  "setting-update": { key: string; value: unknown };
}

export interface ViewToMainEvents {
  "chat-message": { text: string };
  "setting-changed": { key: string; value: unknown };
  "webview-ready": void;
  "tool-confirmation-response": { approved: boolean };
  "toggle-settings": {};
  "list-audio-devices": {};
  "set-audio-device": { deviceId: string };
  "set-output-device": { deviceId: string };
  "set-avatar-scale": { scale: number };
  "drag-start": {};
  "window-drag-start": {};
  "window-drag-stop": {};
  "drag-stop": {};
}
