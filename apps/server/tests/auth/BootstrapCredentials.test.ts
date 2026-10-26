import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as BootstrapCredentials from "../../src/auth/BootstrapCredentials.ts";
import * as ServerConfig from "../../src/config.ts";

const DESKTOP_TOKEN = "desktop-bootstrap-token-for-tests";

const layer = BootstrapCredentials.layer.pipe(
  Layer.provide(ServerConfig.layerTest({ desktopBootstrapToken: DESKTOP_TOKEN })),
  Layer.provide(NodeServices.layer),
);

describe("BootstrapCredentials", () => {
  it.layer(layer)((it) => {
    it.effect("accepts a pairing token exactly once", () =>
      Effect.gen(function* () {
        const credentials = yield* BootstrapCredentials.BootstrapCredentials;
        const { token } = yield* credentials.issuePairingToken;
        assert.strictEqual(yield* credentials.consume(token), "pairing");
        const reuse = yield* Effect.flip(credentials.consume(token));
        assert.strictEqual(reuse.reason, "unknown");
      }),
    );

    it.effect("rejects a pairing token after fifteen minutes", () =>
      Effect.gen(function* () {
        const credentials = yield* BootstrapCredentials.BootstrapCredentials;
        const { token } = yield* credentials.issuePairingToken;
        yield* TestClock.adjust("16 minutes");
        const error = yield* Effect.flip(credentials.consume(token));
        assert.strictEqual(error.reason, "expired");
      }),
    );

    it.effect("accepts the desktop token for the life of the process", () =>
      Effect.gen(function* () {
        const credentials = yield* BootstrapCredentials.BootstrapCredentials;
        assert.strictEqual(yield* credentials.consume(DESKTOP_TOKEN), "desktop");
        assert.strictEqual(yield* credentials.consume(DESKTOP_TOKEN), "desktop");
      }),
    );
  });
});
