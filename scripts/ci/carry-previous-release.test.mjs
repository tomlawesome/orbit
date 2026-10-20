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
 *
 * Before saving, the script runs scripts/ci/verify-release-manifest.sh on the
 * staged pair (the manifest must verify against cosign.pub). That verifier is
 * the real one, not edited: its cosign check is stubbed through ORBIT_COSIGN
 * (a script that accepts, or rejects per STUB_COSIGN_REJECT /
 * STUB_COSIGN_REJECT_MATCH, and keeps a copy of every pair it was asked to
 * verify), and its openssl check runs for real against a throwaway P-256 key
 * (COSIGN_PUBLIC_KEY), so a "good" pair carries a genuine signature.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./carry-previous-release.sh", import.meta.url).pathname;

const API = "https://gitlab.example.test/api/v4";
const PROJECT = "42";
const TOKEN = "glcbt-TEST-TOKEN-NOT-REAL";
const CURRENT = `sha256:${"1".repeat(64)}`;
const OLDER = `sha256:${"2".repeat(64)}`;
const SIG_BYTES = "STUB-SIG-AAAA+/==";

// A throwaway key pair, so a "good" pair carries a signature the real
// verifier's openssl check accepts. Made once per test file.
const keyDir = mkdtempSync(join(tmpdir(), "carry-previous-key-"));
const PRIVATE_KEY = join(keyDir, "key.pem");
const PUBLIC_KEY = join(keyDir, "cosign.pub");
const openssl = (args, input) => {
  const r = spawnSync("openssl", args, { input, ...processGuard() });
  if (r.status !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", PRIVATE_KEY]);
openssl(["ec", "-in", PRIVATE_KEY, "-pubout", "-out", PUBLIC_KEY]);
// cosign sign-blob's output: base64 of the DER ECDSA signature over the file.
const signManifest = (body) => openssl(["dgst", "-sha256", "-sign", PRIVATE_KEY], Buffer.from(body)).toString("base64");

const COSIGN_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "sig=; manifest=",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --signature) sig="$2"; shift 2 ;;',
  "    --key) shift 2 ;;",
  "    --*) shift ;;",
  '    *) manifest="$1"; shift ;;',
  "  esac",
  "done",
  'n="$(cat "$STUB_COSIGN_DIR/count" 2>/dev/null || echo 0)"; n=$((n + 1)); printf %s "$n" > "$STUB_COSIGN_DIR/count"',
  'cp "$manifest" "$STUB_COSIGN_DIR/$n.manifest"',
  'cp "$sig" "$STUB_COSIGN_DIR/$n.sig"',
  'if [ -n "${STUB_COSIGN_REJECT:-}" ]; then echo "stub cosign: invalid signature" >&2; exit 1; fi',
  'if [ -n "${STUB_COSIGN_REJECT_MATCH:-}" ] && grep -qF -- "$STUB_COSIGN_REJECT_MATCH" "$manifest"; then',
  '  echo "stub cosign: invalid signature" >&2; exit 1',
  "fi",
  "exit 0",
  "",
].join("\n");

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
  "    -H|--header) h=\"$2\"; shift 2 ;;",
  '    --header=*) h="${1#--header=}"; shift ;;',
  '    http://*|https://*) url="$1"; shift ;;',
  "    *) shift ;;",
  "  esac",
  '  # The token travels in a header file (curl -H @file), never in argv,',
  '  # so it cannot show in a process listing.',
  '  if [ -n "${h:-}" ]; then case "$h" in @?*) grep -qxF "JOB-TOKEN: $CI_JOB_TOKEN" "${h#@}" 2>/dev/null && header_ok=1 ;; esac; h=; fi',
  "done",
  '[ -n "$url" ] || exit 2',
  '# No token header means GitLab answers 401 and --fail turns it into 22.',
  '[ -n "$header_ok" ] || exit 22',
  'key="${url#"$CI_API_V4_URL"}"',
  'name="$(printf %s "$key" | base64 -w0 | tr "/+" "__")"',
  'body="$STUB_MAP_DIR/$name"',
  '[ -f "$body" ] || exit 22',
  '# Count requests per URL; from the second one on, serve "<name>.2" if it exists',
  '# (another pipeline finished in between and "latest" now means a different build).',
  'cnt="$STUB_MAP_DIR/$name.count"',
  'n="$(cat "$cnt" 2>/dev/null || echo 0)"; n=$((n + 1)); printf %s "$n" > "$cnt"',
  'if [ "$n" -ge 2 ] && [ -f "$body.2" ]; then body="$body.2"; fi',
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
 * laterRoutes: { "<path?query>": body } -- served from the second request to
 * that URL on, instead of the routes body.
 * The default ref is "main"; the slash test passes its own.
 * Each run gets its own empty TMPDIR, so leftovers are visible.
 * Verification defaults to accepting; pass env { STUB_COSIGN_REJECT: "1" } to
 * make the stubbed cosign reject every pair, or STUB_COSIGN_REJECT_MATCH to
 * reject only a manifest containing that text. verifications() lists the pairs
 * the verifier was asked about, in order.
 */
function run({ args = [CURRENT], routes = {}, laterRoutes = {}, ref = "main", env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "carry-previous-"));
  const bin = join(dir, "bin");
  const mapDir = join(dir, "map");
  const work = join(dir, "work");
  const tmp = join(dir, "tmp");
  const cosignDir = join(dir, "cosign");
  for (const d of [bin, mapDir, work, tmp, cosignDir]) mkdirSync(d);
  const cosignStub = join(dir, "cosign-stub.sh");
  writeFileSync(cosignStub, COSIGN_STUB);
  chmodSync(cosignStub, 0o755);
  writeFileSync(join(bin, "curl"), CURL_STUB);
  chmodSync(join(bin, "curl"), 0o755);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  for (const [key, body] of Object.entries(routes)) writeFileSync(join(mapDir, mapName(key)), body);
  for (const [key, body] of Object.entries(laterRoutes)) writeFileSync(join(mapDir, `${mapName(key)}.2`), body);

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
        TMPDIR: tmp,
        STUB_LOG: logFile,
        STUB_MAP_DIR: mapDir,
        STUB_COSIGN_DIR: cosignDir,
        ORBIT_COSIGN: cosignStub,
        COSIGN_PUBLIC_KEY: PUBLIC_KEY,
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
  const supplyChainDir = join(work, ".orbit-supply-chain");
  const supplyChainEntries = () => (existsSync(supplyChainDir) ? readdirSync(supplyChainDir).sort() : []);
  const tmpEntries = () => readdirSync(tmp);
  const verifications = () =>
    readdirSync(cosignDir)
      .filter((name) => name.endsWith(".manifest"))
      .map((name) => parseInt(name, 10))
      .sort((a, b) => a - b)
      .map((n) => ({
        manifest: readFileSync(join(cosignDir, `${n}.manifest`)),
        sig: readFileSync(join(cosignDir, `${n}.sig`)),
      }));
  return { result, calls, requestedKeys, previousFiles, previous, work, supplyChainEntries, tmpEntries, verifications };
}

const MANIFEST = "orbit-release-manifest.json";
const SIG = "orbit-release-manifest.json.sig";
// A manifest and its genuine signature (what the real verifier's openssl check accepts).
const pair = (digest) => {
  const body = manifest(digest);
  return { body, sig: signManifest(body) };
};
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
    const { body: manifestBody, sig } = pair(OLDER);
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifestBody,
        [assetPath("main", SIG, "sign_evidence")]: sig,
      },
    });
    expect(r.result.status).toBe(0);
    expect(r.result.stdout).toContain(OLDER);
    expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    expect(r.previous(MANIFEST).equals(Buffer.from(manifestBody))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(sig))).toBe(true);
    expectNoToken(r.result);
    // No staging dir left beside previous/.
    expect(r.supplyChainEntries()).toEqual(["previous"]);
  });

  it("requests the manifest from job record_image and the signature from job sign_evidence, with the JOB-TOKEN header from a file, not argv", () => {
    const { body, sig } = pair(OLDER);
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: body,
        [assetPath("main", SIG, "sign_evidence")]: sig,
      },
    });
    expect(r.result.status).toBe(0);
    const keys = r.requestedKeys();
    expect(keys).toContain(assetPath("main", MANIFEST, "record_image"));
    expect(keys).toContain(assetPath("main", SIG, "sign_evidence"));
    // A normal build has no reason to look at its own carried pair.
    expect(keys.filter((key) => key.includes("/previous/"))).toEqual([]);
    // The token goes in a header file (curl -H @file): never in curl's argv.
    for (const argv of r.calls()) {
      expect(argv.join("\n")).not.toContain(TOKEN);
      expect(argv.some((arg) => arg.startsWith("@"))).toBe(true);
    }
    // ...and the header file is deleted when the script ends: the script's TMPDIR is empty.
    expect(r.tmpEntries()).toEqual([]);
  });

  it("pairs one build: downloads the manifest, the signature, then the manifest again, and accepts the pair when both manifest copies are identical", () => {
    const { body: manifestBody, sig } = pair(OLDER);
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: manifestBody,
        [assetPath("main", SIG, "sign_evidence")]: sig,
      },
    });
    expect(r.result.status).toBe(0);
    const keys = r.requestedKeys();
    expect(keys).toEqual([
      assetPath("main", MANIFEST, "record_image"),
      assetPath("main", SIG, "sign_evidence"),
      assetPath("main", MANIFEST, "record_image"),
    ]);
    expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    expect(r.previous(MANIFEST).equals(Buffer.from(manifestBody))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(sig))).toBe(true);
    expect(r.tmpEntries()).toEqual([]);
  });

  it("manifest changes between the two downloads (another pipeline finished): no predecessor, nothing under previous/, no staging or temp leftovers, exit 0", () => {
    const first = manifest(OLDER);
    const second = manifest(`sha256:${"3".repeat(64)}`);
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: first,
        [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
      },
      laterRoutes: { [assetPath("main", MANIFEST, "record_image")]: second },
    });
    expectNoPredecessor(r);
    expect(r.requestedKeys().filter((key) => key === assetPath("main", MANIFEST, "record_image"))).toHaveLength(2);
    expect(r.supplyChainEntries().filter((entry) => entry !== "previous")).toEqual([]);
    expect(r.tmpEntries()).toEqual([]);
    expectNoToken(r.result);
  });

  it("URL-encodes the slash in a branch name", () => {
    const { body, sig } = pair(OLDER);
    const r = run({
      ref: "hotfix/x",
      routes: {
        [assetPath("hotfix%2Fx", MANIFEST, "record_image")]: body,
        [assetPath("hotfix%2Fx", SIG, "sign_evidence")]: sig,
      },
    });
    expect(r.result.status).toBe(0);
    expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    const keys = r.requestedKeys();
    expect(keys).toContain(assetPath("hotfix%2Fx", MANIFEST, "record_image"));
    expect(keys.some((key) => key.includes("hotfix/x"))).toBe(false);
  });

  it("rebuild: when the fetched digest is the current one, carries that build's own previous pair, both from record_image", () => {
    const { body: carriedManifest, sig: carriedSig } = pair(OLDER);
    const own = pair(CURRENT);
    const r = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: own.body,
        [assetPath("main", SIG, "sign_evidence")]: own.sig,
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
    // No leftover staging dir either, and the header file is gone.
    expect(r.supplyChainEntries().filter((entry) => entry !== "previous")).toEqual([]);
    expect(r.tmpEntries()).toEqual([]);
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
    const { body, sig } = pair(OLDER);
    const ok = run({
      routes: {
        [assetPath("main", MANIFEST, "record_image")]: body,
        [assetPath("main", SIG, "sign_evidence")]: sig,
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

  describe("verification against cosign.pub (#1480)", () => {
    const expectCleanNoPredecessor = (r) => {
      expectNoPredecessor(r);
      expect(r.supplyChainEntries()).toEqual([]);
      expect(r.tmpEntries()).toEqual([]);
      expectNoToken(r.result);
    };

    it("(a) the verifier rejects the staged pair: exit 0, no predecessor saying the manifest does not verify, previous/ absent, no leftovers, token never printed", () => {
      const { body, sig } = pair(OLDER);
      const r = run({
        env: { STUB_COSIGN_REJECT: "1" },
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: body,
          [assetPath("main", SIG, "sign_evidence")]: sig,
        },
      });
      expectCleanNoPredecessor(r);
      expect(`${r.result.stdout}${r.result.stderr}`).toMatch(/does not verify/i);
      // The verifier really ran on the pair the script fetched.
      const seen = r.verifications();
      expect(seen).toHaveLength(1);
      expect(seen[0].manifest.equals(Buffer.from(body))).toBe(true);
      expect(seen[0].sig.equals(Buffer.from(sig))).toBe(true);
    });

    it("(a) a signature that is not a real signature over the manifest (even if cosign were fooled) is no predecessor, nothing written", () => {
      const r = run({
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: manifest(OLDER),
          [assetPath("main", SIG, "sign_evidence")]: SIG_BYTES,
        },
      });
      expectCleanNoPredecessor(r);
      expect(`${r.result.stdout}${r.result.stderr}`).toMatch(/does not verify/i);
    });

    it("(b) the verifier accepts: the pair is saved byte-for-byte, and the verifier saw exactly that pair", () => {
      const { body, sig } = pair(OLDER);
      const r = run({
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: body,
          [assetPath("main", SIG, "sign_evidence")]: sig,
        },
      });
      expect(r.result.status).toBe(0);
      expect(r.result.stdout).toContain(OLDER);
      expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
      expect(r.previous(MANIFEST).equals(Buffer.from(body))).toBe(true);
      expect(r.previous(SIG).equals(Buffer.from(sig))).toBe(true);
      const seen = r.verifications();
      expect(seen).toHaveLength(1);
      expect(seen[0].manifest.equals(Buffer.from(body))).toBe(true);
      expect(seen[0].sig.equals(Buffer.from(sig))).toBe(true);
      expect(r.supplyChainEntries()).toEqual(["previous"]);
      expect(r.tmpEntries()).toEqual([]);
      expectNoToken(r.result);
    });

    it("(c) rebuild: the carried pair goes through verification too, and a rejecting verifier is no predecessor", () => {
      const own = pair(CURRENT);
      const carried = pair(OLDER);
      const r = run({
        // Reject only the carried pair, so the current build's own pair cannot be what fails.
        env: { STUB_COSIGN_REJECT_MATCH: OLDER },
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: own.body,
          [assetPath("main", SIG, "sign_evidence")]: own.sig,
          [assetPath("main", `previous/${MANIFEST}`, "record_image")]: carried.body,
          [assetPath("main", `previous/${SIG}`, "record_image")]: carried.sig,
        },
      });
      expectCleanNoPredecessor(r);
      expect(`${r.result.stdout}${r.result.stderr}`).toMatch(/does not verify/i);
      expect(r.verifications().some((v) => v.manifest.equals(Buffer.from(carried.body)))).toBe(true);
    });

    it("(c) rebuild: an accepted carried pair is saved byte-for-byte after being verified", () => {
      const own = pair(CURRENT);
      const carried = pair(OLDER);
      const r = run({
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: own.body,
          [assetPath("main", SIG, "sign_evidence")]: own.sig,
          [assetPath("main", `previous/${MANIFEST}`, "record_image")]: carried.body,
          [assetPath("main", `previous/${SIG}`, "record_image")]: carried.sig,
        },
      });
      expect(r.result.status).toBe(0);
      expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
      expect(r.previous(MANIFEST).equals(Buffer.from(carried.body))).toBe(true);
      expect(r.previous(SIG).equals(Buffer.from(carried.sig))).toBe(true);
      expect(r.verifications().some((v) => v.manifest.equals(Buffer.from(carried.body)))).toBe(true);
    });

    const HEX = "a1b2c3d4".repeat(8);
    it.each([
      ["uppercase prefix", `SHA256:${HEX}`],
      ["uppercase hex", `sha256:${HEX.toUpperCase()}`],
      ["63 hex digits", `sha256:${HEX.slice(1)}`],
      ["65 hex digits", `sha256:${HEX}a`],
      ["a non-hex character", `sha256:${HEX.slice(1)}g`],
      ["no prefix", HEX],
      ["a trailing newline and a fake line", `sha256:${HEX}\n[fake]`],
      ["a trailing escape sequence", `sha256:${HEX}\u001b[31m`],
    ])("(d) fetched digest with %s: no predecessor, nothing written", (_label, digest) => {
      const { body, sig } = pair(digest);
      const r = run({
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: body,
          [assetPath("main", SIG, "sign_evidence")]: sig,
        },
      });
      expectCleanNoPredecessor(r);
    });

    it("(d) rebuild: a carried manifest whose digest is malformed is no predecessor, nothing written", () => {
      const own = pair(CURRENT);
      const carried = pair(`SHA256:${HEX}`);
      const r = run({
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: own.body,
          [assetPath("main", SIG, "sign_evidence")]: own.sig,
          [assetPath("main", `previous/${MANIFEST}`, "record_image")]: carried.body,
          [assetPath("main", `previous/${SIG}`, "record_image")]: carried.sig,
        },
      });
      expectCleanNoPredecessor(r);
    });

    it("(e) the normal-case request sequence is still manifest, signature, manifest, with nothing fetched from previous/", () => {
      const { body, sig } = pair(OLDER);
      const r = run({
        routes: {
          [assetPath("main", MANIFEST, "record_image")]: body,
          [assetPath("main", SIG, "sign_evidence")]: sig,
        },
      });
      expect(r.result.status).toBe(0);
      expect(r.requestedKeys()).toEqual([
        assetPath("main", MANIFEST, "record_image"),
        assetPath("main", SIG, "sign_evidence"),
        assetPath("main", MANIFEST, "record_image"),
      ]);
    });
  });
});
