// @ts-nocheck
export default {
  app: {
    name: "Albedo AI",
    identifier: "ai.albedo.app",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      external: ["@grpc/grpc-js", "@grpc/proto-loader"],
    },
    views: {
      mainview: {
        entrypoint: "src/views/mainview/main.tsx",
        target: "browser",
      },
    },
    copy: {
      "src/views/mainview/index.html": "views/mainview/index.html",
      "proto/audio.proto": "proto/audio.proto",
      "proto/daemon.proto": "proto/daemon.proto",
    },
    buildFolder: ".electrobun/build",
  },
}
