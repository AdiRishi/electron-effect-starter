import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/** Logs to the terminal and to a JSON-lines file, since a packaged app has no terminal. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(environment.logDir, { recursive: true });
    return Logger.layer(
      [
        Logger.consolePretty(),
        Logger.toFile(Logger.formatJson, path.join(environment.logDir, "desktop.log"), {
          flag: "a",
        }),
      ],
      { mergeWithExisting: false },
    );
  }),
);

/** Effect's log functions, annotating every line with the part of the shell that wrote it. */
export const forComponent = (component: string) => {
  const annotate = Effect.annotateLogs({ component });
  return {
    logInfo: flow(Effect.logInfo, annotate),
    logWarning: flow(Effect.logWarning, annotate),
    logError: flow(Effect.logError, annotate),
  };
};
