import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// The shutdown latch, in two stages. `DesktopApp.program` blocks on
// `awaitRequest`; the Electron `window-all-closed` / `before-quit` listeners
// fire `request`, which releases the scoped program and runs the finalizers
// (backend SIGTERM, etc.). Once those finalizers have finished the program
// fires `markComplete`, and only then does the lifecycle allow Electron to
// actually quit — otherwise Electron tears the process down mid-finalizer and
// orphans the backend child.
export class DesktopShutdown extends Context.Service<
  DesktopShutdown,
  {
    readonly request: Effect.Effect<void>;
    readonly awaitRequest: Effect.Effect<void>;
    readonly markComplete: Effect.Effect<void>;
    readonly awaitComplete: Effect.Effect<void>;
  }
>()("@app/desktop/app/DesktopShutdown") {}

const make = Effect.gen(function* () {
  const requested = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();

  return DesktopShutdown.of({
    request: Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    awaitRequest: Deferred.await(requested),
    markComplete: Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
    awaitComplete: Deferred.await(completed),
  });
});

export const layer = Layer.effect(DesktopShutdown, make);
