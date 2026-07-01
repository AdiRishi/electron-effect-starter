import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Write a file atomically: write to a temp sibling, then rename over the
 * target. A crash mid-write leaves the previous file intact instead of a
 * truncated one. Used by the desktop settings store. `suffix` should be a
 * unique-per-write token (e.g. a random hex string) to avoid concurrent-write
 * collisions.
 */
export const atomicWriteString = Effect.fn("shared.atomicWrite.atomicWriteString")(function* (input: {
  readonly path: string;
  readonly contents: string;
  readonly suffix: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(input.path);
  const tempPath = `${input.path}.${input.suffix}.tmp`;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(tempPath, input.contents);
  yield* fileSystem.rename(tempPath, input.path);
});
