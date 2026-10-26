import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../../src/app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  platform: "darwin",
  productName: "Electron Effect Starter",
  metadata: {
    appVersion: "0.1.0",
    appPath: "/repo/apps/desktop",
    isPackaged: false,
    appDataPath: "/Users/alice/Library/Application Support",
  },
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironment = (env: Record<string, string | undefined> = {}) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer(defaultInput).pipe(
        Layer.provide(Layer.mergeAll(NodePath.layerPosix, DesktopConfig.layerTest(env))),
      ),
    ),
  );

describe("DesktopEnvironment", () => {
  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment({
        VITE_DEV_SERVER_URL: "http://localhost:5173",
      });

      const production = yield* makeEnvironment();

      assert.equal(
        development.userDataPath,
        "/Users/alice/Library/Application Support/Electron Effect Starter (Dev)",
      );
      assert.equal(
        production.userDataPath,
        "/Users/alice/Library/Application Support/Electron Effect Starter",
      );
      assert.equal(development.stateDir, development.userDataPath);
      assert.equal(production.stateDir, production.userDataPath);
    }),
  );
});
