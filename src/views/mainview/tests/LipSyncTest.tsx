import { Avatar, type AvatarHandle } from "../components/Avatar";
import { useRef, useState } from "react";
import type { Viseme, ExpressionName } from "../types/rpc";

const MOCK_VISEMES: Viseme[] = [
  { shape: "rest", startMs: 0, durationMs: 50, weight: 1.0 },
  { shape: "E", startMs: 50, durationMs: 120, weight: 1.0 },
  { shape: "O", startMs: 170, durationMs: 130, weight: 1.0 },
  { shape: "rest", startMs: 300, durationMs: 100, weight: 1.0 },
  { shape: "A", startMs: 400, durationMs: 120, weight: 1.0 },
  { shape: "rest", startMs: 520, durationMs: 80, weight: 1.0 },
  { shape: "A", startMs: 600, durationMs: 100, weight: 1.0 },
  { shape: "E", startMs: 700, durationMs: 80, weight: 1.0 },
  { shape: "rest", startMs: 780, durationMs: 100, weight: 1.0 },
  { shape: "A", startMs: 880, durationMs: 100, weight: 1.0 },
  { shape: "U", startMs: 980, durationMs: 120, weight: 1.0 },
  { shape: "O", startMs: 1100, durationMs: 120, weight: 1.0 },
  { shape: "rest", startMs: 1220, durationMs: 200, weight: 1.0 },
];

const EXPRESSIONS: ExpressionName[] = ["neutral", "happy", "sad", "alert"];

export function LipSyncTest() {
  const avatarRef = useRef<AvatarHandle>(null);
  const [expression, setExpression] = useState<ExpressionName>("neutral");
  const [exprIdx, setExprIdx] = useState(0);

  function playTest() {
    avatarRef.current?.setVisemes(MOCK_VISEMES);
  }

  function cycleExpression() {
    const next = (exprIdx + 1) % EXPRESSIONS.length;
    setExprIdx(next);
    setExpression(EXPRESSIONS[next]);
  }

  return (
    <div style={{ width: 420, height: 650, background: "#111" }}>
      <Avatar
        ref={avatarRef}
        modelPath="../../../assets/models/albedo/albedo.model3.json"
        expression={expression}
      />
      <button
        onClick={playTest}
        style={{ position: "absolute", bottom: 60, left: 10, zIndex: 999 }}
      >
        Play Lip Sync Test
      </button>
      <button
        onClick={cycleExpression}
        style={{ position: "absolute", bottom: 10, left: 10, zIndex: 999 }}
      >
        Expression: {expression}
      </button>
    </div>
  );
}
