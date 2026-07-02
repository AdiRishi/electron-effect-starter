import { builtinModules } from "node:module";

import { defineConfig } from "vite";

// Bundle every non-Node dependency into the single-file CLI so the packaged
// `dist/bin.mjs` has no runtime dependency on the monorepo layout.
const nodeBuiltinIds = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

function isExternalCliDependency(id: string): boolean {
  return nodeBuiltinIds.has(id);
}

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: "src/bin.ts",
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    minify: false,
    // The bundle's floor is Electron's bundled Node (v20.18) — the shell spawns
    // dist/bin.mjs via ELECTRON_RUN_AS_NODE — even though dev runs on Node 22+.
    target: "node20",
    rollupOptions: {
      external: isExternalCliDependency,
      output: {
        banner: "#!/usr/bin/env node\n",
        entryFileNames: "[name].mjs",
      },
    },
  },
});
