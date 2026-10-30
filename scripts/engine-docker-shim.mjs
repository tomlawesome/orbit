import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * A fake `docker` for tests that drive the real scripts/configure.sh (#1210).
 *
 * configure.sh runs every flow as `docker run --rm ... --entrypoint node
 * <image> /opt/orbit/cli/orbit.js <args> --dir /orbit-deploy` with the
 * deployment directory bind-mounted at /orbit-deploy. This shim runs the same
 * orbit CLI from this checkout (src/cli/orbit.ts through tsx) with the mount
 * path translated back to the host directory and only the `-e` variables the
 * real run would forward (plus the image's own ORBIT_ENGINE_CONTEXT), so a
 * suite exercises configure.sh or install.sh, its argv and the engine
 * together without a daemon or an image. Everything else it is asked
 * answers like a present image on a rootful daemon, or as configured.
 *
 * Every invocation's argv is appended, one JSON array per line, to
 * $ORBIT_FAKE_DOCKER_LOG when that is set.
 *
 * Options (all optional): imagePresent (default true), pullSucceeds
 * (default true), rootless (default false), oidcDiscoveryStub (default
 * false: the pretend container's engine gets writeOidcDiscoveryStub's
 * provider; the environment's ORBIT_TEST_OIDC_PUBLISHED_ISSUER does not cross
 * into it, so it answers with the entered issuer).
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/*
 * #1454: the engine now fetches the OIDC provider's discovery document when
 * it asks for the issuer, and a test has no provider. This preload answers
 * every discovery request with the discovery URL minus its well-known suffix
 * (an issuer entered with its trailing slash matches), or with
 * $ORBIT_TEST_OIDC_PUBLISHED_ISSUER when that is set. Start a child with
 * NODE_OPTIONS=--require <the returned path>.
 */
const OIDC_STUB_FILE = "oidc-discovery-stub.cjs";
export function writeOidcDiscoveryStub(dir) {
  const path = join(dir, OIDC_STUB_FILE);
  writeFileSync(
    path,
    `const real = globalThis.fetch;
const suffix = ".well-known/openid-configuration";
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.endsWith(suffix)) return real(input, init);
  return new Response(JSON.stringify({ issuer: process.env.ORBIT_TEST_OIDC_PUBLISHED_ISSUER || url.slice(0, -suffix.length) }), { status: 200 });
};
`,
  );
  return path;
}

export function writeEngineDockerShim(binDir, { imagePresent = true, pullSucceeds = true, rootless = false, oidcDiscoveryStub = false } = {}) {
  if (oidcDiscoveryStub) writeOidcDiscoveryStub(binDir);
  const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const cli = join(repoRoot, "src", "cli", "orbit.ts");
  const source = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
if (process.env.ORBIT_FAKE_DOCKER_LOG) appendFileSync(process.env.ORBIT_FAKE_DOCKER_LOG, JSON.stringify(argv) + "\\n");
const [command, sub] = argv;
if (command === "image" && sub === "inspect") process.exit(${imagePresent ? 0 : 1});
if (command === "pull") process.exit(${pullSucceeds ? 0 : 1});
if (command === "info") { process.stdout.write(${JSON.stringify(rootless ? "[name=seccomp,profile=builtin name=rootless name=cgroupns]" : "[name=seccomp,profile=builtin name=cgroupns]")} + "\\n"); process.exit(0); }
if (command !== "run") { process.stderr.write("fake docker: unsupported " + argv.join(" ") + "\\n"); process.exit(1); }
// The image's own ENV (Dockerfile): every engine one-off runs with it.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: process.env.TERM, ORBIT_ENGINE_CONTEXT: "container" };
${oidcDiscoveryStub ? `env.NODE_OPTIONS = ${JSON.stringify(`--require ${join(binDir, OIDC_STUB_FILE)}`)};` : ""}
const mounts = [];
let index = 1;
const flagsWithValue = new Set(["-e", "--env", "-v", "--volume", "--entrypoint", "--network", "--user", "--name"]);
let entrypoint;
for (; index < argv.length; index += 1) {
  const flag = argv[index];
  if (!flag.startsWith("-")) break;
  if (!flagsWithValue.has(flag)) continue;
  const value = argv[++index];
  if (flag === "-e" || flag === "--env") {
    const eq = value.indexOf("=");
    if (eq >= 0) env[value.slice(0, eq)] = value.slice(eq + 1);
    else if (process.env[value] !== undefined) env[value] = process.env[value];
  } else if (flag === "-v" || flag === "--volume") {
    const [source, target] = value.split(":");
    mounts.push([target, source]);
  } else if (flag === "--entrypoint") {
    entrypoint = value;
  }
}
const image = argv[index];
const rest = argv.slice(index + 1);
if (entrypoint !== "node" || rest[0] !== "/opt/orbit/cli/orbit.js") {
  process.stderr.write("fake docker: unexpected run " + JSON.stringify({ entrypoint, image, rest }) + "\\n");
  process.exit(125);
}
const translate = (value) => {
  for (const [target, source] of mounts) {
    if (value === target) return source;
    if (value.startsWith(target + "/")) return source + value.slice(target.length);
  }
  return value;
};
const result = spawnSync("node", [${JSON.stringify(tsx)}, ${JSON.stringify(cli)}, ...rest.slice(1).map(translate)], { stdio: "inherit", env });
process.exit(result.status === null ? 1 : result.status);
`;
  const path = join(binDir, "docker");
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}
