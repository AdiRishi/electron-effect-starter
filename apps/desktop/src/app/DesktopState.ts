import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

// Small piece of mutable app-wide state shared across services: whether the
// backend has reached readiness, and whether we've begun quitting (so the fatal
// error path doesn't stack error dialogs).
export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
  }
>()("@app/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
