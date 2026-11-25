import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { failOnProcessDeadline, processGuard, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

/*
 * #1489: the acceptance stack's GreenMail sidecar must not trust the leaked
 * emSign and COMODO roots. tests/greenmail/Dockerfile derives from the pinned
 * upstream image and removes them from the Java store and the system bundle.
 *
 * Needs a real Docker daemon (it runs the images), so the `fast` lane
 * excludes this file (ORBIT_TEST_SKIP_DOCKER in vitest.config.ts) and
 * `fast_docker` runs it.
 *
 * The image is built before the tests run, never inside them, so every
 * spawn here keeps the standard process budget (scripts/process-budget.mjs):
 * fast_docker builds it in its script, as the acceptance jobs build
 * orbit-dkim-dns, and scripts/test-backend.sh builds it first locally. Where
 * the image is missing, the tests fail in CI and say how to build it;
 * outside CI they skip and say so, like popplerIt.
 *
 * ORBIT_GREENMAIL_ROOTS_IMAGE points the same checks at another image; run
 * against the upstream image they must fail. The control test below keeps
 * that honest in every run: it asserts the detector finds the blocked roots
 * in the upstream image.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS, hookTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(join(repoRoot, ".github/supply-chain-policy.json"), "utf8"));
const upstreamImage = JSON.stringify(policy)
  .match(/greenmail\/standalone:[0-9.]+@sha256:[0-9a-f]{64}/u)?.[0];
/** The tag fast_docker and scripts/test-backend.sh build tests/greenmail as. */
export const GREENMAIL_ROOTS_TAG = "orbit-greenmail-roots:local";
const BUILD_HINT = `build it first: docker build -t ${GREENMAIL_ROOTS_TAG} tests/greenmail (fast_docker and scripts/test-backend.sh do)`;

// The blocked set, by certificate subject (never by alias or file name):
// every emSign root (O=eMudhra) and COMODO AAA / ECC / RSA. COMODO AAA's
// subject is "AAA Certificate Services"; the CN pattern accepts both forms.
const BLOCKED = [
  /\bO\s*=\s*eMudhra/iu,
  /\bCN\s*=\s*(AAA Certificate Services|COMODO (AAA|ECC|RSA) Certification Authority)\s*(,|$)/iu,
];
const isBlocked = (subject) => BLOCKED.some((re) => re.test(subject));

function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: processGuard.timeout,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  failOnProcessDeadline(result, `docker ${args[0]}`);
  return result;
}

function run(image, script) {
  const r = docker(["run", "--rm", "--entrypoint", "sh", image, "-c", script]);
  if (r.status !== 0) throw new Error(`docker run ${image} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

// Subjects from the Java store (keytool Owner lines) and the system bundle
// (each PEM block through openssl), as the image's default user sees them.
const JAVA_OWNERS = "keytool -list -v -cacerts -storepass changeit 2>/dev/null | grep '^Owner:'";
const SYSTEM_SUBJECTS =
  'd=$(mktemp -d); cd "$d"; awk \'/BEGIN CERT/{n++} {print > ("c" n ".pem")}\' /etc/ssl/certs/ca-certificates.crt; ' +
  'for f in c*.pem; do openssl x509 -noout -subject -in "$f"; done';
const JAVA_COUNT = "keytool -list -cacerts -storepass changeit 2>/dev/null | grep -c trustedCertEntry";

function inspectImage(image) {
  const lines = (out) => out.split("\n").filter(Boolean);
  const java = lines(run(image, JAVA_OWNERS));
  const system = lines(run(image, SYSTEM_SUBJECTS));
  const meta = JSON.parse(docker(["image", "inspect", image, "--format", "{{json .Config}}"]).stdout);
  return {
    blockedJava: java.filter(isBlocked),
    blockedSystem: system.filter(isBlocked),
    javaRoots: Number(run(image, JAVA_COUNT).trim()),
    systemRoots: system.length,
    user: meta.User,
    entrypoint: meta.Entrypoint,
    cmd: meta.Cmd,
  };
}

const image = process.env.ORBIT_GREENMAIL_ROOTS_IMAGE || GREENMAIL_ROOTS_TAG;
const present = (ref) => docker(["image", "inspect", ref, "--format", "{{.Id}}"]).status === 0;
const HAS_IMAGE = present(image);
const SKIP = !HAS_IMAGE && !process.env.CI;
const NEEDS_IMAGE = HAS_IMAGE ? "" : process.env.CI ? ` (FAILS: ${image} missing in CI)` : ` (SKIPPED: ${image} not built; ${BUILD_HINT})`;
let derived;
let upstream;

beforeAll(() => {
  if (SKIP) return;
  expect(upstreamImage, "policy lists the pinned GreenMail reference").toBeTruthy();
  if (!HAS_IMAGE) throw new Error(`${image} is missing in CI; ${BUILD_HINT}`);
  derived = inspectImage(image);
  upstream = inspectImage(upstreamImage);
});

describe.skipIf(SKIP)(`GreenMail sidecar image (#1489)${NEEDS_IMAGE}`, () => {
  it("control: the upstream image does trust the blocked roots, so the detector can see them", () => {
    expect(upstream.blockedJava.length).toBeGreaterThanOrEqual(6);
    expect(upstream.blockedSystem.length).toBeGreaterThan(0);
  });

  it("trusts no blocked root in the Java store", () => {
    expect(derived.blockedJava).toEqual([]);
  });

  it("trusts no blocked root in the system bundle", () => {
    expect(derived.blockedSystem).toEqual([]);
  });

  it("keeps the rest of the Java store (more than 100 roots)", () => {
    expect(derived.javaRoots).toBeGreaterThan(100);
  });

  it("keeps the rest of the system bundle", () => {
    expect(derived.systemRoots).toBeGreaterThan(100);
  });

  it("runs as greenmail, not root", () => {
    expect(derived.user).toBe("greenmail");
  });

  it("keeps the upstream entrypoint and command", () => {
    expect(derived.entrypoint).toEqual(upstream.entrypoint);
    expect(derived.cmd).toEqual(upstream.cmd);
  });
});
