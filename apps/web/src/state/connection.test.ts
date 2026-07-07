import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";
import { describe, expect, it, vi } from "vitest";

import {
  ConnectionTransientError,
  connectionSupervisorLayer,
  type PreparedConnection,
} from "@app/client-runtime/connection";
import {
  RpcSessionFactory,
  type RpcSession,
  type WsRpcProtocolClient,
} from "@app/client-runtime/rpc";

import { createConnectionAtoms } from "./connection.ts";

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
    "server.echo": (input: { readonly message: string }) =>
      Effect.succeed({ message: input.message, receivedAt: AT }),
    "server.subscribeTicks": () =>
      Stream.fromIterable([
        { tick: 1, at: AT },
        { tick: 2, at: AT },
      ]).pipe(Stream.concat(Stream.never)),
    "server.subscribeLifecycle": () =>
      Stream.fromIterable([{ sequence: 1, phase: "ready" as const, at: AT }]).pipe(
        Stream.concat(Stream.never),
      ),
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
  it("reaches connected and syncs config, ticks, and lifecycle", async () => {
    const harness = makeScriptedHarness();
    const atoms = createConnectionAtoms(Atom.runtime(harness.layer));
    const registry = AtomRegistry.make();

    const unmounts = [
      registry.mount(atoms.state),
      registry.mount(atoms.serverConfig),
      registry.mount(atoms.tick),
      registry.mount(atoms.lifecycle),
    ];

    await vi.waitFor(() => {
      expect(registry.get(atoms.state).phase).toBe("connected");
      expect(registry.get(atoms.serverConfig)).toEqual(SERVER_CONFIG);
      expect(registry.get(atoms.tick)).toBe(2);
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

  it("runs the echo call and exposes the result", async () => {
    const harness = makeScriptedHarness();
    const atoms = createConnectionAtoms(Atom.runtime(harness.layer));
    const registry = AtomRegistry.make();

    const unmounts = [registry.mount(atoms.state), registry.mount(atoms.echo)];

    await vi.waitFor(() => {
      expect(registry.get(atoms.state).phase).toBe("connected");
    });

    registry.set(atoms.echo, { message: "hi" });

    await vi.waitFor(() => {
      const result = registry.get(atoms.echo);
      expect(AsyncResult.isSuccess(result)).toBe(true);
      if (AsyncResult.isSuccess(result)) {
        expect(result.value.message).toBe("hi");
      }
    });

    for (const unmount of unmounts) unmount();
  });
});
