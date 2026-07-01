/**
 * Bootstrap envelope reader.
 *
 * The desktop shell mints a one-time bootstrap token and hands it to the
 * spawned server over an inherited file descriptor. The envelope is a single
 * JSON line `{ "desktopBootstrapToken": string, "port"?: number }`. Reading a
 * secret off an fd keeps it out of argv/env where other processes could see it.
 *
 * @module bootstrap
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Shape written by the shell into the bootstrap fd. */
export const BootstrapEnvelope = Schema.Struct({
  desktopBootstrapToken: Schema.String,
  port: Schema.optional(Schema.Number),
});
export type BootstrapEnvelope = typeof BootstrapEnvelope.Type;

export class BootstrapEnvelopeReadError extends Schema.TaggedErrorClass<BootstrapEnvelopeReadError>()(
  "BootstrapEnvelopeReadError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

export class BootstrapEnvelopeDecodeError extends Schema.TaggedErrorClass<BootstrapEnvelopeDecodeError>()(
  "BootstrapEnvelopeDecodeError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

const decodeEnvelope = Schema.decodeEffect(Schema.fromJsonString(BootstrapEnvelope));

/**
 * Read + decode the bootstrap envelope from the given file descriptor. Returns
 * `Option.none()` when the fd is unavailable (`EBADF`/`ENOENT`), so a missing
 * bootstrap fd is not fatal — the caller falls back to env/random tokens.
 */
export const readBootstrapEnvelope = Effect.fn("bootstrap.readBootstrapEnvelope")(function* (
  fd: number,
): Effect.fn.Return<
  Option.Option<BootstrapEnvelope>,
  BootstrapEnvelopeReadError | BootstrapEnvelopeDecodeError
> {
  const raw = yield* Effect.try({
    try: () => NodeFS.readFileSync(fd, "utf8"),
    catch: (cause) => new BootstrapEnvelopeReadError({ fd, cause }),
  }).pipe(
    Effect.catchTag("BootstrapEnvelopeReadError", (error) => {
      const code =
        typeof error.cause === "object" && error.cause !== null && "code" in error.cause
          ? (error.cause as { code?: unknown }).code
          : undefined;
      return code === "EBADF" || code === "ENOENT"
        ? Effect.succeed(null)
        : Effect.fail(error);
    }),
  );

  if (raw === null) {
    return Option.none();
  }

  const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    return Option.none();
  }

  const envelope = yield* decodeEnvelope(firstLine).pipe(
    Effect.mapError((cause) => new BootstrapEnvelopeDecodeError({ fd, cause })),
  );
  return Option.some(envelope);
});
