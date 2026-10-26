import {
  Connectivity,
  ConnectionSupervisor,
  ConnectionTarget,
  ConnectionTransientError,
  ConnectionWakeups,
  type NetworkStatus,
} from "@app/client-runtime/connection";
import { RpcSession } from "@app/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { Atom } from "effect/reactivity";
import * as Socket from "effect/socket/Socket";

import { desktopBridge } from "../env";
import { serverTarget } from "../server/current";

const currentNetworkStatus = (): NetworkStatus => (navigator.onLine ? "online" : "offline");

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback<NetworkStatus>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);

        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ),
  ),
});

const layerWakeups = ConnectionWakeups.layer({
  changes: Stream.callback<ConnectionWakeups.ConnectionWakeup>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };

        document.addEventListener("visibilitychange", listener);

        return listener;
      }),
      (listener) => Effect.sync(() => document.removeEventListener("visibilitychange", listener)),
    ),
  ),
});

const bridge = desktopBridge;

const bearerToken = bridge
  ? Effect.tryPromise({
      try: () => bridge.getBearerToken(),
      catch: () =>
        new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "The desktop shell could not provide a credential.",
        }),
    }).pipe(Effect.asSome)
  : Effect.succeedNone;

const layerTarget = ConnectionTarget.layerTicket({
  label: "The local server",
  httpBaseUrl: serverTarget.httpBaseUrl,
  wsBaseUrl: serverTarget.wsBaseUrl,
  bearerToken,
});

export const layerConnection = ConnectionSupervisor.layer({ initiallyDesired: true }).pipe(
  Layer.provide(RpcSession.layer),
  Layer.provide(layerTarget),
  Layer.provide(Layer.mergeAll(layerConnectivity, layerWakeups)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(FetchHttpClient.layer),
);

/** The one application runtime: every atom that talks to the server runs here. */
export const connectionRuntime = Atom.runtime(layerConnection);
