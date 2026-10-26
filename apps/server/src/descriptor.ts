import type { ServerDescriptor, ServerPlatformArch, ServerPlatformOs } from "@app/contracts";
import * as HostProcess from "@app/shared/HostProcess";
import * as Effect from "effect/Effect";

import packageJson from "../package.json" with { type: "json" };

const toOs = (platform: NodeJS.Platform): ServerPlatformOs => {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
};

const toArch = (arch: NodeJS.Architecture): ServerPlatformArch =>
  arch === "arm64" || arch === "x64" ? arch : "other";

export const serverDescriptor = Effect.gen(function* () {
  return {
    name: packageJson.name,
    version: packageJson.version,
    platform: {
      os: toOs(yield* HostProcess.Platform),
      arch: toArch(yield* HostProcess.Architecture),
    },
  } satisfies ServerDescriptor;
});
