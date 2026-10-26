import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./migrations/0001_Notes.ts";
import Migration0002 from "./migrations/0002_AuthSessions.ts";

/**
 * Append new migrations; never edit or reorder a released one. The migrator skips every id up to
 * the highest one it has recorded.
 */
const migrationEntries = [
  [1, "Notes", Migration0001],
  [2, "AuthSessions", Migration0002],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

export const runMigrations = Effect.fn("runMigrations")(function* () {
  const executedMigrations = yield* run({ loader });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);

  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  const sql = yield* SqlClient.SqlClient;

  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;

  const manifestNames = new Map<number, string>(migrationManifest);

  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);

    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }

    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });

  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }

  return executedMigrations;
});
