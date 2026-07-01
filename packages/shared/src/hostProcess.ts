import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

// Injectable process-level values. `Context.Reference` gives each a default
// (read from the real process) while letting tests override them — so nothing
// downstream has to touch the `process` global directly.

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@app/shared/hostProcess/HostProcessPlatform",
  { defaultValue: () => process.platform },
);

export const HostProcessArchitecture = Context.Reference<NodeJS.Architecture>(
  "@app/shared/hostProcess/HostProcessArchitecture",
  { defaultValue: () => process.arch },
);

export const HostProcessHostname = Context.Reference<string>(
  "@app/shared/hostProcess/HostProcessHostname",
  { defaultValue: () => NodeOS.hostname() },
);

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@app/shared/hostProcess/HostProcessEnvironment",
  { defaultValue: () => process.env },
);

export const isHostWindows = Effect.map(
  HostProcessPlatform,
  (platform) => platform === "win32",
);
