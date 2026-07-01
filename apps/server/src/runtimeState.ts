/**
 * Runtime state file.
 *
 * Writes the actually-bound port (and pid) to a small JSON file so a
 * supervising shell can discover where the server landed when it let the OS
 * pick the port. Written atomically; removed on shutdown.
 *
 * @module runtimeState
 */
import { atomicWriteString } from "@app/shared/atomicWrite";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const RuntimeState = Schema.Struct({
  port: Schema.Number,
  pid: Schema.Number,
  startedAt: Schema.Number,
});
export type RuntimeState = typeof RuntimeState.Type;

const encodeState = Schema.encodeSync(Schema.fromJsonString(RuntimeState));

export const writeRuntimeState = Effect.fn("runtimeState.writeRuntimeState")(
  function* (input: { readonly path: string; readonly state: RuntimeState }) {
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* atomicWriteString({
      path: input.path,
      contents: encodeState(input.state),
      suffix,
    });
  },
);

export const clearRuntimeState = Effect.fn("runtimeState.clearRuntimeState")(
  function* (path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(path).pipe(Effect.ignore);
  },
);
