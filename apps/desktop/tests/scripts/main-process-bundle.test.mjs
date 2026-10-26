import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { build } from "tsdown";
import { assert, it } from "vitest";

import desktopConfig from "../../tsdown.config.ts";

it("loads the emitted packaged boot entry and backend cache preload", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "desktop-boot-"));

  try {
    const entries = ["src/boot.ts", "src/compileCache.ts"];
    await NodeFSP.mkdir(NodePath.join(directory, "src"));
    await Promise.all(
      entries.map((entry) =>
        NodeFSP.copyFile(
          new URL(`../../${entry}`, import.meta.url),
          NodePath.join(directory, entry),
        ),
      ),
    );

    assert.ok(Array.isArray(desktopConfig));

    for (const packConfig of desktopConfig) {
      if (!Array.isArray(packConfig.entry)) continue;

      if (!packConfig.entry.some((entry) => entries.includes(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }

    const outputDirectory = NodePath.join(directory, "dist-electron");
    const fixture = `console.log(require('node:module').getCompileCacheDir() ? 'cached' : 'uncached');`;
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "main.cjs"), fixture);
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "backend.mjs"),
      `import { getCompileCacheDir } from 'node:module'; console.log(getCompileCacheDir() ? 'cached' : 'uncached');`,
    );

    for (const disabled of [false, true]) {
      for (const args of [
        [NodePath.join(outputDirectory, "boot.cjs")],
        [
          "--require",
          NodePath.join(outputDirectory, "compileCache.cjs"),
          NodePath.join(outputDirectory, "backend.mjs"),
        ],
      ]) {
        const child = NodeChildProcess.spawnSync(process.execPath, args, {
          encoding: "utf8",
          env: {
            ...process.env,
            APPIMAGE: "",
            NODE_COMPILE_CACHE: undefined,
            NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
            XDG_CACHE_HOME: directory,
            TMPDIR: directory,
            TEMP: directory,
            TMP: directory,
          },
        });

        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout.trim(), disabled ? "uncached" : "cached");
      }
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
