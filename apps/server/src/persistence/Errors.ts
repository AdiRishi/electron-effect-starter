import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";

function summarizeSchemaIssue(issue: SchemaIssue.Issue): string {
  return Match.value(issue).pipe(
    Match.tags({
      Filter: (nested) => `${nested._tag}(${summarizeSchemaIssue(nested.issue)})`,
      Encoding: (nested) => `${nested._tag}(${summarizeSchemaIssue(nested.issue)})`,
      Pointer: (nested) => `${nested._tag}(${summarizeSchemaIssue(nested.issue)})`,
      Composite: (nested) => `${nested._tag}(${nested.issues.map(summarizeSchemaIssue).join(",")})`,
      AnyOf: (nested) => `${nested._tag}(${nested.issues.map(summarizeSchemaIssue).join(",")})`,
    }),
    Match.orElse((other) => other._tag),
  );
}

export const PersistenceErrorCorrelation = Schema.Union([
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ currentSessionId: Schema.String }),
]);

export type PersistenceErrorCorrelation = typeof PersistenceErrorCorrelation.Type;

export class PersistenceSqlError extends Schema.TaggedError<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedError<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static fromSchemaError(
    operation: string,
    cause: Schema.SchemaError,
    correlation?: PersistenceErrorCorrelation,
  ): PersistenceDecodeError {
    return new PersistenceDecodeError({
      operation,
      issue: summarizeSchemaIssue(cause.issue),
      ...(correlation === undefined ? {} : { correlation }),
      cause,
    });
  }

  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
