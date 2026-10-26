import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export const Platform = Context.Reference<NodeJS.Platform>("@app/shared/HostProcess/Platform", {
  defaultValue: () => process.platform,
});

export const Architecture = Context.Reference<NodeJS.Architecture>(
  "@app/shared/HostProcess/Architecture",
  {
    defaultValue: () => process.arch,
  },
);

export const HomeDirectory = Context.Reference<string>("@app/shared/HostProcess/HomeDirectory", {
  defaultValue: () => NodeOS.homedir(),
});

export const Environment = Context.Reference<NodeJS.ProcessEnv>(
  "@app/shared/HostProcess/Environment",
  {
    defaultValue: () => process.env,
  },
);

export const isWindows = Effect.map(Platform, (platform) => platform === "win32");
