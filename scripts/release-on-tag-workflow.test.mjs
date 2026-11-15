import { spawnSync } from "node:child_process";
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

const classifier = new URL("./ci/classify-release-tag.sh", import.meta.url).pathname;

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
    const create = step("Create the release");
    expect(create).toContain("repos/${GITHUB_REPOSITORY}/releases"); // lists drafts too, so a re-run finds its own draft
    expect(create).toContain("gh release create");
    expect(create).toContain("--verify-tag");
  });

  // #1848: only a stable vX.Y.Z tag is ever released; the refusal runs first.
  const allSteps = () => workflow.slice(workflow.indexOf("\n    steps:\n")).split(/\n(?=      - name:)/u).slice(1);
  const stepIndex = (name) => allSteps().findIndex((text) => text.startsWith(`      - name: ${name}`));
  const CREATE = "Create the release";
  const CHECK = "Check the launcher assets against the manifest";
  const ATTACH = "Attach the launcher and manifest to the release";

  it("refuses anything but a stable tag right after checkout and before any gh release call (#1848)", () => {
    const steps = allSteps();
    const refuse = steps[1];
    expect(steps[0]).toContain("actions/checkout@");
    expect(refuse).toContain("bash scripts/ci/classify-release-tag.sh");
    expect(refuse).toContain("stable");
    expect(refuse).toContain("::error::");
    expect(refuse).toMatch(/TAG: \$\{\{ github\.ref_name \}\}/u);
    expect(refuse).toMatch(/exit 1/u);
    expect(refuse).not.toContain("gh release");
    const firstGh = workflow.indexOf("gh release");
    expect(workflow.indexOf("classify-release-tag.sh")).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf("classify-release-tag.sh")).toBeLessThan(firstGh);
    expect(stepIndex("Create the release")).toBeGreaterThan(1);
  });

  it("has no pre-release branch: no --prerelease, --latest=false or --generate-notes anywhere (#1848)", () => {
    const code = workflow.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toContain("--prerelease");
    expect(code).not.toContain("--latest=false");
    expect(code).not.toContain("--generate-notes");
  });

  it("gives the release the CHANGELOG.md section as its notes (#1704)", () => {
    const create = step(CREATE);
    expect(create).toContain("scripts/release-notes.mjs");
    expect(create).toContain("--notes-file");
    expect(create.indexOf("scripts/release-notes.mjs")).toBeLessThan(create.indexOf("--notes-file"));
    expect(create).toContain("repos/${GITHUB_REPOSITORY}/releases"); // lists drafts too, so a re-run finds its own draft
  });

  it("creates the release as a draft, only after the launcher assets check (#1848)", () => {
    const create = step(CREATE);
    expect(create).toMatch(/gh release create[\s\S]*--draft/u);
    expect(create).toContain("--notes-file");
    expect(create).toContain("--verify-tag");
    expect(stepIndex(CHECK)).toBeGreaterThanOrEqual(0);
    expect(stepIndex(CREATE)).toBeGreaterThan(stepIndex(CHECK));
    expect(stepIndex(CREATE)).toBeLessThan(stepIndex(ATTACH));
  });

  it("publishes the draft in the last step, after the upload (#1848)", () => {
    const steps = allSteps();
    const last = steps[steps.length - 1];
    expect(last).toContain("gh release edit");
    expect(last).toContain("--draft=false");
    expect(last).toMatch(/TAG: \$\{\{ github\.ref_name \}\}/u);
    expect(steps.length - 1).toBeGreaterThan(stepIndex(ATTACH));
    expect(steps[stepIndex(ATTACH)]).toContain("gh release upload");
    expect(steps[stepIndex(ATTACH)]).toContain("--clobber");
    expect(steps[stepIndex(ATTACH)]).not.toContain("--draft=false");
  });

  it("classify-release-tag.sh says stable for vX.Y.Z and prerelease or refuses otherwise (#1848)", () => {
    const run = (tag) => spawnSync("bash", [classifier, tag], { encoding: "utf8" });
    expect(run("v1.2.3").stdout.trim()).toBe("stable");
    expect(run("v1.3.0-e2e.1").stdout.trim()).toBe("prerelease");
    expect(run("not-a-tag").status).not.toBe(0);
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
    // The separate public handoff repository, of the repository's own owner.
    expect(evidence).toContain("GITHUB_HANDOFF_REPO: ${{ github.repository_owner }}/orbit-handoff");
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
    expect(stepStart("Check the launcher assets against the manifest")).toBeLessThan(stepStart("Create the release"));
  });

  // A stale launcher: the handoff is found by commit, but the signed manifest
  // inside it must also be for this tag's commit and version.
  it("refuses a manifest whose commit is not the tag's commit or whose version is not the tag name (#1824)", () => {
    const start = stepStart("Verify the release manifest's signature");
    const attach = stepStart("Attach the launcher and manifest to the release");
    const between = workflow.slice(start, attach);
    const checkSteps = between.split(/\n(?=      - name:)/u).filter((text) => /\.commit\b|\bcommit\b/u.test(text) && /\.version\b|\bversion\b/u.test(text) && text.includes("release_manifest"));
    // A step after the signature check and before anything is attached.
    expect(checkSteps.length, "a step comparing the manifest's commit and version").toBeGreaterThan(0);
    const text = checkSteps.join("\n");
    expect(text).toContain("github.sha");
    expect(text).toContain("github.ref_name");
    expect(text).not.toContain("continue-on-error");
    // It reads the manifest that was just signature-checked.
    expect(text).toContain("steps.evidence.outputs.release_manifest");
    expect(start).toBeLessThan(attach);
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

  it("never writes to the handoff repository: the launcher is only read from it (#1824)", () => {
    const evidence = step("Fetch the tested launcher, manifest and .sig from GitLab's handoff");
    expect(evidence).not.toMatch(/gh\s+(?:release|api)\b/u);
    expect(workflow).not.toContain("github-prune-handoffs");
    expect(workflow).not.toContain("github-upload-handoff");
    // Every release write names this repository, not the handoff one.
    for (const line of workflow.split("\n").filter((l) => /gh release (?:create|upload)/u.test(l) || l.includes("--repo"))) {
      expect(line).not.toMatch(/orbit-handoff|HANDOFF_REPO/u);
    }
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
