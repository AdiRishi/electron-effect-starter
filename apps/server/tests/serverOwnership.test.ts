import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
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

    it.effect("lets only one of two racing starts own a state directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-owner-race-" });

        const attempts = yield* Effect.all(
          [
            acquireServerOwnership(stateDir).pipe(Effect.result),
            acquireServerOwnership(stateDir).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );

        assert.strictEqual(attempts.filter(Result.isSuccess).length, 1);
        const refused = attempts.find(Result.isFailure);
        assert.strictEqual(refused?.failure._tag, "ServerAlreadyRunningError");
      }).pipe(Effect.scoped),
    );
  });
});
