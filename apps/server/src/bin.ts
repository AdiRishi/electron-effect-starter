/**
 * CLI entrypoint. `app-server [start]` runs the server; the root command
 * defaults to the same behavior as `start`.
 *
 * @module bin
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { runServerCommand, sharedServerCommandFlags, startCommand } from "./cli/server.ts";

const APP_VERSION = "0.0.0";

export const cli = Command.make("app-server", {
  ...sharedServerCommandFlags,
}).pipe(
  Command.withDescription("Run the Desktop Starter server."),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([startCommand]),
);

// Run unconditionally — this bundle is only ever the process entrypoint. We
// deliberately avoid an `import.meta.main` guard: it is `undefined` on the Node
// bundled with Electron (v20.18), where the desktop shell spawns this server,
// which would make the CLI silently no-op.
Command.run(cli, { version: APP_VERSION }).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
