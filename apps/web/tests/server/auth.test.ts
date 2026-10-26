import {
  AuthInvalidError,
  type AuthBrowserSessionResult,
  type AuthSessionState,
} from "@app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installServerHttpTest } from "../support/serverHttpTest";

type TestWindow = {
  location: URL;
  history: {
    state: History["state"];
    replaceState: History["replaceState"];
  };
};

const SESSION_EXPIRES_AT = DateTime.makeUnsafe("2026-04-05T00:00:00.000Z");

const unauthenticatedSession: AuthSessionState = { authenticated: false };

const authenticatedSession: AuthSessionState = {
  authenticated: true,
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
};

const browserSession: AuthBrowserSessionResult = {
  authenticated: true,
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
};

function installTestBrowser(url: string) {
  const testWindow: TestWindow = {
    location: new URL(url),
    history: {
      state: null,
      replaceState: (data, _unused, nextUrl) => {
        testWindow.history.state = data;

        if (nextUrl !== undefined && nextUrl !== null) {
          testWindow.location = new URL(nextUrl, testWindow.location.href);
        }
      },
    },
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "Electron Effect Starter" });

  return testWindow;
}

function sequence<A>(...values: ReadonlyArray<A>) {
  let index = 0;

  return () => values[Math.min(index++, values.length - 1)]!;
}

let disposeHttpTest: (() => void) | undefined;

async function installAuthApi(input: Parameters<typeof installServerHttpTest>[0]) {
  const testApi = await installServerHttpTest(input);
  disposeHttpTest = testApi.dispose;

  return testApi;
}

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    disposeHttpTest?.();
    disposeHttpTest = undefined;
    const { __resetServerAuthBootstrapForTests } = await import("~/server/auth");
    __resetServerAuthBootstrapForTests();
    vi.unstubAllGlobals();
  });

  it("reuses an in-flight silent bootstrap attempt", async () => {
    const testApi = await installAuthApi({ session: () => Effect.succeed(authenticatedSession) });
    const { resolveInitialServerAuthGateState } = await import("~/server/auth");

    await expect(
      Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]),
    ).resolves.toEqual([{ status: "authenticated" }, { status: "authenticated" }]);
    expect(testApi.calls.session).toBe(1);
  });

  it("takes a pairing token from the location hash and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/#token=pairing-token");
    const { takePairingTokenFromUrl } = await import("~/server/auth");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("reports a rejected URL token without caching false success", async () => {
    const nextSession = sequence(authenticatedSession, unauthenticatedSession);

    const testApi = await installAuthApi({
      session: () => Effect.succeed(nextSession()),
      browserSession: () => Effect.fail(new AuthInvalidError({ reason: "invalid_credential" })),
    });

    installTestBrowser("http://localhost/#token=rejected-token");
    const { resolveInitialServerAuthGateState } = await import("~/server/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      errorMessage: "Invalid pairing token. Check the token and try again.",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "rejected-token" }]);
  });

  it("exchanges a URL token for a session", async () => {
    const nextSession = sequence(unauthenticatedSession, authenticatedSession);

    const testApi = await installAuthApi({
      session: () => Effect.succeed(nextSession()),
      browserSession: () => Effect.succeed(browserSession),
    });

    installTestBrowser("http://localhost/#token=pairing-token");
    const { resolveInitialServerAuthGateState } = await import("~/server/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "pairing-token" }]);
  });

  it("retries the session check while the server is unreachable", async () => {
    let failures = 0;

    const testApi = await installAuthApi({
      session: () => Effect.succeed(authenticatedSession),
      transport: (runner) => (request) => {
        if (failures < 2) {
          failures += 1;

          return Promise.reject(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request: HttpClientRequest.get("http://localhost/api/auth/session"),
                cause: new TypeError("Failed to fetch"),
              }),
            }),
          );
        }

        return runner(request);
      },
    });

    const { resolveInitialServerAuthGateState } = await import("~/server/auth");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(failures).toBe(2);
    expect(testApi.calls.session).toBe(1);
  });
});

describe("submitServerAuthCredential", () => {
  beforeEach(() => {
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    disposeHttpTest?.();
    disposeHttpTest = undefined;
    const { __resetServerAuthBootstrapForTests } = await import("~/server/auth");
    __resetServerAuthBootstrapForTests();
    vi.unstubAllGlobals();
  });

  it("rejects a token the server does not accept with a message for the user", async () => {
    await installAuthApi({
      session: () => Effect.succeed(unauthenticatedSession),
      browserSession: () => Effect.fail(new AuthInvalidError({ reason: "invalid_credential" })),
    });

    const { submitServerAuthCredential } = await import("~/server/auth");

    await expect(submitServerAuthCredential("wrong-token")).rejects.toThrow(
      "Invalid pairing token. Check the token and try again.",
    );
  });

  it("asks for a token before calling the server", async () => {
    const testApi = await installAuthApi({});
    const { submitServerAuthCredential } = await import("~/server/auth");

    await expect(submitServerAuthCredential("   ")).rejects.toMatchObject({
      message: "Enter a pairing token to continue.",
    });
    expect(testApi.calls.browserSession).toEqual([]);
  });
});
