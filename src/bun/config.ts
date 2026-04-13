type ConfigValue = string | number | boolean;

class Config {
  private store: Map<string, ConfigValue> = new Map();

  constructor() {
    this.store.set("mic-device", "default");
    this.store.set("voice-speed", 1.0);
    this.store.set("muted", false);
    this.store.set("model-path", "assets/models/albedo/albedo.model3.json");
    this.store.set("show-subtitles", true);
  }

  get(key: string): ConfigValue | undefined {
    return this.store.get(key);
  }

  set(key: string, value: ConfigValue): void {
    this.store.set(key, value);
  }

  getAll(): Record<string, ConfigValue> {
    return Object.fromEntries(this.store);
  }
}

export const config = new Config();
