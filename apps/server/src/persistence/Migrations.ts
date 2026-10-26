import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./migrations/0001_Notes.ts";

/**
 * Append new migrations; never edit or reorder a released one. The migrator skips every id up to
 * the highest one it has recorded.
 */
const loader = Migrator.fromRecord({
  "1_Notes": Migration0001,
});

const run = Migrator.make({});

export const runMigrations = run({ loader }).pipe(
  Effect.tap((executed) =>
    executed.length === 0
      ? Effect.logDebug("Database schema is current")
      : Effect.log("Migrations ran", {
          migrations: executed.map(([id, name]) => `${id}_${name}`),
        }),
  ),
  Effect.withSpan("runMigrations"),
);
