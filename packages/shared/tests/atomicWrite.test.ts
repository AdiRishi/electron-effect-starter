import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../src/atomicWrite.ts";

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  describe("atomic writes", () => {
    it.effect("writes contents and creates missing parent directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const target = path.join(dir, "nested", "deeper", "settings.json");

        yield* writeFileStringAtomically({ filePath: target, contents: "hello" });

        assert.equal(yield* fs.readFileString(target), "hello");
      }).pipe(Effect.scoped),
    );

    it.effect("replaces existing contents and leaves no temp artifacts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const target = path.join(dir, "settings.json");

        yield* writeFileStringAtomically({ filePath: target, contents: "first" });
        yield* writeFileStringAtomically({ filePath: target, contents: "second" });

        assert.equal(yield* fs.readFileString(target), "second");
        assert.deepEqual(yield* fs.readDirectory(dir), ["settings.json"]);
      }).pipe(Effect.scoped),
    );

    it.effect("concurrent writes settle on one complete value", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const target = path.join(dir, "settings.json");
        const a = "a".repeat(4096);
        const b = "b".repeat(4096);

        yield* Effect.all(
          [
            writeFileStringAtomically({ filePath: target, contents: a }),
            writeFileStringAtomically({ filePath: target, contents: b }),
          ],
          { concurrency: 2 },
        );

        const result = yield* fs.readFileString(target);
        assert.ok(result === a || result === b, "file must hold one complete write");
        assert.deepEqual(yield* fs.readDirectory(dir), ["settings.json"]);
      }).pipe(Effect.scoped),
    );

    it.effect("cleans up its temp directory when the rename fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        // A non-empty directory at the target path makes the final rename fail.
        const target = path.join(dir, "occupied");
        yield* fs.makeDirectory(path.join(target, "child"), { recursive: true });

        const result = yield* writeFileStringAtomically({
          filePath: target,
          contents: "doomed",
        }).pipe(Effect.exit);

        assert.ok(result._tag === "Failure", "rename over a non-empty directory must fail");
        assert.deepEqual(yield* fs.readDirectory(dir), ["occupied"]);
      }).pipe(Effect.scoped),
    );
  });
});
