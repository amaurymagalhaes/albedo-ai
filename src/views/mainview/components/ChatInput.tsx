import { useRef, useEffect, useState } from "react";
import "../styles/ChatInput.css";

interface ChatInputProps {
  visible: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}

export default function ChatInput({ visible, onSubmit, onClose }: ChatInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [visible]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && value.trim()) {
      onSubmit(value.trim());
      setValue("");
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  function handleSubmit() {
    if (value.trim()) {
      onSubmit(value.trim());
      setValue("");
    }
  }

  return (
    <div className={`chat-input-bar electrobun-webkit-app-region-no-drag ${visible ? "visible" : ""}`}>
      <input
        ref={inputRef}
        className="chat-input-field"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
      />
      <button className="chat-send-btn" onClick={handleSubmit}>
        Send
      </button>
    </div>
  );
}
