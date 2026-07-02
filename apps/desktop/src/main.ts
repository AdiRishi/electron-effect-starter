import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import * as Electron from "electron";

import * as NetService from "@app/shared/Net";
import { HostProcessPlatform } from "@app/shared/hostProcess";

import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopBackendConfiguration from "./backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./backend/DesktopBackendManager.ts";
import * as DesktopLocalEnvironmentAuth from "./backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopUpdater from "./updates/DesktopUpdater.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";

// ── Composition root ──
// This file is pure Layer wiring: it reads Electron/host metadata, builds the
// DesktopEnvironment from it, then assembles every service into one runtime
// layer and hands `DesktopApp.program` to `NodeRuntime.runMain`. No logic.

// Build the environment from injected Electron + host metadata. `Layer.unwrap`
// lets us read services (ElectronApp metadata, host platform) before deciding
// the layer's contents.
const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const platform = yield* HostProcessPlatform;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform,
      appVersion: metadata.appVersion,
      isPackaged: metadata.isPackaged,
      resourcesPath: metadata.resourcesPath,
    });
  }),
).pipe(Layer.provide(ElectronApp.layer));

// Tier-1 Electron wrappers + the IPC registration service bound to ipcMain.
const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

// Foundation services that only need the environment (+ NodeServices for
// settings' FileSystem/Crypto).
const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopShutdown.layer,
  DesktopObservability.layer,
  DesktopAppSettings.layer,
  DesktopBackendConfiguration.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

// The window needs the environment + electron shell/theme/window wrappers.
const desktopWindowLayer = DesktopWindow.layer.pipe(Layer.provideMerge(desktopFoundationLayer));

// The backend manager depends on the window (readiness callbacks) + config +
// NetService + platform services.
const desktopBackendLayer = DesktopBackendManager.layer.pipe(
  Layer.provideMerge(desktopWindowLayer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopUpdater.layer,
  DesktopLocalEnvironmentAuth.layer,
).pipe(Layer.provideMerge(desktopBackendLayer));

// Provide the platform services (FileSystem, Path, ChildProcessSpawner, Crypto,
// NetService) and the electron wrappers under the whole graph. The HttpClient
// uses Electron's global `fetch` (FetchHttpClient) rather than the undici-based
// Node client: bundling undici into the CJS main crashes Electron at load
// (`webidl.util.markAsUncloneable is not a function` from undici's CacheStorage).
const desktopRuntimeLayer = desktopApplicationLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(electronLayer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
