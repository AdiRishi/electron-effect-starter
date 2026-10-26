import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../src/persistence/Migrations.ts";

/** The `divergent` annotation of each warning the effect logs. */
const captureDivergenceWarnings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const divergent: Array<unknown> = [];

    const logger = Logger.make((options) => {
      if (options.logLevel !== "Warn") return;
      divergent.push(options.fiber.getRef(References.CurrentLogAnnotations)["divergent"]);
    });

    yield* effect.pipe(Effect.provide(Logger.layer([logger])));

    return divergent;
  });

describe("runMigrations", () => {
  it.effect("warns when the recorded history names migrations this build does not know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = 1`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'NewerMigration')`;

      assert.deepStrictEqual(yield* captureDivergenceWarnings(runMigrations()), [
        ["1:SiteLocalMigration (this build: Notes)", "99:NewerMigration (unknown to this build)"],
      ]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("stays quiet when the recorded history matches this build", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* captureDivergenceWarnings(runMigrations()), []);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});
