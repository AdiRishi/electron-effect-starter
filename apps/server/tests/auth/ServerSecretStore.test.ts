import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";

import * as ServerSecretStore from "../../src/auth/ServerSecretStore.ts";
import * as ServerConfig from "../../src/config.ts";

const SECRET = "session-signing-key";

// The disk is real; a failing or racing disk is the real one with a method replaced.
const layerFileSystem = (
  override: (fileSystem: FileSystem.FileSystem) => Effect.Effect<Partial<FileSystem.FileSystem>>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      return { ...fileSystem, ...(yield* override(fileSystem)) } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(NodeServices.layer));

const layerStore = (fileSystem: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer) =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest()),
    Layer.provideMerge(fileSystem),
    Layer.provideMerge(NodeServices.layer),
  );

const permissionDenied = (method: string, path: string) =>
  PlatformError.systemError({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError takes the reason tag as input.
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

const readSecretFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secretsDir } = yield* ServerConfig.ServerConfig;

  return Array.from(yield* fileSystem.readFile(path.join(secretsDir, `${SECRET}.bin`)));
});

const reasonOf = (cause: unknown) =>
  cause instanceof PlatformError.PlatformError ? cause.reason._tag : undefined;

describe("ServerSecretStore", () => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const first = yield* secrets.getOrCreateRandom(SECRET, 32);
      const second = yield* secrets.getOrCreateRandom(SECRET, 32);

      assert.deepStrictEqual(Array.from(second), Array.from(first));
      assert.deepStrictEqual(yield* readSecretFile, Array.from(first));
    }).pipe(Effect.provide(layerStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [secrets.getOrCreateRandom(SECRET, 32), secrets.getOrCreateRandom(SECRET, 32)],
        { concurrency: "unbounded" },
      );

      const persisted = yield* readSecretFile;

      assert.deepStrictEqual(Array.from(first), persisted);
      assert.deepStrictEqual(Array.from(second), persisted);
    }).pipe(
      Effect.provide(
        // Both creators miss the file before either writes it, so both try to create it.
        layerStore(
          layerFileSystem((fileSystem) =>
            Effect.gen(function* () {
              const reads = yield* Ref.make(0);
              const bothMissed = yield* Deferred.make<void>();

              return {
                readFile: (path) =>
                  path.endsWith(`${SECRET}.bin`)
                    ? Effect.gen(function* () {
                        const read = yield* Ref.updateAndGet(reads, (count) => count + 1);

                        if (read > 2) return yield* fileSystem.readFile(path);

                        if (read === 2) yield* Deferred.succeed(bothMissed, undefined);
                        yield* Deferred.await(bothMissed);

                        return yield* PlatformError.systemError({
                          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError takes the reason tag as input.
                          _tag: "NotFound",
                          module: "FileSystem",
                          method: "readFile",
                          pathOrDescriptor: path,
                        });
                      })
                    : fileSystem.readFile(path),
              };
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("propagates read failures other than a missing file", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const error = yield* Effect.flip(secrets.getOrCreateRandom(SECRET, 32));

      assert.strictEqual(error.operation, "read");
      assert.strictEqual(reasonOf(error.cause), "PermissionDenied");
    }).pipe(
      Effect.provide(
        layerStore(
          layerFileSystem(() =>
            Effect.succeed({
              readFile: (path: string) => Effect.fail(permissionDenied("readFile", path)),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const error = yield* Effect.flip(secrets.getOrCreateRandom(SECRET, 32));

      assert.strictEqual(error.operation, "persist");
      assert.strictEqual(reasonOf(error.cause), "PermissionDenied");
    }).pipe(
      Effect.provide(
        layerStore(
          layerFileSystem(() =>
            Effect.succeed({
              link: (from: string, to: string) =>
                Effect.fail(permissionDenied("link", `${from} -> ${to}`)),
            }),
          ),
        ),
      ),
    ),
  );
});
