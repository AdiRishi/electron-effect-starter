import { defineConfig } from "vite-plus";

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
  return !id.startsWith("node:") && !isExternalRuntimeModule(id);
}

const commonPack = {
  format: "cjs",
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  deps: { alwaysBundle: shouldBundle },
} as const;

export default defineConfig({
  pack: [
    { ...commonPack, entry: ["src/main.ts"], clean: true },
    { ...commonPack, entry: ["src/preload.ts"] },
  ],
});
