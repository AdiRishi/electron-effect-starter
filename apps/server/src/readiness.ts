/**
 * Readiness gate.
 *
 * Two latches govern startup:
 *  - `markHttpListening` fires once the HTTP server is bound.
 *  - `signalReady` opens the command gate; `awaitReady` blocks until then.
 *
 * The health route reports 200 only after `isReady` flips true, so a supervisor
 * polling `/.well-known/app/health` sees "up" exactly when the server can serve.
 *
 * @module readiness
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class ReadinessGate extends Context.Service<
  ReadinessGate,
  {
    /** Resolve the HTTP-listening latch (called once the server binds). */
    readonly markHttpListening: Effect.Effect<void>;
    /** Await the HTTP-listening latch. */
    readonly awaitHttpListening: Effect.Effect<void>;
    /** Open the readiness gate. */
    readonly signalReady: Effect.Effect<void>;
    /** Block until the readiness gate opens. */
    readonly awaitReady: Effect.Effect<void>;
    /** Whether the readiness gate is currently open (for the health probe). */
    readonly isReady: Effect.Effect<boolean>;
  }
>()("@app/server/readiness/ReadinessGate") {}

const make = Effect.gen(function* () {
  const httpListening = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<void>();
  const readyFlag = yield* Ref.make(false);

  return {
    markHttpListening: Deferred.succeed(httpListening, undefined).pipe(
      Effect.asVoid,
    ),
    awaitHttpListening: Deferred.await(httpListening),
    signalReady: Ref.set(readyFlag, true).pipe(
      Effect.andThen(Deferred.succeed(ready, undefined)),
      Effect.asVoid,
    ),
    awaitReady: Deferred.await(ready),
    isReady: Ref.get(readyFlag),
  } satisfies ReadinessGate["Service"];
});

export const layer = Layer.effect(ReadinessGate, make);
