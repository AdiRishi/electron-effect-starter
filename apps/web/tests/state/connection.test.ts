import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";
import { describe, expect, it, vi } from "vitest";

import { BearerBootstrapError } from "@app/client-runtime/authorization";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  connectionSupervisorLayer,
  type PreparedConnection,
} from "@app/client-runtime/connection";
import {
  RpcSessionFactory,
  type RpcSession,
  type WsRpcProtocolClient,
} from "@app/client-runtime/rpc";

import { createConnectionAtoms, mapBearerBootstrapError } from "../../src/state/connection.ts";

const AT = DateTime.fromDateUnsafe(new Date(0));

const SERVER_CONFIG = {
  appName: "Test App",
  version: "0.0.0-test",
  startedAt: AT,
};

const CONNECTION: PreparedConnection = {
  label: "test",
  prepareSocketUrl: Effect.succeed("ws://127.0.0.1:0/ws"),
};

/**
 * A supervisor layer over scripted sessions: a fake typed client answers the
 * four methods in-memory, and the test drops the live session by failing its
 * `closed` deferred — no sockets, no React.
 */
const makeScriptedHarness = () => {
  const drops: Array<Deferred.Deferred<never, ConnectionTransientError>> = [];

  const fakeClient = {
    "server.getConfig": () => Effect.succeed(SERVER_CONFIG),
    "server.subscribeLifecycle": () =>
      Stream.fromIterable([
        { version: 1 as const, sequence: 1, phase: "ready" as const, at: AT },
      ]).pipe(Stream.concat(Stream.never)),
  } as unknown as WsRpcProtocolClient;

  const factory = {
    connect: () =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<never, ConnectionTransientError>();
        drops.push(closed);
        return {
          client: fakeClient,
          connected: Effect.void,
          closed: Deferred.await(closed),
        } satisfies RpcSession;
      }),
  };

  const layer = connectionSupervisorLayer(CONNECTION).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(Layer.succeed(RpcSessionFactory, factory)),
  );

  const dropCurrent = () => {
    const current = drops[drops.length - 1];
    if (!current) throw new Error("dropCurrent called before any connect");
    return Deferred.doneUnsafe(
      current,
      Effect.fail(new ConnectionTransientError({ detail: "dropped" })),
    );
  };

  return { layer, dropCurrent };
};

describe("connection atoms", () => {
  it("reaches connected and syncs config and lifecycle", async () => {
    const harness = makeScriptedHarness();
    const atoms = createConnectionAtoms(Atom.runtime(harness.layer));
    const registry = AtomRegistry.make();

    const unmounts = [
      registry.mount(atoms.state),
      registry.mount(atoms.serverConfig),
      registry.mount(atoms.lifecycle),
    ];

    await vi.waitFor(() => {
      expect(registry.get(atoms.state).phase).toBe("connected");
      expect(registry.get(atoms.serverConfig)).toEqual(SERVER_CONFIG);
      expect(registry.get(atoms.lifecycle)).toBe("ready");
    });

    for (const unmount of unmounts) unmount();
  });

  it("clears the server config when the session drops", async () => {
    const harness = makeScriptedHarness();
    const atoms = createConnectionAtoms(Atom.runtime(harness.layer));
    const registry = AtomRegistry.make();

    const unmounts = [registry.mount(atoms.state), registry.mount(atoms.serverConfig)];

    await vi.waitFor(() => {
      expect(registry.get(atoms.serverConfig)).toEqual(SERVER_CONFIG);
    });

    harness.dropCurrent();

    await vi.waitFor(() => {
      expect(registry.get(atoms.serverConfig)).toBeNull();
      expect(registry.get(atoms.state).phase).toBe("reconnecting");
    });

    for (const unmount of unmounts) unmount();
  });

  it("surfaces a blocked connection distinctly from reconnecting", async () => {
    const factory = {
      connect: () =>
        Effect.fail(
          new ConnectionBlockedError({
            reason: "authentication",
            detail: "Authentication required.",
          }),
        ),
    };
    const layer = connectionSupervisorLayer(CONNECTION).pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(Layer.succeed(RpcSessionFactory, factory)),
    );
    const atoms = createConnectionAtoms(Atom.runtime(layer));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atoms.state);

    await vi.waitFor(() => {
      expect(registry.get(atoms.state).phase).toBe("blocked");
      expect(registry.get(atoms.state).lastError).toBe("Authentication required.");
    });

    unmount();
  });
});

describe("mapBearerBootstrapError", () => {
  it("blocks an HTTP 401 as an authentication rejection", () => {
    const error = mapBearerBootstrapError(
      new BearerBootstrapError({ detail: "HTTP 401 Unauthorized", status: 401 }),
    );
    expect(error).toBeInstanceOf(ConnectionBlockedError);
    expect(error).toMatchObject({ reason: "authentication", detail: "HTTP 401 Unauthorized" });
  });

  it("blocks an HTTP 403 as a permission rejection", () => {
    const error = mapBearerBootstrapError(
      new BearerBootstrapError({ detail: "HTTP 403 Forbidden", status: 403 }),
    );
    expect(error).toBeInstanceOf(ConnectionBlockedError);
    expect(error).toMatchObject({ reason: "permission", detail: "HTTP 403 Forbidden" });
  });

  it("keeps every other failure transient", () => {
    expect(
      mapBearerBootstrapError(new BearerBootstrapError({ detail: "fetch failed" })),
    ).toBeInstanceOf(ConnectionTransientError);
    expect(
      mapBearerBootstrapError(new BearerBootstrapError({ detail: "HTTP 503", status: 503 })),
    ).toBeInstanceOf(ConnectionTransientError);
  });
});
