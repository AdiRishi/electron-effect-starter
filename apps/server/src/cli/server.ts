/**
 * The `start` command: resolve config, then launch the server.
 *
 * @module cli/server
 */
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { ServerConfig } from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export { sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    const config = yield* resolveServerConfig(flags);
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

export const startCommand = Command.make("start", {
  ...sharedServerCommandFlags,
}).pipe(
  Command.withDescription("Run the Desktop Starter server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);
