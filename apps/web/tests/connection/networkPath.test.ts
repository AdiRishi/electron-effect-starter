import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { networkPathChanges } from "~/connection/networkPath";

class FakeNetworkInformation extends EventTarget {
  type: string;
  readonly listening = Deferred.makeUnsafe<void>();

  constructor(type: string) {
    super();
    this.type = type;
  }

  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    super.addEventListener(...args);
    Deferred.doneUnsafe(this.listening, Effect.void);
  }

  moveTo(type: string) {
    this.type = type;
    this.dispatchEvent(new Event("change"));
  }
}

describe("networkPathChanges", () => {
  it.effect("wakes the connection only when the kind of network changes", () =>
    Effect.gen(function* () {
      const connection = new FakeNetworkInformation("wifi");
      const stop = yield* Deferred.make<void>();

      const wakeups = yield* networkPathChanges(() => connection).pipe(
        Stream.interruptWhen(Deferred.await(stop)),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(connection.listening);
      // A bandwidth estimate on the same network also fires change.
      connection.moveTo("wifi");
      connection.moveTo("cellular");
      connection.moveTo("cellular");
      connection.moveTo("wifi");
      // Let the stream take what the listener queued before it is halted.
      yield* Effect.yieldNow;
      yield* Deferred.succeed(stop, undefined);

      expect(yield* Fiber.join(wakeups)).toEqual(["network-changed", "network-changed"]);
    }),
  );
});
