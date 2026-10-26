import { defineConfig } from "tsdown";

const isElectron = (id: string) => id === "electron" || id.startsWith("electron/");
const launchAfterBuild = process.env.APP_DESKTOP_DEV === "1";

const common = {
  format: "cjs",
  platform: "node",
  outDir: "dist-electron",
  dts: false,
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  // Effect reads import.meta.env when bundled for Vite; in CommonJS it is an empty object, as intended.
  inputOptions: { checks: { emptyImportMeta: false } },
} as const;

export default defineConfig([
  {
    ...common,
    entry: ["src/main.ts"],
    clean: true,
    // Electron's Node runs the main process, so everything but Electron itself is bundled.
    outputOptions: { codeSplitting: false },
    deps: {
      alwaysBundle: (id) => !id.startsWith("node:") && !isElectron(id),
      neverBundle: isElectron,
      onlyBundle: false,
    },
    ...(launchAfterBuild ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
  },
  {
    // boot.cjs requires the other two at runtime, so all three stay separate files.
    ...common,
    entry: ["src/boot.ts", "src/compileCache.ts"],
    clean: false,
    deps: { neverBundle: (id) => id === "./main.cjs" || id === "./compileCache.cjs" },
  },
  {
    // Sandboxed preloads cannot require from the app bundle, so the preload is self-contained.
    ...common,
    entry: ["src/preload.ts"],
    clean: false,
    outputOptions: { codeSplitting: false },
    deps: { neverBundle: isElectron, onlyBundle: false },
  },
]);
