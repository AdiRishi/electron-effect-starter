import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@app/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";

import packageJson from "../package.json" with { type: "json" };
import { cli } from "./cli.ts";

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  NodeRuntime.runMain,
);
