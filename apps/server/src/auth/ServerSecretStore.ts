import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export class SecretStoreError extends Schema.TaggedError<SecretStoreError>()("SecretStoreError", {
  secret: Schema.String,
  operation: Schema.Literals(["secure", "read", "generate", "persist"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} the ${this.secret} secret.`;
  }
}

/** Secrets that must survive restarts, such as the session signing key, kept as owner-only files. */
export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
  }
>()("@app/server/auth/ServerSecretStore") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secretsDir } = yield* ServerConfig.ServerConfig;

  yield* fs.makeDirectory(secretsDir, { recursive: true });
  yield* fs
    .chmod(secretsDir, 0o700)
    .pipe(
      Effect.mapError(
        (cause) => new SecretStoreError({ secret: "directory", operation: "secure", cause }),
      ),
    );

  const secretPath = (name: string) => path.join(secretsDir, `${name}.bin`);

  const read = (name: string) =>
    fs.readFile(secretPath(name)).pipe(
      Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError((cause) => new SecretStoreError({ secret: name, operation: "read", cause })),
    );

  // `link` publishes the fully written temp file under the final name or fails with AlreadyExists,
  // so a concurrent reader never sees a partial secret and two creators agree on one value.
  const create = Effect.fn("ServerSecretStore.create")(function* (name: string, value: Uint8Array) {
    const finalPath = secretPath(name);

    const uuid = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new SecretStoreError({ secret: name, operation: "generate", cause }),
        ),
      );

    const tempPath = `${finalPath}.${uuid}.tmp`;

    return yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(tempPath, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(value);
          yield* file.sync;
        }),
      );
      yield* fs.link(tempPath, finalPath);

      return true;
    }).pipe(
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      Effect.mapError(
        (cause) => new SecretStoreError({ secret: name, operation: "persist", cause }),
      ),
      Effect.ensuring(fs.remove(tempPath).pipe(Effect.ignore)),
    );
  });

  const getOrCreateRandom = Effect.fn("ServerSecretStore.getOrCreateRandom")(function* (
    name: string,
    bytes: number,
  ) {
    const existing = yield* read(name);

    if (Option.isSome(existing)) return existing.value;

    const generated = yield* crypto
      .randomBytes(bytes)
      .pipe(
        Effect.mapError(
          (cause) => new SecretStoreError({ secret: name, operation: "generate", cause }),
        ),
      );

    if (yield* create(name, generated)) return Uint8Array.from(generated);
    const winner = yield* read(name);

    if (Option.isSome(winner)) return winner.value;

    return yield* new SecretStoreError({
      secret: name,
      operation: "read",
      cause: "The secret vanished after a concurrent create.",
    });
  });

  return ServerSecretStore.of({ getOrCreateRandom });
});

export const layer = Layer.effect(ServerSecretStore, make);
