import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * GitHub does no judging of its own for the image (#821 is GitLab's job):
 * this workflow only turns a mirrored stable tag into a GitHub Release. What
 * it *does* add (ADR-0031 #9) is the signed launcher and release manifest --
 * the exact bytes GitLab already tested for this commit, attached only after
 * the shared verifier and the shared asset checker both pass.
 */
const workflow = readFileSync(new URL("../.github/workflows/release-on-tag.yml", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const getOrbitScript = readFileSync(new URL("./get-orbit.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");

const stepStart = (name) => workflow.indexOf(`- name: ${name}`);
const step = (name) => {
  const start = stepStart(name);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
};

describe("release-on-tag workflow", () => {
  it("runs only on a stable tag push, never a pull request or schedule", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:\n"));
    expect(trigger).toContain('      - "v*"');
    expect(trigger).not.toContain("pull_request");
    expect(trigger).not.toContain("schedule");
  });

  it("creates the release from the mirrored tag without recomputing anything", () => {
    const create = step("Create the release if it does not already exist");
    expect(create).toContain("gh release view");
    expect(create).toContain("gh release create");
    expect(create).toContain("--verify-tag");
    expect(create).toContain("--generate-notes");
  });

  it("resolves which mirrored branch GitLab tested this commit on, preferring preview", () => {
    const source = step("Find the branch GitLab tested this commit on");
    expect(source).toContain("--contains");
    expect(source).toContain("refs/remotes/origin/preview");
    expect(source).toContain("refs/remotes/origin/hotfix/*");
    expect(source).toContain("origin/preview");
    const checkout = step("Check out the tagged commit and its preview/hotfix branches");
    expect(checkout).toContain("fetch-depth: 0");
    expect(checkout).toContain("persist-credentials: false");
    expect(stepStart("Check out the tagged commit and its preview/hotfix branches")).toBeLessThan(
      stepStart("Find the branch GitLab tested this commit on"),
    );
  });

  it("fetches the launcher, manifest and .sig from the resolved branch's pipeline", () => {
    const evidence = step("Fetch the tested launcher, manifest and .sig from GitLab");
    expect(evidence).toContain("run: bash scripts/ci/gitlab-await-tested-image.sh");
    expect(evidence).toContain('ORBIT_FETCH_LAUNCHER_ASSETS: "1"');
    expect(evidence).toContain("ORBIT_COMMIT: ${{ github.sha }}");
    expect(evidence).toContain("ORBIT_REF: ${{ steps.source.outputs.ref }}");
    expect(stepStart("Find the branch GitLab tested this commit on")).toBeLessThan(
      stepStart("Fetch the tested launcher, manifest and .sig from GitLab"),
    );
  });

  it("verifies the manifest's signature and every asset before attaching anything", () => {
    const verify = step("Verify the release manifest's signature");
    expect(verify).toContain("bash scripts/ci/verify-release-manifest.sh");
    expect(verify).toContain("${{ steps.evidence.outputs.release_manifest }}");
    expect(verify).toContain("${{ steps.evidence.outputs.release_manifest_sig }}");
    expect(verify).not.toContain("continue-on-error");

    const check = step("Check the launcher assets against the manifest");
    expect(check).toContain("bash scripts/ci/verify-manifest-assets.sh");
    expect(getOrbitScript).toContain('archive_name="orbit-launcher_linux_${arch}.tar.gz"');
    for (const name of ["orbit-launcher_linux_amd64.tar.gz", "orbit-launcher_linux_arm64.tar.gz", "install.sh"]) {
      expect(check, name).toContain(`${name}=`);
    }

    expect(stepStart("Fetch the tested launcher, manifest and .sig from GitLab")).toBeLessThan(
      stepStart("Verify the release manifest's signature"),
    );
    expect(stepStart("Verify the release manifest's signature")).toBeLessThan(
      stepStart("Check the launcher assets against the manifest"),
    );
    expect(stepStart("Check the launcher assets against the manifest")).toBeLessThan(
      stepStart("Attach the launcher and manifest to the release"),
    );
  });

  it("attaches the verified launcher, manifest, .sig and get-orbit.sh to the tagged release", () => {
    const attach = step("Attach the launcher and manifest to the release");
    expect(attach).toContain("gh release upload");
    expect(attach).toContain("--clobber");
    expect(attach).toContain('TAG: ${{ github.ref_name }}');
    expect(attach).toContain("${MANIFEST}");
    expect(attach).toContain("${MANIFEST_SIG}");
    expect(attach).toContain("${AMD64_ARCHIVE}");
    expect(attach).toContain("${ARM64_ARCHIVE}");
    expect(attach).toContain("scripts/install.sh");
    expect(attach).toContain("scripts/get-orbit.sh");
  });

  it("holds least privilege and only a read token for GitLab", () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: write\n/);
    expect(workflow).not.toContain("packages: write");
    expect(workflow).not.toContain("id-token: write");
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]);
    expect(new Set(secrets)).toEqual(new Set(["GITLAB_READ_TOKEN"]));
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/^\s+uses:\s+([^#\s]+)(?:\s+#.*)?$/gmu)]
      .map((match) => match[1])
      .filter((reference) => !reference.startsWith("./"));
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/u);
    }
  });
});
