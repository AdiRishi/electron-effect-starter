import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "repos/**",
    "dist",
    "dist-electron",
    "release",
    "node_modules",
    "pnpm-lock.yaml",
    "*.tsbuildinfo",
    "**/routeTree.gen.ts",
  ],
  sortPackageJson: {},
});
