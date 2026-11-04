import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseNotes } from "@/release-notes";
import { parseReleaseVersion } from "@/lib/release-version";

/* #1618: the shape of the release notes the repo carries. */
const directory = fileURLToPath(new URL("../../src/release-notes/", import.meta.url));
const files = readdirSync(directory).filter((name) => /^v.*\.ts$/u.test(name)).sort();
const fileVersions = files.map((name) => name.replace(/\.ts$/u, ""));

function bullets(release) {
  return [...release.forEveryone, ...release.forAdministrators];
}

describe("release notes", () => {
  it("has one file per release and lists every one in the index, and only those", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(releaseNotes.map((r) => r.version).sort()).toEqual([...fileVersions].sort());
  });

  it("names each file with a valid vX.Y.Z", () => {
    for (const version of fileVersions) expect(parseReleaseVersion(version), version).not.toBeNull();
  });

  it("has each version equal to its filename and valid", () => {
    for (const name of fileVersions) {
      const release = releaseNotes.find((r) => r.version === name);
      expect(release, name).toBeDefined();
      expect(parseReleaseVersion(release.version), name).not.toBeNull();
    }
  });

  it("has unique versions", () => {
    const versions = releaseNotes.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("has the two parts as arrays and every bullet a plain, trimmed, non-empty lead and text", () => {
    for (const release of releaseNotes) {
      expect(Array.isArray(release.forEveryone), release.version).toBe(true);
      expect(Array.isArray(release.forAdministrators), release.version).toBe(true);
      for (const bullet of bullets(release)) {
        for (const field of ["lead", "text"]) {
          const value = bullet[field];
          expect(typeof value, `${release.version} ${field}`).toBe("string");
          expect(value.length, `${release.version} ${field}`).toBeGreaterThan(0);
          expect(value, `${release.version} ${field}`).toBe(value.trim());
          expect(value, `${release.version} ${field}`).not.toMatch(/[<>]/u);
        }
      }
    }
  });

  it("includes v0.3.7", () => {
    expect(files).toContain("v0.3.7.ts");
    expect(releaseNotes.map((r) => r.version)).toContain("v0.3.7");
  });
});
