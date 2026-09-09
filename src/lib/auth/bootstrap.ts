/*
 * The instance claim (ADR-0022).
 *
 * An Orbit instance is UNCLAIMED until `instance_authority` has a row. While
 * it is, the process holds one 32-byte code in memory and prints it as the
 * last act of start-up; presenting that code is the only way to become the
 * first administrator. The code is never written to the database, to a file,
 * to any operational-log record or into any response body, and it is
 * regenerated on every restart — "I lost the code" is answered by
 * `docker compose restart orbit-app` and reading the log again.
 *
 * Whoever can read the container's log while the instance is unclaimed can
 * claim it (ADR-0022 §6). That is the trust boundary, stated plainly, and it
 * is the reason nothing here persists anything.
 */

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { instanceAuthority } from "@/db/schema";
import { constantTimeEqual, openProof, sealProof } from "@/lib/auth/crypto";
import { verificationGate } from "@/lib/auth/verification-gate";
import { getAuthConfig, type AuthConfig } from "@/lib/env";
import type { CookieSink } from "@/lib/http";
import { getLogFormat, log } from "@/lib/logger";

/** RFC 4648 base32, upper case: no lower/upper confusion when read off a log. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 32 bytes, as ADR-0022 §1 says; 52 base32 characters carry them. */
const CLAIM_BYTES = 32;

/** Groups of four, so the code can be read aloud and typed by hand. */
const CLAIM_GROUP_SIZE = 4;

/** The audience that keeps a claim cookie from opening as anything else. */
export const CLAIM_PROOF_AUDIENCE = "bootstrap-claim";

/**
 * Five minutes (ADR-0022 §2), matching the recovery link: the operator has
 * just clicked the link and is at the keyboard, and a lapse costs one more
 * click because the code stays valid until the next restart.
 */
export const CLAIM_COOKIE_TTL_SECONDS = 300;

/** Longer than any real code; bounds the work a hostile body can ask for. */
const MAX_CLAIM_INPUT_LENGTH = 256;

/* The same shape as the sign-in backoff (ADR-0023 §4), keyed on the one
   literal `bootstrap` because there is exactly one claim per process. It is
   held in memory rather than in a row: the secret it protects is itself only
   in memory, so a backoff that outlived the process would be guarding a code
   that no longer exists, and a restart already replaces the code it would
   have been protecting. */
const CLAIM_FREE_ATTEMPTS = 5;
const CLAIM_BACKOFF_FLOOR_MS = 1_000;
const CLAIM_BACKOFF_CEILING_MS = 900_000;

interface ClaimBackoff {
  failures: number;
  lockedUntil: number;
}

interface ClaimState {
  /** Normalised (ungrouped, upper case) — what an entered code is compared with. */
  normalised: string;
  /** Grouped for display: the form printed in the notice and in the link. */
  display: string;
}

let activeClaim: ClaimState | undefined;
let backoff: ClaimBackoff = { failures: 0, lockedUntil: 0 };
let clock = (): number => Date.now();

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // The trailing partial group is padded with zero bits rather than dropped,
  // so every bit of entropy reaches the printed code.
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function group(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += CLAIM_GROUP_SIZE) {
    groups.push(code.slice(index, index + CLAIM_GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Case-insensitive on entry, with whitespace and hyphens ignored
 * (ADR-0022 §1): a code read off a log and typed by hand should not fail on
 * how it was spaced.
 */
export function normaliseClaim(value: string): string {
  return value.slice(0, MAX_CLAIM_INPUT_LENGTH).replace(/[\s-]/gu, "").toUpperCase();
}

/** A fresh claim code. Never stored anywhere by this function. */
export function generateClaim(): ClaimState {
  const normalised = encodeBase32(randomBytes(CLAIM_BYTES));
  return { normalised, display: group(normalised) };
}

/** Whether the instance already has a primary administrator. */
export async function isClaimed(): Promise<boolean> {
  const [row] = await getDb().select({ total: sql<number>`count(*)::int` }).from(instanceAuthority);
  return (row?.total ?? 0) > 0;
}

/** True while this process holds a live claim code. */
export function hasActiveClaim(): boolean {
  return activeClaim !== undefined;
}

/**
 * The notice, exactly as ADR-0022 §1 writes it. Built here rather than at the
 * print site so its wording is under test without capturing stdout.
 */
export function formatClaimNotice(claim: ClaimState, config: AuthConfig, format = getLogFormat()): string {
  const link = new URL(config.appUrl.href);
  link.hash = `claim=${claim.display}`;
  if (format === "json") {
    return JSON.stringify({ event: "bootstrap.claim", url: link.href, code: claim.display });
  }
  return [
    "Orbit is not yet claimed. Open this link to create the first administrator:",
    `  ${link.href}`,
    `or enter the code by hand on the sign-in screen: ${claim.display}`,
  ].join("\n");
}

/**
 * The last act of start-up (ADR-0022 §1), called by `registerNode`.
 *
 * This is the ONE documented bypass of the `operationalDetail` protocol: the
 * notice carries a URL and a secret, which that protocol renders
 * `[unavailable]` by design, so it is written straight to stdout instead. It
 * is the only place in Orbit that prints a secret, and nothing else may copy
 * the pattern.
 *
 * Nothing is generated or printed once `instance_authority` exists, so a
 * restored backup — which carries the authority row — never prints a code.
 */
export async function printClaimNotice(options: { write?: (line: string) => void } = {}): Promise<void> {
  const write = options.write ?? ((line: string) => { console.log(line); });

  let claimed: boolean;
  try {
    claimed = await isClaimed();
  } catch {
    /* The claimed state could not be read, so no code is generated and none
       is printed: an instance nobody can claim is the safe direction, and the
       remedy is the same restart that rotates the code. */
    activeClaim = undefined;
    log.warn({
      event: "auth.configuration",
      state: "degraded",
      reason: "dependency_unavailable",
      action: "check_database",
      impact: "sign_in_blocked",
    });
    return;
  }

  if (claimed) {
    activeClaim = undefined;
    return;
  }

  let config: AuthConfig;
  let claim: ClaimState;
  try {
    config = getAuthConfig();
    claim = generateClaim();
  } catch {
    /* Fail closed (ADR-0022 §3): with no code there is no way to claim the
       instance, so the process refuses to run rather than sit unclaimable. */
    log.error({
      event: "auth.configuration",
      state: "blocked",
      reason: "configuration_invalid",
      action: "check_configuration",
      impact: "sign_in_blocked",
    });
    throw new Error("bootstrap_claim_unavailable");
  }

  activeClaim = claim;
  backoff = { failures: 0, lockedUntil: 0 };
  log.warn({
    event: "auth.configuration",
    state: "degraded",
    reason: "bootstrap_unclaimed",
    action: "none",
    impact: "sign_in_blocked",
  });
  write(formatClaimNotice(claim, config));
}

/** Why a claim attempt did not succeed. All of them answer `bootstrap_invalid`. */
export type ClaimRefusal = "unavailable" | "mismatch" | "throttled";

export type ClaimVerdict = { accepted: true } | { accepted: false; refusal: ClaimRefusal };

/**
 * Compares an entered code with the one this process holds, behind the
 * verification gate and the per-process backoff (ADR-0022 §2). Every refusal
 * is the same generic answer at the route: a caller learns whether they got
 * it right and nothing else.
 */
export async function verifyClaim(input: string): Promise<ClaimVerdict> {
  const claim = activeClaim;
  if (!claim) return { accepted: false, refusal: "unavailable" };

  const now = clock();
  if (now < backoff.lockedUntil) return { accepted: false, refusal: "throttled" };

  const matched = await verificationGate.run(async () => constantTimeEqual(normaliseClaim(input), claim.normalised));
  if (matched) {
    backoff = { failures: 0, lockedUntil: 0 };
    return { accepted: true };
  }

  const failures = backoff.failures + 1;
  const overrun = failures - CLAIM_FREE_ATTEMPTS;
  const penaltyMs = overrun <= 0
    ? 0
    : Math.min(CLAIM_BACKOFF_FLOOR_MS * 2 ** (overrun - 1), CLAIM_BACKOFF_CEILING_MS);
  backoff = { failures, lockedUntil: penaltyMs > 0 ? now + penaltyMs : 0 };
  log.warn({
    event: "auth.configuration",
    state: "invalid",
    reason: "bootstrap_rejected",
    action: "none",
    impact: "sign_in_blocked",
  });
  return { accepted: false, refusal: "mismatch" };
}

export function claimCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Secure-orbit-claim" : "orbit-claim";
}

/**
 * Mints the claim cookie: a sealed proof that this browser presented the code,
 * good for five minutes and for nothing else. It carries no secret — the code
 * itself never leaves this process — only the fact that the check passed.
 */
export async function sealClaimProof(config: AuthConfig): Promise<string> {
  return sealProof({ claim: true }, CLAIM_PROOF_AUDIENCE, CLAIM_COOKIE_TTL_SECONDS, config);
}

/** True only for a live, correctly sealed claim cookie. Never throws. */
export async function hasClaimProof(cookies: CookieSink, config: AuthConfig): Promise<boolean> {
  const value = cookies.get(claimCookieName(config));
  if (!value) return false;
  try {
    const payload = await openProof(value, CLAIM_PROOF_AUDIENCE, config);
    return payload.claim === true;
  } catch {
    // Expired, forged, or sealed for another audience: all the same answer.
    return false;
  }
}

export function setClaimCookie(cookies: CookieSink, value: string, config: AuthConfig): void {
  cookies.set(claimCookieName(config), value, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: CLAIM_COOKIE_TTL_SECONDS,
  });
}

export function clearClaimCookie(cookies: CookieSink, config: AuthConfig): void {
  cookies.set(claimCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Test-only seam: the claim this process holds, and the backoff around it. */
export function setActiveClaimForTests(claim: ClaimState | undefined): void {
  activeClaim = claim;
  backoff = { failures: 0, lockedUntil: 0 };
}

/** Test-only seam: drives the backoff without waiting out a real penalty. */
export function setBootstrapClockForTests(nextClock: (() => number) | undefined): void {
  clock = nextClock ?? (() => Date.now());
}
