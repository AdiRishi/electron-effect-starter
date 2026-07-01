import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Bundle the workspace packages into the single-file CLI so the packaged
// `dist/bin.mjs` has no runtime dependency on the monorepo layout.
const bundledPackagePrefixes = ["@app/"];

export function shouldBundleCliDependency(id: string): boolean {
  return bundledPackagePrefixes.some((prefix) => id.startsWith(prefix));
}

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    format: "esm",
    sourcemap: true,
    clean: true,
    deps: {
      alwaysBundle: shouldBundleCliDependency,
      onlyBundle: false,
    },
    banner: {
      js: "#!/usr/bin/env node\n",
    },
  },
});
