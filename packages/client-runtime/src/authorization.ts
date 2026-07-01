import { BearerSession, type BootstrapBearerInput } from "@app/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

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

const decodeBearerSession = HttpClientResponse.schemaBodyJson(BearerSession);

/**
 * Exchange a bootstrap credential for a short-lived `/ws` bearer session.
 *
 * `POST ${httpBaseUrl}/api/auth/bootstrap/bearer` with the credential; decode the
 * `access_token` + `expires_at`. This is the browser path of the integration
 * contract — in the Electron shell the token comes from the bridge instead.
 *
 * Requires an `HttpClient` (provide `FetchHttpClient.layer` at the edge).
 */
export const bootstrapRemoteBearerSession = (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly clientMetadata?: BootstrapBearerInput["clientMetadata"];
}): Effect.Effect<BearerSession, BearerBootstrapError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = new URL("/api/auth/bootstrap/bearer", input.httpBaseUrl).toString();

    const body: BootstrapBearerInput = {
      credential: input.credential,
      ...(input.clientMetadata ? { clientMetadata: input.clientMetadata } : {}),
    };

    return yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.flatMap((request) => client.execute(request)),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(decodeBearerSession),
      // Any failure (encode, network, non-2xx, decode) collapses to one error.
      Effect.catch((cause) =>
        Effect.fail(
          new BearerBootstrapError({
            detail: `Could not bootstrap a bearer session from ${input.httpBaseUrl}: ${cause.message}`,
          }),
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
