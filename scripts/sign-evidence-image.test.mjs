import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #1368: `sign_evidence` is the one job that has the signing key mounted, and
// it used to install bash, curl and node with `apk add` and then download
// cosign with curl while that key was in reach. The decision on the issue
// (build-isolation practice): the job runs from a prebuilt, digest-pinned
// signing tool image built by ai/orbit-base-image, installs nothing, fetches
// nothing, and fails if cosign is missing rather than getting it. This file
// holds those three facts: the image, the script, and the refusal.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");
const repoRoot = new URL("..", import.meta.url).pathname;

// Top-level blocks by name, the same shape scripts/gitlab-ci-lanes.test.mjs
// reads: a line that is `name:` at column zero, with or without an
// `&anchor |` after it, up to the next such line.
function blocks() {
  const found = new Map();
  const headers = [...gitlabCi.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):\s*(?:&\S+\s*\|?\s*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].index : gitlabCi.length;
    found.set(match[1], gitlabCi.slice(match.index, end));
  });
  return found;
}

const allBlocks = blocks();

function withoutComments(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

function signEvidence() {
  const block = allBlocks.get("sign_evidence");
  expect(block, "the sign_evidence job exists").toBeDefined();
  return block;
}

// The job as the runner sees it: every `- *anchor` list item replaced by the
// hidden key it names (`.apk_retry: &apk_retry |` and the like), and comment
// lines dropped so prose about a download cannot trip or satisfy a check.
function expandedJob() {
  const expanded = signEvidence().replace(/^( *)- \*(\S+)[ \t]*$/gmu, (_line, indent, name) => {
    const anchor = allBlocks.get(`.${name}`);
    expect(anchor, `no hidden key defines *${name}`).toBeDefined();
    return `${indent}- ${anchor}`;
  });
  return withoutComments(expanded);
}

// The top-level `variables:` block, comments dropped.
function globalVariables() {
  const start = gitlabCi.search(/^variables:\s*$/mu);
  expect(start, "a top-level variables: block exists").toBeGreaterThan(-1);
  const rest = gitlabCi.slice(start).split("\n").slice(1);
  const body = [];
  for (const line of rest) {
    if (/^\S/u.test(line) && !line.startsWith("#")) break;
    body.push(line);
  }
  return withoutComments(body.join("\n"));
}

describe("sign_evidence image (#1368)", () => {
  const imageLine = () => signEvidence().match(/^ {2}image:[ \t]*(\S+)[ \t]*$/mu);

  it("takes its image from a named variable, not a literal reference", () => {
    const match = imageLine();
    expect(match, "sign_evidence has a one-line `image:`").not.toBeNull();
    expect(match[1], "the image is a variable reference such as ${ORBIT_SIGNING_IMAGE}").toMatch(
      /^\$\{?[A-Z][A-Z0-9_]*\}?$/u,
    );
  });

  it("defines that variable once, in the top-level variables:, pinned by @sha256: digest", () => {
    const name = imageLine()?.[1].match(/^\$\{?([A-Z][A-Z0-9_]*)\}?$/u)?.[1];
    expect(name, "the image names a variable").toBeDefined();
    const definitions = [...gitlabCi.matchAll(new RegExp(`^ +${name}:[ \\t]*(\\S+)[ \\t]*$`, "gmu"))];
    expect(definitions, `${name} is defined exactly once in .gitlab-ci.yml`).toHaveLength(1);
    const inGlobals = [...globalVariables().matchAll(new RegExp(`^ +${name}:[ \\t]*(\\S+)[ \\t]*$`, "gmu"))];
    expect(inGlobals, `${name} is defined in the top-level variables:`).toHaveLength(1);
    expect(inGlobals[0][1]).toMatch(/@sha256:[0-9a-f]{64}$/u);
  });

  it("is the orbit-base-image signing image, not the stock docker CLI image or the acceptance image", () => {
    const name = imageLine()?.[1].match(/^\$\{?([A-Z][A-Z0-9_]*)\}?$/u)?.[1];
    expect(name, "the image names a variable").toBeDefined();
    const value = globalVariables().match(new RegExp(`^ +${name}:[ \\t]*(\\S+)[ \\t]*$`, "mu"))?.[1] ?? "";
    expect(value).toContain("orbit-base-image");
    expect(value).not.toMatch(/\/docker:[^@]*-cli@/u);
    const acceptance = globalVariables().match(/^ +ORBIT_ACCEPTANCE_IMAGE:[ \t]*(\S+)[ \t]*$/mu)?.[1];
    expect(value, "a signing image of its own, not the acceptance image").not.toBe(acceptance);
  });
});

describe("sign_evidence script (#1368)", () => {
  const forbidden = [
    ["apk add", /\bapk\s+add\b/u],
    ["apk_add", /\bapk_add\b/u],
    ["apk update or upgrade", /\bapk\s+(update|upgrade)\b/u],
    ["apt-get", /\bapt(-get)?\s+(install|update)\b|\bapt-get\b/u],
    ["npm install", /\bnpm\s+(install|i|ci|add)\b/u],
    ["pnpm install", /\bpnpm\s+(install|i|add)\b/u],
    ["corepack", /\bcorepack\b/u],
    ["curl or wget piped into a shell", /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/u],
    ["a download of cosign", /\b(curl|wget)\b[^\n]*cosign|sigstore\/cosign|cosign-linux/u],
    ["the ensure-cosign download step", /\bensure-cosign\b/u],
  ];

  for (const [label, pattern] of forbidden) {
    it(`does not contain ${label}`, () => {
      expect(expandedJob()).not.toMatch(pattern);
    });
  }

  it("still attests the image and signs the release manifest", () => {
    const job = expandedJob();
    expect(job).toContain("attest-tested-image.sh");
    expect(job).toContain("sign-release-manifest.sh");
  });
});

// The signing scripts call scripts/ci/ensure-cosign.sh when ORBIT_COSIGN is
// unset, and that script downloads the pinned cosign with curl when none is on
// PATH. In the signing job that is a fetch with the key mounted. With the key
// mounted and no cosign on PATH, the scripts must now refuse and say why,
// never reach for the network. The environment is the job's own: the key
// mount (ORBIT_SIGNING_DIR) plus whatever `variables:` or inline assignments
// sign_evidence gives the two scripts, so the refusal may be keyed on either.
describe("signing scripts without cosign (#1368)", () => {
  const DIGEST = `sha256:${"1".repeat(64)}`;

  function jobEnvironment() {
    const env = {};
    const job = expandedJob();
    const variables = job.match(/^ {2}variables:\n((?: {4}\S.*\n?)+)/mu)?.[1] ?? "";
    for (const [, name, value] of variables.matchAll(/^ {4}([A-Z][A-Z0-9_]*):[ \t]*"?([^"\n]*)"?[ \t]*$/gmu)) {
      if (!value.includes("$")) env[name] = value;
    }
    for (const match of job.matchAll(/^ +([A-Z][A-Z0-9_]*)=("?)([^\s"$\\]+)\2 \\$/gmu)) {
      env[match[1]] = match[3];
    }
    return env;
  }

  // A PATH holding the tools the scripts need and nothing else: no cosign,
  // and a curl that records the attempt and fails.
  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), "sign-no-cosign-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["bash", "node", "sed", "sha256sum", "mktemp", "dirname", "date", "cat", "chmod", "mv", "rm", "mkdir", "base64", "git", "tr", "head", "grep", "env", "sh"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }
    const log = join(dir, "network.log");
    writeFileSync(log, "");
    for (const tool of ["curl", "wget"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const signingDir = join(dir, "orbit-signing");
    mkdirSync(signingDir);
    writeFileSync(join(signingDir, "cosign.key"), "TEST-PRIVATE-KEY-NOT-REAL\n");
    writeFileSync(join(signingDir, "password"), "TEST-PASSWORD-NOT-REAL\n");
    const manifest = join(dir, "orbit-release-manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
        version: "1.4.0",
        channel: "preview",
        commit: "a".repeat(40),
        image: { repository: "registry.example/ai/orbit", digest: DIGEST },
        launcher: { tag: "v1.2.3", commit: "b".repeat(40) },
        files: {},
        recordedAt: "2026-09-24T00:00:00Z",
      }),
    );
    return { dir, bin, log, signingDir, manifest };
  }

  function run(args, { dir, bin, signingDir }) {
    return failOnProcessDeadline(
      spawnSync("bash", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          PATH: bin,
          HOME: dir,
          ORBIT_SIGNING_DIR: signingDir,
          ORBIT_COSIGN_DIR: join(dir, "cosign-cache"),
          CI_COMMIT_SHA: "c".repeat(40),
          CI_COMMIT_REF_NAME: "preview",
          CI_PIPELINE_ID: "1368",
          CI_PIPELINE_URL: "https://gitlab.example/ai/orbit/-/pipelines/1368",
          ORBIT_POLICY_VERSION: `sha256:${"d".repeat(64)}`,
          ...jobEnvironment(),
        },
        ...processGuard(),
      }),
      { label: "signing script" },
    );
  }

  it("attest-tested-image.sh refuses, naming cosign, and never touches the network", () => {
    const box = sandbox();
    const image = `registry.example/ai/orbit@${DIGEST}`;
    const result = run(["scripts/ci/attest-tested-image.sh", image, DIGEST], box);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cosign/u);
    expect(readFileSync(box.log, "utf8"), "curl or wget was called").toBe("");
    expect(existsSync(join(box.dir, "cosign-cache")), "a cosign cache was created for a download").toBe(false);
  });

  it("sign-release-manifest.sh refuses, naming cosign, and never touches the network", () => {
    const box = sandbox();
    const result = run(["scripts/ci/sign-release-manifest.sh", box.manifest, DIGEST], box);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cosign/u);
    expect(readFileSync(box.log, "utf8"), "curl or wget was called").toBe("");
    expect(existsSync(`${box.manifest}.sig`)).toBe(false);
  });
});
