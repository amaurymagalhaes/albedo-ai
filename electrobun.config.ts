// @ts-nocheck
export default {
  app: {
    name: "Albedo AI",
    identifier: "ai.albedo.app",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: false,
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
      settings: {
        entrypoint: "src/views/settings/main.tsx",
        target: "browser",
      },
    },
    copy: {
      "src/views/mainview/index.html": "views/mainview/index.html",
      "src/views/settings/index.html": "views/settings/index.html",
      "proto/audio.proto": "proto/audio.proto",
      "proto/daemon.proto": "proto/daemon.proto",
      "assets/models": "views/mainview/models",
      "assets/lib/live2dcubismcore.min.js": "views/mainview/live2dcubismcore.min.js",
    },
    buildFolder: ".electrobun/build",
    linux: {
      // Switch from WebKitGTK to CEF (Chromium Embedded Framework) to
      // escape WebKit's transparent-window ghosting bug. CEF uses Chromium's
      // renderer which doesn't have this issue.
      bundleCEF: true,
      defaultRenderer: "cef",
      // Electrobun's CEF defaults include --disable-gpu, which kills WebGL.
      // Pixi.js needs WebGL for the Live2D avatar — re-enable GPU.
      chromiumFlags: {
        "disable-gpu": false,
        "ignore-gpu-blocklist": true,
        "enable-gpu-rasterization": true,
        "enable-webgl": true,
      },
    },
  },
}
