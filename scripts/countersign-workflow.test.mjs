import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1075. The second custody on a released image: a keyless signature that
 * only the owner can start, added only after GitLab's key-based evidence for
 * the same digest verifies. Each case below guards a way the second
 * signature could stop meaning anything -- running without the owner, signing
 * before checking, checking with a private copy of the rules, or trusting an
 * input pasted into a shell.
 */
const workflow = readFileSync(new URL("../.github/workflows/countersign.yml", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

const stepStart = (name) => workflow.indexOf(`- name: ${name}`);
const step = (name) => {
  const start = stepStart(name);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
};

describe("countersign workflow", () => {
  it("runs only when started by hand, never on a push, schedule or other workflow", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\nconcurrency:\n"));
    // Triggers are the two-space keys under `on:`; anything deeper is an
    // input definition (the `release` input is not the `release` event).
    const events = [...trigger.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
    expect(events).toEqual(["workflow_dispatch"]);
  });

  it("takes a stable release tag and refuses anything else before using it", () => {
    expect(workflow).toContain("RELEASE: ${{ inputs.release }}");
    const validate = step("Validate the release input");
    expect(validate).toContain('[[ "${RELEASE}" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(validate).toContain("exit 1");
    expect(stepStart("Validate the release input")).toBeLessThan(stepStart("Check out the release"));
  });

  it("never pastes the input into a shell", () => {
    const runs = workflow.split("\n").filter((_line, index, lines) => {
      const before = lines.slice(0, index + 1).reverse();
      const runLine = before.findIndex((l) => /^\s+run:/.test(l));
      const withLine = before.findIndex((l) => /^\s+(with|env):/.test(l));
      return runLine !== -1 && (withLine === -1 || runLine < withLine);
    });
    for (const line of runs) expect(line).not.toContain("${{ inputs.");
  });

  it("checks GitLab's evidence with the shared verifier, against the GitLab registry, before signing", () => {
    const verify = step("Verify GitLab's key-based evidence");
    expect(verify).toContain("run: bash scripts/ci/verify-validation-evidence.sh");
    expect(verify).toContain("ORBIT_IMAGE: ${{ env.GITLAB_REGISTRY }}/ai/orbit");
    expect(verify).toContain("ORBIT_DIGEST: ${{ steps.release.outputs.digest }}");
    expect(verify).toContain("ORBIT_COMMIT: ${{ steps.release.outputs.commit }}");
    expect(verify).not.toContain("continue-on-error");
    // No private copy of the verifier's rules.
    expect(workflow).not.toContain("verify-attestation");
    expect(stepStart("Resolve the release's digest and commit")).toBeLessThan(
      stepStart("Verify GitLab's key-based evidence"),
    );
    expect(stepStart("Verify GitLab's key-based evidence")).toBeLessThan(stepStart("Countersign keyless"));
  });

  it("signs the release's own digest keyless with the pinned cosign, then verifies the result", () => {
    const resolve = step("Resolve the release's digest and commit");
    expect(resolve).toContain('crane digest "${GHCR_IMAGE}:${RELEASE}"');
    expect(resolve).toContain("git rev-parse 'HEAD^{commit}'");
    const sign = step("Countersign keyless");
    expect(sign).toContain('cosign="$(bash scripts/ci/ensure-cosign.sh)"');
    expect(sign).toContain('"${cosign}" sign --yes "${GHCR_IMAGE}@${DIGEST}"');
    expect(sign).not.toContain("--key");
    expect(sign).not.toContain("tlog-upload=false");
    const check = step("Verify the countersignature");
    expect(check).toContain("--certificate-identity-regexp '^https://github.com/tomlawesome/orbit/'");
    expect(check).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
    expect(stepStart("Countersign keyless")).toBeLessThan(stepStart("Verify the countersignature"));
  });

  it("holds only what signing needs, and only a read token for GitLab", () => {
    expect(workflow).toContain("permissions:\n  contents: read\n");
    const job = workflow.slice(workflow.indexOf("  countersign:\n"));
    // contents: write at the job level only, for uploading the manifest
    // countersignature bundle (ADR-0031 #10) -- the workflow-level default
    // above stays read-only.
    expect(job).toContain("      contents: write\n      packages: write\n      id-token: write\n");
    expect(job).not.toContain("attestations: write");
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
    expect(new Set(secrets)).toEqual(new Set(["GITLAB_READ_TOKEN_NAME", "GITLAB_READ_TOKEN", "GITHUB_TOKEN"]));
  });

  it("pins every third-party action to an immutable commit", () => {
    const uses = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
  });
});

/*
 * ADR-0031 #4/#10: the release manifest gets the same second signature the
 * image does, keyless, but only after the shared verifier passes on the
 * manifest actually downloaded from this release, and only for the digest
 * this run just countersigned -- never a manifest signature taken on trust.
 */
describe("countersign workflow: manifest countersignature", () => {
  it("downloads the manifest and its .sig from the release's own assets, and verifies them", () => {
    const download = step("Download the release manifest and its signature");
    expect(download).toContain("gh release download");
    expect(download).toContain("orbit-release-manifest.json");
    expect(download).toContain("orbit-release-manifest.json.sig");

    const verify = step("Verify the release manifest's signature");
    expect(verify).toContain(
      "run: bash scripts/ci/verify-release-manifest.sh orbit-release-manifest.json orbit-release-manifest.json.sig",
    );
    expect(stepStart("Verify the countersignature")).toBeLessThan(stepStart("Download the release manifest and its signature"));
    expect(stepStart("Download the release manifest and its signature")).toBeLessThan(
      stepStart("Verify the release manifest's signature"),
    );
  });

  it("refuses a manifest naming a digest other than the one just countersigned", () => {
    const refuse = step("Refuse a manifest for the wrong image");
    expect(refuse).toContain("DIGEST: ${{ steps.release.outputs.digest }}");
    expect(refuse).toContain('[[ "${manifest_digest}" == "${DIGEST}" ]]');
    expect(refuse).toContain("exit 1");
    expect(stepStart("Verify the release manifest's signature")).toBeLessThan(
      stepStart("Refuse a manifest for the wrong image"),
    );
  });

  it("signs the manifest keyless as a bundle, verifies it, then uploads it to the release", () => {
    const sign = step("Countersign the release manifest keyless");
    expect(sign).toContain('"${cosign}" sign-blob --yes \\');
    expect(sign).toContain("--bundle orbit-release-manifest.json.sigstore.json");
    expect(sign).toContain("orbit-release-manifest.json");
    expect(sign).not.toContain("--key");
    expect(sign).not.toContain("tlog-upload=false");

    const verify = step("Verify the manifest countersignature bundle");
    expect(verify).toContain("--certificate-identity-regexp '^https://github.com/tomlawesome/orbit/'");
    expect(verify).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");

    const upload = step("Upload the manifest countersignature bundle to the release");
    expect(upload).toContain("gh release upload");
    expect(upload).toContain("--clobber");
    expect(upload).toContain("orbit-release-manifest.json.sigstore.json");

    expect(stepStart("Refuse a manifest for the wrong image")).toBeLessThan(
      stepStart("Countersign the release manifest keyless"),
    );
    expect(stepStart("Countersign the release manifest keyless")).toBeLessThan(
      stepStart("Verify the manifest countersignature bundle"),
    );
    expect(stepStart("Verify the manifest countersignature bundle")).toBeLessThan(
      stepStart("Upload the manifest countersignature bundle to the release"),
    );
  });
});
