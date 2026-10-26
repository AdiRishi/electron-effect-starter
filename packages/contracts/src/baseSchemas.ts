import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const trim = (value: string) => {
  const trimmed = value.trim();

  return trimmed.length === value.length ? value : trimmed;
};

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => Effect.succeed(trim(value)),
      encode: (value) => Effect.succeed(trim(value)),
    }),
  ),
);

// `make` and encode see untrimmed values; `isNonEmpty` would accept whitespace that encodes to an invalid empty string.
const isNonBlank = Schema.makeFilter((value: string) => value.trim().length > 0, {
  expected: "a non-blank string",
  toJsonSchema: () => [{ minLength: 1 }, true],
  arbitraryConstraint: { minLength: 1 },
});

export const TrimmedNonEmptyString = TrimmedString.check(isNonBlank);

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const makeEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const AuthSessionId = makeEntityId("AuthSessionId");

export type AuthSessionId = typeof AuthSessionId.Type;

export const NoteId = makeEntityId("NoteId");

export type NoteId = typeof NoteId.Type;
