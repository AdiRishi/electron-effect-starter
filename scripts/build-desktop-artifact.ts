#!/usr/bin/env node
// Package the desktop app into a distributable (dmg / nsis / AppImage).
//
// Pipeline: build web -> build server -> build desktop -> stage an app dir ->
// run electron-builder. The packaged app runs the SAME local-server + web
// bundle the dev flow does; the shell spawns `apps/server/dist/bin.mjs` and
// the server serves the web build from its `dist/client`.
//
// This is the one piece the starter ships as a *skeleton*: signing, icons,
// notarization, and per-OS targets always need project-specific values. It is
// intentionally small and honest rather than a 1000-line clone. Run:
//   pnpm dist:desktop -- --platform mac --target dmg
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const APP_ID = "com.example.electron-effect-starter";
const PRODUCT_NAME = "Electron Effect Starter";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] !== undefined
    ? (process.argv[index + 1] as string)
    : fallback;
}

const platform = arg(
  "platform",
  process.platform === "win32" ? "win" : process.platform === "linux" ? "linux" : "mac",
);
const target = arg("target", platform === "mac" ? "dmg" : platform === "win" ? "nsis" : "AppImage");

function sh(command: string): void {
  process.stdout.write(`\n$ ${command}\n`);
  NodeChildProcess.execSync(command, { cwd: REPO_ROOT, stdio: "inherit" });
}

function main(): void {
  // 1. Build all three packages (order matters: the server serves the web build).
  sh("pnpm --filter @app/web build");
  sh("pnpm --filter @app/server build");
  sh("pnpm --filter @app/desktop build");

  // 2. Stage an app directory electron-builder will pack.
  const stage = NodePath.join(REPO_ROOT, "release/app");
  NodeFS.rmSync(stage, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(stage, "apps/server/dist"), {
    recursive: true,
  });

  const copy = (from: string, to: string) =>
    NodeFS.cpSync(NodePath.join(REPO_ROOT, from), NodePath.join(stage, to), {
      recursive: true,
    });
  copy("apps/desktop/dist-electron", "dist-electron");
  copy("apps/server/dist", "apps/server/dist");
  copy("apps/web/dist", "apps/server/dist/client");

  // Minimal package.json for the packaged app (main = built Electron entry).
  NodeFS.writeFileSync(
    NodePath.join(stage, "package.json"),
    JSON.stringify(
      {
        name: "electron-effect-starter",
        version: "0.0.0",
        main: "dist-electron/main.cjs",
      },
      null,
      2,
    ),
  );

  // 3. electron-builder config. `asarUnpack` keeps the server bundle spawnable
  //    (a child process can't be launched from inside the asar archive).
  const config = {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    directories: { app: "release/app", output: "release/dist" },
    files: ["**/*"],
    asarUnpack: ["apps/server/**"],
    mac: { target: [target], category: "public.app-category.developer-tools" },
    win: { target: [target] },
    linux: { target: [target], category: "Development" },
    // TODO(you): add `icon`, code-signing (`mac.identity` / `win.certificateFile`),
    // and notarization (`afterSign`) for real releases.
  };
  const configPath = NodePath.join(REPO_ROOT, "release/electron-builder.json");
  NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
  NodeFS.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // 4. Pack. Requires `electron-builder` (a devDependency of @app/desktop).
  sh(`pnpm --filter @app/desktop exec electron-builder --${platform} --config ${configPath}`);
  process.stdout.write(`\n✔ Artifacts in release/dist\n`);
}

main();
