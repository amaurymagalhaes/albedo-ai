import {
  forwardRef,
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";
import type { Viseme, ExpressionName } from "../types/rpc";
import "../styles/Avatar.css";

const VISEME_TO_MOUTH_OPEN: Record<string, number> = {
  rest: 0.0,
  A: 1.0,
  E: 0.7,
  I: 0.5,
  O: 0.9,
  U: 0.6,
  B: 0.1,
  F: 0.15,
  TH: 0.2,
  S: 0.2,
};

const LERP_FACTOR = 0.4;
const MOUTH_PARAM_ID = "ParamMouthOpenY";
const VISEME_LEAD_MS = 80;
const CUBISM_READY_TIMEOUT_MS = 10000;

export interface AvatarHandle {
  setVisemes: (visemes: Viseme[]) => void;
}

interface AvatarProps {
  modelPath: string;
  expression: ExpressionName;
}

export const Avatar = forwardRef<AvatarHandle, AvatarProps>(
  ({ modelPath, expression }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const pixiAppRef = useRef<any>(null);
    const modelRef = useRef<any>(null);
    const visemeQueueRef = useRef<Viseme[]>([]);
    const lipSyncStartTimeRef = useRef<number>(0);
    const pendingExpressionRef = useRef<ExpressionName>(expression);

    useImperativeHandle(ref, () => ({
      setVisemes(visemes: Viseme[]) {
        visemeQueueRef.current = visemes;
        lipSyncStartTimeRef.current = performance.now();
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      let cancelled = false;
      let app: any = null;

      (async () => {
        try {
          const PIXI = await import("pixi.js");
          const { Live2DModel } = await import("pixi-live2d-display");

          Live2DModel.registerTicker(PIXI.Ticker);

          app = new PIXI.Application({
            backgroundAlpha: 0,
            antialias: true,
            autoDensity: true,
            resolution: window.devicePixelRatio || 1,
            width: containerRef.current!.clientWidth,
            height: containerRef.current!.clientHeight,
          });

          if (cancelled) { app.destroy(true); return; }

          containerRef.current!.appendChild(app.view as HTMLCanvasElement);
          pixiAppRef.current = app;

          const startWait = Date.now();
          while (!(Live2DModel as any).cubismReady) {
            if (Date.now() - startWait > CUBISM_READY_TIMEOUT_MS) {
              console.error("[avatar] cubism core WASM failed to initialize within timeout");
              return;
            }
            if (cancelled) return;
            await new Promise((r) => setTimeout(r, 100));
          }

          const model = await Live2DModel.from(modelPath, {
            autoInteract: false,
          });
          if (cancelled) {
            model.destroy();
            return;
          }

          model.scale.set(0.3);
          model.anchor.set(0.5, 0.5);
          model.x = app.screen.width / 2;
          model.y = app.screen.height / 2;

          app.stage.addChild(model as any);
          modelRef.current = model;

          try { model.expression(pendingExpressionRef.current); } catch {}
          try { model.motion("idle"); } catch {}
        } catch (err: any) {
          console.warn("[avatar] Live2D unavailable:", err.message);
          if (containerRef.current && !cancelled) {
            containerRef.current.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.3);font-size:13px;font-family:sans-serif;">No avatar model</div>`;
          }
        }
      })();

      return () => {
        cancelled = true;
        if (modelRef.current) {
          modelRef.current.destroy();
          modelRef.current = null;
        }
        if (app) {
          app.destroy(true);
          pixiAppRef.current = null;
        }
      };
    }, [modelPath]);

    useEffect(() => {
      pendingExpressionRef.current = expression;
      if (!modelRef.current) return;
      try { modelRef.current.expression(expression); } catch {}
    }, [expression]);

    useEffect(() => {
      let ticker: any = null;
      let onTick: (() => void) | null = null;

      (async () => {
        try {
          const PIXI = await import("pixi.js");
          ticker = PIXI.Ticker.shared;

          onTick = () => {
            const visemes = visemeQueueRef.current;
            if (!visemes.length || !modelRef.current) return;

            const elapsed = performance.now() - lipSyncStartTimeRef.current - VISEME_LEAD_MS;
            const coreModel = (modelRef.current as any).internalModel.coreModel;

            const active = visemes.find(
              (v) => elapsed >= v.startMs && elapsed < v.startMs + v.durationMs
            );

            if (active) {
              const targetOpen = VISEME_TO_MOUTH_OPEN[active.shape] ?? 0;
              const current = coreModel.getParameterValueById(MOUTH_PARAM_ID);
              const next = current + (targetOpen * active.weight - current) * LERP_FACTOR;
              coreModel.setParameterValueById(MOUTH_PARAM_ID, next);
            } else {
              const current = coreModel.getParameterValueById(MOUTH_PARAM_ID);
              coreModel.setParameterValueById(MOUTH_PARAM_ID, current * LERP_FACTOR);
            }

            const lastViseme = visemes[visemes.length - 1];
            if (lastViseme && elapsed > lastViseme.startMs + lastViseme.durationMs + 200) {
              visemeQueueRef.current = [];
            }
          };

          ticker.add(onTick);
        } catch {}
      })();

      return () => {
        if (ticker && onTick) {
          ticker.remove(onTick);
        }
      };
    }, []);

    return <div ref={containerRef} className="avatar-container" />;
  }
);

Avatar.displayName = "Avatar";

export default Avatar;
