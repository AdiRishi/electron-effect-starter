/**
 * Bearer session store.
 *
 * A minimal in-memory auth boundary. A client first exchanges the server's
 * bootstrap token for an opaque bearer (`authenticateBootstrap`), then uses
 * that bearer either directly on an `Authorization` header, or — for the `/ws`
 * upgrade, where browsers can't set headers — exchanges it for a short-lived
 * ticket (`issueWsTicket`) that rides in the URL instead. Bearer tokens are
 * random hex held in a `Set` for the process lifetime (no persistence); tickets
 * are random hex held in a `Map` with a 5-minute expiry, so a leaked `/ws` URL
 * (proxy log, browser history) exposes minutes of access, not the session.
 *
 * The reference implementation signs stateless HMAC tickets bound to a
 * persisted session row; with this starter's in-memory, process-lifetime
 * sessions a stateful random ticket keeps the same exposure bound with far
 * less machinery.
 *
 * @module auth
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Headers, type HttpServerRequest } from "effect/unstable/http";

import * as ServerConfig from "./config.ts";

const TOKEN_BYTES = 32;
const WS_TICKET_TTL_MILLIS = 5 * 60 * 1000;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Constant-time equality so a wrong credential can't leak how much of it matched. */
const timingSafeStringEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length && NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
};

export interface IssuedWsTicket {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
}

/** Extract the token from an `Authorization: Bearer <token>` header, if any. */
export function extractAuthorizationBearer(
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<string> {
  const header = Headers.get(request.headers, "authorization");
  if (Option.isSome(header)) {
    const match = /^Bearer\s+(.+)$/i.exec(header.value.trim());
    if (match?.[1]) {
      return Option.some(match[1].trim());
    }
  }
  return Option.none();
}

/**
 * BearerSessionStore - mints and validates opaque bearer tokens and the
 * short-lived WebSocket tickets derived from them.
 */
export class BearerSessionStore extends Context.Service<
  BearerSessionStore,
  {
    /**
     * Exchange a bootstrap credential for a fresh bearer token. Returns
     * `Option.none()` when the credential does not match the server's token.
     */
    readonly authenticateBootstrap: (credential: string) => Effect.Effect<Option.Option<string>>;
    /** Whether the given bearer token is a live session. */
    readonly authenticateBearer: (token: string) => Effect.Effect<boolean>;
    /**
     * Exchange a live bearer for a short-lived `/ws` ticket. Returns
     * `Option.none()` when the bearer is not a live session.
     */
    readonly issueWsTicket: (token: string) => Effect.Effect<Option.Option<IssuedWsTicket>>;
    /** Whether the given ticket exists and has not expired. */
    readonly authenticateWsTicket: (ticket: string) => Effect.Effect<boolean>;
  }
>()("@app/server/auth/BearerSessionStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* Ref.make<ReadonlySet<string>>(new Set());
  // ticket → expiry (epoch millis). Pruned on every mint/verify, so the map
  // is bounded by the tickets minted in any 5-minute window.
  const tickets = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const mintToken = crypto.randomBytes(TOKEN_BYTES).pipe(Effect.map(toHex), Effect.orDie);

  const pruneExpired = (current: ReadonlyMap<string, number>, nowMillis: number) => {
    const next = new Map<string, number>();
    for (const [ticket, expiresAt] of current) {
      if (expiresAt > nowMillis) {
        next.set(ticket, expiresAt);
      }
    }
    return next;
  };

  return {
    authenticateBootstrap: (credential) =>
      Effect.gen(function* () {
        if (!timingSafeStringEqual(credential, config.bootstrapToken)) {
          return Option.none();
        }
        const token = yield* mintToken;
        yield* Ref.update(sessions, (current) => new Set(current).add(token));
        return Option.some(token);
      }),
    authenticateBearer: (token) =>
      Ref.get(sessions).pipe(Effect.map((current) => current.has(token))),
    issueWsTicket: (token) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(sessions)).has(token)) {
          return Option.none();
        }
        const ticket = yield* mintToken;
        const now = yield* DateTime.now;
        const expiresAt = DateTime.add(now, { milliseconds: WS_TICKET_TTL_MILLIS });
        yield* Ref.update(tickets, (current) => {
          const next = pruneExpired(current, now.epochMilliseconds);
          next.set(ticket, expiresAt.epochMilliseconds);
          return next;
        });
        return Option.some({ ticket, expiresAt });
      }),
    authenticateWsTicket: (ticket) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const expiresAt = (yield* Ref.get(tickets)).get(ticket);
        return expiresAt !== undefined && expiresAt > now.epochMilliseconds;
      }),
  } satisfies BearerSessionStore["Service"];
});

export const layer = Layer.effect(BearerSessionStore, make);
