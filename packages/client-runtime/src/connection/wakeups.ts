import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

/** Moments when a live socket may have died without a close event, or a waiting retry should run now. */
export type ConnectionWakeup = "application-active" | "network-changed";

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@app/client-runtime/connection/wakeups/ConnectionWakeups") {}

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, ConnectionWakeups.of(service));
