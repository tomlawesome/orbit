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
  });

  // #1704: the stable body is the version's CHANGELOG.md section, and no
  // release is made without one.
  const branches = () => {
    const create = step("Create the release if it does not already exist");
    const match = /"prerelease" \]\]; then\n(?<pre>[\s\S]*?)\n\s+else\n(?<stable>[\s\S]*?)\n\s+fi\n\s+fi/u.exec(create);
    expect(match, "prerelease/stable branches").not.toBeNull();
    return { create, pre: match.groups.pre, stable: match.groups.stable };
  };

  it("gives a stable release the CHANGELOG.md section as its notes, never generated notes (#1704)", () => {
    const { create, stable } = branches();
    expect(stable).toContain("gh release create");
    expect(stable).toContain("--notes-file");
    expect(stable).not.toContain("--generate-notes");
    expect(create).toContain("scripts/release-notes.mjs");
    expect(create.indexOf("scripts/release-notes.mjs")).toBeLessThan(create.indexOf("--notes-file"));
  });

  it("keeps generated notes on the pre-release branch (#1704)", () => {
    const { pre } = branches();
    expect(pre).toContain("--prerelease");
    expect(pre).toContain("--generate-notes");
    expect(pre).not.toContain("--notes-file");
  });

  it("classifies the tag and never marks a pre-release tag Latest (#1121)", () => {
    const create = step("Create the release if it does not already exist");
    expect(create).toContain("bash scripts/ci/classify-release-tag.sh");
    expect(create).toContain("--prerelease");
    expect(create).toContain("--latest=false");
    expect(stepStart("Check out the tagged commit and its preview/hotfix branches")).toBeLessThan(
      stepStart("Create the release if it does not already exist"),
    );
  });

  it("falls back to which mirrored branch contains the commit, preferring preview, when the tag names none", () => {
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

  // #1640: a hotfix promoted through a merge request leaves main at a merge
  // commit that no preview or hotfix branch history decides cleanly, so the
  // tag message (written by promote_stable) says where GitLab tested it.
  it("reads the branch from the annotated tag's `Tested on:` line first, falling back to the branch search only without one (#1640)", () => {
    const source = step("Find the branch GitLab tested this commit on");
    expect(source).toContain("%(contents)");
    expect(source).toMatch(/refs\/tags\/\$\{TAG\}|tag -l/u);
    expect(source).toContain("Tested on:");
    expect(source).toContain("preview|hotfix/");
    expect(source).toContain("TAG: ${{ github.ref_name }}");
    // The tag message is consulted before the branch search.
    expect(source.indexOf("%(contents)")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("%(contents)")).toBeLessThan(source.indexOf("--contains"));
    expect(source.indexOf("Tested on:")).toBeLessThan(source.indexOf("--contains"));
  });

  it("fetches tags when checking out, so the annotated tag object and its message are present (#1640)", () => {
    const checkout = step("Check out the tagged commit and its preview/hotfix branches");
    expect(checkout).toContain("fetch-tags: true");
  });

  it("fetches the launcher, manifest and .sig from GitLab's handoff for the resolved branch (#1824)", () => {
    const evidence = step("Fetch the tested launcher, manifest and .sig from GitLab's handoff");
    expect(evidence).toContain("run: bash scripts/ci/github-await-handoff.sh");
    expect(evidence).toContain("GH_TOKEN: ${{ github.token }}");
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

  it("holds least privilege and no secrets: the handoff is read with the built-in token (#1824)", () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: write\n/);
    expect(workflow).not.toContain("packages: write");
    expect(workflow).not.toContain("id-token: write");
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]);
    expect(secrets).toEqual([]);
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
