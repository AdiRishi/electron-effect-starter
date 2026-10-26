import { AppHttpApi, WS_PATH, WS_TICKET_QUERY_PARAM } from "@app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "./model.ts";

/** Where the supervisor connects, and how it earns the right to. */
export class ConnectionTarget extends Context.Service<
  ConnectionTarget,
  {
    readonly label: string;
    readonly prepare: Effect.Effect<{ readonly socketUrl: string }, ConnectionAttemptError>;
  }
>()("@app/client-runtime/connection/target/ConnectionTarget") {}

/**
 * Mints a WebSocket ticket over HTTP before each connection. A browser authenticates the ticket
 * request with its session cookie; the desktop renderer passes a bearer token. Minting over HTTP
 * lets an expired credential surface as a 401, which a failed WebSocket upgrade cannot report.
 */
export const layerTicket = (options: {
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
}) =>
  Layer.effect(
    ConnectionTarget,
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(AppHttpApi, { baseUrl: options.httpBaseUrl });

      const prepare = Effect.gen(function* () {
        const bearer = yield* options.bearerToken;

        const { ticket } = yield* client.auth
          .webSocketTicket({
            headers: Option.match(bearer, {
              onNone: () => ({}),
              onSome: (token) => ({ authorization: `Bearer ${token}` }),
            }),
          })
          .pipe(
            Effect.catchTags({
              AuthInvalidError: () =>
                Effect.fail(
                  new ConnectionBlockedError({
                    reason: "authentication",
                    detail: `${options.label} did not accept this client's credentials.`,
                    httpStatus: 401,
                  }),
                ),
              InternalError: (error) =>
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "remote-unavailable",
                    detail: error.message,
                    httpStatus: 500,
                  }),
                ),
              HttpClientError: () =>
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "network",
                    detail: `${options.label} is not reachable.`,
                  }),
                ),
              SchemaError: () =>
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "remote-unavailable",
                    detail: `${options.label} sent a response this client does not understand.`,
                  }),
                ),
            }),
          );

        const url = new URL(WS_PATH, options.wsBaseUrl);
        url.searchParams.set(WS_TICKET_QUERY_PARAM, ticket);

        return { socketUrl: url.toString() };
      }).pipe(Effect.withSpan("ConnectionTarget.prepare"));

      return ConnectionTarget.of({ label: options.label, prepare });
    }),
  );
