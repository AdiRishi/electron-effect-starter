import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      method TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX idx_auth_sessions_active
    ON auth_sessions(revoked_at, expires_at, issued_at)
  `;
});
