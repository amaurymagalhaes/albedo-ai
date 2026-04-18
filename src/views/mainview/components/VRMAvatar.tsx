// @ts-nocheck - Three.js types can conflict between @types/three and three-vrm peer deps
import {
  forwardRef,
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { Viseme, ExpressionName } from "../types/rpc";

// Map Kokoro visemes → VRM expression (blend shape) names
const VISEME_TO_VRM: Record<string, string> = {
  rest: "",
  A: "aa",
  E: "ih",
  I: "ee",
  O: "oh",
  U: "ou",
  B: "aa",
  F: "ih",
  TH: "aa",
  S: "ih",
};

// Map our expression names → VRM expression names
const EXPRESSION_TO_VRM: Record<string, string> = {
  neutral: "",
  happy: "happy",
  sad: "sad",
  alert: "surprised",
};

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

const LERP_FACTOR = 0.35;
const VISEME_LEAD_MS = 80;

export interface VRMAvatarHandle {
  setVisemes: (visemes: Viseme[]) => void;
}

interface VRMAvatarProps {
  modelPath: string;
  expression: ExpressionName;
  scaleMultiplier: number;
  offsetX?: number;
  offsetY?: number;
}

/**
 * Force arms out of T-Pose into a natural rest position.
 */
function applyRestPose(vrm: any) {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  const armAngle = THREE.MathUtils.degToRad(50);

  // Try normalized bone names first, then fall back to raw node search
  const boneNames = {
    leftUpperArm: ["leftUpperArm", "LeftUpperArm", "J_Bip_L_UpperArm", "upper_arm_L"],
    rightUpperArm: ["rightUpperArm", "RightUpperArm", "J_Bip_R_UpperArm", "upper_arm_R"],
    leftLowerArm: ["leftLowerArm", "LeftLowerArm", "J_Bip_L_LowerArm", "forearm_L"],
    rightLowerArm: ["rightLowerArm", "RightLowerArm", "J_Bip_R_LowerArm", "forearm_R"],
  };

  function getBone(names: string[]): THREE.Object3D | null {
    for (const name of names) {
      const bone = humanoid.getNormalizedBoneNode(name);
      if (bone) return bone;
    }
    // Fallback: search the skeleton directly
    const skeleton = vrm.scene;
    for (const name of names) {
      const found = skeleton.getObjectByName(name);
      if (found) return found;
    }
    return null;
  }

  const leftUpperArm = getBone(boneNames.leftUpperArm);
  if (leftUpperArm) leftUpperArm.rotation.z = armAngle;

  const rightUpperArm = getBone(boneNames.rightUpperArm);
  if (rightUpperArm) rightUpperArm.rotation.z = -armAngle;

  const leftLowerArm = getBone(boneNames.leftLowerArm);
  if (leftLowerArm) leftLowerArm.rotation.x = -0.15;

  const rightLowerArm = getBone(boneNames.rightLowerArm);
  if (rightLowerArm) rightLowerArm.rotation.x = -0.15;
}

export const VRMAvatar = forwardRef<VRMAvatarHandle, VRMAvatarProps>(
  ({ modelPath, expression, scaleMultiplier, offsetX = 0, offsetY = 0 }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const vrmRef = useRef<any>(null);
    const clockRef = useRef(new THREE.Clock());
    const animFrameRef = useRef<number>(0);
    const visemeQueueRef = useRef<Viseme[]>([]);
    const lipSyncStartTimeRef = useRef<number>(0);
    const currentMouthRef = useRef(0);
    const pendingExpressionRef = useRef<ExpressionName>(expression);
    const initDoneRef = useRef(false);
    const baseScaleRef = useRef<number>(1);
    const idleTimeRef = useRef(0);
    const scaleRef = useRef(scaleMultiplier);
    scaleRef.current = scaleMultiplier;

    useImperativeHandle(ref, () => ({
      setVisemes(visemes: Viseme[]) {
        visemeQueueRef.current = visemes;
        lipSyncStartTimeRef.current = performance.now();
      },
    }));

    useEffect(() => {
      pendingExpressionRef.current = expression;
      if (!vrmRef.current) return;
      applyExpression(vrmRef.current, expression);
    }, [expression]);

    // Zoom: move camera closer/further
    useEffect(() => {
      if (!cameraRef.current || !rendererRef.current) return;
      const cam = cameraRef.current;
      const renderer = rendererRef.current;
      const baseZ = cam.userData.baseZ || 0.9;
      const z = baseZ / Math.max(0.3, Math.min(3.0, scaleMultiplier));
      cam.position.z = z;
      const w = window.innerWidth || 420;
      const h = window.innerHeight || 650;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + "px";
      renderer.domElement.style.height = h + "px";
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }, [scaleMultiplier]);

    useEffect(() => {
      if (!containerRef.current) return;
      if (initDoneRef.current && vrmRef.current) return;

      let cancelled = false;

      const setStatus = (msg: string) => {
        if (containerRef.current && !cancelled) {
          containerRef.current.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.6);font-size:11px;font-family:monospace;padding:20px;text-align:center;">${msg}</div>`;
        }
      };

      (async () => {
        try {
          setStatus("Loading VRM...");

          const container = containerRef.current!;
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => requestAnimationFrame(r));

          // Use window size — renderer needs actual pixel dimensions
          const width = window.innerWidth || 420;
          const height = window.innerHeight || 650;

          console.log(`[vrm-avatar] size: ${width}x${height}`);

          // Renderer
          const renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: true,
          });
          const dpr = window.devicePixelRatio || 1;
          renderer.setSize(width, height, false);
          renderer.setPixelRatio(dpr);
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.0;
          container.innerHTML = "";
          const canvas = renderer.domElement;
          canvas.style.width = width + "px";
          canvas.style.height = height + "px";
          container.appendChild(canvas);
          rendererRef.current = renderer;

          // Scene
          const scene = new THREE.Scene();
          sceneRef.current = scene;

          // Camera — wider FOV to fill the window
          const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
          cameraRef.current = camera;

          // Lighting
          const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
          dirLight.position.set(1, 2, 1);
          scene.add(dirLight);
          const ambLight = new THREE.AmbientLight(0xffffff, 0.6);
          scene.add(ambLight);

          // Load VRM via fetch() + parse() — Electrobun's views:// protocol
          // doesn't support Three.js GLTFLoader's internal XHR requests.
          const resp = await fetch(modelPath);
          if (!resp.ok) throw new Error(`Failed to fetch VRM: ${resp.status}`);
          const arrayBuffer = await resp.arrayBuffer();

          if (cancelled) { renderer.dispose(); return; }

          const loader = new GLTFLoader();
          loader.register((parser) => new VRMLoaderPlugin(parser));
          const gltf = await new Promise<any>((resolve, reject) => {
            loader.parse(arrayBuffer, "", resolve, reject);
          });

          const vrm = gltf.userData.vrm;
          if (!vrm) throw new Error("File does not contain valid VRM data");

          if (cancelled) { renderer.dispose(); return; }

          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.removeUnnecessaryJoints(gltf.scene);

          applyRestPose(vrm);
          vrm.update(0);

          // VRM models typically face -Z (towards the camera in most viewers).
          // Our camera is at +Z, so rotate 180° to face us.
          vrm.scene.rotation.y = Math.PI;

          // Scale model so height = 1.5 units
          const bbox = new THREE.Box3().setFromObject(vrm.scene);
          const modelHeight = bbox.max.y - bbox.min.y;
          const s = 1.5 / modelHeight;
          baseScaleRef.current = s;
          vrm.scene.scale.set(s, s, s);

          // Center model, feet at y=0
          const scaledBbox = new THREE.Box3().setFromObject(vrm.scene);
          const scaledCenter = scaledBbox.getCenter(new THREE.Vector3());
          vrm.scene.position.set(-scaledCenter.x, -scaledBbox.min.y, -scaledCenter.z);

          scene.add(vrm.scene);
          vrmRef.current = vrm;
          initDoneRef.current = true;

          // Camera: frame upper body to fill portrait window.
          // Model is 1.5 units tall, feet at y=0, top at y=1.5.
          // At z=0.9 FOV=40: view height ≈ 0.655 units → shows face+chest
          camera.position.set(0, 1.2, 0.9);
          camera.lookAt(0, 1.2, 0);
          camera.userData.baseZ = 0.9;
          // Apply current scale as camera zoom
          camera.position.z = 0.9 / scaleRef.current;

          applyExpression(vrm, pendingExpressionRef.current);

          // Animation loop
          const clock = clockRef.current;
          clock.start();

          const animate = () => {
            if (cancelled) return;
            animFrameRef.current = requestAnimationFrame(animate);
            const delta = clock.getDelta();
            idleTimeRef.current += delta;
            processVisemes(vrm);
            animateIdle(vrm, idleTimeRef.current);
            vrm.update(delta);
            renderer.render(scene, camera);
          };
          animate();
        } catch (err: any) {
          console.warn("[vrm-avatar] error:", err.message);
          if (containerRef.current && !cancelled) {
            containerRef.current.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ff6b6b;font-size:11px;font-family:monospace;padding:20px;text-align:left;white-space:pre-wrap;overflow:auto;">VRM error: ${err.stack || err.message || err}</div>`;
          }
        }
      })();

      return () => {
        cancelled = true;
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = 0;
        }
        if (vrmRef.current) {
          vrmRef.current.scene.traverse((obj: any) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
              if (Array.isArray(obj.material)) {
                obj.material.forEach((m: any) => m.dispose());
              } else {
                obj.material.dispose();
              }
            }
          });
          vrmRef.current = null;
        }
        if (rendererRef.current) {
          rendererRef.current.dispose();
          rendererRef.current = null;
        }
        sceneRef.current = null;
        cameraRef.current = null;
        initDoneRef.current = false;
        if (containerRef.current) containerRef.current.innerHTML = "";
      };
    }, [modelPath]);

    function animateIdle(vrm: any, time: number) {
      const humanoid = vrm.humanoid;
      if (!humanoid) return;

      const breathe = Math.sin(time * 2.0) * 0.005;
      const spine = humanoid.getNormalizedBoneNode("spine");
      if (spine) spine.scale.y = 1.0 + breathe;

      const sway = Math.sin(time * 0.8) * 0.015;
      const hips = humanoid.getNormalizedBoneNode("hips");
      if (hips) hips.rotation.z = sway;

      const head = humanoid.getNormalizedBoneNode("head");
      if (head) {
        head.rotation.y = Math.sin(time * 0.5) * 0.03;
        head.rotation.x = Math.sin(time * 0.7) * 0.02 - 0.02;
      }
    }

    function processVisemes(vrm: any) {
      const visemes = visemeQueueRef.current;
      if (!visemes.length) return;

      const elapsed = performance.now() - lipSyncStartTimeRef.current - VISEME_LEAD_MS;
      const em = vrm.expressionManager;
      if (!em) return;

      const visemeNames = ["aa", "ih", "ou", "ee", "oh"];

      const active = visemes.find(
        (v) => elapsed >= v.startMs && elapsed < v.startMs + v.durationMs
      );

      if (active) {
        const vrmName = VISEME_TO_VRM[active.shape] ?? "";
        const targetValue = (VISEME_TO_MOUTH_OPEN[active.shape] ?? 0) * active.weight;
        for (const name of visemeNames) {
          try { em.setValue(name, name === vrmName ? targetValue : 0); } catch {}
        }
        currentMouthRef.current = targetValue;
      } else {
        let anyActive = false;
        for (const name of visemeNames) {
          try {
            const current = em.getValue(name) ?? 0;
            if (current > 0.01) {
              em.setValue(name, current * (1 - LERP_FACTOR));
              anyActive = true;
            } else {
              em.setValue(name, 0);
            }
          } catch {}
        }
        if (!anyActive) currentMouthRef.current = 0;
      }

      const lastViseme = visemes[visemes.length - 1];
      if (lastViseme && elapsed > lastViseme.startMs + lastViseme.durationMs + 200) {
        visemeQueueRef.current = [];
      }
    }

    function applyExpression(vrm: any, expr: ExpressionName) {
      const em = vrm.expressionManager;
      if (!em) return;
      const vrmName = EXPRESSION_TO_VRM[expr] ?? "";
      try {
        const allExpressions = em.expressions;
        if (allExpressions) {
          for (const exp of allExpressions) {
            if (["aa", "ih", "ou", "ee", "oh"].includes(exp.name)) continue;
            try { em.setValue(exp.name, 0); } catch {}
          }
        }
      } catch {}
      if (vrmName) {
        try { em.setValue(vrmName, 1.0); } catch {}
      }
    }

    return <div ref={containerRef} className="vrm-avatar-root" />;
  }
);

VRMAvatar.displayName = "VRMAvatar";

export default VRMAvatar;
