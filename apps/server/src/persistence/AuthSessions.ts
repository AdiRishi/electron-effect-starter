import { AuthSessionId, ServerAuthSessionMethod } from "@app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  type AuthSessionRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  method: ServerAuthSessionMethod,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  method: ServerAuthSessionMethod,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});

export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const CreateReplacingActiveAuthSessionInput = Schema.Struct({
  session: CreateAuthSessionInput,
  revokedAt: Schema.DateTimeUtcFromString,
  replaceSessionId: Schema.optionalKey(AuthSessionId),
});

export type CreateReplacingActiveAuthSessionInput =
  typeof CreateReplacingActiveAuthSessionInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});

export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});

export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const RevokeOtherAuthSessionsInput = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});

export type RevokeOtherAuthSessionsInput = typeof RevokeOtherAuthSessionsInput.Type;

export class AuthSessionRepository extends Context.Service<
  AuthSessionRepository,
  {
    readonly create: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly createReplacingActive: (
      input: CreateReplacingActiveAuthSessionInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly getById: (
      input: GetAuthSessionByIdInput,
    ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly revoke: (
      input: RevokeAuthSessionInput,
    ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
    readonly revokeAllExcept: (
      input: RevokeOtherAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
  }
>()("@app/server/persistence/AuthSessions/AuthSessionRepository") {}

const AuthSessionRawDbRow = Schema.Struct({
  sessionId: Schema.String,
  subject: Schema.Unknown,
  method: Schema.Unknown,
  issuedAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
});

const decodeAuthSessionRecord = Schema.decodeUnknownEffect(AuthSessionRecord);

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createSessionRow = SqlSchema.void({
    Request: CreateAuthSessionInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          method,
          issued_at,
          expires_at,
          revoked_at
        )
        VALUES (
          ${input.sessionId},
          ${input.subject},
          ${input.method},
          ${input.issuedAt},
          ${input.expiresAt},
          NULL
        )
      `,
  });

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionRawDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          method AS "method",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          revoked_at AS "revokedAt"
        FROM auth_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const revokeActiveSessionsForReplacement = SqlSchema.findAll({
    Request: CreateReplacingActiveAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ session, revokedAt, replaceSessionId }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE ${
          replaceSessionId === undefined
            ? sql`subject = ${session.subject}`
            : sql`session_id = ${replaceSessionId}`
        }
          AND method = ${session.method}
          AND revoked_at IS NULL
          AND expires_at > ${revokedAt}
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id <> ${currentSessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const create: AuthSessionRepository["Service"]["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const createReplacingActive: AuthSessionRepository["Service"]["createReplacingActive"] = (
    input,
  ) =>
    sql
      .withTransaction(
        revokeActiveSessionsForReplacement(input).pipe(
          Effect.flatMap((revokedRows) =>
            createSessionRow(input.session).pipe(
              Effect.as(revokedRows.map((row) => row.sessionId)),
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.createReplacingActive:query",
            "AuthSessionRepository.createReplacingActive:encodeRequest",
            { sessionId: input.session.sessionId },
          ),
        ),
      );

  const getById: AuthSessionRepository["Service"]["getById"] = (input) =>
    getSessionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthSessionRecord(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthSessionRepository.getById:decodeRow",
                  cause,
                  { sessionId: input.sessionId },
                ),
              ),
              Effect.asSome,
            ),
        }),
      ),
    );

  const revoke: AuthSessionRepository["Service"]["revoke"] = (input) =>
    revokeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revokeAllExcept: AuthSessionRepository["Service"]["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
          { currentSessionId: input.currentSessionId },
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  return AuthSessionRepository.of({
    create,
    createReplacingActive,
    getById,
    revoke,
    revokeAllExcept,
  });
});

export const layer = Layer.effect(AuthSessionRepository, make);
