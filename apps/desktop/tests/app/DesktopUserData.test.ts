import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as DesktopUserData from "../../src/app/DesktopUserData.ts";
import { makeFakeElectronApp } from "../support/electronApp.ts";
import { layerTestEnvironment } from "../support/environment.ts";

const layerUserData = (events: string[], lockAcquired: boolean) =>
  DesktopUserData.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTestEnvironment({ userDataPath: "/app-data/Test (Dev)" }),
        makeFakeElectronApp({
          setPath: (name, path) =>
            Effect.sync(() => {
              events.push(`setPath:${name}:${path}`);
            }),
          requestSingleInstanceLock: Effect.sync(() => {
            events.push("requestSingleInstanceLock");

            return lockAcquired;
          }),
          quit: Effect.sync(() => {
            events.push("quit");
          }),
        }).layer,
      ),
    ),
  );

describe("DesktopUserData", () => {
  it.effect("points userData at this launch's directory before taking the instance lock", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      yield* Effect.scoped(Layer.build(layerUserData(events, true)));

      assert.deepEqual(events, [
        "setPath:userData:/app-data/Test (Dev)",
        "requestSingleInstanceLock",
      ]);
    }),
  );

  it.effect("quits a second launch before initializing the application runtime", () =>
    Effect.gen(function* () {
      const events: string[] = [];

      const runtime = layerUserData(events, false).pipe(
        Layer.flatMap(() =>
          Layer.effectDiscard(
            Effect.sync(() => {
              events.push("initializeApplicationRuntime");
            }),
          ),
        ),
      );

      const exit = yield* Effect.exit(Effect.scoped(Layer.build(runtime)));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepEqual(events, [
        "setPath:userData:/app-data/Test (Dev)",
        "requestSingleInstanceLock",
        "quit",
      ]);
    }),
  );
});
