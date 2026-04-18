import { useState, useEffect, useCallback, useRef } from "react";
import { useSettingsRPC, useSettingsRPCEvent } from "./hooks/useSettingsRpc";

interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export default function App() {
  const { emit } = useSettingsRPC();
  const [voiceSpeed, setVoiceSpeed] = useState(1.0);
  const [muted, setMuted] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("default");
  const [deviceDropdownOpen, setDeviceDropdownOpen] = useState(false);
  const [avatarScale, setAvatarScale] = useState(1.0);

  useSettingsRPCEvent("audio-devices", ({ devices }: any) => {
    setAudioDevices(devices ?? []);
    setSelectedDevice((prev) => {
      if (prev !== "default") return prev;
      const def = devices?.find((d: AudioDevice) => d.isDefault);
      return def?.id ?? "default";
    });
  });

  useSettingsRPCEvent("settings-data", (data: any) => {
    setVoiceSpeed(data.voiceSpeed ?? 1.0);
    setMuted(data.muted ?? false);
    setShowSubtitles(data.showSubtitles ?? true);
    setAvatarScale(data.avatarScale ?? 1.0);
    setSelectedDevice(data.audioDeviceId ?? "default");
  });

  const readySent = useRef(false);
  useEffect(() => {
    if (!readySent.current) {
      readySent.current = true;
      emit("settings-ready", undefined);
    }
  }, [emit]);

  const handleSettingChange = useCallback(
    (key: string, value: unknown) => {
      emit("setting-changed", { key, value });
    },
    [emit]
  );

  const selectedName =
    audioDevices.find((d) => d.id === selectedDevice)?.name ?? "System Default";

  return (
    <div className="settings-root">
      <div className="settings-title">Settings</div>

      <div className="settings-row">
        <label>Mic Device</label>
        <div className="custom-select">
          <button
            className="custom-select-trigger"
            onClick={() => setDeviceDropdownOpen((v) => !v)}
          >
            <span className="custom-select-value">{selectedName}</span>
            <span className="custom-select-arrow">
              {deviceDropdownOpen ? "▲" : "▼"}
            </span>
          </button>
          {deviceDropdownOpen && (
            <div className="custom-select-options">
              <div
                className={`custom-select-option ${selectedDevice === "default" ? "selected" : ""}`}
                onClick={() => {
                  setSelectedDevice("default");
                  emit("set-audio-device", { deviceId: "default" });
                  setDeviceDropdownOpen(false);
                }}
              >
                System Default ★
              </div>
              {audioDevices.map((d) => (
                <div
                  key={d.id}
                  className={`custom-select-option ${selectedDevice === d.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedDevice(d.id);
                    emit("set-audio-device", { deviceId: d.id });
                    setDeviceDropdownOpen(false);
                  }}
                >
                  {d.name}
                  {d.isDefault ? " ★" : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="settings-row">
        <label>Voice Speed ({voiceSpeed.toFixed(1)})</label>
        <input
          type="range"
          min="0.5"
          max="2.0"
          step="0.1"
          value={voiceSpeed}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setVoiceSpeed(v);
            handleSettingChange("voice-speed", v);
          }}
        />
      </div>

      <div className="settings-row">
        <label>Mute Albedo</label>
        <button
          className={`settings-toggle ${muted ? "active" : ""}`}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            handleSettingChange("muted", next);
          }}
        />
      </div>

      <div className="settings-row">
        <label>Show Subtitles</label>
        <button
          className={`settings-toggle ${showSubtitles ? "active" : ""}`}
          onClick={() => {
            const next = !showSubtitles;
            setShowSubtitles(next);
            handleSettingChange("show-subtitles", next);
          }}
        />
      </div>

      <div className="settings-row">
        <label>Avatar Size ({Math.round(avatarScale * 100)}%)</label>
        <input
          type="range"
          min="0.3"
          max="2.0"
          step="0.1"
          value={avatarScale}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setAvatarScale(v);
            emit("set-avatar-scale", { scale: v });
          }}
        />
      </div>
    </div>
  );
}
