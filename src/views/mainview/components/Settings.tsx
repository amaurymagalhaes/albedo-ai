import { useState, useEffect } from "react";
import "../styles/Settings.css";
import { useRPCEvent } from "../hooks/useRPC";
import type { AvatarModelInfo } from "../types/rpc";

interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

interface SettingsProps {
  visible: boolean;
  onClose: () => void;
  onSettingChange: (key: string, value: unknown) => void;
  avatarScale: number;
  onAvatarScaleChange: (scale: number) => void;
  emit: (event: string, data: any) => void;
}

function DeviceDropdown({
  label,
  devices,
  selectedId,
  storageKey,
  onSelect,
}: {
  label: string;
  devices: AudioDevice[];
  selectedId: string;
  storageKey: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedName = devices.find(d => d.id === selectedId)?.name ?? "System Default";

  return (
    <div className="settings-row">
      <label>{label}</label>
      <div className="custom-select">
        <button className="custom-select-trigger" onClick={() => setOpen(v => !v)}>
          <span className="custom-select-value">{selectedName}</span>
          <span className="custom-select-arrow">{open ? "▲" : "▼"}</span>
        </button>
        {open && (
          <div className="custom-select-options">
            <div
              className={`custom-select-option ${selectedId === "default" ? "selected" : ""}`}
              onClick={() => {
                onSelect("default");
                localStorage.setItem(storageKey, "default");
                setOpen(false);
              }}
            >
              System Default ★
            </div>
            {devices.map((d) => (
              <div
                key={d.id}
                className={`custom-select-option ${selectedId === d.id ? "selected" : ""}`}
                onClick={() => {
                  onSelect(d.id);
                  localStorage.setItem(storageKey, d.id);
                  setOpen(false);
                }}
              >
                {d.name}{d.isDefault ? " ★" : ""}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Settings({ visible, onClose, onSettingChange, avatarScale, onAvatarScaleChange, emit }: SettingsProps) {
  const [voiceSpeed, setVoiceSpeed] = useState(1.0);
  const [muted, setMuted] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [sttBackend, setSttBackend] = useState(() => localStorage.getItem("stt-backend") ?? "whisper");
  const [sttOpen, setSttOpen] = useState(false);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedInput, setSelectedInput] = useState(() => localStorage.getItem("audio-device-id") ?? "default");
  const [selectedOutput, setSelectedOutput] = useState(() => localStorage.getItem("output-device-id") ?? "default");
  const [avatarList, setAvatarList] = useState<AvatarModelInfo[]>([]);
  const [selectedAvatarId, setSelectedAvatarId] = useState(() => localStorage.getItem("selected-avatar-id") ?? "default");
  const [avatarDropdownOpen, setAvatarDropdownOpen] = useState(false);

  // Fetch audio devices when settings panel opens
  useEffect(() => {
    if (visible) {
      emit("list-audio-devices", {});
    }
  }, [visible, emit]);

  // Listen for device list
  useRPCEvent("audio-devices" as any, ({ inputs, outputs }: any) => {
    setInputDevices(inputs ?? []);
    setOutputDevices(outputs ?? []);
    setSelectedInput(prev => {
      if (prev !== "default") return prev;
      const saved = localStorage.getItem("audio-device-id");
      if (saved && inputs?.some((d: AudioDevice) => d.id === saved)) return saved;
      return prev;
    });
    setSelectedOutput(prev => {
      if (prev !== "default") return prev;
      const saved = localStorage.getItem("output-device-id");
      if (saved && outputs?.some((d: AudioDevice) => d.id === saved)) return saved;
      return prev;
    });
  });

  // Listen for avatar list
  useRPCEvent("avatar-list" as any, ({ avatars }: any) => {
    const list: AvatarModelInfo[] = avatars;
    setAvatarList(list);
    setSelectedAvatarId(prev => {
      if (prev !== "default" && list.some(a => a.id === prev)) return prev;
      const saved = localStorage.getItem("selected-avatar-id");
      if (saved && list.some(a => a.id === saved)) return saved;
      return list[0]?.id ?? "default";
    });
  });

  return (
    <div className={`settings-panel ${visible ? "visible" : ""}`}>
      <button className="settings-close" onClick={onClose}>
        &times;
      </button>
      <div className="settings-title">Settings</div>

      <DeviceDropdown
        label="🎤 Mic"
        devices={inputDevices}
        selectedId={selectedInput}
        storageKey="audio-device-id"
        onSelect={(id) => {
          setSelectedInput(id);
          emit("set-audio-device", { deviceId: id });
        }}
      />

      <DeviceDropdown
        label="🔊 Speaker"
        devices={outputDevices}
        selectedId={selectedOutput}
        storageKey="output-device-id"
        onSelect={(id) => {
          setSelectedOutput(id);
          emit("set-output-device", { deviceId: id });
        }}
      />

      <div className="settings-row">
        <label>STT Engine</label>
        <div className="custom-select">
          <button
            className="custom-select-trigger"
            onClick={() => setSttOpen(v => !v)}
          >
            <span className="custom-select-value">
              {sttBackend === "qwen3" ? "Qwen3-ASR (SOTA PT+EN)" : "Whisper (local, fast)"}
            </span>
            <span className="custom-select-arrow">{sttOpen ? "▲" : "▼"}</span>
          </button>
          {sttOpen && (
            <div className="custom-select-options">
              <div
                className={`custom-select-option ${sttBackend === "whisper" ? "selected" : ""}`}
                onClick={() => {
                  setSttBackend("whisper");
                  localStorage.setItem("stt-backend", "whisper");
                  onSettingChange("stt-backend", "whisper");
                  setSttOpen(false);
                }}
              >
                Whisper (local, fast)
              </div>
              <div
                className={`custom-select-option ${sttBackend === "qwen3" ? "selected" : ""}`}
                onClick={() => {
                  setSttBackend("qwen3");
                  localStorage.setItem("stt-backend", "qwen3");
                  onSettingChange("stt-backend", "qwen3");
                  setSttOpen(false);
                }}
              >
                Qwen3-ASR (SOTA PT+EN)
              </div>
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
            onSettingChange("voice-speed", v);
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
            onSettingChange("muted", next);
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
            onSettingChange("show-subtitles", next);
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
          onChange={(e) => onAvatarScaleChange(parseFloat(e.target.value))}
        />
      </div>

      <div className="settings-section-title">Avatar</div>
      <div className="settings-row">
        <label>Model</label>
        <div className="custom-select">
          <button className="custom-select-trigger" onClick={() => setAvatarDropdownOpen(v => !v)}>
            <span className="custom-select-value">
              {avatarList.find(a => a.id === selectedAvatarId)?.name ?? "Default"}
              {avatarList.find(a => a.id === selectedAvatarId) && (
                <span className="avatar-format-tag">
                  {avatarList.find(a => a.id === selectedAvatarId)!.format.toUpperCase()}
                </span>
              )}
            </span>
            <span className="custom-select-arrow">{avatarDropdownOpen ? "▲" : "▼"}</span>
          </button>
          {avatarDropdownOpen && (
            <div className="custom-select-options">
              {avatarList.map((avatar) => (
                <div
                  key={avatar.id}
                  className={`custom-select-option ${selectedAvatarId === avatar.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedAvatarId(avatar.id);
                    setAvatarDropdownOpen(false);
                    localStorage.setItem("selected-avatar-id", avatar.id);
                    emit("select-avatar", { id: avatar.id });
                  }}
                >
                  <span className="avatar-option-name">{avatar.name}</span>
                  <span className={`avatar-format-badge ${avatar.format}`}>{avatar.format.toUpperCase()}</span>
                </div>
              ))}
              {avatarList.length === 0 && (
                <div className="custom-select-option" style={{ opacity: 0.5 }}>
                  No models found in assets/models/
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
