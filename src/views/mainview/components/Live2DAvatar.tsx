import {
  forwardRef,
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";
import type { Viseme, ExpressionName } from "../types/rpc";

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

export interface Live2DAvatarHandle {
  setVisemes: (visemes: Viseme[]) => void;
}

interface Live2DAvatarProps {
  modelPath: string;
  expression: ExpressionName;
  scaleMultiplier: number;
}

function resolveAssetURL(base: string, relative: string): string {
  const baseDir = base.substring(0, base.lastIndexOf("/") + 1);
  return baseDir + relative;
}

async function fetchTexture(PIXI: any, url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Texture fetch failed: ${url} (${resp.status})`);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return PIXI.Texture.from(canvas);
}

export const Live2DAvatar = forwardRef<Live2DAvatarHandle, Live2DAvatarProps>(
  ({ modelPath, expression, scaleMultiplier }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const pixiAppRef = useRef<any>(null);
    const modelRef = useRef<any>(null);
    const visemeQueueRef = useRef<Viseme[]>([]);
    const lipSyncStartTimeRef = useRef<number>(0);
    const pendingExpressionRef = useRef<ExpressionName>(expression);
    const initDoneRef = useRef(false);
    const baseScaleRef = useRef<number | null>(null);
    const scaleRef = useRef(scaleMultiplier);
    scaleRef.current = scaleMultiplier;

    useImperativeHandle(ref, () => ({
      setVisemes(visemes: Viseme[]) {
        visemeQueueRef.current = visemes;
        lipSyncStartTimeRef.current = performance.now();
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;
      if (initDoneRef.current && modelRef.current) return;

      let cancelled = false;
      let app: any = null;
      let model: any = null;

      const setStatus = (msg: string) => {
        if (containerRef.current && !cancelled) {
          containerRef.current.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.6);font-size:11px;font-family:monospace;padding:20px;text-align:center;">${msg}</div>`;
        }
      };

      (async () => {
        try {
          setStatus("Loading Live2D...");
          const PIXI = await import("pixi.js");
          const { Live2DModel, Live2DLoader, Live2DFactory } = await import("pixi-live2d-display/cubism4");

          if (cancelled) return;

          // Replace XHR loader with fetch for views:// protocol
          Live2DLoader.middlewares = [
            async (context: any) => {
              const url = context.settings
                ? resolveAssetURL(context.settings.url, context.url)
                : context.url;
              const resp = await fetch(url);
              if (!resp.ok) throw new Error(`Failed to load: ${url} (${resp.status})`);
              if (context.type === "json") {
                context.result = await resp.json();
              } else if (context.type === "arraybuffer") {
                context.result = await resp.arrayBuffer();
              } else {
                context.result = await resp.blob();
              }
            },
          ];

          // Replace setupEssentials to use fetch+canvas for textures
          const middlewares = (Live2DFactory as any).live2DModelMiddlewares as any[];
          const essRef = (Live2DFactory as any).setupEssentials;
          let essIdx = middlewares.indexOf(essRef);
          if (essIdx === -1) {
            for (let i = 0; i < middlewares.length; i++) {
              const src = middlewares[i].toString();
              if (src.includes("textures") && src.includes("textureLoaded")) {
                essIdx = i;
                break;
              }
            }
          }
          if (essIdx !== -1) {
            middlewares[essIdx] = async (context: any, next: () => Promise<void>) => {
              if (!context.settings) throw new TypeError("Missing settings.");
              const texPromises = context.settings.textures.map((t: string) =>
                fetchTexture(PIXI, resolveAssetURL(context.settings.url, t))
              );
              await next();
              if (context.internalModel) {
                context.live2dModel.internalModel = context.internalModel;
                context.live2dModel.emit("modelLoaded", context.internalModel);
              } else {
                throw new TypeError("Missing internal model.");
              }
              context.live2dModel.textures = await Promise.all(texPromises);
              context.live2dModel.emit("textureLoaded", context.live2dModel.textures);
            };
          }

          if (cancelled) return;

          // Create pixi app
          app = new PIXI.Application({
            backgroundAlpha: 0,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
            clearBeforeRender: true,
            antialias: true,
            autoDensity: true,
            resolution: window.devicePixelRatio || 1,
            width: containerRef.current!.clientWidth,
            height: containerRef.current!.clientHeight,
          });
          const canvas = app.view as HTMLCanvasElement;
          canvas.style.display = "block";
          containerRef.current!.innerHTML = "";
          containerRef.current!.appendChild(app.view as HTMLCanvasElement);
          pixiAppRef.current = app;

          Live2DModel.registerTicker(PIXI.Ticker);

          if (cancelled) { app.destroy(true); return; }

          // Fetch model JSON and load
          const modelResp = await fetch(modelPath);
          const modelJson = await modelResp.json();
          modelJson.url = modelPath;

          if (cancelled) { app.destroy(true); return; }

          model = await new Promise<any>((resolve, reject) => {
            const m = Live2DModel.fromSync(modelJson, {
              autoInteract: false,
              onLoad: () => resolve(m),
              onError: (e: any) => reject(e),
            });
          });

          if (cancelled) { model.destroy(); app.destroy(true); return; }

          const baseScale = Math.min(
            app.screen.width / model.width,
            app.screen.height / model.height
          ) * 0.8;
          baseScaleRef.current = baseScale;
          model.scale.set(baseScale * scaleRef.current);
          model.anchor.set(0.5, 0.0);
          model.x = app.screen.width / 2;
          model.y = Math.max(0, app.screen.height * (1 - scaleRef.current) * 0.5);

          if (cancelled) { model.destroy(); app.destroy(true); return; }

          app.stage.addChild(model as any);
          modelRef.current = model;
          initDoneRef.current = true;

          try { model.expression(pendingExpressionRef.current); } catch {}
          try { model.motion("idle"); } catch {}
        } catch (err: any) {
          console.warn("[live2d-avatar] error:", err.message);
          if (containerRef.current && !cancelled) {
            containerRef.current.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ff6b6b;font-size:11px;font-family:monospace;padding:20px;text-align:left;white-space:pre-wrap;overflow:auto;">Live2D error: ${err.stack || err.message || err}</div>`;
          }
        }
      })();

      return () => {
        cancelled = true;
        if (modelRef.current) {
          modelRef.current.destroy();
          modelRef.current = null;
        }
        if (pixiAppRef.current) {
          pixiAppRef.current.destroy(true);
          pixiAppRef.current = null;
        }
        initDoneRef.current = false;
        baseScaleRef.current = null;
        if (containerRef.current) containerRef.current.innerHTML = "";
      };
    }, [modelPath]);

    useEffect(() => {
      pendingExpressionRef.current = expression;
      if (!modelRef.current) return;
      try { modelRef.current.expression(expression); } catch {}
    }, [expression]);

    useEffect(() => {
      if (!modelRef.current || baseScaleRef.current === null || !pixiAppRef.current) return;
      const model = modelRef.current;
      const app = pixiAppRef.current;
      model.scale.set(baseScaleRef.current * scaleMultiplier);
      model.x = app.screen.width / 2;
      model.y = Math.max(0, app.screen.height * (1 - scaleMultiplier) * 0.5);
    }, [scaleMultiplier]);

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

Live2DAvatar.displayName = "Live2DAvatar";

export default Live2DAvatar;
