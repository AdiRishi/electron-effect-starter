import * as Context from "effect/Context";

// Injectable process-level values. `Context.Reference` gives each a default
// (read from the real process) while letting tests override them — so nothing
// downstream has to touch the `process` global directly. Add more references
// here (architecture, hostname, …) as the app needs them.

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@app/shared/hostProcess/HostProcessPlatform",
  { defaultValue: () => process.platform },
);

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@app/shared/hostProcess/HostProcessEnvironment",
  { defaultValue: () => process.env },
);
