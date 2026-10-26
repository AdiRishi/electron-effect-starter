import type { ServerLifecycleEvent } from "@app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleEvent, { type: "ready" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleEvent>;
}

/**
 * Server lifecycle milestones. Late subscribers first receive the latest event of each type, then
 * live events, without gaps or duplicates.
 */
export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  {
    readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleEvent>;
    readonly subscribe: Stream.Stream<ServerLifecycleEvent>;
  }
>()("@app/server/ServerLifecycleEvents") {}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ServerLifecycleEvent>();
  const state = yield* Ref.make<SnapshotState>({ sequence: 0, events: [] });

  const publish: ServerLifecycleEvents["Service"]["publish"] = (event) =>
    Ref.modify(state, (current) => {
      const sequence = current.sequence + 1;
      const next = { ...event, sequence } satisfies ServerLifecycleEvent;
      return [
        next,
        { sequence, events: [next, ...current.events.filter((entry) => entry.type !== next.type)] },
      ] as const;
    }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event)));

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const liveBuffer = yield* Queue.unbounded<ServerLifecycleEvent>();
      yield* Effect.forkScoped(
        Stream.fromPubSub(pubsub).pipe(
          Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
        ),
        { startImmediately: true },
      );
      const snapshot = yield* Ref.get(state);
      const snapshotEvents = snapshot.events.toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      return Stream.concat(
        Stream.fromIterable(snapshotEvents),
        Stream.fromQueue(liveBuffer).pipe(
          Stream.filter((event) => event.sequence > snapshot.sequence),
        ),
      );
    }),
  );

  return ServerLifecycleEvents.of({ publish, subscribe });
});

export const layer = Layer.effect(ServerLifecycleEvents, make);
