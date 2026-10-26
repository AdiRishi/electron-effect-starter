import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../src/config.ts";
import { resolveStartupBrowserTarget } from "../src/startup.ts";

const targetFor = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  resolveStartupBrowserTarget.pipe(
    Effect.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;

          return { ...config, port: 3773, ...overrides };
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest()), Layer.provide(NodeServices.layer)),
    ),
  );

describe("resolveStartupBrowserTarget", () => {
  it.effect("opens localhost for a wildcard bind, which no browser can dial", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* targetFor({ host: "0.0.0.0" }), "http://localhost:3773");
      assert.strictEqual(yield* targetFor({ host: "::" }), "http://localhost:3773");
    }),
  );

  it.effect("opens the bound host when it is specific", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* targetFor({ host: "192.168.1.50" }), "http://192.168.1.50:3773");
      assert.strictEqual(yield* targetFor({ host: "::1" }), "http://[::1]:3773");
    }),
  );

  it.effect("opens the dev server when one fronts the app", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* targetFor({ host: "0.0.0.0", devUrl: new URL("http://localhost:5733") }),
        "http://localhost:5733/",
      );
    }),
  );
});
