import { useState, useEffect, useRef, useCallback } from "react";
import "../styles/Subtitles.css";

interface SubtitlesProps {
  text: string;
  isSpeaking: boolean;
  speakerLabel?: string;
}

export default function Subtitles({ text, isSpeaking, speakerLabel }: SubtitlesProps) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  useEffect(() => {
    clearTimers();

    if (text) {
      setFading(false);
      setVisible(true);
    }

    if (!isSpeaking && text) {
      const fadeOutTimer = setTimeout(() => {
        setFading(true);
        const hideTimer = setTimeout(() => {
          setVisible(false);
          setFading(false);
        }, 500);
        timersRef.current.push(hideTimer);
      }, 500);
      timersRef.current.push(fadeOutTimer);
    }

    if (!text) {
      setVisible(false);
      setFading(false);
    }

    return clearTimers;
  }, [text, isSpeaking, clearTimers]);

  if (!visible && !fading) return null;

  return (
    <div
      className={`subtitle-container ${visible && !fading ? "visible" : ""} ${fading ? "fading" : ""}`}
    >
      {speakerLabel && (
        <span className="subtitle-speaker">{speakerLabel}</span>
      )}
      {text}
    </div>
  );
}
