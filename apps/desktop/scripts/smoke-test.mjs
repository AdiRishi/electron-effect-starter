import * as NodeChildProcess from "node:child_process";

import { desktopDir, electronEnv, electronPath } from "./electron.mjs";

// Launches the packaged entry point against the built server and web app, and fails on the
// errors a broken bundle produces at startup.
console.log("\nLaunching Electron smoke test...");

const child = NodeChildProcess.spawn(electronPath, ["."], {
  cwd: desktopDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: electronEnv({ VITE_DEV_SERVER_URL: "", ELECTRON_ENABLE_LOGGING: "1" }),
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);

child.on("exit", () => {
  clearTimeout(timeout);
  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
    "fatal startup error",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));
  if (!output.includes("server ready")) failures.push("the server never became ready");
  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) console.error(` - ${failure}`);
    console.error(`\nFull output:\n${output}`);
    process.exit(1);
  }
  console.log("Desktop smoke test passed.");
  process.exit(0);
});
