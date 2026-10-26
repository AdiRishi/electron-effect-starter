// @effect-diagnostics nodeBuiltinImport:off -- Build config runs in plain Node, outside any Effect runtime.
import * as NodeFSP from "node:fs/promises";

import { defineConfig } from "tsdown";

const WEB_DIST = new URL("../web/dist", import.meta.url);
const CLIENT_DIR = new URL("./dist/client", import.meta.url);

// One self-contained file: the desktop app ships it without a node_modules tree.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: "esm",
  platform: "node",
  // The packaged desktop app runs the server on Electron's bundled Node 24.
  target: "node24",
  outDir: "dist",
  fixedExtension: true,
  dts: false,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  hooks: {
    // The web build, including its .vite manifest, is served from dist/client.
    "build:done": async () => {
      await NodeFSP.rm(CLIENT_DIR, { recursive: true, force: true });
      await NodeFSP.cp(WEB_DIST, CLIENT_DIR, { recursive: true });
    },
  },
});
