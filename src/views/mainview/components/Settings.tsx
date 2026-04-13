import { useState } from "react";
import "../styles/Settings.css";

interface SettingsProps {
  visible: boolean;
  onClose: () => void;
  onSettingChange: (key: string, value: unknown) => void;
}

export default function Settings({ visible, onClose, onSettingChange }: SettingsProps) {
  const [voiceSpeed, setVoiceSpeed] = useState(1.0);
  const [muted, setMuted] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [modelPath, setModelPath] = useState("assets/models/albedo/albedo.model3.json");

  return (
    <div className={`settings-panel ${visible ? "visible" : ""}`}>
      <button className="settings-close" onClick={onClose}>
        &times;
      </button>
      <div className="settings-title">Settings</div>

      <div className="settings-row">
        <label>Mic Device</label>
        <select
          onChange={(e) => onSettingChange("mic-device", e.target.value)}
          defaultValue="default"
        >
          <option value="default">System Default</option>
        </select>
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
        <label>Model Path</label>
        <input
          type="text"
          value={modelPath}
          onChange={(e) => {
            setModelPath(e.target.value);
            onSettingChange("model-path", e.target.value);
          }}
        />
      </div>
    </div>
  );
}
