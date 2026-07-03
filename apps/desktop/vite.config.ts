import * as NodeModule from "node:module";

import { defineConfig, type ConfigEnv, type UserConfig } from "vite";

// Two CJS entries bundled into `dist-electron`: the Electron main process and
// the sandboxed preload. Electron's main + preload must be CommonJS (`.cjs`);
// the renderer (apps/web) is built separately as ESM.
//
// CRITICAL: Effect 4 (`effect`, `@effect/*`) is ESM-only, and a CJS module
// cannot `require()` an ESM one (ERR_REQUIRE_ESM). So we must BUNDLE those deps
// into the `.cjs` output rather than leave them as runtime requires. We keep
// only the Electron-runtime modules external: `electron` is injected by the
// runtime, and `electron-updater` is CJS with dynamic requires that don't
// bundle cleanly.
function isExternalRuntimeModule(id: string): boolean {
  return (
    id === "electron" ||
    id.startsWith("electron/") ||
    id === "electron-updater" ||
    id.startsWith("electron-updater/")
  );
}

function shouldBundle(id: string): boolean {
  return !nodeBuiltinIds.has(id) && !isExternalRuntimeModule(id);
}

const nodeBuiltinIds = new Set([
  ...NodeModule.builtinModules,
  ...NodeModule.builtinModules.map((moduleName) => `node:${moduleName}`),
]);

function electronEntryConfig(input: {
  readonly entryName: "main" | "preload";
  readonly entry: string;
  readonly emptyOutDir: boolean;
}): UserConfig {
  return {
    build: {
      lib: {
        entry: input.entry,
        formats: ["cjs"],
        fileName: () => `${input.entryName}.cjs`,
      },
      outDir: "dist-electron",
      sourcemap: true,
      emptyOutDir: input.emptyOutDir,
      minify: false,
      target: "node20",
      rollupOptions: {
        external: (id) => !shouldBundle(id),
      },
    },
  };
}

export default defineConfig((env: ConfigEnv) =>
  env.mode === "preload"
    ? electronEntryConfig({
        entryName: "preload",
        entry: "src/preload.ts",
        emptyOutDir: false,
      })
    : electronEntryConfig({
        entryName: "main",
        entry: "src/main.ts",
        emptyOutDir: true,
      }),
);
