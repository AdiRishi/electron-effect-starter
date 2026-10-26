import { ConnectionSupervisor } from "@app/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionRuntime } from "./runtime";

export const connectionStateAtom = connectionRuntime.atom(
  Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* ConnectionSupervisor.ConnectionSupervisor;

      return SubscriptionRef.changes(supervisor.state);
    }),
  ),
);

export const retryConnectionAtom = connectionRuntime.fn(
  Effect.fnUntraced(function* () {
    const supervisor = yield* ConnectionSupervisor.ConnectionSupervisor;
    yield* supervisor.retryNow;
  }),
);
