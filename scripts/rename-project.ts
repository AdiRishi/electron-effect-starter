#!/usr/bin/env node
// Rename this project from "electron-effect-starter" to your own name.
//
// The project name appears in exactly three shapes across the repo:
//   kebab   "electron-effect-starter"             package name, ~/.<name> data dir
//   title   "Electron Effect Starter"             product name, CLI docs, HTML title
//   app id  "com.example.electron-effect-starter" electron-builder appId
//
// This script sweeps every git-tracked text file and replaces all three
// (app id first, since it contains the kebab name). It also rewrites its
// own OLD_* constants below, so it stays re-runnable after a rename.
//
// Usage:
//   pnpm rename                        # interactive
//   pnpm rename my-app com.mycompany   # name + app id prefix (both required)
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const OLD_KEBAB = "electron-effect-starter";
const OLD_TITLE = "Electron Effect Starter";
const OLD_APP_ID = "com.example.electron-effect-starter";

/** "my-cool-app" -> "My Cool App" */
export function toTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function isKebabCase(name: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name);
}

/** Reverse-DNS prefix, e.g. "com.mycompany" — at least two lowercase segments. */
export function isReverseDns(prefix: string): boolean {
  return /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(prefix);
}

function ask(question: string): Promise<string> {
  const rl = NodeReadline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  let kebab = process.argv[2];
  let appIdPrefix = process.argv[3];

  if (!kebab) {
    kebab = await ask("Project name (kebab-case, e.g. my-cool-app)");
  }
  if (!kebab || !isKebabCase(kebab)) {
    console.error(`Error: project name must be kebab-case (got "${kebab ?? ""}").`);
    process.exit(1);
  }
  if (!appIdPrefix) {
    appIdPrefix = await ask("App id prefix (reverse-DNS, e.g. com.mycompany)");
  }
  if (!appIdPrefix || !isReverseDns(appIdPrefix)) {
    console.error(`Error: app id prefix must be reverse-DNS (got "${appIdPrefix ?? ""}").`);
    process.exit(1);
  }

  const title = toTitle(kebab);
  const appId = `${appIdPrefix}.${kebab}`;

  console.log("\nRenaming project:\n");
  console.log(`  name          ${OLD_KEBAB} -> ${kebab}`);
  console.log(`  product name  ${OLD_TITLE} -> ${title}`);
  console.log(`  app id        ${OLD_APP_ID} -> ${appId}`);
  console.log(`  app data dir  ~/.${OLD_KEBAB} -> ~/.${kebab}`);
  console.log();

  const trackedFiles = NodeChildProcess.execSync("git ls-files", {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .split("\n")
    .filter((file) => file !== "" && file !== "pnpm-lock.yaml");

  for (const file of trackedFiles) {
    const absolute = NodePath.join(REPO_ROOT, file);
    const before = NodeFS.readFileSync(absolute, "utf-8");
    // Order matters: the app id contains the kebab name.
    const after = before
      .replaceAll(OLD_APP_ID, appId)
      .replaceAll(OLD_KEBAB, kebab)
      .replaceAll(OLD_TITLE, title);
    if (after !== before) {
      NodeFS.writeFileSync(absolute, after);
      console.log(`  ✓ ${file}`);
    }
  }

  console.log("\nDone! You may also want to:");
  console.log("  • Rewrite the README intro for your project");
  console.log("  • Run `pnpm check && pnpm test` to verify everything still passes");
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  await main();
}
