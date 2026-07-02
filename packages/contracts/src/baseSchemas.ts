import * as Schema from "effect/Schema";

/**
 * Shared refined primitives for wire contracts. Prefer these over bare
 * `Schema.String` / `Schema.Number` so validation happens once at the
 * boundary and every consumer can trust decoded values.
 */
export const TrimmedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
