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
import type { Algorithm, Options } from "@node-rs/argon2";
import { verificationGate } from "@/lib/auth/verification-gate";

// The package's `Algorithm` is an ambient const enum, which this project's
// `isolatedModules` forbids reading at runtime. 2 is `Algorithm.Argon2id` in
// its own index.d.ts, and the PHC header this module writes and reads back
// (see `readPhcHeader` below) reports the same numbering.
const ARGON2ID = 2 as Algorithm;

/*
 * `@node-rs/argon2` is loaded lazily, not at module import time (#912,
 * ADR-0015 decision 3). The CLI bundle (`scripts/bundle-orbit-cli.mjs`)
 * reaches this module through `local-credentials.ts`'s `issueSetupToken`,
 * which `orbit auth recovery-link` calls — and that path never hashes or
 * verifies a password. Importing this module used to run the package's own
 * top-level native-binding `require()` regardless, which esbuild cannot
 * inline (it is a compiled `.node` file) and which the shipped CLI has no
 * node_modules to resolve at runtime either way (only `hashPassword`,
 * `verifyPassword` and `decoyHash` actually touch the binding, and each
 * loads it through `loadArgon2` below on first real use, cached for the rest
 * of the process). `scripts/bundle-orbit-cli.mjs` marks the package external
 * for the same reason: bundled or not, nothing here forces it to load.
 */
type Argon2Module = typeof import("@node-rs/argon2");
let argon2Module: Promise<Argon2Module> | undefined;

function loadArgon2(): Promise<Argon2Module> {
  argon2Module ??= import("@node-rs/argon2");
  return argon2Module;
}

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
  const { hash } = await loadArgon2();
  return verificationGate.run(() => hash(normalized, PASSWORD_POLICY));
}

/** The PHC string's own header: `$argon2<variant>$v=<version>$m=<n>,t=<n>,p=<n>$...`. */
const PHC_HEADER_PATTERN = /^\$argon2(id|i|d)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/u;

const PHC_ALGORITHM_BY_VARIANT = { d: 0, i: 1, id: 2 } as Record<"d" | "i" | "id", Algorithm>;

/**
 * Reads just the four PHC-header fields `needsRehash` compares against the
 * policy, by matching the header text directly rather than through
 * `@node-rs/argon2`'s own `parseOptions` (#912): `needsRehash` is called
 * synchronously from `verifyPassword` and its result is asserted
 * synchronously in `password.test.ts`, so it cannot become an async
 * `loadArgon2` caller without changing its exported signature — and it does
 * not need to, since every field it reads is already plain text in the
 * stored string. Returns null for anything that does not match, exactly the
 * cases a caught `parseOptions` throw used to cover.
 */
function readPhcHeader(storedHash: string): { algorithm: Algorithm; memoryCost: number; timeCost: number; parallelism: number } | null {
  const match = PHC_HEADER_PATTERN.exec(storedHash);
  if (!match) return null;
  const [, variant, memoryCost, timeCost, parallelism] = match;
  return {
    algorithm: PHC_ALGORITHM_BY_VARIANT[variant as "d" | "i" | "id"],
    memoryCost: Number(memoryCost),
    timeCost: Number(timeCost),
    parallelism: Number(parallelism),
  };
}

/**
 * True when `storedHash` was made below the current policy in any of `m`,
 * `t` or `p`, or is not Argon2id. A hash *stronger* than the policy never
 * triggers a rehash, so lowering the policy quietly is not a way to weaken
 * existing credentials. An unreadable hash reports true: it could not have
 * verified anyway, and re-hashing is the safe answer.
 */
export function needsRehash(storedHash: string): boolean {
  const parsed = readPhcHeader(storedHash);
  if (!parsed) return true;
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
  const { verify } = await loadArgon2();
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
  decoy ??= (async () => {
    const { hash } = await loadArgon2();
    return verificationGate.run(() => hash(randomBytes(32), PASSWORD_POLICY));
  })().catch((error: unknown) => {
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
