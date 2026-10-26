import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export type BootstrapMethod = "desktop-bootstrap" | "one-time-token";

export interface BootstrapGrant {
  readonly method: BootstrapMethod;
  readonly subject: string;
  readonly expiresAt: DateTime.Utc;
}

export class UnknownBootstrapCredentialError extends Schema.TaggedError<UnknownBootstrapCredentialError>()(
  "UnknownBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Unknown bootstrap credential.";
  }
}

export class ExpiredBootstrapCredentialError extends Schema.TaggedError<ExpiredBootstrapCredentialError>()(
  "ExpiredBootstrapCredentialError",
  {},
) {
  override get message(): string {
    return "Bootstrap credential expired.";
  }
}

export const BootstrapCredentialInvalidError = Schema.Union([
  UnknownBootstrapCredentialError,
  ExpiredBootstrapCredentialError,
]);

export type BootstrapCredentialInvalidError = typeof BootstrapCredentialInvalidError.Type;

export class PairingCredentialRandomGenerationError extends Schema.TaggedError<PairingCredentialRandomGenerationError>()(
  "PairingCredentialRandomGenerationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to generate pairing credential data.";
  }
}

export interface IssuedBootstrapCredential {
  readonly credential: string;
  readonly expiresAt: DateTime.Utc;
}

/**
 * Credentials a client trades for a session: the token the desktop shell passes at launch, valid
 * for 24 hours and any number of exchanges, and one-time pairing tokens printed for browsers.
 */
export class BootstrapCredentials extends Context.Service<
  BootstrapCredentials,
  {
    readonly issueOneTimeToken: Effect.Effect<
      IssuedBootstrapCredential,
      PairingCredentialRandomGenerationError
    >;
    readonly consume: (
      credential: string,
    ) => Effect.Effect<BootstrapGrant, BootstrapCredentialInvalidError>;
  }
>()("@app/server/auth/BootstrapCredentials") {}

interface StoredBootstrapGrant extends BootstrapGrant {
  readonly remainingUses: number | "unbounded";
}

type ConsumeResult = Result.Result<BootstrapGrant, BootstrapCredentialInvalidError>;

const DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES = Duration.minutes(5);
const DESKTOP_BOOTSTRAP_TTL_HOURS = Duration.hours(24);
const DEV_STARTUP_TTL_HOURS = Duration.hours(24);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const grantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());

  const seedGrant = (credential: string, grant: StoredBootstrapGrant) =>
    Ref.update(grantsRef, (current) => {
      const next = new Map(current);
      next.set(credential, grant);

      return next;
    });

  if (config.desktopBootstrapToken) {
    const now = yield* DateTime.now;
    yield* seedGrant(config.desktopBootstrapToken, {
      method: "desktop-bootstrap",
      subject: "desktop-bootstrap",
      expiresAt: DateTime.addDuration(now, DESKTOP_BOOTSTRAP_TTL_HOURS),
      // Reloads and expired bearer sessions must be able to re-exchange the desktop seed.
      remainingUses: "unbounded",
    });
  }

  const issueOneTimeToken = Effect.gen(function* () {
    const bytes = yield* crypto
      .randomBytes(32)
      .pipe(Effect.mapError((cause) => new PairingCredentialRandomGenerationError({ cause })));

    const credential = Buffer.from(bytes).toString("base64url");

    // The dev server restarts often; a startup link that outlives a few restarts saves re-pairing.
    const ttl =
      config.devUrl === undefined ? DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES : DEV_STARTUP_TTL_HOURS;

    const expiresAt = DateTime.addDuration(yield* DateTime.now, ttl);
    yield* seedGrant(credential, {
      method: "one-time-token",
      subject: "one-time-token",
      expiresAt,
      remainingUses: 1,
    });

    return { credential, expiresAt } satisfies IssuedBootstrapCredential;
  }).pipe(Effect.withSpan("BootstrapCredentials.issueOneTimeToken"));

  const consume: BootstrapCredentials["Service"]["consume"] = Effect.fn(
    "BootstrapCredentials.consume",
  )(function* (credential) {
    const now = yield* DateTime.now;

    // One Ref.modify finds, checks and spends the grant, so racing requests cannot both spend it.
    const result: ConsumeResult = yield* Ref.modify(
      grantsRef,
      (current): readonly [ConsumeResult, Map<string, StoredBootstrapGrant>] => {
        const grant = current.get(credential);

        if (!grant) {
          return [Result.fail(new UnknownBootstrapCredentialError({})), current];
        }

        const next = new Map(current);

        if (DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt)) {
          next.delete(credential);

          return [Result.fail(new ExpiredBootstrapCredentialError({})), next];
        }

        const remainingUses = grant.remainingUses;

        if (remainingUses !== "unbounded") {
          if (remainingUses <= 1) {
            next.delete(credential);
          } else {
            next.set(credential, { ...grant, remainingUses: remainingUses - 1 });
          }
        }

        return [
          Result.succeed({
            method: grant.method,
            subject: grant.subject,
            expiresAt: grant.expiresAt,
          }),
          next,
        ];
      },
    );

    return yield* Effect.fromResult(result);
  });

  return BootstrapCredentials.of({ issueOneTimeToken, consume });
});

export const layer = Layer.effect(BootstrapCredentials, make);
