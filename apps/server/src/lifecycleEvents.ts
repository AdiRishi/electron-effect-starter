/**
 * Server lifecycle events - the ordered push bus.
 *
 * A monotonic sequence, a retained snapshot (latest event per phase), and a
 * live `PubSub`. Subscribers replay the snapshot sorted by `sequence`, then
 * follow the live stream filtered to `sequence > snapshot.sequence` — so no
 * event is missed or duplicated across the snapshot/live boundary.
 *
 * @module lifecycleEvents
 */
import type { ServerLifecycleStreamEvent, ServerLifecyclePhase } from "@app/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/** A publish request: the phase + the wall-clock instant, sequence assigned here. */
export interface LifecycleEventInput {
  readonly phase: ServerLifecyclePhase;
  readonly at: DateTime.Utc;
}

export interface LifecycleSnapshot {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  {
    readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
    readonly snapshot: Effect.Effect<LifecycleSnapshot>;
    readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
  }
>()("@app/server/lifecycleEvents/ServerLifecycleEvents") {}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
  const state = yield* Ref.make<LifecycleSnapshot>({ sequence: 0, events: [] });

  return {
    publish: (input) =>
      Ref.modify(state, (current) => {
        const nextSequence = current.sequence + 1;
        const nextEvent: ServerLifecycleStreamEvent = {
          sequence: nextSequence,
          phase: input.phase,
          at: input.at,
        };
        // Retain only the latest event per phase, ordered by sequence.
        const retained = current.events.filter((entry) => entry.phase !== input.phase);
        const nextEvents = [...retained, nextEvent].sort((a, b) => a.sequence - b.sequence);
        return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
      }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event))),
    snapshot: Ref.get(state),
    get stream() {
      return Stream.fromPubSub(pubsub);
    },
  } satisfies ServerLifecycleEvents["Service"];
});

export const layer = Layer.effect(ServerLifecycleEvents, make);
