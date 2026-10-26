import { AppHttpApi } from "@app/contracts";
import { getPairingTokenFromUrl, stripPairingTokenFromUrl } from "@app/shared/pairingUrl";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

/**
 * Signs a plain browser in. A pairing token in the fragment is traded for an HttpOnly session
 * cookie and removed from the address bar; either way the server says whether a session exists.
 */
export const ensureBrowserSession = Effect.fn("browserAuth.ensureBrowserSession")(function* (
  httpBaseUrl: string,
) {
  const client = yield* HttpApiClient.make(AppHttpApi, { baseUrl: httpBaseUrl });
  const location = new URL(window.location.href);
  const token = getPairingTokenFromUrl(location);

  if (token !== null) {
    window.history.replaceState(null, "", stripPairingTokenFromUrl(location));
    // A used or expired token falls through to the session check below.
    yield* client.auth
      .browserSession({ payload: { credential: token } })
      .pipe(Effect.catchTags({ AuthInvalidError: () => Effect.void }));
  }

  const session = yield* client.auth.session({ headers: {} });

  return session.authenticated;
});
