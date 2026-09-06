import { createHash, randomBytes } from "node:crypto";
import { base64url } from "jose";

/**
 * The invitation's secret, and the two things that are stored instead of it
 * (#481).
 *
 * The token is 32 random bytes, base64url so it survives a URL path, a mail
 * client's line wrapping and a copy-paste. It exists in exactly two places —
 * the mail, and the invitee's own short-lived cookie — and in neither of them
 * does Orbit keep a copy: the row holds the SHA-256 digest, which is enough to
 * recognise a link and useless for making one.
 *
 * The address is stored normalised for the same reason a digest is: the
 * ratified rule (#481, Q43) is that the signed-in identity's address must
 * MATCH the invited one, so the comparison has to be made on bytes that were
 * settled once, at the seam, rather than on whatever casing two systems
 * happened to use.
 */

/** 32 bytes: the same strength as a session token, and for the same reason. */
export const INVITATION_TOKEN_BYTES = 32;

export function createInvitationToken(): string {
  return base64url.encode(randomBytes(INVITATION_TOKEN_BYTES));
}

export function invitationTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Trimmed and case-folded, which is the whole of the ratified rule.
 *
 * Nothing cleverer: no plus-tag stripping, no dot-folding, no per-provider
 * knowledge. Those are guesses about somebody else's mail server, and a guess
 * here either delivers an invitation to an address the owner did not type or
 * refuses to match the person who was invited.
 */
export function normaliseInvitationEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The address as it appears in an audit row: never the address itself (#481).
 *
 * The audit trail has to be able to say "this invitation, to this address, was
 * withdrawn" and let two rows be compared, without the log becoming a list of
 * everyone an owner has ever tried to invite.
 */
export function invitationEmailDigest(email: string): string {
  return createHash("sha256").update(normaliseInvitationEmail(email), "utf8").digest("hex");
}

/** 14 days — the same window a retiring mail-in alias is given. */
export const INVITATION_LIFETIME_DAYS = 14;

export function invitationExpiry(from: Date): Date {
  return new Date(from.getTime() + INVITATION_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
}
