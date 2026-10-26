import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@app/shared/HostProcess";
import * as NetService from "@app/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopLogger from "./app/DesktopLogger.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopUserData from "./app/DesktopUserData.ts";
import * as DesktopBackend from "./backend/DesktopBackend.ts";
import * as DesktopServerAuth from "./backend/DesktopServerAuth.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";

// A closed terminal must not crash the app the first time it logs.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

// Electron accepts scheme privileges only before it emits ready, so this runs before any Effect.
ElectronProtocol.registerSchemePrivileges();

const layerElectron = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronProtocol.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

const layerEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    const app = yield* ElectronApp.ElectronApp;

    return DesktopEnvironment.layer({
      dirname: __dirname,
      platform: yield* HostProcess.Platform,
      productName: Electron.app.getName(),
      metadata: yield* app.metadata,
    });
  }),
);

// The userData claim is built before anything that writes into it.
const layerFoundation = Layer.mergeAll(DesktopState.layer, DesktopShutdown.layer).pipe(
  Layer.provideMerge(DesktopUserData.layer),
  Layer.provideMerge(layerEnvironment),
);

const layerBackend = DesktopServerAuth.layer.pipe(
  Layer.provideMerge(DesktopBackend.layer),
  Layer.provideMerge(DesktopWindow.layer),
);

const layerApplication = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer.pipe(Layer.provideMerge(DesktopUpdates.layer)),
).pipe(Layer.provideMerge(layerBackend));

const layerRuntime = layerApplication.pipe(
  Layer.provideMerge(DesktopLogger.layer),
  Layer.provideMerge(layerFoundation),
  Layer.provideMerge(layerElectron),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NodeServices.layer),
);

DesktopApp.program.pipe(Effect.provide(layerRuntime), NodeRuntime.runMain);
