// @ts-nocheck
import { defineConfig } from "electrobun/config";

export default defineConfig({
  app: {
    name: "Albedo AI",
    identifier: "ai.albedo.app",
    version: "0.1.0",
  },
  main: "src/bun/index.ts",
  views: {
    mainview: "src/views/mainview/index.html",
  },
  build: {
    outDir: ".electrobun/build",
  },
});
