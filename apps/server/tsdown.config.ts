import { defineConfig } from "tsdown";

// One self-contained file: the desktop app ships it without a node_modules tree.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: "esm",
  platform: "node",
  outDir: "dist",
  fixedExtension: true,
  dts: false,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  copy: [{ from: "../web/dist/**/*", to: "dist/client", flatten: false }],
});
