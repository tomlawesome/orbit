import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INVITATION_LIFETIME_DAYS,
  INVITATION_TOKEN_BYTES,
  createInvitationToken,
  invitationEmailDigest,
  invitationExpiry,
  invitationTokenDigest,
  normaliseInvitationEmail,
} from "./token";

describe("the invitation token", () => {
  it("carries 32 bytes of randomness in a form a URL and a mail client survive", () => {
    const token = createInvitationToken();
    expect(INVITATION_TOKEN_BYTES).toBe(32);
    /* base64url only: nothing that a path, a line wrap or a copy-paste can
       change, and nothing needing percent-encoding. */
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createInvitationToken()));
    expect(seen.size).toBe(200);
  });

  it("digests with SHA-256, so the stored row cannot reconstruct a link", () => {
    const token = createInvitationToken();
    const digest = invitationTokenDigest(token);
    expect(digest).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(token);
    expect(invitationTokenDigest(token)).toBe(digest);
    expect(invitationTokenDigest(`${token}x`)).not.toBe(digest);
  });

  it("lapses fourteen days after it is made", () => {
    expect(INVITATION_LIFETIME_DAYS).toBe(14);
    expect(invitationExpiry(new Date("2026-09-06T12:00:00.000Z")).toISOString())
      .toBe("2026-09-20T12:00:00.000Z");
  });
});

describe("the invited address", () => {
  it("is trimmed and case-folded, which is the whole of the ratified rule", () => {
    expect(normaliseInvitationEmail("  Priya@Example.COM \n")).toBe("priya@example.com");
    expect(normaliseInvitationEmail("priya@example.com")).toBe("priya@example.com");
  });

  it("keeps the parts a provider may care about, guessing nothing on its behalf", () => {
    /* Plus tags and dots mean different things at different providers, so
       folding them here would either misdeliver or refuse to match. */
    expect(normaliseInvitationEmail("Priya+orbit@example.com")).toBe("priya+orbit@example.com");
    expect(normaliseInvitationEmail("p.riya@example.com")).toBe("p.riya@example.com");
  });

  it("audits as a digest of the normalised address, never the address", () => {
    const digest = invitationEmailDigest(" PRIYA@example.com ");
    expect(digest).toBe(invitationEmailDigest("priya@example.com"));
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain("priya");
    expect(digest).not.toContain("@");
  });
});
