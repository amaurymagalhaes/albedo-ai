import { forwardRef, useRef, useImperativeHandle } from "react";
import { Live2DAvatar, type Live2DAvatarHandle } from "./Live2DAvatar";
import { VRMAvatar, type VRMAvatarHandle } from "./VRMAvatar";
import type { Viseme, ExpressionName, AvatarFormat } from "../types/rpc";

export interface AvatarHandle {
  setVisemes: (visemes: Viseme[]) => void;
}

interface AvatarProps {
  modelPath: string;
  modelType: AvatarFormat;
  expression: ExpressionName;
  scaleMultiplier?: number;
  offsetX?: number;
  offsetY?: number;
}

export function detectFormat(path: string): AvatarFormat {
  if (path.endsWith(".vrm")) return "vrm";
  if (path.endsWith(".model3.json")) return "live2d";
  return "live2d";
}

export const Avatar = forwardRef<AvatarHandle, AvatarProps>(
  ({ modelPath, modelType: modelTypeProp, expression, scaleMultiplier = 1.0, offsetX = 0, offsetY = 0 }, ref) => {
    const live2dRef = useRef<Live2DAvatarHandle>(null);
    const vrmRef = useRef<VRMAvatarHandle>(null);

    const modelType = modelTypeProp ?? detectFormat(modelPath);

    useImperativeHandle(ref, () => ({
      setVisemes(visemes: Viseme[]) {
        if (modelType === "vrm") {
          vrmRef.current?.setVisemes(visemes);
        } else {
          live2dRef.current?.setVisemes(visemes);
        }
      },
    }), [modelType]);

    if (modelType === "vrm") {
      return (
        <VRMAvatar
          key={modelPath}
          ref={vrmRef}
          modelPath={modelPath}
          expression={expression}
          scaleMultiplier={scaleMultiplier}
          offsetX={offsetX}
          offsetY={offsetY}
        />
      );
    }

    return (
      <Live2DAvatar
        key={modelPath}
        ref={live2dRef}
        modelPath={modelPath}
        expression={expression}
        scaleMultiplier={scaleMultiplier}
      />
    );
  }
);

Avatar.displayName = "Avatar";

export default Avatar;
