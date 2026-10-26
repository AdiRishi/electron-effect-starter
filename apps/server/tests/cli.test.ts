import * as NetService from "@app/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveServerConfig } from "../src/cli.ts";

const devUrl = new URL("http://localhost:5733");

const resolveWith = (input: {
  readonly baseDirFlag: Option.Option<string>;
  readonly env: Record<string, string>;
}) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.some(3773),
      host: Option.none(),
      baseDir: input.baseDirFlag,
      devUrl: Option.some(devUrl),
      bootstrapFd: Option.none(),
      logWebSocketEvents: Option.none(),
    },
    Option.none(),
  ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env }))));

describe("resolveServerConfig", () => {
  it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))((it) => {
    it.effect("keeps an explicit base directory's state out of dev/ behind the dev server", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-cli-" });

        const fromFlag = yield* resolveWith({ baseDirFlag: Option.some(baseDir), env: {} });
        assert.strictEqual(fromFlag.stateDir, path.join(baseDir, "userdata"));

        const fromEnv = yield* resolveWith({
          baseDirFlag: Option.none(),
          env: { APP_HOME: baseDir },
        });

        assert.strictEqual(fromEnv.stateDir, path.join(baseDir, "userdata"));
      }),
    );

    it.effect("logs requests by default behind the dev server", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-cli-" });

        assert.isTrue(
          (yield* resolveWith({ baseDirFlag: Option.some(baseDir), env: {} })).logWebSocketEvents,
        );

        assert.isFalse(
          (yield* resolveWith({
            baseDirFlag: Option.some(baseDir),
            env: { APP_LOG_WS_EVENTS: "false" },
          })).logWebSocketEvents,
        );
      }),
    );
  });
});
