import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "repos/**",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "dist",
    "dist-electron",
    "release",
    "node_modules",
    "pnpm-lock.yaml",
    "*.tsbuildinfo",
    "**/routeTree.gen.ts",
    "tooling/oxlint-plugin-anti-slop/**",
  ],
  sortPackageJson: {},
});
