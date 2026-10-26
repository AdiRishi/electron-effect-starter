// Stages the output of `pnpm build` and packages it with electron-builder. `--publish` uploads to
// GitHub Releases. macOS signing turns on when CSC_LINK and the APPLE_API_* variables are set, and
// auto-update metadata is embedded only when GITHUB_REPOSITORY (owner/name) is set.
import * as NodeModule from "node:module";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { build, type Configuration } from "electron-builder";

import desktopPackage from "../../apps/desktop/package.json" with { type: "json" };

const APP_ID = "com.example.electron-effect-starter";
const ARTIFACT_NAME = "electron-effect-starter";
const BUNDLE_SELF_CHECK_TIMEOUT = Duration.seconds(120);
const ELECTRON_LANGUAGES = ["en-US"] as const;

const REQUIRED_BUILD_OUTPUTS = [
  "apps/desktop/dist-electron/boot.cjs",
  "apps/desktop/dist-electron/main.cjs",
  "apps/desktop/dist-electron/preload.cjs",
  "apps/server/dist/bin.mjs",
  "apps/server/dist/client/index.html",
] as const;

class MissingBuildOutputError extends Schema.TaggedError<MissingBuildOutputError>()(
  "MissingBuildOutputError",
  { output: Schema.String },
) {
  override get message(): string {
    return `Missing ${this.output}. Run \`pnpm build\` before packaging.`;
  }
}

class BundleNotSelfContainedError extends Schema.TaggedError<BundleNotSelfContainedError>()(
  "BundleNotSelfContainedError",
  { exitCode: Schema.Number, output: Schema.String },
) {
  override get message(): string {
    return `The packaged server bundle could not load from an isolated copy of the app (exit ${this.exitCode}). It imports something that is neither a Node built-in nor in the bundle. Output:
${this.output}`;
  }
}

class ElectronBuilderError extends Schema.TaggedError<ElectronBuilderError>()(
  "ElectronBuilderError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "electron-builder failed.";
  }
}

const decodeElectronPackage = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const encodeStagedPackage = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      productName: Schema.String,
      version: Schema.String,
      description: Schema.String,
      author: Schema.String,
      main: Schema.String,
    }),
    { space: 2 },
  ),
);

const ReleaseConfig = Config.all({
  cscLink: Config.String("CSC_LINK").pipe(Config.option),
  appleApiKey: Config.String("APPLE_API_KEY").pipe(Config.option),
  appleApiKeyId: Config.String("APPLE_API_KEY_ID").pipe(Config.option),
  appleApiIssuer: Config.String("APPLE_API_ISSUER").pipe(Config.option),
  githubRepository: Config.schema(
    Schema.TemplateLiteralParser([Schema.NonEmptyString, "/", Schema.NonEmptyString]),
    "GITHUB_REPOSITORY",
  ).pipe(Config.option),
});

const SIGNING_VARIABLES = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

function trimTrailingSeparators(value: string): string {
  let end = value.length;

  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;

  return value.slice(0, end);
}

/** Stop UNC ancestor walks at the share; a bare server is not a directory root. */
function uncShareRootLength(value: string): number {
  const isUnc = value.startsWith("\\\\") || value.startsWith("//");

  if (!isUnc) return 0;
  const separator = /[\\/]/;
  const serverEnd = value.slice(2).search(separator);

  if (serverEnd < 0) return value.length;
  const shareStart = 2 + serverEnd + 1;
  const shareEnd = value.slice(shareStart).search(separator);

  return shareEnd < 0 ? value.length : shareStart + shareEnd;
}

function ancestorNodeModulesPaths(startDir: string, separator: string): ReadonlyArray<string> {
  // Splitting/rebuilding can lose UNC or drive roots; preserve their prefixes with lastIndexOf.
  const paths: string[] = [];
  let current = trimTrailingSeparators(startDir);
  const uncRootLength = uncShareRootLength(current);

  for (;;) {
    const cut = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));

    if (cut < 0 || (uncRootLength > 0 && cut < uncRootLength)) break;
    const parent = cut === 0 ? current.slice(0, 1) : current.slice(0, cut);

    if (parent === current) break;
    paths.push(
      parent.endsWith(separator) ? `${parent}node_modules` : `${parent}${separator}node_modules`,
    );

    if (cut === 0) break;
    current = parent;
  }

  return paths;
}

// @electron/asar ships with electron-builder; resolve it through electron-builder's own dependencies.
const requireFromElectronBuilder = NodeModule.createRequire(
  import.meta.resolve("electron-builder"),
);

const requireFromAppBuilder = NodeModule.createRequire(
  requireFromElectronBuilder.resolve("app-builder-lib/package.json"),
);

const asar: { readonly extractAll: (archive: string, destination: string) => void } =
  requireFromAppBuilder("@electron/asar");

const collectOutput = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * Extracts the packaged app.asar into a temporary directory with no node_modules above it and runs
 * the server's --version there, so a bare import that only resolves in the repository fails the
 * build instead of the installed app.
 */
const verifyPackagedBundleIsSelfContained = Effect.fn("verifyPackagedBundleIsSelfContained")(
  function* (asarPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const probeRoot = yield* fs.makeTempDirectoryScoped({ prefix: `${ARTIFACT_NAME}-selfcheck-` });
    const probeApp = path.join(probeRoot, "app");

    yield* Effect.try({
      try: () => asar.extractAll(asarPath, probeApp),
      catch: (cause) =>
        new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Could not extract ${asarPath}: ${String(cause)}`,
        }),
    });

    // Ancestor node_modules could satisfy missing packaged dependencies and hide a broken stage.
    for (const candidate of ancestorNodeModulesPaths(probeApp, path.sep)) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return yield* new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Refusing to report success: ${candidate} is visible from the probe directory, so bare imports could resolve outside the packaged tree. Point TMPDIR somewhere without one.`,
        });
      }
    }

    const entryPoint = path.join(probeApp, "apps/server/dist/bin.mjs");

    if (!(yield* fs.exists(entryPoint).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new BundleNotSelfContainedError({
        exitCode: -1,
        output: `Expected the server entry at ${entryPoint}.`,
      });
    }

    const child = yield* spawner.spawn(
      // Clearing NODE_PATH leaves CommonJS global fallbacks; disable them so host packages cannot
      // satisfy missing dependencies.
      ChildProcess.make(process.execPath, ["--no-global-search-paths", entryPoint, "--version"], {
        cwd: probeApp,
        env: { NODE_PATH: "" },
        extendEnv: true,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collectOutput(child.stdout), collectOutput(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.timeoutOrElse({
        duration: BUNDLE_SELF_CHECK_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new BundleNotSelfContainedError({
              exitCode: -1,
              output: `The packaged bundle did not print its version within ${Duration.toSeconds(BUNDLE_SELF_CHECK_TIMEOUT)}s.`,
            }),
          ),
      }),
    );

    if (exitCode !== 0) {
      return yield* new BundleNotSelfContainedError({
        exitCode,
        output: `${stderr}${stdout}`.trim(),
      });
    }
  },
  Effect.scoped,
);

const program = Effect.gen(function* () {
  // CI passes an unset secret as an empty string, which electron-builder reads as a path.
  for (const name of SIGNING_VARIABLES) {
    if (process.env[name] === "") delete process.env[name];
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const release = yield* ReleaseConfig;
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const publish = process.argv.includes("--publish");

  for (const output of REQUIRED_BUILD_OUTPUTS) {
    if (!(yield* fs.exists(path.join(repoRoot, output)))) {
      return yield* new MissingBuildOutputError({ output });
    }
  }

  // The catalog pins Electron; read the installed version rather than the "catalog:" specifier.
  const { version: electronVersion } = yield* fs
    .readFileString(path.join(repoRoot, "apps/desktop/node_modules/electron/package.json"))
    .pipe(Effect.flatMap(decodeElectronPackage));

  const stageDir = yield* fs.makeTempDirectoryScoped({ prefix: `${ARTIFACT_NAME}-stage-` });

  const runPromise = Effect.runPromiseWith(
    yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >(),
  );

  // The shell and the server are self-contained bundles, so the staged app needs no node_modules.
  for (const directory of ["apps/desktop/dist-electron", "apps/server/dist"]) {
    yield* fs.copy(path.join(repoRoot, directory), path.join(stageDir, directory));
  }

  const stagedPackage = yield* encodeStagedPackage({
    name: ARTIFACT_NAME,
    productName: desktopPackage.productName,
    version: desktopPackage.version,
    description: desktopPackage.description,
    author: desktopPackage.productName,
    main: "apps/desktop/dist-electron/boot.cjs",
  });

  yield* fs.writeFileString(path.join(stageDir, "package.json"), `${stagedPackage}\n`);

  const signed = [
    release.cscLink,
    release.appleApiKey,
    release.appleApiKeyId,
    release.appleApiIssuer,
  ].every(Option.isSome);

  if (!signed) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

  const config: Configuration = {
    appId: APP_ID,
    productName: desktopPackage.productName,
    artifactName: `${ARTIFACT_NAME}-\${version}-\${os}-\${arch}.\${ext}`,
    electronVersion,
    directories: { output: path.join(repoRoot, "release"), buildResources: "build" },
    files: ["apps/**/*", "!**/*.map", "package.json"],
    asar: true,
    electronLanguages: [...ELECTRON_LANGUAGES],
    // Runs before installers are built or published, so a broken bundle never ships.
    afterPack: (context) =>
      runPromise(
        verifyPackagedBundleIsSelfContained(
          path.join(context.packager.getResourcesDir(context.appOutDir), "app.asar"),
        ),
      ),
    // Pin the static AppImage runtime so hosts with only FUSE 3 do not need libfuse2.
    toolsets: { appimage: "1.0.3" },
    mac: {
      target: ["dmg", "zip"],
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      notarize: signed,
    },
    win: { target: ["nsis"] },
    // Recreates a Start Menu shortcut, stamped with the AppUserModelId, that an update left missing.
    nsis: { include: path.join(repoRoot, "apps/desktop/resources/installer.nsh") },
    linux: { target: ["AppImage"], category: "Development" },
    publish: Option.match(release.githubRepository, {
      onNone: () => null,
      onSome: ([owner, , repo]) => ({ provider: "github", owner, repo }),
    }),
  };

  yield* Effect.tryPromise({
    try: () => build({ projectDir: stageDir, config, publish: publish ? "always" : "never" }),
    catch: (cause) => new ElectronBuilderError({ cause }),
  });
  yield* Effect.log(`Artifacts written to ${path.join(repoRoot, "release")}`);
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
