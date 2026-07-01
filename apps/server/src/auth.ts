/**
 * Bearer session store.
 *
 * A minimal in-memory auth boundary. A client first exchanges the server's
 * bootstrap token for an opaque bearer (`authenticateBootstrap`), then presents
 * that bearer on the `/ws` upgrade (`authenticateBearer`). Tokens are random
 * hex held in a `Set` for the process lifetime — no persistence, no expiry.
 *
 * @module auth
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "./config.ts";

const TOKEN_BYTES = 32;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * BearerSessionStore - mints and validates opaque bearer tokens.
 */
export class BearerSessionStore extends Context.Service<
  BearerSessionStore,
  {
    /**
     * Exchange a bootstrap credential for a fresh bearer token. Returns
     * `Option.none()` when the credential does not match the server's token.
     */
    readonly authenticateBootstrap: (
      credential: string,
    ) => Effect.Effect<Option.Option<string>>;
    /** Whether the given bearer token is a live session. */
    readonly authenticateBearer: (token: string) => Effect.Effect<boolean>;
  }
>()("@app/server/auth/BearerSessionStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* Ref.make<ReadonlySet<string>>(new Set());

  return {
    authenticateBootstrap: (credential) =>
      Effect.gen(function* () {
        if (credential !== config.bootstrapToken) {
          return Option.none();
        }
        const bytes = yield* crypto.randomBytes(TOKEN_BYTES).pipe(Effect.orDie);
        const token = toHex(bytes);
        yield* Ref.update(sessions, (current) => new Set(current).add(token));
        return Option.some(token);
      }),
    authenticateBearer: (token) =>
      Ref.get(sessions).pipe(Effect.map((current) => current.has(token))),
  } satisfies BearerSessionStore["Service"];
});

export const layer = Layer.effect(BearerSessionStore, make);
