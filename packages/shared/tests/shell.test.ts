import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as HostProcess from "../src/HostProcess.ts";
import {
  CommandResolutionCache,
  npmShimExecutable,
  preferGitForWindowsBinary,
  resolveSpawnCommand,
  SpawnExecutableResolution,
  XcodeGitLocation,
} from "../src/shell.ts";

describe("preferGitForWindowsBinary", () => {
  const files =
    (...paths: Array<string>) =>
    (filePath: string) =>
      paths.includes(filePath);

  it("runs the git.exe Git for Windows' launcher would start", () => {
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.EXE",
        {},
        files(
          "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe",
          "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
        ),
      ),
    ).toBe("C:\\Program Files\\Git\\ucrt64\\bin\\git.exe");
    expect(
      preferGitForWindowsBinary(
        "D:\\PortableGit\\bin\\git.exe",
        {},
        files("D:\\PortableGit\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("D:\\PortableGit\\mingw64\\bin\\git.exe");
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        {},
        files("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe");
  });

  it("keeps the launcher when MSYSTEM is set", () => {
    // git.exe adds hook dependencies to PATH only when MSYSTEM is unset.
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        { MSYSTEM: "MINGW64" },
        files("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("leaves other gits and other launchers alone", () => {
    const everything = () => true;
    expect(preferGitForWindowsBinary("C:\\Users\\me\\scoop\\shims\\git.exe", {}, everything)).toBe(
      "C:\\Users\\me\\scoop\\shims\\git.exe",
    );
    expect(preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\gitk.exe", {}, everything)).toBe(
      "C:\\Program Files\\Git\\cmd\\gitk.exe",
    );
  });
});

// Byte for byte what `npm install -g opencode-ai` writes as `opencode.cmd`.
const NPM_OPENCODE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  "",
].join("\r\n");

describe("npmShimExecutable", () => {
  const shimPath = "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd";

  const executable =
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";

  const exists = (filePath: string) => filePath === executable;

  it("finds the executable npm's shim runs", () => {
    expect(npmShimExecutable(shimPath, () => NPM_OPENCODE_SHIM, exists)).toBe(executable);
    expect(
      npmShimExecutable(shimPath.replace(".cmd", ".CMD"), () => NPM_OPENCODE_SHIM, exists),
    ).toBe(executable);
  });

  it("keeps a shim that does more than run the executable", () => {
    const withSetting = NPM_OPENCODE_SHIM.replace(
      "SETLOCAL",
      "SETLOCAL\r\nSET OPENCODE_CONFIG=C:\\x",
    );

    expect(npmShimExecutable(shimPath, () => withSetting, exists)).toBeUndefined();

    const nodeScript = NPM_OPENCODE_SHIM.replace(
      '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      '"%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
    );

    expect(
      npmShimExecutable(
        shimPath,
        () => nodeScript,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("keeps a shim CMD would read differently", () => {
    // CMD preserves trailing SET whitespace, changing the executable path.
    for (const suffix of ["\u00a0", "\t", " "]) {
      const altered = NPM_OPENCODE_SHIM.replace("SET dp0=%~dp0", `SET dp0=%~dp0${suffix}`);
      expect(
        npmShimExecutable(
          shimPath,
          () => altered,
          () => true,
        ),
      ).toBeUndefined();
    }

    const nonBreakingSeparator = NPM_OPENCODE_SHIM.replace(
      'opencode.exe"   %*',
      'opencode.exe"\u00a0%*',
    );

    expect(
      npmShimExecutable(
        shimPath,
        () => nonBreakingSeparator,
        () => true,
      ),
    ).toBeUndefined();
    const indented = NPM_OPENCODE_SHIM.replace("SETLOCAL", "  SETLOCAL");
    expect(
      npmShimExecutable(
        shimPath,
        () => indented,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("keeps the shim when its executable is missing or it is not a .cmd", () => {
    expect(
      npmShimExecutable(
        shimPath,
        () => NPM_OPENCODE_SHIM,
        () => false,
      ),
    ).toBeUndefined();
    expect(
      npmShimExecutable(
        shimPath,
        () => undefined,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      npmShimExecutable(
        shimPath.replace(".cmd", ".bat"),
        () => NPM_OPENCODE_SHIM,
        () => true,
      ),
    ).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("resolveSpawnCommand", (it) => {
  it.effect("runs Windows executables directly without a shell", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("node.exe", ["script.js", "hello & goodbye"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
      );

      expect(command).toEqual({
        command: "node.exe",
        args: ["script.js", "hello & goodbye"],
        shell: false,
      });
    }),
  );

  it.effect.runIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs the executable behind an npm shim directly when asked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const prefix = yield* fs.makeTempDirectoryScoped({ prefix: "app-npm-shim-" });
          const shim = path.join(prefix, "opencode.cmd");

          const executable = path.join(
            prefix,
            "node_modules",
            "opencode-ai",
            "bin",
            "opencode.exe",
          );

          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "");
          yield* fs.writeFileString(shim, NPM_OPENCODE_SHIM);

          const resolve = (bypassNpmShim: boolean) =>
            resolveSpawnCommand("opencode", ["serve", "--port=4096"], {
              env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
              bypassNpmShim,
            }).pipe(
              Effect.provideService(HostProcess.Platform, "win32"),
              Effect.provideService(CommandResolutionCache, new Map()),
              Effect.provideService(SpawnExecutableResolution, () => shim),
            );

          expect(yield* resolve(true)).toEqual({
            command: executable,
            args: ["serve", "--port=4096"],
            shell: false,
          });
          expect((yield* resolve(false)).shell).toBe(true);
        }),
      ),
  );

  it.effect("builds one escaped cmd.exe line for Windows command shims", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand(
        "vp",
        [
          "run",
          "value & calc",
          "%PATH%",
          'quote"value',
          "C:\\dir with space\\",
          'slash\\"quote',
          "x|y<z>^",
        ],
        { env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" } },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(
          SpawnExecutableResolution,
          () => "C:\\Program Files\\npm & tools\\vp.cmd",
        ),
      );

      // No args alongside `shell: true`: Node prints DEP0190 for that pairing.
      expect(command).toEqual({
        command: [
          String.raw`^"C:\Program^ Files\npm^ ^&^ tools\vp.cmd^"`,
          String.raw`^"run^"`,
          String.raw`^"value^ ^&^ calc^"`,
          String.raw`^"^%PATH^%^"`,
          String.raw`^"quote\^"value^"`,
          String.raw`^"C:\dir^ with^ space\\^"`,
          String.raw`^"slash\\\^"quote^"`,
          String.raw`^"x^|y^<z^>^^^"`,
        ].join(" "),
        args: [],
        shell: true,
      });
    }),
  );

  it.effect("resolves against the effective environment when extending host env", () =>
    Effect.gen(function* () {
      let resolvedEnvironment: NodeJS.ProcessEnv | undefined;
      yield* resolveSpawnCommand("codex", ["app-server"], {
        env: { CODEX_HOME: "C:\\Users\\tester\\.codex" },
        extendEnv: true,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(HostProcess.Environment, {
          PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        }),
        Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
          resolvedEnvironment = env;

          return "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
        }),
      );

      expect(resolvedEnvironment).toEqual({
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        CODEX_HOME: "C:\\Users\\tester\\.codex",
      });
    }),
  );

  describe("macOS git", () => {
    // Files that exist, the git first on PATH, and what `xcrun --find git` prints.
    const setup = (options: {
      readonly platform?: NodeJS.Platform;
      readonly gitOnPath: string;
      readonly xcrunGit: string | undefined;
    }) => {
      const files = new Set([options.gitOnPath, ...(options.xcrunGit ? [options.xcrunGit] : [])]);
      const host = { xcrunGit: options.xcrunGit, xcrunCalls: 0 };

      const resolve = resolveSpawnCommand("git", ["status"], { env: { PATH: "/fake/bin" } }).pipe(
        Effect.map((resolved) => resolved.command),
        Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          command === "git" ? options.gitOnPath : files.has(command) ? command : undefined,
        ),
        Effect.provideService(XcodeGitLocation, () => {
          host.xcrunCalls += 1;

          return host.xcrunGit;
        }),
      );

      return { files, host, resolve };
    };

    const XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";

    it.effect("runs the git behind the xcrun shim and looks it up once", () =>
      Effect.gen(function* () {
        const { host, resolve } = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* resolve).toBe(XCODE_GIT);
        expect(yield* resolve).toBe(XCODE_GIT);
        expect(host.xcrunCalls).toBe(1);
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("keeps git when PATH has another git or the host is not macOS", () =>
      Effect.gen(function* () {
        const homebrew = setup({ gitOnPath: "/opt/homebrew/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* homebrew.resolve).toBe("git");
        expect(homebrew.host.xcrunCalls).toBe(0);

        const linux = setup({ platform: "linux", gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* linux.resolve).toBe("git");
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("keeps git when xcrun fails or names a missing file", () =>
      Effect.gen(function* () {
        const failed = setup({ gitOnPath: "/usr/bin/git", xcrunGit: undefined });
        expect(yield* failed.resolve).toBe("git");

        const missing = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        missing.files.delete(XCODE_GIT);
        expect(yield* missing.resolve).toBe("git");
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("looks again when the resolved git disappears", () =>
      Effect.gen(function* () {
        const betaGit = "/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git";
        const { files, host, resolve } = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* resolve).toBe(XCODE_GIT);

        files.delete(XCODE_GIT);
        files.add(betaGit);
        host.xcrunGit = betaGit;
        expect(yield* resolve).toBe(betaGit);
        expect(host.xcrunCalls).toBe(2);
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );
  });

  it.effect("does not fall back to a shell for unresolved Windows commands", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("missing & calc", ["unsafe & value"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
      );

      expect(command).toEqual({
        command: "missing & calc",
        args: ["unsafe & value"],
        shell: false,
      });
    }),
  );
});
