import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { bootstrapRemoteBearerSession } from "@app/client-runtime/authorization";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";

// Exchanges the shell's bootstrap token for a short-lived bearer session the
// renderer uses on the `/ws` upgrade. The token is minted by the shell and
// handed to BOTH the spawned server (via fd3) and here — the "shared secret
// handed to a trusted child" pattern. The exchange itself is the one shared
// `bootstrapRemoteBearerSession` (same call the browser path makes). The result
// is cached for the process lifetime; a `Semaphore(1)` collapses concurrent
// first calls into one request.

export class DesktopLocalEnvironmentAuthBackendNotReadyError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthBackendNotReadyError>()(
  "DesktopLocalEnvironmentAuthBackendNotReadyError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured yet.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotReadyError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
  }
>()("@app/desktop/backend/DesktopLocalEnvironmentAuth") {}

export const make = Effect.gen(function* () {
  const manager = yield* DesktopBackendManager.DesktopBackendManager;
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached)) {
          return cached.value;
        }

        const configOption = yield* manager.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotReadyError();
        }
        const config = configOption.value;

        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: config.httpBaseUrl.href,
          credential: config.bootstrapToken,
          clientMetadata: { label: "App Desktop", deviceType: "desktop" },
        }).pipe(
          Effect.mapError(
            (cause) => new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause }),
          ),
        );
        yield* Ref.set(tokenRef, Option.some(session.access_token));
        return session.access_token;
      }),
    )
    .pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  return DesktopLocalEnvironmentAuth.of({ getBearerToken });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
