import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

const browserNetworkInformation = () =>
  // SAFETY: Navigator.connection is a Chromium extension that the DOM typings omit; it is read as
  // optional.
  (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;

/**
 * Emits when the device moves to another kind of network, such as Wi-Fi to cellular, where an
 * open socket may have died without a close event.
 */
export const networkPathChanges = (
  readConnection: () => NetworkInformationLike | undefined = browserNetworkInformation,
) =>
  Stream.callback<"network-changed">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const connection = readConnection();

        if (connection?.type === undefined) return undefined;
        let previous = connection.type;

        // change also fires for same-network bandwidth and latency estimates; count only type changes.
        const listener = () => {
          const type = connection.type;

          if (type === undefined || type === previous) return;
          previous = type;
          Queue.offerUnsafe(queue, "network-changed");
        };

        connection.addEventListener("change", listener);

        return { connection, listener };
      }),
      (subscription) =>
        Effect.sync(() =>
          subscription?.connection.removeEventListener("change", subscription.listener),
        ),
    ),
  );
