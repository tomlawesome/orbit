import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SCANNED_FILE, findUncachedImageReferences } from "./image-cache-sources.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "image-cache-sources.mjs");

function scan(path, text, exceptions = []) {
  return findUncachedImageReferences([{ path, text }], exceptions);
}

function ci(text) {
  return scan(".gitlab-ci.yml", text);
}

describe("allowed references (#1510)", () => {
  it("allows plain Docker Hub names, with and without a digest", () => {
    const text = [
      "services:",
      "  a:",
      `    image: node:22-bookworm@${DIGEST}`,
      "  b:",
      "    image: greenmail/standalone:2.1.13",
      "  c:",
      "    image: library/postgres:17",
      "  d:",
      "    image: docker:29.6.2-dind",
    ].join("\n");
    expect(scan("docker-compose.yml", text)).toEqual([]);
  });

  it("allows docker.io names, because the mirror covers them", () => {
    expect(scan("compose/test.yml", "services:\n  a:\n    image: docker.io/library/redis:8\n")).toEqual([]);
  });

  it("allows the cache variable prefixes in plain and braced form", () => {
    const text = [
      "a:",
      "  image: $CI_IMAGE_CACHE_DOCKERHUB/library/node:22",
      "b:",
      "  image: $CI_IMAGE_CACHE_GHCR/owner/tool:1.0",
      "c:",
      "  image: $CI_IMAGE_CACHE_MCR/playwright:v1",
      "d:",
      "  image: ${CI_IMAGE_CACHE_DOCKERHUB}/library/node:22",
      "e:",
      "  image: ${CI_IMAGE_CACHE_GHCR}/owner/tool:1.0",
      "f:",
      "  image: ${CI_IMAGE_CACHE_MCR}/playwright:v1",
    ].join("\n");
    expect(ci(text)).toEqual([]);
  });

  it("allows the project's own registry forms", () => {
    const text = [
      "a:",
      "  image: registry.tomlawson.io/ai/orbit/base:latest",
      "b:",
      "  image: $CI_REGISTRY_IMAGE:latest",
      "c:",
      "  image: ${CI_REGISTRY_IMAGE}:latest",
      "d:",
      "  image: $CI_REGISTRY/ai/orbit/tool:1",
    ].join("\n");
    expect(ci(text)).toEqual([]);
  });

  it("allows a local tag with no slash and a variable", () => {
    expect(ci("job:\n  image: orbit-ci:$CI_COMMIT_SHA\n")).toEqual([]);
  });
});

describe("forbidden registry hosts (#1510)", () => {
  const hosts = [
    "ghcr.io/owner/tool:1.0",
    "mcr.microsoft.com/playwright:v1.50",
    "quay.io/org/tool:2",
    "gcr.io/project/tool:3",
    "europe-docker.pkg.dev/project/repo/tool:4",
    "public.ecr.aws/org/tool:5",
  ];

  for (const reference of hosts) {
    it(`finds ${reference.split("/")[0]} in a YAML image value, with its line`, () => {
      const findings = ci(`stages:\n  - test\njob:\n  image: ${reference}\n`);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ path: ".gitlab-ci.yml", line: 4, reference });
      expect(findings[0].reason).toContain("not through the image cache");
    });
  }

  it("finds a host in a services name: value", () => {
    const findings = ci("job:\n  services:\n    - name: ghcr.io/owner/db:1\n      alias: db\n");
    expect(findings.map((f) => [f.line, f.reference])).toEqual([[3, "ghcr.io/owner/db:1"]]);
  });

  it("finds a host in a YAML variable value", () => {
    const findings = ci("variables:\n  TOOL_IMAGE: mcr.microsoft.com/dotnet/sdk:9\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 2, reference: "mcr.microsoft.com/dotnet/sdk:9" });
  });

  it("finds a host in a Compose image value", () => {
    const findings = scan("docker-compose.yml", "services:\n  a:\n    image: quay.io/org/tool:2\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "docker-compose.yml", line: 3, reference: "quay.io/org/tool:2" });
  });

  it("finds a host in shell docker pull and docker run lines", () => {
    const text = "#!/bin/sh\ndocker pull ghcr.io/owner/tool:1\ndocker run --rm quay.io/org/x:2 --help\n";
    const findings = scan("scripts/ci/pull.sh", text);
    expect(findings.map((f) => [f.line, f.reference])).toEqual([
      [2, "ghcr.io/owner/tool:1"],
      [3, "quay.io/org/x:2"],
    ]);
  });

  it("finds a host in a string literal in a .mjs file", () => {
    const text = 'const IMAGE = "ghcr.io/owner/tool:1";\nexport { IMAGE };\n';
    const findings = scan("scripts/tool.mjs", text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, reference: "ghcr.io/owner/tool:1" });
  });

  it("reports findings in file order, then line order", () => {
    const findings = findUncachedImageReferences(
      [
        { path: ".gitlab-ci.yml", text: "a:\n  image: ghcr.io/o/a:1\nb:\n  image: quay.io/o/b:1\n" },
        { path: "docker-compose.yml", text: "services:\n  c:\n    image: gcr.io/o/c:1\n" },
      ],
      [],
    );
    expect(findings.map((f) => [f.path, f.line])).toEqual([
      [".gitlab-ci.yml", 2],
      [".gitlab-ci.yml", 4],
      ["docker-compose.yml", 3],
    ]);
  });
});

describe("any other registry host is refused: default deny (#1536 D-F13)", () => {
  // Docker's rule: the first path segment is a registry when it holds a dot or a :port.
  const unknown = [
    "lscr.io/x/y:1",
    "registry.k8s.io/x:1",
    `cgr.dev/x@${DIGEST}`,
    "registry.example.com:5000/team/tool:2",
    "registry-host:5000/tool:3",
    "192.0.2.10:5000/tool:4",
    "docker.elastic.co/elasticsearch/elasticsearch:8",
    "registry.gitlab.com/group/tool@" + DIGEST,
  ];

  for (const reference of unknown) {
    it(`finds ${reference.split("/")[0]} in a YAML image value, with its line`, () => {
      const findings = ci(`stages:\n  - test\njob:\n  image: ${reference}\n`);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ path: ".gitlab-ci.yml", line: 4, reference });
      expect(findings[0].reason).toContain("not through the image cache");
    });
  }

  it("finds an unknown host in shell docker pull and docker run lines", () => {
    const text = "#!/bin/sh\ndocker pull lscr.io/x/y:1\ndocker run --rm registry.k8s.io/x:1 --help\n";
    const findings = scan("scripts/ci/pull.sh", text);
    expect(findings.map((f) => [f.line, f.reference])).toEqual([
      [2, "lscr.io/x/y:1"],
      [3, "registry.k8s.io/x:1"],
    ]);
  });

  it("finds an unknown host after a Dockerfile FROM", () => {
    const findings = scan("Dockerfile", `FROM cgr.dev/chainguard/node@${DIGEST} AS build\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, reference: `cgr.dev/chainguard/node@${DIGEST}` });
  });

  it("finds an unknown host in a string literal in a .mjs file", () => {
    const findings = scan("scripts/tool.mjs", 'const IMAGE = "registry.k8s.io/x:1";\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, reference: "registry.k8s.io/x:1" });
  });

  it("says the host and that the pull bypasses the cache", () => {
    const [finding] = ci("job:\n  image: lscr.io/x/y:1\n");
    expect(finding.reason).toContain("lscr.io");
  });

  it("does not flag a URL on a shell line", () => {
    expect(scan("scripts/ci/fetch.sh", "curl -fsSL https://example.com/path\n")).toEqual([]);
  });

  it("does not flag a URL with a port or a version-like path", () => {
    expect(scan("scripts/ci/fetch.sh", "curl -fsSL https://example.com:8443/v1/tool:1\n")).toEqual([]);
  });

  it("does not flag a dotted name with neither a tag nor a digest", () => {
    expect(scan("scripts/ci/note.sh", "echo see example.com/docs/page\n")).toEqual([]);
  });

  it("allows the disposable local registry on 127.0.0.1 and localhost", () => {
    const text = "a:\n  image: 127.0.0.1:5000/orbit:dev\nb:\n  image: localhost:5000/orbit:dev\nc:\n  image: localhost/orbit:dev\n";
    expect(ci(text)).toEqual([]);
  });

  it("allows the cache prefixes and Orbit's own registry by name", () => {
    const text = [
      "a:",
      "  image: $CI_IMAGE_CACHE_GHCR/x:1",
      "b:",
      "  image: ${CI_IMAGE_CACHE_MCR}/x:1",
      "c:",
      "  image: registry.tomlawson.io/ai/orbit/base@" + DIGEST,
      "d:",
      "  image: docker.io/library/redis:8",
    ].join("\n");
    expect(ci(text)).toEqual([]);
  });

  it("an exception still covers an unknown host, and goes stale when unused", () => {
    const exception = { path: ".gitlab-ci.yml", reference: "lscr.io/x/y:1", reason: "No mirror carries it." };
    expect(scan(".gitlab-ci.yml", "job:\n  image: lscr.io/x/y:1\n", [exception])).toEqual([]);
    const stale = scan(".gitlab-ci.yml", "job:\n  image: node:22\n", [exception]);
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toContain("stale exception");
  });
});

describe("the retired Dependency Proxy (#1510)", () => {
  const uses = [
    "$CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX/node:22",
    "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/node:22",
    "$CI_DEPENDENCY_PROXY_DIRECT_GROUP_IMAGE_PREFIX/node:22",
  ];

  for (const use of uses) {
    it(`finds ${use.split("/")[0]} as an image prefix`, () => {
      const findings = ci(`job:\n  image: ${use}\n`);
      expect(findings).toHaveLength(1);
      expect(findings[0].line).toBe(2);
      expect(findings[0].reason).toContain("Dependency Proxy");
    });
  }

  for (const name of ["CI_DEPENDENCY_PROXY_USER", "CI_DEPENDENCY_PROXY_PASSWORD", "CI_DEPENDENCY_PROXY_SERVER"]) {
    it(`finds ${name} in a shell login line`, () => {
      const text = `echo "$${name}" | docker login -u x --password-stdin\n`;
      const findings = scan("scripts/ci/login.sh", text);
      expect(findings).toHaveLength(1);
      expect(findings[0].reason).toContain("Dependency Proxy");
    });
  }

  it("does not flag the allowed cache prefix as a Dependency Proxy use", () => {
    expect(ci("job:\n  image: $CI_IMAGE_CACHE_DOCKERHUB/library/node:22\n")).toEqual([]);
  });
});

describe("Dockerfiles (#1510)", () => {
  it("allows a FROM whose registry is a build-arg variable", () => {
    const text = `ARG BASE_IMAGE_REGISTRY=registry.tomlawson.io\nFROM \${BASE_IMAGE_REGISTRY}/orbit-base-image:latest@${DIGEST}\n`;
    expect(scan("Dockerfile", text)).toEqual([]);
  });

  it("finds a literal forbidden host after FROM", () => {
    const findings = scan("docker/Dockerfile.ci", `FROM ghcr.io/owner/base:1@${DIGEST} AS build\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "docker/Dockerfile.ci", line: 1 });
    expect(findings[0].reference).toContain("ghcr.io/owner/base:1");
  });

  it("treats FROM <stage-name> and FROM scratch as not references", () => {
    const text = "FROM node:22 AS build\nFROM scratch AS empty\nFROM build\nFROM empty\n";
    expect(scan("Dockerfile", text)).toEqual([]);
  });

  it("allows a plain Docker Hub FROM with a digest", () => {
    expect(scan("tests/e2e/Dockerfile", `FROM node:22-bookworm@${DIGEST}\n`)).toEqual([]);
  });
});

describe("Docker-in-Docker registry mirror (#1510)", () => {
  const MIRROR = "--registry-mirror=http://$CI_IMAGE_CACHE_DOCKERHUB";
  const MIRROR_BRACED = "--registry-mirror=http://${CI_IMAGE_CACHE_DOCKERHUB}";

  it("finds a string-form dind service, which has nowhere to put the flag", () => {
    const findings = ci("job:\n  services:\n    - docker:29.6.2-dind\n");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
    expect(findings[0].reason).toContain("registry-mirror");
  });

  it("passes a name-form dind service with the $ mirror flag", () => {
    const text = `job:\n  services:\n    - name: docker:29.6.2-dind\n      command: ["${MIRROR}"]\n`;
    expect(ci(text)).toEqual([]);
  });

  it("passes a name-form dind service with the braced mirror flag", () => {
    const text = `job:\n  services:\n    - name: docker:29.6.2-dind\n      command:\n        - ${MIRROR_BRACED}\n`;
    expect(ci(text)).toEqual([]);
  });

  it("passes a dind service whose entrypoint reads the cache address from its environment", () => {
    const text = [
      "job:",
      "  services:",
      "    - name: docker:29.6.2-dind",
      "      entrypoint:",
      "        - /bin/sh",
      "        - -c",
      '        - >-',
      '          set -- "$(printenv CI_IMAGE_CACHE_DOCKERHUB)";',
      '          exec dockerd-entrypoint.sh --registry-mirror="http://$1"',
      "",
    ].join("\n");
    expect(ci(text)).toEqual([]);
  });

  it("finds a dind service whose entrypoint reads the address but never passes a mirror", () => {
    const text = [
      "job:",
      "  services:",
      "    - name: docker:29.6.2-dind",
      "      entrypoint:",
      "        - /bin/sh",
      "        - -c",
      '        - set -- "$(printenv CI_IMAGE_CACHE_DOCKERHUB)"; exec dockerd-entrypoint.sh',
      "",
    ].join("\n");
    expect(ci(text)).toHaveLength(1);
  });

  it("finds a name-form dind service with no command, on the service's line", () => {
    const text = "job:\n  services:\n    - name: docker:29.6.2-dind\n      alias: docker\n";
    const findings = ci(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
    expect(findings[0].reason).toContain("registry-mirror");
  });

  it("finds a dind service whose command lacks the mirror flag", () => {
    const text = 'job:\n  services:\n    - name: docker:29.6.2-dind\n      command: ["--tls=false"]\n';
    const findings = ci(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("registry-mirror");
  });

  it("finds each unmirrored dind service separately", () => {
    const text = [
      "a:",
      "  services:",
      "    - docker:29.6.2-dind",
      "b:",
      "  services:",
      `    - name: docker:29.6.2-dind`,
      `      command: ["${MIRROR}"]`,
      "c:",
      "  services:",
      "    - name: docker:29.7.0-dind",
    ].join("\n");
    expect(ci(text).map((f) => f.line)).toEqual([3, 10]);
  });

  it("does not ask for the flag on non-dind services", () => {
    expect(ci("job:\n  services:\n    - name: postgres:17\n      alias: db\n")).toEqual([]);
  });

  it("only applies the dind rule to .gitlab-ci.yml", () => {
    const text = "services:\n  dind:\n    image: docker:29.6.2-dind\n";
    expect(scan("docker-compose.yml", text)).toEqual([]);
  });
});

describe("comments are ignored (#1510)", () => {
  it("ignores # comments in YAML", () => {
    expect(ci("# copied from ghcr.io/owner/tool:1\njob:\n  image: node:22 # not mcr.microsoft.com/x:1\n")).toEqual([]);
  });

  it("ignores # comments in shell", () => {
    expect(scan("scripts/ci/a.sh", "# docker pull ghcr.io/o/t:1\necho ok # quay.io/o/t:1\n")).toEqual([]);
  });

  it("ignores # comments in a Dockerfile", () => {
    expect(scan("Dockerfile", "# FROM ghcr.io/o/t:1\nFROM node:22\n")).toEqual([]);
  });

  it("ignores // and /* */ comments in .mjs", () => {
    const text = [
      "// see ghcr.io/o/t:1",
      "/* quay.io/o/t:2",
      "   gcr.io/o/t:3 */",
      "export const X = 1; // mcr.microsoft.com/x:1",
    ].join("\n");
    expect(scan("scripts/tool.mjs", text)).toEqual([]);
  });

  it("still reports the line after a multi-line block comment", () => {
    const text = "/* one\n two */\nconst I = 'ghcr.io/o/t:1';\n";
    expect(scan("scripts/tool.mjs", text).map((f) => f.line)).toEqual([3]);
  });
});

describe("exceptions (#1510)", () => {
  const text = "job:\n  image: ghcr.io/owner/tool:1\n";
  const exception = { path: ".gitlab-ci.yml", reference: "ghcr.io/owner/tool:1", reason: "No mirror carries it." };

  it("drops a finding whose path and reference both match", () => {
    expect(scan(".gitlab-ci.yml", text, [exception])).toEqual([]);
  });

  it("keeps a finding when the path differs", () => {
    const findings = scan(".gitlab-ci.yml", text, [{ ...exception, path: "docker-compose.yml" }]);
    expect(findings.some((f) => f.reference === "ghcr.io/owner/tool:1")).toBe(true);
  });

  it("keeps a finding when the reference differs", () => {
    const findings = scan(".gitlab-ci.yml", text, [{ ...exception, reference: "ghcr.io/owner/tool:2" }]);
    expect(findings.some((f) => f.reference === "ghcr.io/owner/tool:1")).toBe(true);
  });

  it("reports an exception with an empty reason", () => {
    const findings = scan(".gitlab-ci.yml", text, [{ ...exception, reason: "" }]);
    expect(findings.some((f) => f.reason.includes("needs a reason"))).toBe(true);
  });

  it("reports an exception with no reason at all", () => {
    const { reason: _unused, ...bare } = exception;
    const findings = scan(".gitlab-ci.yml", text, [bare]);
    expect(findings.some((f) => f.reason.includes("needs a reason"))).toBe(true);
  });

  it("reports an exception that matches nothing as stale", () => {
    const findings = scan(".gitlab-ci.yml", "job:\n  image: node:22\n", [exception]);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("stale exception");
  });

  it("does not report a used exception as stale", () => {
    const findings = scan(".gitlab-ci.yml", text, [exception]);
    expect(findings.some((f) => f.reason.includes("stale exception"))).toBe(false);
  });

  it("excepts a literal Dockerfile FROM host", () => {
    const from = "FROM ghcr.io/owner/base:1\n";
    const found = scan("Dockerfile", from);
    expect(found).toHaveLength(1);
    const exceptions = [{ path: "Dockerfile", reference: found[0].reference, reason: "Pinned upstream." }];
    expect(scan("Dockerfile", from, exceptions)).toEqual([]);
  });
});

describe("SCANNED_FILE (#1510)", () => {
  it.each([
    ".gitlab-ci.yml",
    "docker-compose.yml",
    "docker-compose.ci.yml",
    "compose/test.yml",
    "Dockerfile",
    "Dockerfile.ci",
    "docker/Dockerfile",
    "services/api/Dockerfile.prod",
    "tests/e2e/Dockerfile",
    "scripts/pull.sh",
    "scripts/ci/pull.sh",
    "scripts/lib/tool.mjs",
  ])("reads %s", (path) => {
    expect(SCANNED_FILE(path)).toBe(true);
  });

  it.each([
    ".github/workflows/ci.yml",
    ".github/pull_request_template.md",
    "docs/ci.md",
    "README.md",
    "tests/e2e/helper.mjs",
    "tests/compose.yml",
    "scripts/supply-chain-policy.test.mjs",
    "scripts/ci/check.test.sh",
    "src/app.ts",
    "package.json",
  ])("skips %s", (path) => {
    expect(SCANNED_FILE(path)).toBe(false);
  });
});

describe("command line (#1510)", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
  });

  // A throwaway git repository holding the script and the given files.
  function fixtureRepo(files) {
    const root = mkdtempSync(join(tmpdir(), "orbit-image-cache-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "scripts", "image-cache-sources.mjs"));
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    execFileSync("git", ["add", "."], { cwd: root });
    return root;
  }

  function run(root) {
    return spawnSync("node", ["scripts/image-cache-sources.mjs"], { cwd: root, encoding: "utf8" });
  }

  it("exits 0 and prints nothing when every reference is cached", () => {
    const root = fixtureRepo({
      ".gitlab-ci.yml": "job:\n  image: node:22\n",
      ".github/image-cache-exceptions.json": '{ "exceptions": [] }\n',
    });
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 1 and prints path:line: reference — reason for each finding", () => {
    const root = fixtureRepo({
      ".gitlab-ci.yml": "job:\n  image: ghcr.io/owner/tool:1\n",
      ".github/image-cache-exceptions.json": '{ "exceptions": [] }\n',
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^\.gitlab-ci\.yml:2: ghcr\.io\/owner\/tool:1 — .*not through the image cache/m);
  });

  it("exits 1 for a registry host the old list did not name (#1536 D-F13)", () => {
    const root = fixtureRepo({
      ".gitlab-ci.yml": "job:\n  image: registry.k8s.io/x:1\n",
      ".github/image-cache-exceptions.json": '{ "exceptions": [] }\n',
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^\.gitlab-ci\.yml:2: registry\.k8s\.io\/x:1 — /m);
  });

  it("honours the exceptions file", () => {
    const root = fixtureRepo({
      ".gitlab-ci.yml": "job:\n  image: ghcr.io/owner/tool:1\n",
      ".github/image-cache-exceptions.json": JSON.stringify({
        exceptions: [{ path: ".gitlab-ci.yml", reference: "ghcr.io/owner/tool:1", reason: "No mirror carries it." }],
      }),
    });
    expect(run(root).status).toBe(0);
  });

  it("ignores tracked files the check does not read", () => {
    const root = fixtureRepo({
      "docs/ci.md": "docker pull ghcr.io/owner/tool:1\n",
      ".github/image-cache-exceptions.json": '{ "exceptions": [] }\n',
    });
    expect(run(root).status).toBe(0);
  });
});
