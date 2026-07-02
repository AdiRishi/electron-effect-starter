/**
 * Readiness gate.
 *
 * `signalReady` opens the gate once the HTTP server is bound; the health route
 * reports 200 only after `isReady` flips true, so a supervisor polling
 * `/.well-known/app/health` sees "up" exactly when the server can serve.
 *
 * @module readiness
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class ReadinessGate extends Context.Service<
  ReadinessGate,
  {
    /** Open the readiness gate (called once the server binds). */
    readonly signalReady: Effect.Effect<void>;
    /** Whether the readiness gate is currently open (for the health probe). */
    readonly isReady: Effect.Effect<boolean>;
  }
>()("@app/server/readiness/ReadinessGate") {}

const make = Effect.gen(function* () {
  const readyFlag = yield* Ref.make(false);

  return {
    signalReady: Ref.set(readyFlag, true),
    isReady: Ref.get(readyFlag),
  } satisfies ReadinessGate["Service"];
});

export const layer = Layer.effect(ReadinessGate, make);
