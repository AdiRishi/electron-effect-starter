// Stages the output of `pnpm build` and packages it with electron-builder. `--publish` uploads to
// GitHub Releases. macOS signing turns on when CSC_LINK and the APPLE_API_* variables are set, and
// auto-update metadata is embedded only when GITHUB_REPOSITORY (owner/name) is set.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { build, type Configuration } from "electron-builder";

import desktopPackage from "../../apps/desktop/package.json" with { type: "json" };

const APP_ID = "com.example.electron-effect-starter";
const ARTIFACT_NAME = "electron-effect-starter";

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
    mac: {
      target: ["dmg", "zip"],
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      notarize: signed,
    },
    win: { target: ["nsis"] },
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
