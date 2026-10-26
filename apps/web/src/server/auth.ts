import {
  type AuthBrowserSessionResult,
  AuthInvalidError,
  type AuthSessionState,
  InternalError,
} from "@app/contracts";
import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "@app/shared/pairingUrl";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http";

import { runServerHttp } from "./http";

const ServerRequestOperation = Schema.Literals([
  "fetch-session-state",
  "exchange-bootstrap-credential",
]);

type ServerRequestOperation = typeof ServerRequestOperation.Type;

export class ServerRequestError extends Schema.TaggedError<ServerRequestError>()(
  "ServerRequestError",
  {
    operation: ServerRequestOperation,
    status: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static fromCause(input: {
    readonly operation: ServerRequestOperation;
    readonly cause: unknown;
  }): ServerRequestError {
    const status = readHttpApiStatus(input.cause) ?? 500;

    return new ServerRequestError({ operation: input.operation, status, cause: input.cause });
  }

  override get message(): string {
    return `Server request failed during ${this.operation} (HTTP ${this.status}).`;
  }
}

const isServerRequestError = Schema.is(ServerRequestError);

export class PairingCredentialRejectedError extends Schema.TaggedError<PairingCredentialRejectedError>()(
  "PairingCredentialRejectedError",
  {
    providedLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid pairing token. Check the token and try again.";
  }
}

export class AuthSessionTimeoutError extends Schema.TaggedError<AuthSessionTimeoutError>()(
  "AuthSessionTimeoutError",
  {
    timeoutMs: Schema.Number,
    elapsedMs: Schema.Number,
  },
) {
  override get message(): string {
    return "Timed out waiting for authenticated session after bootstrap.";
  }
}

export class PairingCredentialRequiredError extends Schema.TaggedError<PairingCredentialRequiredError>()(
  "PairingCredentialRequiredError",
  {
    providedLength: Schema.Number,
  },
) {
  override get message(): string {
    return "Enter a pairing token to continue.";
  }
}

const isAuthInvalidError = Schema.is(AuthInvalidError);
const isInternalError = Schema.is(InternalError);

export type ServerAuthGateState =
  | { readonly status: "authenticated" }
  | { readonly status: "requires-auth"; readonly errorMessage?: string };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
let resolvedAuthenticatedGateState: ServerAuthGateState | null = null;
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);

  if (next.toString() === url.toString()) {
    return;
  }

  window.history.replaceState({}, document.title, next.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();

  if (!token) {
    return null;
  }

  stripPairingTokenFromUrl();

  return token;
}

export async function fetchSessionState(): Promise<AuthSessionState> {
  return retryTransientBootstrap(async () => {
    try {
      return await runServerHttp((client) => client.auth.session({ headers: {} }));
    } catch (error) {
      throw ServerRequestError.fromCause({ operation: "fetch-session-state", cause: error });
    }
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- reads whatever a failed request rejected with.
function readHttpApiStatus(error: unknown): number | null {
  if (isAuthInvalidError(error)) return 401;

  if (isInternalError(error)) return 500;

  return HttpClientError.isHttpClientError(error) && error.response !== undefined
    ? error.response.status
    : null;
}

async function exchangeBootstrapCredential(credential: string): Promise<AuthBrowserSessionResult> {
  return retryTransientBootstrap(async () => {
    try {
      return await runServerHttp((client) =>
        client.auth.browserSession({ payload: { credential } }),
      );
    } catch (error) {
      if (isAuthInvalidError(error) && error.reason === "invalid_credential") {
        throw new PairingCredentialRejectedError({
          providedLength: credential.length,
          cause: error,
        });
      }

      throw ServerRequestError.fromCause({
        operation: "exchange-bootstrap-credential",
        cause: error,
      });
    }
  });
}

async function waitForAuthenticatedSessionAfterBootstrap(): Promise<AuthSessionState> {
  const startedAt = Date.now();

  while (true) {
    const session = await fetchSessionState();

    if (session.authenticated) {
      return session;
    }

    const elapsedMs = Date.now() - startedAt;

    if (elapsedMs >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) {
      throw new AuthSessionTimeoutError({
        timeoutMs: AUTH_SESSION_ESTABLISH_TIMEOUT_MS,
        elapsedMs,
      });
    }

    await waitForBootstrapRetry(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

export async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBootstrapError(error)) {
        throw error;
      }

      if (Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
        throw error;
      }

      await waitForBootstrapRetry(BOOTSTRAP_RETRY_STEP_MS);
    }
  }
}

function waitForBootstrapRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

// Effect's fetch client reports a request that never reached the server, fetch's TypeError, as a
// TransportError.
const isTransportFailure = (cause: unknown) =>
  HttpClientError.isHttpClientError(cause) &&
  cause.reason instanceof HttpClientError.TransportError;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- classifies whatever a failed request rejected with.
export function isTransientBootstrapError(error: unknown): boolean {
  if (isServerRequestError(error)) {
    return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status) || isTransportFailure(error.cause);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof DOMException && error.name === "AbortError";
}

async function bootstrapServerAuth(urlCredential: string | null): Promise<ServerAuthGateState> {
  const currentSession = await fetchSessionState();

  if (currentSession.authenticated && !urlCredential) {
    return { status: "authenticated" };
  }

  if (!urlCredential) {
    return { status: "requires-auth" };
  }

  try {
    await exchangeBootstrapCredential(urlCredential);
    await waitForAuthenticatedSessionAfterBootstrap();

    return { status: "authenticated" };
  } catch (error) {
    return {
      status: "requires-auth",
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();

  if (!trimmedCredential) {
    throw new PairingCredentialRequiredError({ providedLength: credential.length });
  }

  resolvedAuthenticatedGateState = null;
  await exchangeBootstrapCredential(trimmedCredential);
  await waitForAuthenticatedSessionAfterBootstrap();
  resolvedAuthenticatedGateState = { status: "authenticated" };
  bootstrapPromise = null;
  stripPairingTokenFromUrl();
}

/**
 * Signs a plain browser in. A pairing token in the URL is taken out of the address bar at once and
 * traded for an HttpOnly session cookie. Concurrent callers share one attempt, and only a success
 * is remembered, so a rejected token is reported once and the next call asks again.
 */
export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  const urlCredential = takePairingTokenFromUrl();
  const previousPromise = bootstrapPromise;

  if (urlCredential) {
    resolvedAuthenticatedGateState = null;
  } else {
    if (previousPromise) {
      return previousPromise;
    }

    if (resolvedAuthenticatedGateState?.status === "authenticated") {
      return resolvedAuthenticatedGateState;
    }
  }

  const nextPromise = previousPromise
    ? previousPromise
        .catch(() => undefined)
        .then(() => {
          resolvedAuthenticatedGateState = null;

          return bootstrapServerAuth(urlCredential);
        })
    : bootstrapServerAuth(urlCredential);

  bootstrapPromise = nextPromise;

  return nextPromise
    .then((result) => {
      if (bootstrapPromise === nextPromise && result.status === "authenticated") {
        resolvedAuthenticatedGateState = result;
      }

      return result;
    })
    .finally(() => {
      if (bootstrapPromise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
}
