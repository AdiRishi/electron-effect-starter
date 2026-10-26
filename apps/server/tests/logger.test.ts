import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redactable from "effect/Redactable";
import * as Tracer from "effect/Tracer";
import * as TestConsole from "effect/testing/TestConsole";

import * as ServerConfig from "../src/config.ts";
import * as ServerLogger from "../src/logger.ts";
import { announceStartupPairingUrl } from "../src/startup.ts";

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    return { ...config, logLevel: "Info" } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest()), Layer.provide(NodeServices.layer));

const layerLogger = ServerLogger.layer.pipe(Layer.provide(layerConfig));

/**
 * Runs `program` inside a span so the tracer logger has somewhere to attach an event, then
 * reports what landed on the span.
 */
const logInSpanThrough = (program: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];

    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (spanOptions) => {
          const span = new Tracer.NativeSpan(spanOptions);
          spans.push(span);

          return span;
        },
      }),
    );

    yield* program.pipe(
      Effect.withSpan("server-logger-test"),
      Effect.provide(Layer.mergeAll(layerLogger, layerTracer)),
    );

    return spans;
  });

const printThroughConsole = <Fields>(fields: Fields) =>
  Effect.gen(function* () {
    const printed: Array<string> = [];

    const testConsole = {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        printed.push(NodeUtil.format(...args));
      },
    } satisfies Console.Console;

    yield* Effect.logWarning("pull request watch check failed", fields).pipe(
      Effect.provide(layerLogger),
      Effect.provideService(Console.Console, testConsole),
    );

    return printed.join("\n");
  });

describe("ServerLogger", () => {
  it.effect("prints a cause passed as a log field instead of collapsing it", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        threadId: "thread-1",
        cause: Cause.fail(new Error("gh: HTTP 502 from api.github.com")),
      });

      assert.include(output, "threadId: 'thread-1'");
      assert.include(output, "gh: HTTP 502 from api.github.com");
      assert.notInclude(output, "[Object]");
    }),
  );

  it.effect("leaves getters uncalled while printing a cause field", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        cause: Cause.fail(new Error("upstream refused")),
        get detail(): string {
          throw new Error("getter must not run");
        },
      });

      assert.include(output, "upstream refused");
      assert.notInclude(output, "getter must not run");
    }),
  );

  it.effect("leaves a message with its own redaction hook to that hook", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        token: "secret-token-value",
        cause: Cause.fail(new Error("upstream refused")),
        [Redactable.symbolRedactable](this: { readonly cause: unknown }) {
          return { token: "<redacted>", cause: Cause.isCause(this.cause) ? "cause" : "missing" };
        },
      });

      assert.include(output, "token: '<redacted>'");
      assert.include(output, "cause: 'cause'");
      assert.notInclude(output, "secret-token-value");
    }),
  );

  describe("startup pairing URL", () => {
    const pairingToken = "PAIRTOKEN7Q4K9";
    const pairingUrl = `http://localhost:3773/#token=${pairingToken}`;

    it.effect("keeps the token off the span events the trace file records", () =>
      Effect.gen(function* () {
        const spans = yield* logInSpanThrough(announceStartupPairingUrl(pairingUrl));

        const events = JSON.stringify(
          spans.flatMap((span) => span.events.map(([name, , attributes]) => [name, attributes])),
        );

        assert.include(events, "Authentication required");
        assert.notInclude(events, pairingToken);

        const printed = (yield* TestConsole.logLines).map((line) =>
          Array.isArray(line) ? line.join(" ") : String(line),
        );

        assert.isTrue(printed.some((line) => line.includes(`pairingUrl: ${pairingUrl}`)));
      }).pipe(Effect.provide(TestConsole.layer)),
    );
  });
});
