export type VisemeShape = "A" | "E" | "I" | "O" | "U" | "rest" | "B" | "F" | "TH" | "S";

export interface Viseme {
  shape: VisemeShape | (string & {});
  startMs: number;
  durationMs: number;
  weight: number;
}

export type ExpressionName = "neutral" | "happy" | "sad" | "alert";

export interface MainToWebviewEvents {
  "user-speech": { text: string };
  subtitle: { text: string };
  visemes: { visemes: Viseme[] };
  "set-expression": { expression: ExpressionName };
  "open-settings": void;
  "speaking-state": { speaking: boolean };
}

export interface WebviewToMainEvents {
  "chat-message": { text: string };
  "setting-changed": { key: string; value: unknown };
  "webview-ready": void;
}
