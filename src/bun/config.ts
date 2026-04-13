import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface AlbedoConfig {
  xaiApiKey: string;
  grokModel: string;
  grokBaseUrl: string;
  grokMaxTokens: number;
  grokTemperature: number;
  audioSocketPath: string;
  daemonSocketPath: string;
  audioBinPath: string;
  daemonBinPath: string;
  whisperModelPath: string;
  voiceModelPath: string;
  vadThreshold: number;
  sampleRate: number;
  defaultVoiceId: string;
  defaultVoiceSpeed: number;
  awarenessIntervalMs: number;
  cpuAlertThreshold: number;
  socketReadyTimeoutMs: number;
  processRestartDelayMs: number;
  maxProcessRestarts: number;
  projectRoot: string;
}

type ConfigValue = string | number | boolean;

const keyMap: Record<string, keyof AlbedoConfig> = {
  "voice-speed": "defaultVoiceSpeed",
  "vad-threshold": "vadThreshold",
  "sample-rate": "sampleRate",
  "voice-id": "defaultVoiceId",
  "model": "grokModel",
  "model-path": "whisperModelPath",
};

const reverseKeyMap: Record<string, string> = {};
for (const [alias, field] of Object.entries(keyMap)) {
  if (!(field in reverseKeyMap)) {
    reverseKeyMap[field] = alias;
  }
}

function loadJsonConfig(): Partial<AlbedoConfig> {
  const configPath = join(homedir(), ".config", "albedo-ai", "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const text = readFileSync(configPath, "utf-8");
    return JSON.parse(text) as Partial<AlbedoConfig>;
  } catch {
    return {};
  }
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function buildConfig(): AlbedoConfig {
  const envXaiApiKey = process.env.XAI_API_KEY;
  const jsonConfig = loadJsonConfig();

  if (!envXaiApiKey && !jsonConfig.xaiApiKey) {
    throw new Error(
      "XAI_API_KEY is required but was not provided. Set the XAI_API_KEY environment variable or add \"xaiApiKey\" to ~/.config/albedo-ai/config.json"
    );
  }

  const defaultAudioSocket = isWindows()
    ? "\\\\.\\pipe\\albedo-audio"
    : "unix:///tmp/albedo-audio.sock";

  const defaultDaemonSocket = isWindows()
    ? "\\\\.\\pipe\\albedo-daemon"
    : "unix:///tmp/albedo-daemon.sock";

  return {
    xaiApiKey: envXaiApiKey ?? jsonConfig.xaiApiKey!,
    grokModel: process.env.ALBEDO_MODEL ?? jsonConfig.grokModel ?? "grok-4-fast",
    grokBaseUrl: jsonConfig.grokBaseUrl ?? "https://api.x.ai/v1",
    grokMaxTokens: jsonConfig.grokMaxTokens ?? 4096,
    grokTemperature: jsonConfig.grokTemperature ?? 0.7,
    audioSocketPath: jsonConfig.audioSocketPath ?? defaultAudioSocket,
    daemonSocketPath: jsonConfig.daemonSocketPath ?? defaultDaemonSocket,
    audioBinPath: jsonConfig.audioBinPath ?? "bin/albedo-audio",
    daemonBinPath: jsonConfig.daemonBinPath ?? "bin/albedo-daemon",
    whisperModelPath: jsonConfig.whisperModelPath ?? "assets/whisper/ggml-base.bin",
    voiceModelPath: jsonConfig.voiceModelPath ?? "assets/voices/kokoro-v1_0.onnx",
    vadThreshold: process.env.ALBEDO_VAD_THRESHOLD
      ? Number(process.env.ALBEDO_VAD_THRESHOLD)
      : jsonConfig.vadThreshold ?? 0.5,
    sampleRate: jsonConfig.sampleRate ?? 16000,
    defaultVoiceId: process.env.ALBEDO_VOICE_ID ?? jsonConfig.defaultVoiceId ?? "default",
    defaultVoiceSpeed: process.env.ALBEDO_VOICE_SPEED
      ? Number(process.env.ALBEDO_VOICE_SPEED)
      : jsonConfig.defaultVoiceSpeed ?? 1.0,
    awarenessIntervalMs: jsonConfig.awarenessIntervalMs ?? 5000,
    cpuAlertThreshold: jsonConfig.cpuAlertThreshold ?? 90,
    socketReadyTimeoutMs: jsonConfig.socketReadyTimeoutMs ?? 10000,
    processRestartDelayMs: jsonConfig.processRestartDelayMs ?? 1000,
    maxProcessRestarts: jsonConfig.maxProcessRestarts ?? 5,
    projectRoot: jsonConfig.projectRoot ?? process.cwd(),
  };
}

const frozenData: AlbedoConfig = Object.freeze(buildConfig());
const extras: Record<string, ConfigValue> = {};

const handler: ProxyHandler<AlbedoConfig> = {
  get(_target: AlbedoConfig, prop: string | symbol): any {
    if (prop === "get") return get;
    if (prop === "set") return set;
    if (prop === "getAll") return getAll;
    if (typeof prop === "string" && prop in frozenData) {
      return frozenData[prop as keyof AlbedoConfig];
    }
    if (typeof prop === "string" && prop in extras) {
      return extras[prop];
    }
    return undefined;
  },
  set(_target: AlbedoConfig, prop: string | symbol, value: any): boolean {
    if (typeof prop === "string" && prop in frozenData) {
      return false;
    }
    if (typeof prop === "string") {
      extras[prop] = value;
      return true;
    }
    return false;
  },
  has(_target: AlbedoConfig, prop: string | symbol): boolean {
    if (typeof prop === "string") {
      return prop in frozenData || prop in extras;
    }
    return false;
  },
  ownKeys(_target: AlbedoConfig): (string | symbol)[] {
    return [
      ...Object.keys(frozenData),
      ...Object.keys(extras),
    ];
  },
  getOwnPropertyDescriptor(_target: AlbedoConfig, prop: string | symbol): PropertyDescriptor | undefined {
    if (typeof prop === "string" && prop in frozenData) {
      return { value: frozenData[prop as keyof AlbedoConfig], configurable: true, enumerable: true };
    }
    if (typeof prop === "string" && prop in extras) {
      return { value: extras[prop], configurable: true, enumerable: true };
    }
    return undefined;
  },
};

function get(key: string): ConfigValue | undefined {
  const mapped = keyMap[key];
  if (mapped && mapped in frozenData) {
    return frozenData[mapped] as ConfigValue;
  }
  if (key in frozenData) {
    return (frozenData as unknown as Record<string, ConfigValue>)[key];
  }
  if (key in extras) {
    return extras[key];
  }
  return undefined;
}

function set(key: string, value: ConfigValue): void {
  const mapped = keyMap[key];
  if (mapped) {
    throw new Error(
      `Cannot set "${key}" at runtime — it maps to frozen config field "${mapped}". Set it via environment variable or config.json.`
    );
  }
  extras[key] = value;
}

function getAll(): Record<string, ConfigValue> {
  return {
    ...(frozenData as unknown as Record<string, ConfigValue>),
    ...extras,
  };
}

export const config: AlbedoConfig & {
  get(key: string): ConfigValue | undefined;
  set(key: string, value: ConfigValue): void;
  getAll(): Record<string, ConfigValue>;
} = new Proxy({} as AlbedoConfig, handler) as any;
