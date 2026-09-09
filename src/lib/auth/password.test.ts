import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY,
  PasswordRejectedError,
  checkPasswordBounds,
  decoyHash,
  hashPassword,
  needsRehash,
  passwordLength,
  verifyAgainstDecoy,
  verifyPassword,
} from "./password";

const password = "correct horse battery staple";

// The same accented password composed two ways: U+00E9, and "e" plus the
// combining acute U+0301. NFC folds the second into the first.
const composedAccents = "é".repeat(12);
const decomposedAccents = "é".repeat(12);

describe("Argon2id password hashing", () => {
  it("hashes at the parameters ADR-0021 §2 fixed", async () => {
    expect(PASSWORD_POLICY).toEqual({
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
      algorithm: 2,
    });

    const stored = await hashPassword(password);
    // A 16-byte salt is 22 base64 characters, a 32-byte tag 43.
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[^$]{22}\$[^$]{43}$/u);
  });

  it("round-trips a password and refuses a wrong one", async () => {
    const stored = await hashPassword(password);
    await expect(verifyPassword(stored, password)).resolves.toEqual({ verified: true, needsRehash: false });
    await expect(verifyPassword(stored, "correct horse battery stapl")).resolves.toEqual({
      verified: false,
      needsRehash: false,
    });
  });

  it("salts every hash, so the same password stores differently twice", async () => {
    const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
    expect(first).not.toBe(second);
  });

  it("reports needsRehash for a hash made below the current policy", async () => {
    const weak = await hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1, algorithm: 2 });
    expect(needsRehash(weak)).toBe(true);
    await expect(verifyPassword(weak, password)).resolves.toEqual({ verified: true, needsRehash: true });
  });

  it("reports needsRehash for a hash that is not Argon2id, and for an unreadable one", async () => {
    const argon2i = await hash(password, { ...PASSWORD_POLICY, memoryCost: 8, timeCost: 1, algorithm: 1 });
    expect(needsRehash(argon2i)).toBe(true);
    expect(needsRehash("not-a-phc-string")).toBe(true);
  });

  it("never asks for a rehash of a hash stronger than the policy", async () => {
    const strong = await hash(password, { ...PASSWORD_POLICY, timeCost: 4 });
    expect(needsRehash(strong)).toBe(false);
  });

  it("treats an unusable stored hash as a failed verification, not an error", async () => {
    await expect(verifyPassword("not-a-phc-string", password)).resolves.toEqual({
      verified: false,
      needsRehash: false,
    });
  });
});

describe("password bounds and normalisation", () => {
  it("rejects a 300-code-point password before hashing", async () => {
    const tooLong = "a".repeat(300);
    expect(passwordLength(tooLong)).toBe(300);
    expect(checkPasswordBounds(tooLong)).toBe("too_long");
    await expect(hashPassword(tooLong)).rejects.toBeInstanceOf(PasswordRejectedError);
    await expect(hashPassword(tooLong)).rejects.toMatchObject({ reason: "too_long" });
  });

  it("rejects a password below the twelve-character floor", async () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(MAX_PASSWORD_LENGTH).toBe(256);
    expect(checkPasswordBounds("a".repeat(11))).toBe("too_short");
    expect(checkPasswordBounds("a".repeat(12))).toBeNull();
    await expect(hashPassword("a".repeat(11))).rejects.toMatchObject({ reason: "too_short" });
  });

  it("refuses an over-long password at verification without touching the stored hash", async () => {
    await expect(verifyPassword("not-a-phc-string", "a".repeat(257))).resolves.toEqual({
      verified: false,
      needsRehash: false,
    });
  });

  it("counts code points after NFC, so a decomposed accent is one character", () => {
    expect(decomposedAccents.length).toBe(24);
    expect(passwordLength(composedAccents)).toBe(12);
    expect(passwordLength(decomposedAccents)).toBe(12);
    expect(checkPasswordBounds(decomposedAccents)).toBeNull();
  });

  it("matches the same password however the client composed its accents", async () => {
    const stored = await hashPassword(composedAccents);
    await expect(verifyPassword(stored, decomposedAccents)).resolves.toMatchObject({ verified: true });
  });
});

describe("the decoy hash", () => {
  it("is one fixed hash at the current policy, reused for the life of the process", async () => {
    const [first, second] = await Promise.all([decoyHash(), decoyHash()]);
    expect(first).toBe(second);
    expect(needsRehash(first)).toBe(false);
  });

  it("verifies a supplied password against it and reports nothing back", async () => {
    await expect(verifyAgainstDecoy(password)).resolves.toBeUndefined();
  });
});
