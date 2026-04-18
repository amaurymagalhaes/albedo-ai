import type { RPCSchema } from "electrobun/view";
import type { Viseme, ExpressionName } from "./shared/rpc-types";

export interface AlbedoRPCSchema {
  bun: RPCSchema<{
    messages: {
      "chat-message": { text: string };
      "setting-changed": { key: string; value: unknown };
      "webview-ready": void;
      "tool-confirmation-response": { approved: boolean };
      "drag-start": {};
      "window-drag-start": {};
      "window-drag-stop": {};
      "drag-stop": {};
      "set-avatar-scale": { scale: number };
      "list-audio-devices": {};
      "set-audio-device": { deviceId: string };
      "set-output-device": { deviceId: string };
      "toggle-settings": {};
      "select-avatar": { id: string };
      "list-avatars": {};
    };
  }>;
  webview: RPCSchema<{
    messages: {
      "user-speech": { text: string };
      "subtitle": { text: string };
      "visemes": { visemes: Viseme[] };
      "set-expression": { expression: ExpressionName };
      "speaking-state": { speaking: boolean };
      "setting-update": { key: string; value: unknown };
      "tool-call-start": { name: string; args: string };
      "tool-call-result": { name: string; result: string; success: boolean };
      "tool-confirmation-request": { name: string; args: string; dangerous: boolean };
      "process-status": { name: string; status: string; attempt?: number };
      "fatal-error": { message: string; detail: string };
      "avatar-position": { x: number; y: number };
      "avatar-scale": { scale: number };
      "ptt-state": { active: boolean };
      "audio-devices": { inputs: Array<{ id: string; name: string; isDefault: boolean }>; outputs: Array<{ id: string; name: string; isDefault: boolean }> };
      "audio-level": { rms: number; peak: number; isSpeech: boolean };
      "current-device": { id: string; name: string };
      "avatar-list": { avatars: Array<{ id: string; name: string; format: string; path: string }> };
      "avatar-changed": { id: string; name: string; format: string; path: string };
    };
  }>;
}

export interface SettingsRPCSchema {
  bun: RPCSchema<{
    messages: {
      "settings-ready": void;
      "setting-changed": { key: string; value: unknown };
      "list-audio-devices": {};
      "set-audio-device": { deviceId: string };
      "set-avatar-scale": { scale: number };
      "close-settings": {};
    };
  }>;
  webview: RPCSchema<{
    messages: {
      "audio-devices": { devices: Array<{ id: string; name: string; isDefault: boolean }> };
      "current-device": { id: string; name: string };
      "settings-data": {
        voiceSpeed: number;
        muted: boolean;
        showSubtitles: boolean;
        avatarScale: number;
        audioDeviceId: string;
      };
    };
  }>;
}
