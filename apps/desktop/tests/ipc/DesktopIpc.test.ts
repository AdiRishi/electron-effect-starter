import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../../src/ipc/DesktopIpc.ts";

// Electron's ipcMain is the external seam; this records what the service registers on it.
const makeFakeIpcMain = () => {
  const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const ipcMain: DesktopIpc.DesktopIpcMain = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
    on: () => undefined,
    removeAllListeners: () => undefined,
  };
  return { ipcMain, handlers };
};

const doubleMethod = DesktopIpc.makeIpcMethod({
  channel: "test:double",
  payload: Schema.Number,
  result: Schema.Number,
  handler: (value) => Effect.succeed(value * 2),
});

describe("DesktopIpc", () => {
  it.effect("decodes the renderer's payload before the handler sees it", () =>
    Effect.gen(function* () {
      const { ipcMain, handlers } = makeFakeIpcMain();
      yield* DesktopIpc.make(ipcMain).handle(doubleMethod);
      const listener = handlers.get("test:double");
      assert.isDefined(listener);
      const event = { sender: { id: 1 } };

      assert.strictEqual(yield* Effect.promise(() => Promise.resolve(listener?.(event, 21))), 42);
      const rejected = yield* Effect.promise(() =>
        Promise.resolve(listener?.(event, "21")).then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(rejected);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the handler when its scope closes", () =>
    Effect.gen(function* () {
      const { ipcMain, handlers } = makeFakeIpcMain();
      yield* Effect.scoped(DesktopIpc.make(ipcMain).handle(doubleMethod));
      assert.isFalse(handlers.has("test:double"));
    }),
  );
});
