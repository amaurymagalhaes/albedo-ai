import { useState, useRef, useEffect, useCallback } from "react";
import { Avatar, type AvatarHandle } from "./components/Avatar";
import Subtitles from "./components/Subtitles";
import ChatInput from "./components/ChatInput";
import Settings from "./components/Settings";
import { useRPC, useRPCEvent } from "./hooks/useRPC";
import type { ExpressionName } from "./types/rpc";

export default function App() {
  const { emit } = useRPC();
  const [subtitle, setSubtitle] = useState("");
  const [userSpeech, setUserSpeech] = useState("");
  const [expression, setExpression] = useState<ExpressionName>("neutral");
  const [showSettings, setShowSettings] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const avatarRef = useRef<AvatarHandle>(null);

  useEffect(() => {
    emit("webview-ready", undefined);
  }, [emit]);

  useRPCEvent("subtitle", ({ text }) => setSubtitle(text));
  useRPCEvent("user-speech", ({ text }) => setUserSpeech(text));
  useRPCEvent("set-expression", ({ expression }) => setExpression(expression));
  useRPCEvent("open-settings", () => setShowSettings(true));
  useRPCEvent("speaking-state", ({ speaking }) => setIsSpeaking(speaking));
  useRPCEvent("visemes", ({ visemes }) => {
    avatarRef.current?.setVisemes(visemes);
  });

  const handleChatSubmit = useCallback(
    (text: string) => {
      emit("chat-message", { text });
      setShowChat(false);
    },
    [emit]
  );

  const handleSettingChange = useCallback(
    (key: string, value: unknown) => {
      emit("setting-changed", { key, value });
      if (key === "show-subtitles") setShowSubtitles(value as boolean);
    },
    [emit]
  );

  return (
    <div className="app-root">
      <Avatar
        ref={avatarRef}
        modelPath="views://mainview/../../assets/models/albedo/albedo.model3.json"
        expression={expression}
      />
      {showSubtitles && subtitle && (
        <Subtitles text={subtitle} isSpeaking={isSpeaking} speakerLabel="Albedo" />
      )}
      {showSubtitles && userSpeech && (
        <div className="subtitle-container visible">
          <span className="subtitle-speaker">You</span>
          {userSpeech}
        </div>
      )}
      <ChatInput
        visible={showChat}
        onSubmit={handleChatSubmit}
        onClose={() => setShowChat(false)}
      />
      <Settings
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        onSettingChange={handleSettingChange}
      />
      <button
        className="chat-toggle"
        onClick={() => setShowChat((v) => !v)}
        aria-label="Toggle chat input"
      >
        ✏
      </button>
    </div>
  );
}
