import { existsSync, readdirSync, statSync } from "fs";
import { join, basename, relative } from "path";
import type { AvatarModelInfo, AvatarFormat } from "../shared/rpc-types";

/**
 * Discovers avatar models in the assets/models/ directory.
 * Supports:
 *  - Live2D: directories containing *.model3.json files
 *  - VRM: standalone *.vrm files or directories containing them
 */
export function discoverAvatars(modelsDir: string): AvatarModelInfo[] {
  const avatars: AvatarModelInfo[] = [];

  if (!existsSync(modelsDir)) {
    console.warn("[avatar-discovery] Models directory not found:", modelsDir);
    return avatars;
  }

  const entries = readdirSync(modelsDir).sort();

  for (const entry of entries) {
    const entryPath = join(modelsDir, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory()) {
      // Check for .model3.json files (Live2D)
      const files = readdirSync(entryPath);
      const model3File = files.find((f) => f.endsWith(".model3.json"));
      if (model3File) {
        const name = entry.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        avatars.push({
          id: entry,
          name,
          format: "live2d",
          path: `./models/${entry}/${model3File}`,
        });
        continue;
      }

      // Check for .vrm files in directory
      const vrmFile = files.find((f) => f.endsWith(".vrm"));
      if (vrmFile) {
        const name = entry.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        avatars.push({
          id: entry,
          name,
          format: "vrm",
          path: `./models/${entry}/${vrmFile}`,
        });
        continue;
      }
    } else if (entry.endsWith(".vrm")) {
      // Standalone .vrm file
      const name = basename(entry, ".vrm").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      avatars.push({
        id: entry,
        name,
        format: "vrm",
        path: `./models/${entry}`,
      });
    }
  }

  return avatars;
}

/**
 * Detect format from a model path.
 */
export function detectAvatarFormat(path: string): AvatarFormat {
  if (path.endsWith(".vrm")) return "vrm";
  if (path.endsWith(".model3.json")) return "live2d";
  return "live2d";
}
