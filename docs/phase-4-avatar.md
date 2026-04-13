# Phase 4: Avatar — Implementation Plan

**Project:** Albedo AI  
**Phase:** 4 of 7  
**Estimated duration:** 1 week  
**Status:** Planned  
**Last updated:** 2026-04-13

---

## Table of Contents

1. [Objective](#1-objective)
2. [Prerequisites](#2-prerequisites)
3. [Step-by-Step Tasks](#3-step-by-step-tasks)
4. [Component Breakdown](#4-component-breakdown)
5. [Live2D Integration](#5-live2d-integration)
6. [Lip Sync System](#6-lip-sync-system)
7. [Expression System](#7-expression-system)
8. [RPC Bridge](#8-rpc-bridge)
9. [UI Layout](#9-ui-layout)
10. [Styling](#10-styling)
11. [Testing Strategy](#11-testing-strategy)
12. [Validation Criteria](#12-validation-criteria)
13. [Risks and Notes](#13-risks-and-notes)

---

## 1. Objective

Phase 4 delivers the React webview UI — the visual layer that users actually see and interact with. By the end of this phase:

- A Live2D avatar is rendered in a transparent, frameless, always-on-top window using `pixi-live2d-display` and WebGL.
- The avatar's mouth moves in real time in sync with Albedo's TTS speech, driven by viseme data forwarded from the Rust audio engine via the Bun orchestrator.
- Subtitle text overlays the avatar during speech.
- An optional chat input allows typed text input as an alternative to voice.
- A settings panel exposes configurable preferences (mic device, voice speed, mute, model path).
- A typed RPC bridge (`useRPC.ts`) connects the webview to the Bun main process with full TypeScript types on both sides, using Electrobun's native webview RPC mechanism.

This phase is purely the frontend layer. It consumes events already produced by Phases 1–3 and sends user input back upstream. No audio processing logic lives here.

---

## 2. Prerequisites

### Phases Complete

| Phase | Deliverable | Required for Phase 4 |
|---|---|---|
| Phase 0 | Electrobun scaffold, Makefile, proto files | Window creation, `BrowserWindow`, webview RPC APIs |
| Phase 1 | Rust audio engine: mic → VAD → Whisper → gRPC | `user-speech` events flowing to orchestrator |
| Phase 2 | Rust TTS: Kokoro + playback + viseme extraction | `visemes` events, `subtitle` events from orchestrator |
| Phase 3 | Bun orchestrator: Grok streaming + context | All RPC emissions (`user-speech`, `subtitle`, `visemes`, `set-expression`) |

### Asset Requirements

Before beginning implementation, the following must be available under `assets/models/`:

- **`.moc3` file** — the compiled Live2D model mesh (e.g., `assets/models/albedo/albedo.moc3`)
- **Textures** — PNG texture sheets (e.g., `assets/models/albedo/textures/texture_00.png`)
- **Model JSON** — the `.model3.json` manifest that references the `.moc3`, textures, expressions, and motions (e.g., `assets/models/albedo/albedo.model3.json`)
- **Expression JSONs** — `assets/models/albedo/expressions/happy.exp3.json`, `sad.exp3.json`, `alert.exp3.json`, `neutral.exp3.json`
- **Physics JSON** (optional but strongly recommended for natural movement) — `assets/models/albedo/albedo.physics3.json`

**Acceptable free source:** The [Live2D Free Material License](https://www.live2d.com/en/terms/live2d-free-material-license-agreement/) sample models (Haru, Hiyori, Mark, etc.). A custom "Albedo" model can be a reskin for the MVP.

### Node/Bun Dependencies to Install

```bash
bun add pixi.js@^7.4.2
bun add pixi-live2d-display@^0.4.0
bun add react react-dom
bun add -d @types/react @types/react-dom
```

> **Version constraint:** `pixi-live2d-display@^0.4.x` targets PixiJS v7. Do NOT use PixiJS v8 — the plugin has not been updated for v8's breaking renderer API changes as of early 2026. Lock both versions in `package.json`.

---

## 3. Step-by-Step Tasks

### Day 1 — Scaffold and RPC Bridge

**Task 1.1 — Create the webview directory structure**

```
src/views/mainview/
├── index.html
├── main.tsx                    # React root mount
├── App.tsx
├── components/
│   ├── Avatar.tsx
│   ├── Subtitles.tsx
│   ├── ChatInput.tsx
│   └── Settings.tsx
├── hooks/
│   └── useRPC.ts
├── types/
│   └── rpc.ts                  # Shared RPC type definitions
└── styles/
    ├── global.css
    ├── Avatar.css
    ├── Subtitles.css
    ├── ChatInput.css
    └── Settings.css
```

**Task 1.2 — Define RPC types in `src/views/mainview/types/rpc.ts`**

Define all event shapes that cross the webview ↔ main-process boundary. This file is the single source of truth for the RPC contract.

```typescript
// src/views/mainview/types/rpc.ts

/** Viseme shape as emitted by the Rust audio engine */
export interface Viseme {
  shape: "A" | "E" | "I" | "O" | "U" | "rest" | string;
  startMs: number;
  durationMs: number;
  weight: number;
}

/** Avatar expression names matching Live2D expression file names */
export type ExpressionName = "neutral" | "happy" | "sad" | "alert";

/** Events emitted FROM main process TO webview */
export interface MainToWebviewEvents {
  /** Whisper transcription of the user's speech */
  "user-speech": { text: string };
  /** TTS subtitle for the current sentence being spoken */
  subtitle: { text: string };
  /** Viseme timing sequence for the current TTS utterance */
  visemes: { visemes: Viseme[] };
  /** Expression change command */
  "set-expression": { expression: ExpressionName };
  /** Open settings panel */
  "open-settings": void;
}

/** Events emitted FROM webview TO main process */
export interface WebviewToMainEvents {
  /** User typed a message in ChatInput */
  "chat-message": { text: string };
  /** User changed a setting */
  "setting-changed": { key: string; value: unknown };
  /** Webview is ready to receive events */
  "webview-ready": void;
}
```

**Task 1.3 — Implement `useRPC.ts`**

Full implementation detailed in [Section 8](#8-rpc-bridge).

**Task 1.4 — Wire up `index.html` and `main.tsx`**

`src/views/mainview/index.html` must load the compiled React bundle and set a transparent background:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Albedo AI</title>
  <style>
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

`src/views/mainview/main.tsx`:

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

---

### Day 2 — Live2D Canvas and Model Loading

**Task 2.1 — Install and configure pixi-live2d-display**

```bash
bun add pixi.js@7.4.2 pixi-live2d-display@0.4.0
```

In your webview entry point, import the Live2D plugin before any Pixi application is created:

```typescript
// Must be imported once at module initialization — do this in Avatar.tsx or main.tsx
import { Live2DModel } from "pixi-live2d-display";
import * as PIXI from "pixi.js";

// Register the Ticker plugin so Live2D's internal update loop runs
Live2DModel.registerTicker(PIXI.Ticker);
```

**Task 2.2 — Implement `Avatar.tsx`**

Full implementation detailed in [Section 5](#5-live2d-integration).

**Task 2.3 — Add model files to the asset path**

Electrobun serves assets from the project root. Ensure `electrobun.config.ts` includes the `assets/` directory in the static asset bundle. During development, models are loaded from absolute paths or served via Electrobun's `views://` protocol.

Verify the path resolves correctly:
```typescript
const MODEL_PATH = "views://mainview/../../assets/models/albedo/albedo.model3.json";
// Or if assets are bundled into the view:
const MODEL_PATH = new URL("../../assets/models/albedo/albedo.model3.json", import.meta.url).href;
```

---

### Day 3 — Lip Sync Implementation

**Task 3.1 — Implement the viseme scheduler in `Avatar.tsx`**

Full implementation detailed in [Section 6](#6-lip-sync-system).

**Task 3.2 — Identify mouth parameter IDs in the model**

Open the `.model3.json` and examine the `Parameters` section, or use the Live2D Cubism Editor to find the correct parameter IDs. Common mouth parameters are:

| Parameter | Typical ID | Range |
|---|---|---|
| Mouth open Y | `ParamMouthOpenY` | 0.0 (closed) – 1.0 (fully open) |
| Mouth form | `ParamMouthForm` | -1.0 (sad) – 1.0 (happy) |

If using a third-party model, parameter IDs may differ (e.g., `PARAM_MOUTH_OPEN_Y`). Add a `MOUTH_PARAM_ID` constant at the top of `Avatar.tsx` so it can be changed without hunting through the code.

---

### Day 4 — Expression System and Subtitles

**Task 4.1 — Implement expression switching in `Avatar.tsx`**

Full implementation detailed in [Section 7](#7-expression-system).

**Task 4.2 — Implement `Subtitles.tsx`**

Full implementation detailed in [Section 4.2](#42-subtitlestsx).

**Task 4.3 — Implement `ChatInput.tsx`**

Full implementation detailed in [Section 4.3](#43-chatinputtsx).

---

### Day 5 — Settings Panel and App Integration

**Task 5.1 — Implement `Settings.tsx`**

Full implementation detailed in [Section 4.4](#44-settingstsx).

**Task 5.2 — Implement `App.tsx`**

Full implementation detailed in [Section 4.5](#45-apptsx).

**Task 5.3 — Wire RPC events in the main process**

In `src/bun/index.ts`, confirm that the window creation sets up the RPC emitters after the orchestrator is initialized. The orchestrator already calls `win.webview.rpc.emit(...)` for all relevant events. The `webview-ready` event from the webview should be handled to confirm the channel is live before the orchestrator starts processing.

```typescript
// src/bun/index.ts (addition)
win.webview.rpc.on("webview-ready", () => {
  console.log("[main] Webview ready, starting orchestrator");
  orchestrator.start();
});

win.webview.rpc.on("chat-message", async ({ text }) => {
  await orchestrator.processUtterance(text);
});

win.webview.rpc.on("setting-changed", ({ key, value }) => {
  config.set(key, value);
});
```

---

### Day 6 — Styling, Polish, and Testing

**Task 6.1 — Implement transparent background and overlay CSS**

Full details in [Section 10](#10-styling).

**Task 6.2 — Write mock viseme playback test**

Full details in [Section 11](#11-testing-strategy).

**Task 6.3 — Run end-to-end smoke test**

With Phases 1–3 running (`make dev`), verify the full pipeline: speak → transcription → LLM response → TTS → visemes arrive in webview → lips move → subtitle appears.

---

## 4. Component Breakdown

### 4.1 `Avatar.tsx`

**Responsibility:** Owns the PixiJS `Application` and the Live2D model instance. Handles all Live2D parameter manipulation — mouth open/close for lip sync, expression switching, idle motion playback. Renders a `<canvas>` element with a transparent WebGL context.

**Props:**
```typescript
interface AvatarProps {
  modelPath: string;
}
```

**Internal state:**
- `pixiApp` — the `PIXI.Application` instance (stored in a ref to avoid React re-rendering it)
- `model` — the `Live2DModel` instance (ref)
- `visemeQueue` — array of pending `Viseme` objects (ref, not state — must not trigger re-renders)
- `currentExpression` — `ExpressionName` (state, drives a `useEffect`)

**Key behaviors:**
- On mount: create `PIXI.Application` with `backgroundAlpha: 0`, add model to stage, start the Ticker.
- On unmount: call `pixiApp.destroy(true)` to release WebGL resources.
- Expose an imperative handle via `useImperativeHandle` (or a callback ref) so `App.tsx` can call `setVisemes(visemes)` and `setExpression(expr)` without prop drilling.
- Internal `useEffect` watches `visemeQueue` changes to start the scheduler loop.

---

### 4.2 `Subtitles.tsx`

**Responsibility:** Displays the current subtitle text as a styled overlay beneath the avatar. Subtitles fade in on arrival and fade out after a timeout or when the next subtitle replaces them.

**Props:**
```typescript
interface SubtitlesProps {
  text: string;        // Current subtitle text (empty string = hidden)
  speakerLabel?: string; // Optional: "Albedo" | "You"
}
```

**Behavior:**
- When `text` changes to a non-empty string, trigger a CSS fade-in animation.
- After 4 seconds of no update, or when `text` becomes empty, trigger a CSS fade-out.
- Display user speech (from `user-speech` RPC event) with a distinct label and style.

---

### 4.3 `ChatInput.tsx`

**Responsibility:** Provides a text field for typed input as an alternative to voice. Toggles visible/hidden based on state in `App.tsx`.

**Props:**
```typescript
interface ChatInputProps {
  visible: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}
```

**Behavior:**
- Renders as a floating input bar at the bottom of the window.
- On Enter key press or submit button click, calls `onSubmit(text)` and clears the field.
- On Escape, calls `onClose()`.
- Focus is automatically set when `visible` transitions to `true` (via `useEffect` + `ref.current.focus()`).

---

### 4.4 `Settings.tsx`

**Responsibility:** A modal/panel for user configuration. Slides in from the right when opened.

**Props:**
```typescript
interface SettingsProps {
  visible: boolean;
  onClose: () => void;
  onSettingChange: (key: string, value: unknown) => void;
}
```

**Settings exposed in MVP:**

| Setting | Type | Default | RPC key |
|---|---|---|---|
| Mic device | Select (populated from media devices) | System default | `mic-device` |
| Voice speed | Slider (0.5–2.0) | 1.0 | `voice-speed` |
| Mute Albedo | Toggle | false | `muted` |
| Avatar model path | Text input | `assets/models/...` | `model-path` |
| Subtitle display | Toggle | true | `show-subtitles` |

Each setting change calls `onSettingChange(key, value)` which propagates via RPC to the main process.

---

### 4.5 `App.tsx`

**Responsibility:** Root component. Owns top-level state, subscribes to all RPC events via `useRPC`, and distributes data to child components.

**State managed:**
- `subtitle: string` — current subtitle text
- `userSpeech: string` — last transcription from the user
- `showChat: boolean` — whether `ChatInput` is visible
- `showSettings: boolean` — whether `Settings` panel is visible
- `showSubtitles: boolean` — user preference from settings
- `expression: ExpressionName` — current avatar expression

**RPC subscriptions (via `useRPC`):**
- `subtitle` → update `subtitle` state
- `user-speech` → update `userSpeech` state
- `visemes` → call `avatarRef.current.setVisemes(visemes)`
- `set-expression` → update `expression` state
- `open-settings` → set `showSettings = true`

**Signal to main process after mount:**
```typescript
useEffect(() => {
  rpc.emit("webview-ready");
}, []);
```

---

### 4.6 `useRPC.ts`

**Responsibility:** Typed wrapper around Electrobun's webview RPC API. Provides a stable, ergonomic hook that components use to subscribe to events from the main process and emit events to it.

Full implementation detailed in [Section 8](#8-rpc-bridge).

---

## 5. Live2D Integration

### 5.1 Library Overview

`pixi-live2d-display` is a PixiJS plugin that renders Live2D Cubism 4 models (`.moc3` format) using WebGL. It manages the model's internal parameter system, expressions, motions, and the Cubism Core WASM runtime.

**Runtime dependency:** The Cubism Core WASM (`live2dcubismcore.min.js`) must be loaded before `pixi-live2d-display` initializes the WASM runtime. The plugin can auto-load it if given a URL, or it can be bundled manually.

```typescript
// In main.tsx or Avatar.tsx, before any model is loaded:
import { config as l2dConfig } from "pixi-live2d-display";
l2dConfig.cubismCorePath = new URL(
  "./vendor/live2dcubismcore.min.js",
  import.meta.url
).href;
```

Place `live2dcubismcore.min.js` at `src/views/mainview/vendor/live2dcubismcore.min.js`. This file is distributed freely with the Cubism SDK.

### 5.2 PixiJS Application Setup

The `PIXI.Application` must be created with:
- `backgroundAlpha: 0` — transparent canvas (required for the see-through window)
- `antialias: true` — smooth model edges
- `autoDensity: true` + `resolution: window.devicePixelRatio` — crisp rendering on HiDPI displays
- `resizeTo: canvas.parentElement` — fills the container div

```typescript
// Inside Avatar.tsx, on mount:
const app = new PIXI.Application({
  view: canvasRef.current!,
  backgroundAlpha: 0,
  antialias: true,
  autoDensity: true,
  resolution: window.devicePixelRatio || 1,
  width: containerRef.current!.clientWidth,
  height: containerRef.current!.clientHeight,
});
pixiAppRef.current = app;
```

### 5.3 Model Loading

```typescript
import { Live2DModel } from "pixi-live2d-display";

const model = await Live2DModel.from(modelPath, {
  autoInteract: false, // Disable built-in drag/touch interaction; we control this
});

// Scale and position the model to fit the canvas
model.scale.set(0.3);
model.anchor.set(0.5, 0.5);
model.x = app.screen.width / 2;
model.y = app.screen.height / 2;

app.stage.addChild(model);
modelRef.current = model;
```

`Live2DModel.from()` returns a Promise. Call it inside a `useEffect` with an async IIFE, and handle the cleanup:

```typescript
useEffect(() => {
  let cancelled = false;
  (async () => {
    const model = await Live2DModel.from(modelPath);
    if (cancelled) { model.destroy(); return; }
    // ... position and add to stage
  })();
  return () => { cancelled = true; };
}, [modelPath]);
```

### 5.4 Idle Motion Playback

After loading, start an idle animation loop so the avatar looks alive when not speaking:

```typescript
// Play the "idle" motion group on loop
model.motion("idle", undefined, MotionPriority.IDLE);
```

The `MotionPriority` enum from `pixi-live2d-display` controls preemption — `IDLE` is preempted by `NORMAL` which is preempted by `FORCE`.

When lip sync begins, the mouth parameters are set directly via `model.internalModel.coreModel.setParameterValueById(...)`, which overrides the idle motion's mouth values for that frame.

### 5.5 Controlling Parameters

The Live2D Cubism model exposes a low-level parameter API:

```typescript
// Get a reference to the core model
const coreModel = model.internalModel.coreModel;

// Set a parameter by ID (value is clamped to the parameter's defined min/max)
coreModel.setParameterValueById("ParamMouthOpenY", 0.8);

// Add to current value (useful for additive blending)
coreModel.addParameterValueById("ParamMouthForm", 0.1);
```

This must be called every frame inside the PixiJS Ticker (or inside a `requestAnimationFrame` loop that aligns with the Ticker). The Live2D runtime's `update()` is called automatically by `pixi-live2d-display` on each Ticker tick.

### 5.6 Controlling Expressions

```typescript
// Set a named expression (matches the expression file names in .model3.json)
model.expression("happy");   // Loads happy.exp3.json parameters
model.expression("neutral"); // Resets to default
```

Expressions blend additively with motion parameters. A "happy" expression typically lifts the brow parameters and curves the mouth form parameter upward.

---

## 6. Lip Sync System

### 6.1 Data Flow

```
Rust (lipsync.rs)
  → SynthesizeResponse.visemes[]
    → gRPC → Bun Orchestrator (orchestrator.ts)
      → win.webview.rpc.emit("visemes", { visemes })
        → useRPC.ts (webview)
          → App.tsx → avatarRef.current.setVisemes(visemes)
            → Avatar.tsx viseme scheduler
              → PIXI.Ticker → coreModel.setParameterValueById("ParamMouthOpenY", ...)
```

The viseme array from Rust contains absolute timestamps relative to the start of the audio playback (`startMs`). The webview must maintain its own playback clock synchronized to when the audio actually started playing.

### 6.2 Playback Clock

The Rust audio engine plays the PCM audio and emits visemes in the same `SynthesizeResponse`. The orchestrator emits both the visemes and triggers audio playback in sequence:

```typescript
// orchestrator.ts
const { pcmData, visemes } = await this.audio.synthesize(...);
this.win.webview.rpc.emit("visemes", { visemes });  // send first
await this.audio.play(pcmData);                     // then start audio
```

In the webview, `setVisemes()` must record the clock time at which it received the array, as the `t=0` reference:

```typescript
// In Avatar.tsx
const visemeQueueRef = useRef<Viseme[]>([]);
const lipSyncStartTimeRef = useRef<number>(0);

function setVisemes(visemes: Viseme[]) {
  visemeQueueRef.current = visemes;
  lipSyncStartTimeRef.current = performance.now();
}
```

### 6.3 Per-Frame Parameter Update

Register a PIXI Ticker callback that fires every frame (~60fps) and looks up the current viseme:

```typescript
// Added inside the Avatar mount effect, after model and app are created:
const ticker = PIXI.Ticker.shared;
const onTick = () => {
  updateLipSync();
};
ticker.add(onTick);

// Cleanup:
return () => { ticker.remove(onTick); };
```

```typescript
function updateLipSync() {
  const visemes = visemeQueueRef.current;
  if (!visemes.length || !modelRef.current) return;

  const elapsed = performance.now() - lipSyncStartTimeRef.current;
  const coreModel = modelRef.current.internalModel.coreModel;

  // Find the active viseme
  const active = visemes.find(
    (v) => elapsed >= v.startMs && elapsed < v.startMs + v.durationMs
  );

  if (active) {
    const targetOpen = VISEME_TO_MOUTH_OPEN[active.shape] ?? 0;
    // Smooth interpolation toward target to avoid jarring jumps
    const current = coreModel.getParameterValueById("ParamMouthOpenY");
    const next = current + (targetOpen * active.weight - current) * LERP_FACTOR;
    coreModel.setParameterValueById("ParamMouthOpenY", next);
  } else {
    // No active viseme — close the mouth smoothly
    const current = coreModel.getParameterValueById("ParamMouthOpenY");
    coreModel.setParameterValueById("ParamMouthOpenY", current * LERP_FACTOR);
  }

  // Clear finished viseme queue
  const lastViseme = visemes[visemes.length - 1];
  if (lastViseme && elapsed > lastViseme.startMs + lastViseme.durationMs + 200) {
    visemeQueueRef.current = [];
  }
}
```

### 6.4 Viseme-to-Parameter Mapping

Define a mapping table that converts the phoneme shape strings from the Rust audio engine to a `ParamMouthOpenY` target value:

```typescript
// src/views/mainview/components/Avatar.tsx

const VISEME_TO_MOUTH_OPEN: Record<string, number> = {
  rest: 0.0,
  A:    1.0,    // "ah" as in "father"
  E:    0.7,    // "eh" as in "bed"
  I:    0.5,    // "ee" as in "see"
  O:    0.9,    // "oh" as in "go"
  U:    0.6,    // "oo" as in "blue"
  // Consonants — partial mouth closure based on phoneme group
  B:    0.1,    // bilabial plosive (lips pressed together, then open)
  F:    0.15,   // labiodental fricative
  TH:   0.2,    // dental fricative
  S:    0.2,    // sibilant
};

const LERP_FACTOR = 0.4;  // Higher = snappier, lower = smoother
const MOUTH_PARAM_ID = "ParamMouthOpenY"; // Override if your model uses different IDs
```

**Note on Rust viseme output:** `lipsync.rs` extracts visemes from the Kokoro TTS phoneme alignment. The shape strings it produces must match the keys in this table. If the Rust side uses a different vocabulary (e.g., X-SAMPA phonemes), add a normalization step either in `lipsync.rs` or in a `normalizeVisemeShape()` function in `Avatar.tsx`.

### 6.5 Audio/Viseme Drift Correction

There is an inherent timing gap between the orchestrator emitting `visemes` and the audio actually starting playback in the Rust engine. This gap is typically 50–150ms (gRPC + audio buffer latency).

**Mitigation:** Introduce a configurable `VISEME_LEAD_MS` offset:

```typescript
const VISEME_LEAD_MS = 80; // Empirically tuned — subtract from elapsed time

const elapsed = (performance.now() - lipSyncStartTimeRef.current) - VISEME_LEAD_MS;
```

This value should be tuned during the integration phase (Phase 6) by observing the lip sync against actual audio output.

---

## 7. Expression System

### 7.1 Event Flow

The orchestrator's `inferExpression()` method runs after each LLM response and emits `set-expression` with one of four values: `neutral`, `happy`, `sad`, `alert`.

```typescript
// orchestrator.ts (existing)
const expression = this.inferExpression(fullResponse);
this.win.webview.rpc.emit("set-expression", { expression });
```

In the webview, `App.tsx` receives this and updates state:

```typescript
rpc.on("set-expression", ({ expression }) => {
  setExpression(expression);
});
```

`Avatar.tsx` receives `expression` as a prop and applies it:

```typescript
// Avatar.tsx
useEffect(() => {
  if (!modelRef.current) return;
  modelRef.current.expression(expression);
}, [expression]);
```

### 7.2 Expression Definitions

Each expression maps to a `.exp3.json` file listed in the model's `.model3.json` under `FileReferences.Expressions`. The expression JSON sets parameter overrides applied on top of the current pose.

| Expression | File | Visual cue |
|---|---|---|
| `neutral` | `expressions/neutral.exp3.json` | Resting face, no overrides |
| `happy` | `expressions/happy.exp3.json` | Raised cheeks, curved mouth form |
| `sad` | `expressions/sad.exp3.json` | Lowered brows, downturned mouth |
| `alert` | `expressions/alert.exp3.json` | Raised brows, wide eyes |

If a model does not ship with matching expression files, they can be created manually in the Cubism Editor or crafted as minimal JSON:

```json
{
  "Type": "Live2D Expression",
  "Parameters": [
    { "Id": "ParamEyeLOpen", "Value": 1.2, "Blend": "Multiply" },
    { "Id": "ParamEyeROpen", "Value": 1.2, "Blend": "Multiply" },
    { "Id": "ParamBrowLY",   "Value": 0.5, "Blend": "Add" },
    { "Id": "ParamBrowRY",   "Value": 0.5, "Blend": "Add" }
  ]
}
```

### 7.3 Expression Transition Timing

Live2D expressions blend over a configurable duration. `pixi-live2d-display` uses the `expressionManager.expressionDuration` setting (default 500ms). This means expressions cross-fade smoothly rather than snapping — which works well for the emotion transitions expected from LLM output.

If an expression change arrives while lip sync is active, they operate on different parameter sets (expression affects brows/eyes; lip sync affects mouth), so they compose correctly with no special handling required.

---

## 8. RPC Bridge

### 8.1 Electrobun's Webview RPC Mechanism

Electrobun exposes a typed RPC channel between the Bun main process and the webview via `BrowserWindow.webview.rpc`. On the webview side, the global `electrobun.rpc` object is injected by Electrobun's Zig bindings before the page loads.

- **Main process → Webview:** `win.webview.rpc.emit(eventName, payload)`
- **Webview → Main process:** `electrobun.rpc.emit(eventName, payload)`
- **Subscribing (main):** `win.webview.rpc.on(eventName, handler)`
- **Subscribing (webview):** `electrobun.rpc.on(eventName, handler)`

The channel is synchronous from the webview's perspective — incoming events are dispatched on the JS event loop. Payloads are JSON-serialized automatically.

### 8.2 `useRPC.ts` Implementation

```typescript
// src/views/mainview/hooks/useRPC.ts

import { useEffect, useCallback, useRef } from "react";
import type {
  MainToWebviewEvents,
  WebviewToMainEvents,
} from "../types/rpc";

// Electrobun injects `electrobun.rpc` into the webview global scope
declare global {
  interface Window {
    electrobun: {
      rpc: {
        on<K extends keyof MainToWebviewEvents>(
          event: K,
          handler: (payload: MainToWebviewEvents[K]) => void
        ): () => void; // returns unsubscribe function
        emit<K extends keyof WebviewToMainEvents>(
          event: K,
          payload: WebviewToMainEvents[K]
        ): void;
      };
    };
  }
}

type EventHandler<K extends keyof MainToWebviewEvents> = (
  payload: MainToWebviewEvents[K]
) => void;

/**
 * useRPC — typed wrapper around Electrobun's webview RPC channel.
 *
 * Usage:
 *   const { on, emit } = useRPC();
 *   useEffect(() => on("subtitle", ({ text }) => setSubtitle(text)), [on]);
 *   const handleChatSubmit = (text: string) => emit("chat-message", { text });
 */
export function useRPC() {
  // Stable references to avoid re-subscribing on every render
  const onRef = useRef(window.electrobun.rpc.on.bind(window.electrobun.rpc));
  const emitRef = useRef(window.electrobun.rpc.emit.bind(window.electrobun.rpc));

  /**
   * Subscribe to a main-process event.
   * Returns an unsubscribe function — call it in a useEffect cleanup.
   */
  const on = useCallback(
    <K extends keyof MainToWebviewEvents>(
      event: K,
      handler: EventHandler<K>
    ): (() => void) => {
      return onRef.current(event, handler);
    },
    []
  );

  /**
   * Emit an event to the main process.
   */
  const emit = useCallback(
    <K extends keyof WebviewToMainEvents>(
      event: K,
      payload: WebviewToMainEvents[K]
    ): void => {
      emitRef.current(event, payload);
    },
    []
  );

  return { on, emit };
}

/**
 * useRPCEvent — convenience hook for subscribing to a single event.
 * Automatically unsubscribes on component unmount.
 *
 * Usage:
 *   useRPCEvent("subtitle", ({ text }) => setSubtitle(text));
 */
export function useRPCEvent<K extends keyof MainToWebviewEvents>(
  event: K,
  handler: EventHandler<K>
): void {
  const { on } = useRPC();
  // Stable handler ref so the effect doesn't re-run on every render
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsubscribe = on(event, (payload) => handlerRef.current(payload));
    return unsubscribe;
  }, [event, on]);
}
```

### 8.3 Usage in `App.tsx`

```typescript
// src/views/mainview/App.tsx (excerpts)
import { useRPC, useRPCEvent } from "./hooks/useRPC";
import type { ExpressionName } from "./types/rpc";

export default function App() {
  const { emit } = useRPC();
  const [subtitle, setSubtitle] = useState("");
  const [userSpeech, setUserSpeech] = useState("");
  const [expression, setExpression] = useState<ExpressionName>("neutral");
  const [showSettings, setShowSettings] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const avatarRef = useRef<AvatarHandle>(null);

  // Signal readiness to main process
  useEffect(() => {
    emit("webview-ready", undefined);
  }, [emit]);

  // Subscribe to incoming events
  useRPCEvent("subtitle", ({ text }) => setSubtitle(text));
  useRPCEvent("user-speech", ({ text }) => setUserSpeech(text));
  useRPCEvent("set-expression", ({ expression }) => setExpression(expression));
  useRPCEvent("open-settings", () => setShowSettings(true));
  useRPCEvent("visemes", ({ visemes }) => {
    avatarRef.current?.setVisemes(visemes);
  });

  const handleChatSubmit = useCallback((text: string) => {
    emit("chat-message", { text });
    setShowChat(false);
  }, [emit]);

  const handleSettingChange = useCallback((key: string, value: unknown) => {
    emit("setting-changed", { key, value });
  }, [emit]);

  return (
    <div className="app-root">
      <Avatar
        ref={avatarRef}
        modelPath="views://mainview/../../assets/models/albedo/albedo.model3.json"
        expression={expression}
      />
      <Subtitles text={subtitle} speakerLabel="Albedo" />
      {userSpeech && <Subtitles text={userSpeech} speakerLabel="You" />}
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
```

### 8.4 Main Process RPC Type Safety

To keep both sides of the bridge in sync, import the same `rpc.ts` type file from the main process as well. Since Electrobun uses Bun for the main process, you can import from the webview source directory directly:

```typescript
// src/bun/orchestrator.ts
import type { MainToWebviewEvents } from "../views/mainview/types/rpc";

// The win.webview.rpc.emit call becomes type-checked:
this.win.webview.rpc.emit("visemes", { visemes }); // TypeScript validates payload shape
```

---

## 9. UI Layout

### 9.1 Window Configuration

The window is created in `src/bun/index.ts` with:

```typescript
const win = new BrowserWindow({
  title: "Albedo AI",
  url: "views://mainview/index.html",
  width: 420,
  height: 650,
  transparent: true,      // OS-level transparent compositing
  frame: false,           // No title bar or window chrome
  alwaysOnTop: true,      // Avatar floats above other windows
});
```

The window sits in the corner of the screen (position set by the user or defaulted in config). It has no drop shadow from the OS — the React UI provides its own visual framing if needed.

### 9.2 Layout Zones

```
┌─────────────────── 420px ────────────────────┐
│                                               │
│   [WEBGL CANVAS — Live2D Avatar]              │  ~480px
│   (transparent background)                   │
│                                               │
│   [SUBTITLE OVERLAY]                         │  ~60px
│   Semi-transparent pill below avatar          │
│                                               │
│   [CHAT INPUT — slides up when visible]      │  ~60px
│   [CHAT TOGGLE BUTTON — bottom right]        │  ~30px
└───────────────────────────────────────────────┘

Settings panel slides in from the RIGHT edge, overlaying the whole window.
```

### 9.3 Z-Index Stack

| Layer | Z-index | Element |
|---|---|---|
| 0 | 0 | WebGL canvas (Avatar) |
| 1 | 10 | Subtitle overlay |
| 2 | 20 | Chat input bar |
| 3 | 30 | Chat toggle button |
| 4 | 100 | Settings panel |

### 9.4 Drag Behavior

Since the window is frameless, the user needs a way to move it. Apply `-webkit-app-region: drag` to the avatar canvas area in CSS. Apply `-webkit-app-region: no-drag` to interactive elements (buttons, inputs) so clicks are not intercepted by the drag handler.

```css
.avatar-canvas {
  -webkit-app-region: drag;
}

.chat-toggle,
.settings-close,
input,
button {
  -webkit-app-region: no-drag;
}
```

---

## 10. Styling

### 10.1 Transparent Background

The critical chain for window transparency:

1. **OS level:** `BrowserWindow({ transparent: true })` enables composited transparency in the Electrobun shell.
2. **HTML level:** `body { background: transparent; }` ensures the HTML document doesn't paint a background.
3. **WebGL level:** `PIXI.Application({ backgroundAlpha: 0 })` makes the canvas pixel alpha channel 0 where the model is not rendered.
4. **React level:** The `.app-root` div must have `background: transparent` — any background color here will show through.

```css
/* src/views/mainview/styles/global.css */
*, *::before, *::after {
  box-sizing: border-box;
}

html, body, #root {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
  font-family: system-ui, -apple-system, sans-serif;
}

.app-root {
  position: relative;
  width: 100%;
  height: 100%;
  background: transparent;
  user-select: none;
}
```

### 10.2 Subtitle Styling

Subtitles use a frosted-glass style pill that floats over the avatar without obscuring it:

```css
/* src/views/mainview/styles/Subtitles.css */
.subtitle-container {
  position: absolute;
  bottom: 90px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 360px;
  padding: 10px 18px;
  border-radius: 20px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  color: #fff;
  font-size: 14px;
  line-height: 1.4;
  text-align: center;
  pointer-events: none;           /* Don't block clicks on avatar */
  z-index: 10;
  opacity: 0;
  transition: opacity 0.2s ease-in;
}

.subtitle-container.visible {
  opacity: 1;
}

.subtitle-container.fading {
  opacity: 0;
  transition: opacity 0.5s ease-out;
}

.subtitle-speaker {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 3px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

### 10.3 Chat Input Styling

```css
/* src/views/mainview/styles/ChatInput.css */
.chat-input-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 12px;
  background: rgba(20, 20, 30, 0.85);
  backdrop-filter: blur(12px);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  gap: 8px;
  align-items: center;
  z-index: 20;
  transform: translateY(100%);
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.chat-input-bar.visible {
  transform: translateY(0);
}

.chat-input-field {
  flex: 1;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  padding: 8px 12px;
  color: #fff;
  font-size: 14px;
  outline: none;
  -webkit-app-region: no-drag;
}

.chat-input-field:focus {
  border-color: rgba(130, 180, 255, 0.6);
  box-shadow: 0 0 0 2px rgba(130, 180, 255, 0.2);
}
```

### 10.4 Settings Panel Styling

```css
/* src/views/mainview/styles/Settings.css */
.settings-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  background: rgba(15, 15, 25, 0.95);
  backdrop-filter: blur(20px);
  z-index: 100;
  padding: 24px 20px;
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow-y: auto;
  -webkit-app-region: no-drag;
}

.settings-panel.visible {
  transform: translateX(0);
}

.settings-title {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  margin-bottom: 24px;
}

.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
}
```

---

## 11. Testing Strategy

### 11.1 Mock Viseme Playback Test

Create a standalone test page at `src/views/mainview/tests/LipSyncTest.tsx` that exercises the lip sync system without requiring Phases 1–3 to be running:

```typescript
// src/views/mainview/tests/LipSyncTest.tsx
import { Avatar, type AvatarHandle } from "../components/Avatar";
import { useRef, useEffect } from "react";
import type { Viseme } from "../types/rpc";

// Synthetic viseme sequence for "Hello, I am Albedo" (~1.8 seconds)
const MOCK_VISEMES: Viseme[] = [
  { shape: "rest", startMs: 0,    durationMs: 50,  weight: 1.0 },
  { shape: "E",    startMs: 50,   durationMs: 120, weight: 1.0 }, // "Heh"
  { shape: "O",    startMs: 170,  durationMs: 130, weight: 1.0 }, // "loh"
  { shape: "rest", startMs: 300,  durationMs: 100, weight: 1.0 },
  { shape: "A",    startMs: 400,  durationMs: 120, weight: 1.0 }, // "I"
  { shape: "rest", startMs: 520,  durationMs: 80,  weight: 1.0 },
  { shape: "A",    startMs: 600,  durationMs: 100, weight: 1.0 }, // "am"
  { shape: "E",    startMs: 700,  durationMs: 80,  weight: 1.0 },
  { shape: "rest", startMs: 780,  durationMs: 100, weight: 1.0 },
  { shape: "A",    startMs: 880,  durationMs: 100, weight: 1.0 }, // "Al"
  { shape: "U",    startMs: 980,  durationMs: 120, weight: 1.0 }, // "be"
  { shape: "O",    startMs: 1100, durationMs: 120, weight: 1.0 }, // "do"
  { shape: "rest", startMs: 1220, durationMs: 200, weight: 1.0 },
];

export function LipSyncTest() {
  const avatarRef = useRef<AvatarHandle>(null);

  function playTest() {
    avatarRef.current?.setVisemes(MOCK_VISEMES);
  }

  return (
    <div style={{ width: 420, height: 650, background: "#111" }}>
      <Avatar
        ref={avatarRef}
        modelPath="../../../assets/models/albedo/albedo.model3.json"
        expression="neutral"
      />
      <button
        onClick={playTest}
        style={{ position: "absolute", bottom: 10, left: 10, zIndex: 999 }}
      >
        Play Lip Sync Test
      </button>
    </div>
  );
}
```

Mount this component by temporarily changing `main.tsx` to render `<LipSyncTest />` during development.

### 11.2 Expression Switching Test

Add a simple expression cycle button to `LipSyncTest.tsx`:

```typescript
const EXPRESSIONS: ExpressionName[] = ["neutral", "happy", "sad", "alert"];
let exprIdx = 0;

function cycleExpression() {
  exprIdx = (exprIdx + 1) % EXPRESSIONS.length;
  setExpression(EXPRESSIONS[exprIdx]);
}
```

Visually verify:
- `happy` — lifted cheeks, curved mouth
- `sad` — drooped brows, downward mouth corners
- `alert` — wide eyes, raised brows
- `neutral` — relaxed default pose

### 11.3 Subtitle Rendering Test

Mount `Subtitles.tsx` in isolation with a prop cycler:

```typescript
const SUBTITLE_SAMPLES = [
  "Hey! I noticed your CPU is running hot.",
  "Do you want me to check what's consuming resources?",
  "I can also open the Activity Monitor for you.",
  "",
];
```

Step through these at 2-second intervals and verify fade-in/fade-out animations, text truncation on long strings, and the empty string causing the subtitle to hide.

### 11.4 RPC Bridge Mock

For testing without a live Electrobun main process, provide a mock implementation of `window.electrobun`:

```typescript
// src/views/mainview/tests/mockRPC.ts
const handlers: Map<string, Function[]> = new Map();

window.electrobun = {
  rpc: {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const arr = handlers.get(event)!;
        arr.splice(arr.indexOf(handler), 1);
      };
    },
    emit(event, payload) {
      console.log(`[mock rpc → main] ${event}`, payload);
    },
  },
};

// Expose helper to simulate incoming events from main
export function simulateEvent(event: string, payload: unknown) {
  handlers.get(event)?.forEach((h) => h(payload));
}
```

Import this mock at the top of test files or a test-only entry point.

### 11.5 WebGL Performance Check

Open the browser devtools (if available via Electrobun's debug mode) and verify:
- Frame rate stays at 60fps during lip sync playback
- GPU memory usage is stable (no texture leaks on model reload)
- No dropped frames during expression transitions

Use `PIXI.Ticker.shared.FPS` to read the current frame rate and display it in an overlay during development.

---

## 12. Validation Criteria

Phase 4 is complete when all of the following pass:

| # | Criterion | How to verify |
|---|---|---|
| 1 | Avatar is visible in the transparent window | Launch the app, see Live2D model rendered against the desktop |
| 2 | Window is frameless and transparent | Desktop shows through in the non-model areas |
| 3 | Avatar stays on top of other windows | Open another application, avatar remains visible |
| 4 | Lips move in sync with TTS speech | Run `make dev`, speak to Albedo, observe mouth movement during response |
| 5 | Lip sync timing is within ~100ms of audio | Compare visual mouth open against audio output spectrogram |
| 6 | Subtitles appear when Albedo speaks | Subtitle text appears below avatar for each sentence |
| 7 | Subtitles fade out after speech ends | Text disappears ~4s after last subtitle update |
| 8 | User speech subtitle appears | Speak to Albedo, see transcription appear with "You" label |
| 9 | Expressions change correctly | Say something funny → happy expression; trigger alert condition → alert expression |
| 10 | Expression transitions are smooth | No snapping — parameters blend over ~500ms |
| 11 | Chat input submits to orchestrator | Type a message, press Enter, Albedo responds as if spoken |
| 12 | Settings panel opens from tray menu | Click "Settings" in system tray, panel slides in |
| 13 | Settings changes propagate | Toggle mute in settings, verify Albedo stops speaking |
| 14 | No WebGL errors in console | Zero WebGL errors after 5 minutes of normal use |
| 15 | Model loads within 2 seconds | From app launch to avatar visible |

---

## 13. Risks and Notes

### 13.1 Live2D Licensing

**Risk (High — must be resolved before any public release):**

The Live2D Cubism SDK (including the Core WASM `live2dcubismcore.min.js`) is **not open-source**. It is distributed under the [Live2D Proprietary Software License](https://www.live2d.com/en/terms/live2d-proprietary-software-license-agreement/).

Key restrictions:
- **Free for non-commercial use and apps earning under ¥10M/year** under the Free Material License.
- **Requires a paid license** for commercial products or products distributing the Cubism Core runtime embedded in a product.
- **Do not redistribute** `live2dcubismcore.min.js` in a public repository without verifying license terms.

**Mitigation for MVP:**
- Use the free tier during development (personal use, under the revenue threshold).
- Do not commit `live2dcubismcore.min.js` to a public git repository. Add it to `.gitignore` and document the manual download step.
- Evaluate open-source alternatives (e.g., `eft-canvas-web` or raw Spine2D) for a production release if licensing costs are prohibitive.

### 13.2 PixiJS Version Compatibility

**Risk (Medium):**

`pixi-live2d-display` has not been updated for PixiJS v8, which has a completely rewritten renderer. Using PixiJS v8 will cause runtime errors.

**Mitigation:**
- Pin `"pixi.js": "7.4.2"` and `"pixi-live2d-display": "0.4.0"` in `package.json`.
- Add an `overrides` field in `package.json` to prevent transitive dependencies from bumping PixiJS:
  ```json
  "overrides": {
    "pixi.js": "7.4.2"
  }
  ```
- Monitor the `pixi-live2d-display` repository for a v8-compatible release.

### 13.3 WebGL Performance in the System Webview

**Risk (Medium):**

Electrobun uses the OS system webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). WebGL support and GPU acceleration vary:

- **macOS (WKWebView):** WebGL 2.0 is supported and hardware-accelerated. Expected good performance.
- **Windows (WebView2/Chromium-based):** WebGL 2.0 supported, GPU acceleration available. Generally good.
- **Linux (WebKitGTK):** WebGL support depends on the GTK and Mesa version. On some distributions, WebGL may fall back to software rendering (llvmpipe), causing low frame rates.

**Mitigation:**
- Detect `PIXI.utils.isWebGLSupported()` on startup and display a fallback static image if WebGL is unavailable.
- For Linux, document the dependency on hardware-accelerated Mesa (`libgl1-mesa-dri`).
- Keep the Live2D model polygon count reasonable (< 2000 mesh vertices) to stay performant even on lower-end GPUs.

### 13.4 Viseme-to-Audio Synchronization Drift

**Risk (Low-Medium):**

The gap between the orchestrator emitting `visemes` via RPC and the Rust audio engine beginning actual PCM playback through `cpal` is non-deterministic and depends on OS audio buffer scheduling.

**Mitigation:**
- The `VISEME_LEAD_MS` constant in `Avatar.tsx` provides a tunable offset.
- During Phase 6 integration, measure the average delay empirically using a metronome test (TTS a "tick" word with known viseme timing and observe the audio/visual offset).
- If drift is inconsistent (jitter > 30ms), add a shared timestamp to the `play()` response from the Rust engine that the orchestrator forwards to the webview as part of the `visemes` event.

### 13.5 Electrobun RPC API Stability

**Risk (Low):**

Electrobun is a relatively new framework (first stable release late 2024). The `BrowserWindow.webview.rpc` API could change in minor versions.

**Mitigation:**
- Pin the Electrobun version in `package.json`.
- Isolate all Electrobun RPC calls inside `useRPC.ts` — if the API changes, only one file needs updating.

### 13.6 `live2dcubismcore.min.js` WASM Initialization Race Condition

**Risk (Low):**

If `Live2DModel.from()` is called before the Cubism Core WASM module has finished loading (which happens asynchronously via a `<script>` tag or `fetch`), the model load will fail silently or throw an uncaught error.

**Mitigation:**
- Set `l2dConfig.cubismCorePath` before any model loading.
- Wrap model loading in a retry loop with a 100ms delay:
  ```typescript
  while (!Live2DModel.cubismReady) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const model = await Live2DModel.from(modelPath);
  ```
- Or, if the WASM is bundled inline, import it as a module and await its initialization promise before mounting `Avatar.tsx`.

---

*End of Phase 4 Implementation Plan*
