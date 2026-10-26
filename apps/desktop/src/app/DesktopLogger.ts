import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

/** Annotates every log line from one part of the shell with its component name. */
export const makeComponentLogger = (component: string) => ({
  logInfo: (message: string, fields?: Record<string, unknown>) =>
    Effect.logInfo(message, ...(fields ? [fields] : [])).pipe(Effect.annotateLogs({ component })),
  logWarning: (message: string, fields?: Record<string, unknown>) =>
    Effect.logWarning(message, ...(fields ? [fields] : [])).pipe(
      Effect.annotateLogs({ component }),
    ),
  logError: (message: string, fields?: Record<string, unknown>) =>
    Effect.logError(message, ...(fields ? [fields] : [])).pipe(Effect.annotateLogs({ component })),
});
