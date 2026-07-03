import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BearerSessionJson, type BearerSession, type BootstrapBearerInput } from "@app/contracts";

const BOOTSTRAP_TIMEOUT = Duration.seconds(10);

/**
 * Raised when the bearer-bootstrap exchange fails — a network error, a non-2xx
 * status, or a response that does not decode as a `BearerSession`. The web app
 * surfaces this as "could not reach the server".
 */
export class BearerBootstrapError extends Schema.TaggedErrorClass<BearerBootstrapError>()(
  "BearerBootstrapError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const decodeBearerSession = Schema.decodeUnknownEffect(BearerSessionJson);

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const bearerBootstrapError = (httpBaseUrl: string, cause: unknown): BearerBootstrapError =>
  new BearerBootstrapError({
    detail: `Could not bootstrap a bearer session from ${httpBaseUrl}: ${describeCause(cause)}`,
  });

/**
 * Exchange a bootstrap credential for a short-lived `/ws` bearer session.
 *
 * `POST ${httpBaseUrl}/api/auth/bootstrap/bearer` with the credential; decode the
 * `access_token` + `expires_at`. This is the browser path of the integration
 * contract — in the Electron shell the token comes from the bridge instead.
 *
 * Uses the platform `fetch` directly. That keeps the browser edge simple and
 * avoids adapter differences around host-bound fetch implementations.
 */
export const bootstrapRemoteBearerSession = (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly clientMetadata?: BootstrapBearerInput["clientMetadata"];
}): Effect.Effect<BearerSession, BearerBootstrapError> =>
  Effect.gen(function* () {
    const url = new URL("/api/auth/bootstrap/bearer", input.httpBaseUrl).toString();

    const body: BootstrapBearerInput = {
      credential: input.credential,
      ...(input.clientMetadata ? { clientMetadata: input.clientMetadata } : {}),
    };

    return yield* Effect.tryPromise({
      try: async () => {
        const response = await globalThis.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return await response.json();
      },
      catch: (cause) => bearerBootstrapError(input.httpBaseUrl, cause),
    }).pipe(
      Effect.flatMap((json) =>
        decodeBearerSession(json).pipe(
          Effect.mapError((cause) => bearerBootstrapError(input.httpBaseUrl, cause)),
        ),
      ),
      Effect.timeoutOrElse({
        duration: BOOTSTRAP_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new BearerBootstrapError({
              detail: `Bearer bootstrap to ${input.httpBaseUrl} timed out.`,
            }),
          ),
      }),
    );
  });
