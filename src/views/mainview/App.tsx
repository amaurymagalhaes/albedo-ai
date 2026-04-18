import { useState, useRef, useEffect, useCallback } from "react";
import { Avatar, type AvatarHandle } from "./components/Avatar";
import Subtitles from "./components/Subtitles";
import ChatInput from "./components/ChatInput";
import Settings from "./components/Settings";
import { useRPC, useRPCEvent } from "./hooks/useRPC";
import type { ExpressionName, AvatarFormat, AvatarModelInfo } from "./types/rpc";

export default function App() {
  const { emit } = useRPC();
  const [subtitle, setSubtitle] = useState("");
  const [userSpeech, setUserSpeech] = useState("");
  const [expression, setExpression] = useState<ExpressionName>("neutral");
  const [showChat, setShowChat] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [fatalError, setFatalError] = useState<{ message: string; detail: string } | null>(null);
  const [confirmationRequest, setConfirmationRequest] = useState<{ name: string; args: string; dangerous: boolean } | null>(null);
  const [processStatuses, setProcessStatuses] = useState<Record<string, { status: string; attempt?: number }>>({});
  const [avatarScale, setAvatarScaleRaw] = useState(1.0);
  const [avatarOffset, setAvatarOffset] = useState({ x: 0, y: 0 });
  const [avatarMoveEnabled, setAvatarMoveEnabled] = useState(false);
  const [showUI, setShowUI] = useState(true);
  const [pttActive, setPttActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState({ rms: 0, peak: 0, isSpeech: false });
  const [avatarVisible, setAvatarVisible] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [avatarList, setAvatarList] = useState<AvatarModelInfo[]>([]);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string>("default");
  const avatarRef = useRef<AvatarHandle>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);

  const setAvatarScale = useCallback((s: number | ((prev: number) => number)) => {
    setAvatarScaleRaw((prev) => {
      const next = typeof s === "function" ? s(prev) : s;
      emit("set-avatar-scale", { scale: next });
      return next;
    });
  }, [emit]);

  useEffect(() => {
    emit("webview-ready", undefined);
  }, [emit]);

  // ─── Avatar drag (only when move mode is enabled) ──────────────────────
  useEffect(() => {
    const el = dragAreaRef.current;
    if (!el) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!avatarMoveEnabled) return;
      e.stopPropagation();
      emit("drag-start", {});
    };

    el.addEventListener("mousedown", onMouseDown, true);
    return () => el.removeEventListener("mousedown", onMouseDown, true);
  }, [emit, avatarMoveEnabled]);

  // ─── Window drag button (hold to move window across screens) ──────────
  const handleWindowDragDown = useCallback(() => {
    emit("window-drag-start", {});
  }, [emit]);

  const handleWindowDragUp = useCallback(() => {
    emit("window-drag-stop", {});
  }, [emit]);

  // ─── RPC events ──────────────────────────────────────────────────────
  useRPCEvent("avatar-list" as any, ({ avatars }: any) => {
    const list: AvatarModelInfo[] = avatars;
    setAvatarList(list);
    // If no avatar is selected yet, pick the first one or saved one
    setSelectedAvatarId((prev) => {
      if (prev !== "default" && list.some((a) => a.id === prev)) return prev;
      const saved = localStorage.getItem("selected-avatar-id");
      if (saved && list.some((a) => a.id === saved)) return saved;
      return list[0]?.id ?? "default";
    });
  });
  useRPCEvent("avatar-changed" as any, ({ id }: any) => {
    setSelectedAvatarId(id);
    localStorage.setItem("selected-avatar-id", id);
    // Reset offset when switching avatars — different formats need different framing
    setAvatarOffset({ x: 0, y: 0 });
    emit("set-avatar-scale", { scale: 1.0 });
    setAvatarScaleRaw(1.0);
  });
  useRPCEvent("subtitle", ({ text }) => setSubtitle(text));
  useRPCEvent("user-speech", ({ text }) => { setUserSpeech(text); setSubtitle(""); });
  useRPCEvent("set-expression", ({ expression }) => setExpression(expression));
  useRPCEvent("speaking-state", ({ speaking }) => setIsSpeaking(speaking));
  useRPCEvent("visemes", ({ visemes }) => avatarRef.current?.setVisemes(visemes));
  useRPCEvent("tool-call-start", () => setExpression("alert"));
  useRPCEvent("tool-call-result", () => setExpression("neutral"));
  useRPCEvent("tool-confirmation-request", (data) => setConfirmationRequest(data));
  useRPCEvent("fatal-error", (data) => setFatalError(data));
  useRPCEvent("process-status", ({ name, status, attempt }) => {
    setProcessStatuses((prev) => ({ ...prev, [name]: { status, attempt } }));
  });
  useRPCEvent("avatar-position", ({ x, y }) => setAvatarOffset({ x, y }));
  useRPCEvent("avatar-scale", ({ scale }) => setAvatarScaleRaw(scale));
  useRPCEvent("ptt-state", ({ active }) => setPttActive(active));
  useRPCEvent("audio-level" as any, (level: any) => setAudioLevel(level));
  useRPCEvent("setting-update" as any, ({ key, value }: any) => {
    if (key === "show-subtitles") setShowSubtitles(value as boolean);
  });

  const handleChatSubmit = useCallback(
    (text: string) => {
      emit("chat-message", { text });
      setUserSpeech(text);
      setShowChat(false);
    },
    [emit]
  );

  // Request avatar list on mount
  useEffect(() => {
    emit("list-avatars" as any, {});
  }, [emit]);

  const currentAvatar = avatarList.find((a) => a.id === selectedAvatarId);
  const avatarModelPath = currentAvatar?.path ?? "./models/albedo/fuxuan.model3.json";
  const avatarModelType: AvatarFormat = currentAvatar?.format ?? "live2d";

  return (
    <div className="app-root">
      <div
        className={`avatar-drag-area ${avatarMoveEnabled ? "move-mode" : ""} ${!avatarVisible ? "avatar-hidden" : ""}`}
        ref={dragAreaRef}
        style={{ transform: `translate(${avatarOffset.x}px, ${avatarOffset.y}px)` }}
      >
        <Avatar
          key={selectedAvatarId}
          ref={avatarRef}
          modelPath={avatarModelPath}
          modelType={avatarModelType}
          expression={expression}
          scaleMultiplier={avatarScale}
          offsetX={avatarOffset.x}
          offsetY={avatarOffset.y}
        />
      </div>
      <div className="subtitles-stack">
        {showSubtitles && userSpeech && (
          <div className="subtitle-container visible" style={{ pointerEvents: "none" }}>
            <span className="subtitle-speaker">You</span>
            {userSpeech}
          </div>
        )}
        {showSubtitles && subtitle && (
          <Subtitles text={subtitle} isSpeaking={isSpeaking} speakerLabel="Albedo" />
        )}
      </div>
      <ChatInput
        visible={showChat}
        onSubmit={handleChatSubmit}
        onClose={() => setShowChat(false)}
      />
      <div className="sidebar-buttons">
        <button
          className="sidebar-btn ui-toggle-btn"
          onClick={() => setShowUI((v) => !v)}
          aria-label="Toggle UI"
          title={showUI ? "Hide UI" : "Show UI"}
        >
          {showUI ? "▽" : "△"}
        </button>
        {showUI && (<>
          <button
            className="sidebar-btn window-drag-btn"
            onMouseDown={handleWindowDragDown}
            onMouseUp={handleWindowDragUp}
            onMouseLeave={handleWindowDragUp}
            aria-label="Drag window"
            title="Hold to move window"
          >
            ✥
          </button>
          <button
            className={`sidebar-btn move-toggle-btn ${avatarMoveEnabled ? "active" : ""}`}
            onClick={() => setAvatarMoveEnabled((v) => !v)}
            aria-label="Toggle avatar move"
            title={avatarMoveEnabled ? "Avatar move: ON" : "Avatar move: OFF"}
          >
            ✋
          </button>
          <button
            className="sidebar-btn chat-btn"
            onClick={() => setShowChat((v) => !v)}
            aria-label="Toggle chat input"
            title="Chat"
          >
            ✏
          </button>
          <button
            className={`sidebar-btn avatar-toggle-btn ${!avatarVisible ? "active" : ""}`}
            onClick={() => setAvatarVisible((v) => !v)}
            aria-label="Toggle avatar"
            title={avatarVisible ? "Hide avatar" : "Show avatar"}
          >
            {avatarVisible ? "👤" : "👤"}
          </button>
          <button
            className="sidebar-btn settings-btn"
            onClick={() => setShowSettings((v) => !v)}
            aria-label="Settings"
            title="Settings"
          >
            ⚙
          </button>
        </>)}
      </div>
      {showUI && <div className="zoom-controls">
        <button onClick={() => setAvatarScale((s) => Math.max(0.3, +(s - 0.1).toFixed(1)))}>−</button>
        <span className="zoom-label">{Math.round(avatarScale * 100)}%</span>
        <button onClick={() => setAvatarScale((s) => Math.min(2.0, +(s + 0.1).toFixed(1)))}>+</button>
      </div>}
      {pttActive && (
        <div className="ptt-indicator">
          <span className={`ptt-dot ${audioLevel.isSpeech ? "speech" : ""}`} />
          <div className="ptt-level-bar">
            <div
              className={`ptt-level-fill ${audioLevel.isSpeech ? "speech" : ""}`}
              style={{ width: `${Math.min(100, audioLevel.peak * 300)}%` }}
            />
          </div>
        </div>
      )}
      {confirmationRequest && (
        <div className="confirmation-overlay">
          <div className="confirmation-dialog">
            <div className="confirmation-title">Confirm Action</div>
            <div className="confirmation-body">
              <p><strong>{confirmationRequest.name}</strong></p>
              <p className="confirmation-args">{confirmationRequest.args}</p>
              {confirmationRequest.dangerous && <p className="confirmation-warning">This action may be destructive.</p>}
            </div>
            <div className="confirmation-actions">
              <button className="confirmation-deny" onClick={() => { emit("tool-confirmation-response", { approved: false }); setConfirmationRequest(null); }}>Deny</button>
              <button className="confirmation-approve" onClick={() => { emit("tool-confirmation-response", { approved: true }); setConfirmationRequest(null); }}>Approve</button>
            </div>
          </div>
        </div>
      )}
      {fatalError && (
        <div className="fatal-error-overlay">
          <div className="fatal-error-content">
            <div className="fatal-error-icon">!</div>
            <div className="fatal-error-message">{fatalError.message}</div>
            {fatalError.detail && <div className="fatal-error-detail">{fatalError.detail}</div>}
          </div>
        </div>
      )}
      <Settings
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        onSettingChange={(key, value) => emit("setting-changed", { key, value })}
        avatarScale={avatarScale}
        onAvatarScaleChange={(scale) => setAvatarScale(scale)}
        emit={emit as any}
      />
    </div>
  );
}
