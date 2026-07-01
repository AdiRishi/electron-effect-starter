import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";

import { ConnectionTransientError, type PreparedConnection } from "./model.ts";
import { start } from "./supervisor.ts";

// The reliability property the starter advertises: when a connect attempt fails
// — here the credential mint in `prepareSocketUrl` — the supervisor does not
// freeze. It surfaces a `reconnecting` state, keeps the session ref empty, and
// retries. Because the failure happens before any socket is opened, the global
// WebSocket constructor is provided but never actually used.

describe("ConnectionSupervisor", () => {
  it.effect(
    "keeps retrying when the credential mint fails, without freezing",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const connection: PreparedConnection = {
          label: "test",
          prepareSocketUrl: Ref.update(attempts, (n) => n + 1).pipe(
            Effect.andThen(
              Effect.fail(
                new ConnectionTransientError({ detail: "mint failed" }),
              ),
            ),
          ),
        };

        const supervisor = yield* start(connection);

        // Wait for a failure to surface as a reconnecting state.
        const reconnecting = yield* SubscriptionRef.changes(
          supervisor.state,
        ).pipe(
          Stream.filter((state) => state.phase === "reconnecting"),
          Stream.runHead,
        );

        assert.isTrue(Option.isSome(reconnecting));
        if (Option.isSome(reconnecting)) {
          assert.equal(reconnecting.value.lastError, "mint failed");
        }
        // The mint was actually attempted, and no live session is exposed.
        assert.isTrue((yield* Ref.get(attempts)) >= 1);
        assert.isTrue(
          Option.isNone(yield* SubscriptionRef.get(supervisor.session)),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
      ),
  );
});
