// Local password hashing, exactly as ADR-0021 records it: Argon2id through
// `@node-rs/argon2`, m = 64 MiB, t = 3, p = 1, a 16-byte random salt and a
// 32-byte tag. Every derivation in the process — hashing and verifying alike
// — goes through the verification gate, so the memory a login flood can
// reach is bounded here rather than at each call site.
//
// The stored value is the PHC string the library produces
// (`$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`). It is self-describing, so
// a credential always carries the parameters it was made with and raising the
// policy needs no migration: `needsRehash` notices on the next sign-in.
//
// Nothing here logs, audits or returns password plaintext, and nothing here
// should start to.

import { randomBytes } from "node:crypto";
import { hash, parseOptions, verify } from "@node-rs/argon2";
import type { Algorithm, Options } from "@node-rs/argon2";
import { verificationGate } from "@/lib/auth/verification-gate";

// The package's `Algorithm` is an ambient const enum, which this project's
// `isolatedModules` forbids reading at runtime. 2 is `Algorithm.Argon2id` in
// its own index.d.ts, and `parseOptions` reports the same numbering back.
const ARGON2ID = 2 as Algorithm;

/**
 * The current hashing policy (ADR-0021 §2): RFC 9106's memory-constrained
 * option with parallelism reduced to 1, comfortably above OWASP's floor.
 * `p = 1` keeps the gate's memory accounting exact — one derivation, one
 * 64 MiB arena — and keeps Argon2 off the request threadpool's back.
 *
 * Raising any of these is a one-line change: existing credentials are
 * upgraded as their owners sign in. Lowering them is not supported.
 */
export const PASSWORD_POLICY = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
  algorithm: ARGON2ID,
} as const satisfies Options;

/** Same floor as `MIN_RECOVERY_PASSPHRASE_LENGTH`: one number to remember. */
export const MIN_PASSWORD_LENGTH = 12;

/** Bounds the Argon2 input. Counted in code points, like the floor. */
export const MAX_PASSWORD_LENGTH = 256;

/** Why a password was refused before any derivation was attempted. */
export type PasswordRejectionReason = "too_short" | "too_long";

/** Thrown by {@link hashPassword} for a password outside the bounds. */
export class PasswordRejectedError extends Error {
  constructor(public readonly reason: PasswordRejectionReason) {
    super(
      reason === "too_short"
        ? `Use a password of at least ${MIN_PASSWORD_LENGTH} characters`
        : `Use a password of at most ${MAX_PASSWORD_LENGTH} characters`,
    );
    this.name = "PasswordRejectedError";
  }
}

export interface PasswordVerification {
  /** Whether the supplied password matched the stored hash. */
  verified: boolean;
  /**
   * Whether the stored hash was made below the current policy. Only
   * meaningful when `verified` is true: the caller then re-hashes the
   * plaintext it already holds and stores the result in the same
   * transaction that clears the failure counter (ADR-0021 §3).
   */
  needsRehash: boolean;
}

/**
 * NFC normalisation, so the same typed password matches however the client
 * composed its accents. Applied identically on the way in and on every
 * verification, which is what makes it safe.
 */
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}

/** Code points, not UTF-16 units: an emoji is one character to the person typing it. */
export function passwordLength(password: string): number {
  return [...normalizePassword(password)].length;
}

/**
 * The bounds check, separated so a route can answer `password_rejected`
 * without provoking a derivation. Returns null when the password is
 * acceptable.
 */
export function checkPasswordBounds(password: string): PasswordRejectionReason | null {
  const length = passwordLength(password);
  if (length < MIN_PASSWORD_LENGTH) return "too_short";
  if (length > MAX_PASSWORD_LENGTH) return "too_long";
  return null;
}

/**
 * Hashes a new or changed password at the current policy, returning the PHC
 * string to store. Refuses an out-of-bounds password before spending a
 * derivation on it, and may be refused by the verification gate.
 */
export async function hashPassword(password: string): Promise<string> {
  const rejection = checkPasswordBounds(password);
  if (rejection) throw new PasswordRejectedError(rejection);
  const normalized = normalizePassword(password);
  return verificationGate.run(() => hash(normalized, PASSWORD_POLICY));
}

/**
 * True when `storedHash` was made below the current policy in any of `m`,
 * `t` or `p`, or is not Argon2id. A hash *stronger* than the policy never
 * triggers a rehash, so lowering the policy quietly is not a way to weaken
 * existing credentials. An unreadable hash reports true: it could not have
 * verified anyway, and re-hashing is the safe answer.
 */
export function needsRehash(storedHash: string): boolean {
  let parsed;
  try {
    parsed = parseOptions(storedHash);
  } catch {
    return true;
  }
  return parsed.algorithm !== PASSWORD_POLICY.algorithm
    || parsed.memoryCost < PASSWORD_POLICY.memoryCost
    || parsed.timeCost < PASSWORD_POLICY.timeCost
    || parsed.parallelism < PASSWORD_POLICY.parallelism;
}

/**
 * Verifies a password against a stored PHC string, reporting whether the
 * stored hash is now below policy. May be refused by the verification gate.
 *
 * Only the upper bound is enforced here, and only to keep the Argon2 input
 * bounded: rejecting a short password at verification time would lock out a
 * credential that was valid when it was set, were the floor ever raised. The
 * refusal depends solely on the attacker's own input, so it reveals nothing
 * about whether the account exists.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<PasswordVerification> {
  if (passwordLength(password) > MAX_PASSWORD_LENGTH) {
    return { verified: false, needsRehash: false };
  }
  const normalized = normalizePassword(password);
  const verified = await verificationGate.run(async () => {
    try {
      return await verify(storedHash, normalized, PASSWORD_POLICY);
    } catch {
      // A malformed or foreign stored hash is a failed verification, not a
      // 500: the credential row is simply unusable.
      return false;
    }
  });
  return { verified, needsRehash: verified && needsRehash(storedHash) };
}

// The decoy (ADR-0021 §5). A sign-in naming an address with no credential row
// verifies against this instead, so an unknown account costs the same
// derivation as a wrong password and the answer is the same generic
// `credentials_invalid` either way. The secret behind it is random per
// process and never leaves it, so the decoy cannot be precomputed or
// recognised.
let decoy: Promise<string> | null = null;

/**
 * The process's fixed decoy hash, made once at the current policy. Awaiting
 * this at boot moves its one-off cost off the first sign-in.
 */
export function decoyHash(): Promise<string> {
  /* A refusal must not be memoised. `??=` keeps whatever promise it assigned,
     so a gate refusal on the first-ever decoy would stay cached for the life
     of the process: every sign-in naming an unknown address would answer
     `too_many_attempts` while a known one answered `credentials_invalid`,
     which is exactly the oracle §5 exists to close. Clearing the slot lets
     the next caller make the decoy properly. */
  decoy ??= verificationGate.run(() => hash(randomBytes(32), PASSWORD_POLICY)).catch((error: unknown) => {
    decoy = null;
    throw error;
  });
  return decoy;
}

/**
 * Spends the same derivation a real verification would, then discards the
 * result. Called where no credential row exists, so the two paths cost the
 * same. Gate refusals still propagate — an unknown account must not be the
 * one request the gate lets through.
 */
export async function verifyAgainstDecoy(password: string): Promise<void> {
  const hashed = await decoyHash();
  await verifyPassword(hashed, password);
}
