import { describe, expect, it } from "vitest";

import {
  type ImageIdentityAdapter,
  resolveImageIdentity,
  resolveRepoDigest,
  validateRevisionLabel,
  validateVersionLabel,
} from "./image-resolution";

// Unit coverage for issue #295 slice 5's image-identity resolution
// (install.sh:1264-1310, guarantees #41-#44). install.sh has no standalone
// function for this sequence (it is inline in the main flow), so there is no
// awk-extractable body for a source-extraction parity test — see this
// module's own header comment and docs/adr-notes/295-install-port-plan.md's
// Flags section. Coverage here instead exercises each cited install.sh line
// range's exact regex/line-selection behaviour against literal fixture
// values transcribed from the script.

const REPOSITORY = "ghcr.io/tomlawesome/orbit";
const DIGEST = "a".repeat(64);
const RESOLVED = `${REPOSITORY}@sha256:${DIGEST}`;

describe("resolveRepoDigest (install.sh:1278-1288, guarantee #41)", () => {
  it("picks the first line matching the expected repository, ignoring other repositories", () => {
    const output = ["ghcr.io/other/image@sha256:" + "b".repeat(64), RESOLVED].join("\n");
    expect(resolveRepoDigest(REPOSITORY, output)).toBe(RESOLVED);
  });

  it("returns undefined when no RepoDigests line matches the expected repository", () => {
    expect(resolveRepoDigest(REPOSITORY, "ghcr.io/other/image@sha256:" + "b".repeat(64))).toBeUndefined();
  });

  it("returns undefined for a malformed digest (wrong hex length)", () => {
    expect(resolveRepoDigest(REPOSITORY, `${REPOSITORY}@sha256:` + "a".repeat(63))).toBeUndefined();
  });

  it("returns undefined for empty RepoDigests output", () => {
    expect(resolveRepoDigest(REPOSITORY, "")).toBeUndefined();
  });
});

describe("validateRevisionLabel (install.sh:1296, guarantee #42)", () => {
  it("accepts exactly 40 lowercase hex characters", () => {
    expect(validateRevisionLabel("a".repeat(40))).toBe("a".repeat(40));
  });
  it("rejects uppercase hex", () => {
    expect(validateRevisionLabel("A".repeat(40))).toBeUndefined();
  });
  it("rejects short or long values", () => {
    expect(validateRevisionLabel("a".repeat(39))).toBeUndefined();
    expect(validateRevisionLabel("a".repeat(41))).toBeUndefined();
  });
  it("rejects the empty-label sentinel <no value>", () => {
    expect(validateRevisionLabel("<no value>")).toBeUndefined();
  });
});

describe("validateVersionLabel (install.sh:1302, guarantee #43)", () => {
  it.each(["v1.0.0", "v0.0.1", "v10.20.30"])("accepts strict semver %s", (value) => {
    expect(validateVersionLabel(value)).toBe(value);
  });
  it.each(["1.0.0", "v1.0", "v01.0.0", "v1.0.0-rc1", "<no value>"])("rejects %s", (value) => {
    expect(validateVersionLabel(value)).toBeUndefined();
  });
});

function fixedAdapter(overrides: Partial<ImageIdentityAdapter> = {}): ImageIdentityAdapter {
  return {
    pull: () => true,
    inspectRepoDigests: () => RESOLVED,
    inspectRevisionLabel: () => "b".repeat(40),
    inspectVersionLabel: () => "v1.2.3",
    runBanner: () => true,
    ...overrides,
  };
}

describe("resolveImageIdentity orchestration (install.sh:1264-1310)", () => {
  it("resolves a fully valid image identity end-to-end", () => {
    const result = resolveImageIdentity(REPOSITORY, "latest", fixedAdapter());
    expect(result).toEqual({
      status: "ok",
      resolvedReference: RESOLVED,
      revision: "b".repeat(40),
      imageVersion: "v1.2.3",
      appliedDigest: `sha256:${DIGEST}`,
    });
  });

  it("fails closed when the pull itself fails", () => {
    const result = resolveImageIdentity(REPOSITORY, "latest", fixedAdapter({ pull: () => false }));
    expect(result).toEqual({ status: "failed", reason: "pull-failed", message: expect.stringContaining("Could not pull") });
  });

  it("fails closed when RepoDigests inspection fails", () => {
    const result = resolveImageIdentity(REPOSITORY, "latest", fixedAdapter({ inspectRepoDigests: () => null }));
    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toBe("inspect-failed");
  });

  it("fails closed when no digest for the expected repository is found (#41)", () => {
    const result = resolveImageIdentity(
      REPOSITORY,
      "latest",
      fixedAdapter({ inspectRepoDigests: () => "ghcr.io/other/image@sha256:" + "c".repeat(64) }),
    );
    expect((result as { reason: string }).reason).toBe("digest-not-resolved");
  });

  it("fails closed when the revision label is invalid (#42)", () => {
    const result = resolveImageIdentity(REPOSITORY, "latest", fixedAdapter({ inspectRevisionLabel: () => "not-hex" }));
    expect((result as { reason: string }).reason).toBe("revision-invalid");
  });

  it("fails closed when the version label is invalid (#43)", () => {
    const result = resolveImageIdentity(REPOSITORY, "latest", fixedAdapter({ inspectVersionLabel: () => "1.0.0" }));
    expect((result as { reason: string }).reason).toBe("version-invalid");
  });

  it("fails closed when the resolved image cannot render its banner (#44)", () => {
    const result = resolveImageIdentity(REPOSITORY, "latest", fixedAdapter({ runBanner: () => false }));
    expect((result as { reason: string }).reason).toBe("banner-failed");
  });
});
