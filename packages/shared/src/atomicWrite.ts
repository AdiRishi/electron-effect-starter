import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Write a file atomically: write into a scoped temp directory next to the
 * target, then rename over it. A crash mid-write leaves the previous file
 * intact instead of a truncated one, and the scoped temp directory is cleaned
 * up even when the write or rename fails. Used by the desktop settings store.
 */
export const writeFileStringAtomically = Effect.fn("shared.atomicWrite.writeFileStringAtomically")(
  function* (input: { readonly filePath: string; readonly contents: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targetDirectory = path.dirname(input.filePath);

    yield* fs.makeDirectory(targetDirectory, { recursive: true });
    const tempDirectory = yield* fs.makeTempDirectoryScoped({
      directory: targetDirectory,
      prefix: `${path.basename(input.filePath)}.`,
    });
    const tempPath = path.join(tempDirectory, "contents.tmp");

    yield* fs.writeFileString(tempPath, input.contents);
    yield* fs.rename(tempPath, input.filePath);
  },
  Effect.scoped,
);
