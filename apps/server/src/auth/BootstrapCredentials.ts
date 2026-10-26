// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const PAIRING_TOKEN_TTL = Duration.minutes(15);

export class BootstrapCredentialInvalidError extends Schema.TaggedError<BootstrapCredentialInvalidError>()(
  "BootstrapCredentialInvalidError",
  { reason: Schema.Literals(["unknown", "expired"]) },
) {
  override get message(): string {
    return `The bootstrap credential is not usable (${this.reason}).`;
  }
}

export class PairingTokenIssueError extends Schema.TaggedError<PairingTokenIssueError>()(
  "PairingTokenIssueError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to issue a pairing token.";
  }
}

const tokensMatch = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

/**
 * Credentials a client trades once for a session: the token the desktop shell passes at launch,
 * which stays valid for the process lifetime, and one-time pairing tokens printed for browsers.
 */
export class BootstrapCredentials extends Context.Service<
  BootstrapCredentials,
  {
    readonly issuePairingToken: Effect.Effect<
      { readonly token: string; readonly expiresAt: DateTime.Utc },
      PairingTokenIssueError
    >;
    readonly consume: (
      credential: string,
    ) => Effect.Effect<"desktop" | "pairing", BootstrapCredentialInvalidError>;
  }
>()("@app/server/auth/BootstrapCredentials") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const { desktopBootstrapToken } = yield* ServerConfig.ServerConfig;
  const pairingTokens = yield* Ref.make(new Map<string, DateTime.Utc>());

  const issuePairingToken = Effect.gen(function* () {
    const bytes = yield* crypto
      .randomBytes(32)
      .pipe(Effect.mapError((cause) => new PairingTokenIssueError({ cause })));
    const token = Buffer.from(bytes).toString("base64url");
    const now = yield* DateTime.now;
    const expiresAt = DateTime.addDuration(now, PAIRING_TOKEN_TTL);
    yield* Ref.update(pairingTokens, (current) =>
      new Map(
        [...current].filter(([, tokenExpiry]) => DateTime.isGreaterThan(tokenExpiry, now)),
      ).set(token, expiresAt),
    );
    return { token, expiresAt };
  }).pipe(Effect.withSpan("BootstrapCredentials.issuePairingToken"));

  const consume = Effect.fn("BootstrapCredentials.consume")(function* (credential: string) {
    if (desktopBootstrapToken !== undefined && tokensMatch(credential, desktopBootstrapToken)) {
      return "desktop" as const;
    }
    const expiresAt = yield* Ref.modify(pairingTokens, (current) => {
      const found = current.get(credential);
      if (found === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(credential);
      return [found, next] as const;
    });
    if (expiresAt === undefined) {
      return yield* new BootstrapCredentialInvalidError({ reason: "unknown" });
    }
    if (DateTime.isLessThanOrEqualTo(expiresAt, yield* DateTime.now)) {
      return yield* new BootstrapCredentialInvalidError({ reason: "expired" });
    }
    return "pairing" as const;
  });

  return BootstrapCredentials.of({ issuePairingToken, consume });
});

export const layer = Layer.effect(BootstrapCredentials, make);
