import type { ServerBootstrapEnvelope } from "@app/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

// The concrete recipe for spawning + reaching the server child. `httpBaseUrl`
// is where the shell probes for readiness and points the window; `bootstrapToken`
// is the shared secret the renderer later exchanges for a bearer session.
export interface DesktopBackendStartConfig {
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
  readonly entryPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly bootstrapEnvelope: ServerBootstrapEnvelope;
  readonly port: number;
  readonly bootstrapToken: string;
  readonly httpBaseUrl: URL;
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  {
    // Build the primary (local) backend's start config for the given port.
    // Fails with PlatformError because minting the token uses crypto.randomBytes.
    readonly resolve: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopBackendStartConfig, PlatformError.PlatformError>;
    // The bootstrap token, minted once and reused. Exposed so the auth service
    // can exchange it without re-resolving the whole start config.
    readonly bootstrapToken: Effect.Effect<string, PlatformError.PlatformError>;
  }
>()("@app/desktop/backend/DesktopBackendConfiguration") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const crypto = yield* Crypto.Crypto;

  // SynchronizedRef (not a plain Ref) so the read-generate-write is atomic:
  // crypto.randomBytes is a yield point, and the renderer relies on a single
  // stable token for the lifetime of the process. The first caller mints it;
  // everyone after reuses it.
  const tokenRef = yield* SynchronizedRef.make(Option.none<string>());
  const getOrCreateBootstrapToken = SynchronizedRef.modifyEffect(tokenRef, (current) =>
    Option.match(current, {
      onSome: (token) => Effect.succeed([token, current] as const),
      onNone: () =>
        crypto.randomBytes(24).pipe(
          Effect.map((bytes) => {
            const token = Encoding.encodeHex(bytes);
            return [token, Option.some(token)] as const;
          }),
        ),
    }),
  );

  return DesktopBackendConfiguration.of({
    bootstrapToken: getOrCreateBootstrapToken,
    resolve: (input) =>
      Effect.gen(function* () {
        const bootstrapToken = yield* getOrCreateBootstrapToken;
        const httpBaseUrl = new URL(`http://127.0.0.1:${input.port}`);
        return {
          // In the Electron main process `process.execPath` is the Electron
          // binary. `ELECTRON_RUN_AS_NODE=1` makes it behave as plain Node so
          // the spawned server doesn't become a second GUI app instance.
          executablePath: process.execPath,
          args: [environment.backendEntryPath, "start", "--bootstrap-fd", "3"],
          entryPath: environment.backendEntryPath,
          cwd: environment.backendCwd,
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            // The server receives these through fd3. Clear inherited env values
            // so a developer shell cannot accidentally override the envelope.
            APP_BOOTSTRAP_TOKEN: undefined,
            APP_SERVER_PORT: undefined,
          },
          bootstrapEnvelope: {
            desktopBootstrapToken: bootstrapToken,
            port: input.port,
          },
          port: input.port,
          bootstrapToken,
          httpBaseUrl,
        } satisfies DesktopBackendStartConfig;
      }).pipe(
        Effect.withSpan("desktop.backendConfiguration.resolve", {
          attributes: { port: input.port },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
