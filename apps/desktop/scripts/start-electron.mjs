import * as NodeChildProcess from "node:child_process";

import { desktopDir, electronEnv, electronPath } from "./electron.mjs";

const child = NodeChildProcess.spawn(electronPath, ["."], {
  stdio: "inherit",
  cwd: desktopDir,
  env: electronEnv(),
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);

    return;
  }

  process.exit(code ?? 0);
});
