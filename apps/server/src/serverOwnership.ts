// @effect-diagnostics nodeBuiltinImport:off -- The ownership lock is a native SQLite handle held for the server's lifetime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

export class ServerAlreadyRunningError extends Schema.TaggedError<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  { stateDir: Schema.String },
) {
  // A distinct exit code tells the desktop supervisor to stop restarting.
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;

  override get message(): string {
    return `Another server already owns ${this.stateDir}. Stop it or use a different --base-dir.`;
  }
}

export class ServerOwnershipError extends Schema.TaggedError<ServerOwnershipError>()(
  "ServerOwnershipError",
  { stateDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not acquire server ownership of ${this.stateDir}.`;
  }
}

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

/**
 * Hold an exclusive lock on the state directory until the scope closes. The lock is an exclusive
 * transaction on `server-owner.sqlite`, which never holds data and must never be unlinked: the OS
 * releases it when the process exits, even on SIGKILL, so a crashed owner never blocks the next
 * start.
 */
export const acquireServerOwnership = Effect.fn("acquireServerOwnership")(function* (
  stateDir: string,
) {
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        NodeFS.mkdirSync(stateDir, { recursive: true });
        const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "server-owner.sqlite"));
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
        } catch (cause) {
          db.close();
          throw cause;
        }
        return db;
      },
      catch: (cause) =>
        isSqliteBusy(cause)
          ? new ServerAlreadyRunningError({ stateDir })
          : new ServerOwnershipError({ stateDir, cause }),
    }),
    (db) => Effect.sync(() => db.close()),
  );
});
