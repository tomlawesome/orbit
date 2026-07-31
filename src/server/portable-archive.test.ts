import { describe, expect, it } from "vitest";
import { decryptPortableArchive, encryptPortableArchive } from "./portable-archive";

describe("portable archive encryption", () => {
  it("round-trips an archive only with its passphrase", () => {
    const encrypted = encryptPortableArchive(Buffer.from('{"format":"orbit"}'), "correct-horse-battery-staple");
    expect(decryptPortableArchive(encrypted, "correct-horse-battery-staple").toString()).toBe('{"format":"orbit"}');
    expect(() => decryptPortableArchive(encrypted, "wrong-passphrase-123")).toThrow();
  });
});
