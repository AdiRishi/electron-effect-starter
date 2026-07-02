// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ServerBootstrapEnvelope,
  type ServerBootstrapEnvelope as ServerBootstrapEnvelopeValue,
} from "@app/contracts";
import { HostProcessEnvironment } from "@app/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveServerConfig, type CliServerFlags } from "./config.ts";

const encodeBootstrapEnvelope = Schema.encodeSync(
  Schema.fromJsonString(ServerBootstrapEnvelope),
);

const baseFlags: CliServerFlags = {
  port: Option.none(),
  host: Option.none(),
  devWebUrl: Option.some("http://127.0.0.1:5173"),
  bootstrapFd: Option.none(),
};

function withBootstrapFd<A, E, R>(
  envelope: ServerBootstrapEnvelopeValue,
  use: (fd: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "desktop-starter-bootstrap-"),
      );
      const path = NodePath.join(dir, "bootstrap.json");
      NodeFS.writeFileSync(path, `${encodeBootstrapEnvelope(envelope)}\n`);
      return { dir, fd: NodeFS.openSync(path, "r") };
    }),
    ({ fd }) => use(fd),
    ({ dir, fd }) =>
      Effect.sync(() => {
        NodeFS.closeSync(fd);
        NodeFS.rmSync(dir, { force: true, recursive: true });
      }),
  );
}

describe("resolveServerConfig", () => {
  it.effect(
    "prefers the bootstrap fd envelope over inherited environment values",
    () =>
      withBootstrapFd(
        { desktopBootstrapToken: "fd-token", port: 19731 },
        (fd) =>
          Effect.gen(function* () {
            const config = yield* resolveServerConfig({
              ...baseFlags,
              bootstrapFd: Option.some(fd),
            });

            assert.equal(config.bootstrapToken, "fd-token");
            assert.equal(config.port, 19731);
            assert.equal(config.devWebUrl?.href, "http://127.0.0.1:5173/");
          }),
      ).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_SERVER_PORT: "3000",
        }),
        Effect.provide(NodeServices.layer),
      ),
  );
});
