import { AppHttpApi, PAIRING_TOKEN_QUERY_PARAM } from "@app/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

/** Reads a pairing token from a URL fragment such as `#token=…`. */
export function readPairingToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get(PAIRING_TOKEN_QUERY_PARAM);
  return token !== null && token.trim().length > 0 ? token.trim() : null;
}

/**
 * Signs a plain browser in. A pairing token in the fragment is traded for an HttpOnly session
 * cookie and removed from the address bar; either way the server says whether a session exists.
 */
export const ensureBrowserSession = Effect.fn("browserAuth.ensureBrowserSession")(function* (
  httpBaseUrl: string,
) {
  const client = yield* HttpApiClient.make(AppHttpApi, { baseUrl: httpBaseUrl });
  const token = readPairingToken(window.location.hash);
  if (token !== null) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    // A used or expired token falls through to the session check below.
    yield* client.auth
      .browserSession({ payload: { credential: token } })
      .pipe(Effect.catchTags({ AuthInvalidError: () => Effect.void }));
  }
  const session = yield* client.auth.session({ headers: {} });
  return session.authenticated;
});
