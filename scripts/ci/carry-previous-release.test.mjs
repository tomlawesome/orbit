import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * scripts/ci/carry-previous-release.sh (#1480) saves the previous build's
 * signed release manifest, from the GitLab job-artifacts API, under
 * .orbit-supply-chain/previous/ so a later consumer can find it with no job
 * ID. It must never fail the pipeline: anything it cannot fetch or trust is
 * the "no predecessor" outcome, exit 0 with nothing written. curl is stubbed
 * on PATH; the stub serves bodies from a map keyed by URL path plus query
 * (the part after CI_API_V4_URL), honours --output/-o and stdout, and exits
 * 22 for an unknown URL, which is curl's code for an HTTP error under --fail.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./carry-previous-release.sh", import.meta.url).pathname;

const API = "https://gitlab.example.test/api/v4";
const PROJECT = "42";
const TOKEN = "glcbt-TEST-TOKEN-NOT-REAL";
const CURRENT = `sha256:${"1".repeat(64)}`;
const OLDER = `sha256:${"2".repeat(64)}`;
const SIG_BYTES = "STUB-SIG-AAAA+/==";

const CURL_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'printf \'curl\' >> "$STUB_LOG"',
  'for a in "$@"; do printf \'\\x1f%s\' "$a" >> "$STUB_LOG"; done',
  "printf '\\x1e' >> \"$STUB_LOG\"",
  "output=",
  "url=",
  "header_ok=",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -o|--output) output="$2"; shift 2 ;;',
  '    --output=*) output="${1#--output=}"; shift ;;',
  '    -H|--header) case "$2" in "JOB-TOKEN: $CI_JOB_TOKEN") header_ok=1 ;; esac; shift 2 ;;',
  '    --header=*) case "${1#--header=}" in "JOB-TOKEN: $CI_JOB_TOKEN") header_ok=1 ;; esac; shift ;;',
  '    http://*|https://*) url="$1"; shift ;;',
  "    *) shift ;;",
  "  esac",
  "done",
  '[ -n "$url" ] || exit 2',
  '# No token header means GitLab answers 401 and --fail turns it into 22.',
  '[ -n "$header_ok" ] || exit 22',
  'key="${url#"$CI_API_V4_URL"}"',
  'name="$(printf %s "$key" | base64 -w0 | tr "/+" "__")"',
  'body="$STUB_MAP_DIR/$name"',
  '[ -f "$body" ] || exit 22',
  'if [ -n "$output" ]; then cat "$body" > "$output"; else cat "$body"; fi',
  "exit 0",
  "",
].join("\n");

const assetPath = (ref, file, job) =>
  `/projects/${PROJECT}/jobs/artifacts/${ref}/raw/.orbit-supply-chain/${file}?job=${job}`;
const mapName = (key) => Buffer.from(key).toString("base64").replace(/[/+]/g, "_");

const manifest = (digest) =>
  `{\n  "image": {"repository": "registry.example/ai/orbit", "digest": "${digest}"},\n  "version": "1.4.0"\n}`;

/*
 * routes: { "<path?query>": body } -- anything else is a 404 (curl exit 22).
 * The default ref is "main"; the slash test passes its own.
 */
function run({ args = [CURRENT], routes = {}, ref = "main", env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "carry-previous-"));
  const bin = join(dir, "bin");
  const mapDir = join(dir, "map");
  const work = join(dir, "work");
  for (const d of [bin, mapDir, work]) mkdirSync(d);
  writeFileSync(join(bin, "curl"), CURL_STUB);
  chmodSync(join(bin, "curl"), 0o755);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  for (const [key, body] of Object.entries(routes)) writeFileSync(join(mapDir, mapName(key)), body);

  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...args], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CI_API_V4_URL: API,
        CI_PROJECT_ID: PROJECT,
        CI_COMMIT_REF_NAME: ref,
        CI_JOB_TOKEN: TOKEN,
        STUB_LOG: logFile,
        STUB_MAP_DIR: mapDir,
        ...env,
      },
      ...processGuard(),
    }),
    { label: "carry-previous-release" },
  );
  const calls = () =>
    readFileSync(logFile, "utf8")
      .split("\x1e")
      .filter(Boolean)
      .map((call) => call.split("\x1f").filter(Boolean).slice(1));
  const requestedKeys = () =>
    calls()
      .flatMap((argv) => argv.filter((arg) => arg.startsWith(API)))
      .map((url) => url.slice(API.length));
  const previousDir = join(work, ".orbit-supply-chain", "previous");
  const previousFiles = () => (existsSync(previousDir) ? readdirSync(previousDir).sort() : []);
  const previous = (name) => readFileSync(join(previousDir, name));
  return { result, calls, requestedKeys, previousFiles, previous, work };
}

const MANIFEST = "orbit-release-manifest.json";
const SIG = "orbit-release-manifest.json.sig";
const expectNoToken = (result) => {
  expect(result.stdout).not.toContain(TOKEN);
  expect(result.stderr).not.toContain(TOKEN);
};
const expectNoPredecessor = ({ result, previousFiles }) => {
  expect(result.status).toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("no predecessor on this ref");
  expect(previousFiles()).toEqual([]);
};

describe("carry-previous-release.sh", () => {
  it("normal case: writes the fetched manifest and signature byte-for-byte and names the fetched digest", () => {
    const manifestBody = manifest(OLDER);
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifestBody,
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
      },
    });
    expect(r.result.status).toBe(0);
    expect(r.result.stdout).toContain(OLDER);
    expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    expect(r.previous(MANIFEST).equals(Buffer.from(manifestBody))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(SIG_BYTES))).toBe(true);
    expectNoToken(r.result);
  });

  it("requests the manifest from job record_image and the signature from job sign_evidence, with the JOB-TOKEN header", () => {
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifest(OLDER),
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
      },
    });
    expect(r.result.status).toBe(0);
    const keys = r.requestedKeys();
    expect(keys).toContain(assetPath("main", MANIFEST, "record_image"));
    expect(keys).toContain(assetPath("main", SIG, "sign_evidence"));
    // A normal build has no reason to look at its own carried pair.
    expect(keys.filter((key) => key.includes("/previous/"))).toEqual([]);
    for (const argv of r.calls()) expect(argv.join("\n")).toContain(`JOB-TOKEN: ${TOKEN}`);
  });

  it("URL-encodes the slash in a branch name", () => {
    const r = run({
      ref: "hotfix/x",
      routes: {
        [assetPath("hotfix%2Fx", MANIFEST, "record_image")]: manifest(OLDER),
        [assetPath("hotfix%2Fx", SIG, "sign_evidence")]: SIG_BYTES,
      },
    });
    expect(r.result.status).toBe(0);
    expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    const keys = r.requestedKeys();
    expect(keys).toContain(assetPath("hotfix%2Fx", MANIFEST, "record_image"));
    expect(keys.some((key) => key.includes("hotfix/x"))).toBe(false);
  });

  it("rebuild: when the fetched digest is the current one, carries that build's own previous pair, both from record_image", () => {
    const carriedManifest = manifest(OLDER);
    const carriedSig = "CARRIED-SIG-BBBB";
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifest(CURRENT),
        [assetPath("main", SIG, "sign_evidence")]: "THIS-BUILDS-OWN-SIG",
        [assetPath("main", `previous/${MANIFEST}`, "record_image")]: carriedManifest,
        [assetPath("main", `previous/${SIG}`, "record_image")]: carriedSig,
      },
    });
    expect(r.result.status).toBe(0);
    expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    expect(r.previous(MANIFEST).equals(Buffer.from(carriedManifest))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(carriedSig))).toBe(true);
    const keys = r.requestedKeys();
    expect(keys).toContain(assetPath("main", `previous/${MANIFEST}`, "record_image"));
    expect(keys).toContain(assetPath("main", `previous/${SIG}`, "record_image"));
    expectNoToken(r.result);
  });

  it("rebuild without a carried pair: no predecessor, nothing written, exit 0", () => {
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifest(CURRENT),
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
      },
    });
    expectNoPredecessor(r);
  });

  it("rebuild with a carried manifest but no carried signature: nothing written", () => {
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifest(CURRENT),
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
        [assetPath("main", `previous/${MANIFEST}`, "record_image")]: manifest(OLDER),
      },
    });
    expectNoPredecessor(r);
  });

  it("rebuild whose carried manifest is also the current digest: no predecessor, nothing written", () => {
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifest(CURRENT),
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
        [assetPath("main", `previous/${MANIFEST}`, "record_image")]: manifest(CURRENT),
        [assetPath("main", `previous/${SIG}`, "record_image")]: "CARRIED-SIG-BBBB",
      },
    });
    expectNoPredecessor(r);
  });

  it("manifest fetch fails (404): no predecessor, nothing written, exit 0", () => {
    const r = run({ routes: { [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES } });
    expectNoPredecessor(r);
    expectNoToken(r.result);
  });

  it("signature fetch fails after the manifest succeeded: no predecessor, and no manifest left behind", () => {
    const r = run({ routes: { [assetPath("main", MANIFEST, "record_image")]: manifest(OLDER) } });
    expectNoPredecessor(r);
    expect(existsSync(join(r.work, ".orbit-supply-chain", "previous", MANIFEST))).toBe(false);
  });

  it.each([
    ["not JSON", "this is not json {"],
    ["empty", ""],
    ["JSON with no image", JSON.stringify({ version: "1.4.0" })],
    ["image without a digest", JSON.stringify({ image: { repository: "r" } })],
    ["digest that is not a string", JSON.stringify({ image: { repository: "r", digest: 12345 } })],
  ])("fetched manifest is %s: no predecessor, nothing written, exit 0", (_label, body) => {
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: body,
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
      },
    });
    expectNoPredecessor(r);
  });

  it("never prints the job token, on success or on failure", () => {
    const ok = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifest(OLDER),
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
      },
    });
    expect(ok.result.status).toBe(0);
    expectNoToken(ok.result);
    const failed = run({});
    expect(failed.result.status).toBe(0);
    expectNoToken(failed.result);
  });

  it("without arguments exits 2 with a usage message on stderr and fetches nothing", () => {
    const r = run({ args: [] });
    expect(r.result.status).toBe(2);
    expect(r.result.stderr.toLowerCase()).toContain("usage");
    expect(r.calls()).toEqual([]);
    expect(r.previousFiles()).toEqual([]);
  });

  it("with an empty digest argument exits 2 with a usage message on stderr", () => {
    const r = run({ args: [""] });
    expect(r.result.status).toBe(2);
    expect(r.result.stderr.toLowerCase()).toContain("usage");
    expect(r.calls()).toEqual([]);
  });
});
