import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";

import { acquireServerOwnership } from "../src/serverOwnership.ts";

describe("acquireServerOwnership", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("refuses a second owner until the first releases the state directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-ownership-" });

        const first = yield* Scope.make();
        yield* acquireServerOwnership(stateDir).pipe(Scope.provide(first));

        const second = yield* Effect.flip(Effect.scoped(acquireServerOwnership(stateDir)));
        assert.strictEqual(second._tag, "ServerAlreadyRunningError");

        yield* Scope.close(first, Exit.void);
        yield* Effect.scoped(acquireServerOwnership(stateDir));
      }),
    );
  });
});
