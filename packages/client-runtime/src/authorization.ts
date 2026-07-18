import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  BearerSessionJson,
  WsTicketJson,
  type BearerSession,
  type BootstrapBearerInput,
  type WsTicket,
} from "@app/contracts";

const REQUEST_TIMEOUT = Duration.seconds(10);

/**
 * Raised when an auth HTTP exchange (bearer bootstrap or WS-ticket mint)
 * fails. `status` carries the HTTP status of a rejection so callers can tell a
 * rejected credential (401/403 — retrying won't help) apart from "could not
 * reach the server" (`status: null` — a transient network/timeout/decode
 * failure worth retrying).
 */
export class AuthorizationRequestError extends Schema.TaggedErrorClass<AuthorizationRequestError>()(
  "AuthorizationRequestError",
  {
    detail: Schema.String,
    status: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }

  /** The server understood the request and said no — retrying won't change it. */
  get isRejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const describeCause = (cause: unknown): string =>
  Predicate.isError(cause) ? cause.message : String(cause);

interface FetchedJson {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/**
 * POST `url` and hand back status + parsed body. Network-level failures (no
 * response at all) fail with `status: null`; HTTP rejections are returned as
 * values so callers surface the status code.
 *
 * Uses the platform `fetch` directly. That keeps the browser edge simple and
 * avoids adapter differences around host-bound fetch implementations.
 */
const postJson = (input: {
  readonly url: string;
  readonly label: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Effect.Effect<FetchedJson, AuthorizationRequestError> =>
  Effect.tryPromise({
    try: async (): Promise<FetchedJson> => {
      const response = await globalThis.fetch(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...input.headers,
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      return {
        status: response.status,
        ok: response.ok,
        body: response.ok ? await response.json() : null,
      };
    },
    catch: (cause) =>
      new AuthorizationRequestError({
        detail: `${input.label} failed: ${describeCause(cause)}`,
        status: null,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new AuthorizationRequestError({ detail: `${input.label} timed out.`, status: null }),
        ),
    }),
  );

const decodeOrFail =
  <A, I>(schema: Schema.Codec<A, I>, label: string) =>
  (fetched: FetchedJson): Effect.Effect<A, AuthorizationRequestError> => {
    if (!fetched.ok) {
      return Effect.fail(
        new AuthorizationRequestError({
          detail: `${label} was rejected with HTTP ${fetched.status}.`,
          status: fetched.status,
        }),
      );
    }
    return Schema.decodeUnknownEffect(schema)(fetched.body).pipe(
      Effect.mapError(
        (cause) =>
          new AuthorizationRequestError({
            detail: `${label} returned an undecodable response: ${describeCause(cause)}`,
            status: null,
          }),
      ),
    );
  };

/**
 * Exchange a bootstrap credential for a bearer session.
 *
 * `POST ${httpBaseUrl}/api/auth/bootstrap/bearer` with the credential; decode
 * the `access_token` + `expires_at`. This is the browser path of the
 * integration contract — in the Electron shell the token comes from the bridge
 * instead.
 */
export const bootstrapRemoteBearerSession = (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly clientMetadata?: BootstrapBearerInput["clientMetadata"];
}): Effect.Effect<BearerSession, AuthorizationRequestError> => {
  const label = `Bearer bootstrap against ${input.httpBaseUrl}`;
  const body: BootstrapBearerInput = {
    credential: input.credential,
    ...(input.clientMetadata ? { clientMetadata: input.clientMetadata } : {}),
  };
  return postJson({
    url: new URL("/api/auth/bootstrap/bearer", input.httpBaseUrl).toString(),
    label,
    body,
  }).pipe(Effect.flatMap(decodeOrFail(BearerSessionJson, label)));
};

/**
 * Exchange a live bearer for a short-lived `/ws` ticket.
 *
 * `POST ${httpBaseUrl}/api/auth/ws-ticket` with the bearer on `Authorization`
 * (headers work here — this is plain HTTP). The ticket then rides in the
 * `/ws?wsTicket=` query string, so the long-lived bearer never appears in a
 * URL. Minted fresh for every connect attempt; tickets expire in minutes.
 */
export const issueWebSocketTicket = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Effect.Effect<WsTicket, AuthorizationRequestError> => {
  const label = `WebSocket ticket mint against ${input.httpBaseUrl}`;
  return postJson({
    url: new URL("/api/auth/ws-ticket", input.httpBaseUrl).toString(),
    label,
    headers: { authorization: `Bearer ${input.bearerToken}` },
  }).pipe(Effect.flatMap(decodeOrFail(WsTicketJson, label)));
};
