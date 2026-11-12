import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("checks GitLab's evidence with the shared verifier, on GHCR where the publish copied it, before signing (#1824)", () => {
    const verify = step("Verify GitLab's key-based evidence");
    expect(verify).toContain("run: bash scripts/ci/verify-validation-evidence.sh");
    expect(verify).toContain("ORBIT_IMAGE: ${{ env.GHCR_IMAGE }}");
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

  it("holds only what signing needs, and no GitLab token (#1824)", () => {
    expect(workflow).toContain("permissions:\n  contents: read\n");
    const job = workflow.slice(workflow.indexOf("  countersign:\n"));
    // contents: write at the job level only, for uploading the manifest
    // countersignature bundle (ADR-0031 #10) -- the workflow-level default
    // above stays read-only.
    expect(job).toContain("      contents: write\n      packages: write\n      id-token: write\n");
    expect(job).not.toContain("attestations: write");
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
    expect(new Set(secrets)).toEqual(new Set(["GITHUB_TOKEN"]));
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

/*
 * #1644. The evidence window is measured from the release tag's own tagger
 * date: 7 days plus the whole days since the tag was made. These cases run
 * the new step's shell against a throwaway repository, so they hold however
 * the step is named or hands its value on (GITHUB_ENV, or a step output read
 * by an `env:` entry on the verify step).
 */
describe("countersign workflow: evidence window from the tag date", () => {
  const RESOLVE = "Resolve the release's digest and commit";
  const VERIFY = "Verify GitLab's key-based evidence";
  const DAY = 86400;

  // The step(s) sitting between the resolve step and the verify step.
  const windowStep = () => {
    const from = stepStart(RESOLVE);
    const to = stepStart(VERIFY);
    expect(from, RESOLVE).toBeGreaterThanOrEqual(0);
    expect(to, VERIFY).toBeGreaterThan(from);
    const between = workflow.slice(from, to).split("\n      - name:").slice(1);
    expect(between.length, "a step between resolve and verify that reads the tag date").toBeGreaterThanOrEqual(1);
    return between.map((text) => "      - name:" + text).join("\n");
  };

  const runBlock = (text) => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => /^\s+run:\s*[|>][-+]?\s*$/.test(line));
    expect(at, "a multi-line run: block").toBeGreaterThanOrEqual(0);
    const body = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== "" && !line.startsWith("          ")) break;
      body.push(line.replace(/^ {10}/, ""));
    }
    return body.join("\n");
  };

  const git = (cwd, args, env = {}) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env },
    });
    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  };

  // Makes a repo with one tag; kind is "annotated" (tagged at `epoch`) or "lightweight".
  const runWindow = ({ kind, epoch, tag = "v0.3.0", release = "v0.3.0" }) => {
    const dir = mkdtempSync(join(tmpdir(), "countersign-window-"));
    try {
      const who = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
      git(dir, ["init", "-q"], who);
      git(dir, ["commit", "-q", "--allow-empty", "-m", "c"], who);
      if (kind === "annotated") {
        git(dir, ["tag", "-a", tag, "-m", "release"], { ...who, GIT_COMMITTER_DATE: `${epoch} +0000` });
      } else {
        git(dir, ["tag", tag], who);
      }
      const githubEnv = join(dir, "github_env");
      const githubOutput = join(dir, "github_output");
      writeFileSync(githubEnv, "");
      writeFileSync(githubOutput, "");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runBlock(windowStep())], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir, RELEASE: release, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: githubOutput },
      });
      const envFile = readFileSync(githubEnv, "utf8");
      const outFile = readFileSync(githubOutput, "utf8");
      let value = null;
      const fromEnv = envFile.match(/^ORBIT_MAX_EVIDENCE_AGE_DAYS=(.*)$/m);
      if (fromEnv) value = fromEnv[1];
      else {
        const wired = step(VERIFY).match(/ORBIT_MAX_EVIDENCE_AGE_DAYS:\s*\$\{\{\s*steps\.[\w-]+\.outputs\.([\w-]+)\s*\}\}/);
        const out = wired && outFile.match(new RegExp(`^${wired[1]}=(.*)$`, "m"));
        if (out) value = out[1];
      }
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, value };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const now = () => Math.floor(Date.now() / 1000);

  it("has a step between resolving the release and verifying the evidence that reads the tag date", () => {
    const text = windowStep();
    expect(text).toContain("ORBIT_MAX_EVIDENCE_AGE_DAYS");
    expect(text).toContain("refs/tags/");
  });

  it("hands the window to the verify step as ORBIT_MAX_EVIDENCE_AGE_DAYS", () => {
    const ok = runWindow({ kind: "annotated", epoch: now() - 3 * DAY - 7200 });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.value).not.toBeNull();
    const verify = step(VERIFY);
    const viaEnvFile = /ORBIT_MAX_EVIDENCE_AGE_DAYS=/.test(windowStep());
    if (!viaEnvFile) expect(verify).toMatch(/ORBIT_MAX_EVIDENCE_AGE_DAYS:\s*\$\{\{\s*steps\./);
  });

  it("gives 7 plus the whole days since the tag was made (13 days and 2 hours old gives 20)", () => {
    const run = runWindow({ kind: "annotated", epoch: now() - 13 * DAY - 7200 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.value).toBe("20");
  });

  it("rounds the age down (13 days and 23 hours old still gives 20, not 21)", () => {
    const run = runWindow({ kind: "annotated", epoch: now() - 13 * DAY - 23 * 3600 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.value).toBe("20");
  });

  it("gives 7 for a tag less than a day old", () => {
    const run = runWindow({ kind: "annotated", epoch: now() - 2 * 3600 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.value).toBe("7");
  });

  it("adds nothing for a tagger date in the future: the window is 7, never less", () => {
    const run = runWindow({ kind: "annotated", epoch: now() + 3 * DAY });
    expect(run.status, run.stderr).toBe(0);
    expect(run.value).toBe("7");
  });

  it("refuses a lightweight tag (no tagger date) with an ::error:: naming the tag, and sets no window", () => {
    const run = runWindow({ kind: "lightweight" });
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toMatch(/::error::[^\n]*v0\.3\.0/);
    expect(run.value).toBeNull();
  });

  it("refuses when the tag date cannot be read (no such tag), naming the tag, and sets no window", () => {
    const run = runWindow({ kind: "annotated", epoch: now() - DAY, release: "v9.9.9" });
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toMatch(/::error::[^\n]*v9\.9\.9/);
    expect(run.value).toBeNull();
  });

  it("prints one line saying the window used and why", () => {
    const run = runWindow({ kind: "annotated", epoch: now() - 13 * DAY - 7200 });
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.startsWith("Evidence window:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Evidence window: 20 days \(7 \+ 13 since v0\.3\.0 was tagged \d{4}-\d{2}-\d{2}\)\.$/);
  });

  it("changes nothing else: the verify step still runs the shared verifier, whose code is unchanged", () => {
    expect(step(VERIFY)).toContain("run: bash scripts/ci/verify-validation-evidence.sh");
    // Comment lines may change (#1824 renamed a script one names); code may not.
    const diff = spawnSync("/usr/bin/git", ["diff", "--quiet", "-I^#", "fafae28f", "--", "scripts/ci/verify-validation-evidence.sh"], {
      cwd: new URL("..", import.meta.url).pathname,
    });
    expect(diff.status).toBe(0);
    // Order of the existing steps is kept.
    expect(stepStart("Validate the release input")).toBeLessThan(stepStart("Check out the release"));
    expect(stepStart(RESOLVE)).toBeLessThan(stepStart(VERIFY));
    expect(stepStart(VERIFY)).toBeLessThan(stepStart("Countersign keyless"));
    // The new step is the only one added there.
    expect(windowStep().match(/- name:/g)).toHaveLength(1);
  });
});
