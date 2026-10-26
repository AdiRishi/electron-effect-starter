import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as BootstrapCredentials from "../../src/auth/BootstrapCredentials.ts";
import * as ServerConfig from "../../src/config.ts";

const DESKTOP_TOKEN = "desktop-bootstrap-token";

const layer = BootstrapCredentials.layer.pipe(
  Layer.provide(ServerConfig.layerTest({ desktopBootstrapToken: DESKTOP_TOKEN })),
  Layer.provide(NodeServices.layer),
);

describe("BootstrapCredentials", () => {
  it.layer(layer)((it) => {
    it.effect("issues one-time bootstrap tokens that can only be consumed once", () =>
      Effect.gen(function* () {
        const credentials = yield* BootstrapCredentials.BootstrapCredentials;
        const issued = yield* credentials.issueOneTimeToken;
        const first = yield* credentials.consume(issued.credential);
        const second = yield* Effect.flip(credentials.consume(issued.credential));

        assert.strictEqual(first.method, "one-time-token");
        assert.strictEqual(first.subject, "one-time-token");
        assert.strictEqual(second._tag, "UnknownBootstrapCredentialError");
        assert.include(second.message, "Unknown bootstrap credential");
      }),
    );

    it.effect("atomically consumes a one-time token when multiple requests race", () =>
      Effect.gen(function* () {
        const credentials = yield* BootstrapCredentials.BootstrapCredentials;
        const token = yield* credentials.issueOneTimeToken;

        const results = yield* Effect.all(
          Array.from({ length: 8 }, () => Effect.result(credentials.consume(token.credential))),
          { concurrency: "unbounded" },
        );

        const successes = results.filter(Result.isSuccess);
        const failures = results.filter(Result.isFailure);

        assert.strictEqual(successes.length, 1);
        assert.strictEqual(failures.length, 7);

        for (const failure of failures) {
          assert.strictEqual(failure.failure._tag, "UnknownBootstrapCredentialError");
        }
      }),
    );

    it.effect("expires a pairing token after five minutes", () =>
      Effect.gen(function* () {
        const credentials = yield* BootstrapCredentials.BootstrapCredentials;
        const { credential } = yield* credentials.issueOneTimeToken;
        yield* TestClock.adjust(Duration.minutes(5));
        const error = yield* Effect.flip(credentials.consume(credential));
        assert.strictEqual(error._tag, "ExpiredBootstrapCredentialError");
      }),
    );

    it.effect("reports seeded desktop bootstrap credentials as expired after their ttl", () =>
      Effect.gen(function* () {
        const credentials = yield* BootstrapCredentials.BootstrapCredentials;

        yield* TestClock.adjust(Duration.hours(12));
        const stillValid = yield* credentials.consume(DESKTOP_TOKEN);
        assert.strictEqual(stillValid.method, "desktop-bootstrap");
        assert.strictEqual((yield* credentials.consume(DESKTOP_TOKEN)).method, "desktop-bootstrap");

        yield* TestClock.adjust(Duration.hours(13));
        const expired = yield* Effect.flip(credentials.consume(DESKTOP_TOKEN));

        assert.strictEqual(expired._tag, "ExpiredBootstrapCredentialError");
        assert.include(expired.message, "Bootstrap credential expired");
      }).pipe(Effect.provide(Layer.fresh(layer))),
    );
  });
});
