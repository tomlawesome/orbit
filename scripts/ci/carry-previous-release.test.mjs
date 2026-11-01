import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * scripts/ci/carry-previous-release.sh (#1480) saves the previous build's
 * signed release manifest, from the GitLab jobs API, under
 * .orbit-supply-chain/previous/ so a later consumer can find it with no job
 * ID. It must never leave a silent gap (#1607 D-F1-1, D-F2-1, D-F5): anything
 * it cannot fetch or trust is a loud failure, a non-zero exit with nothing
 * written and a message naming its cause.
 *
 * The interface under test (#1607 review items 1-4):
 *  - the predecessor is the newest job named record_image, status success, on
 *    CI_COMMIT_REF_NAME (GET /projects/:id/jobs?scope[]=success&ref=<ref>&
 *    per_page=100, filtered again on the client, CI_JOB_ID excluded, X-Next-Page
 *    followed to a page cap), not the newest pipeline;
 *  - its manifest, the signature from the sign_evidence job of the same
 *    pipeline, and its own previous/ pair are fetched by job id;
 *  - `carry-previous-release.sh --prepare` runs BEFORE the image push: the
 *    lookup, the fetches, the verification against cosign.pub and the staging.
 *    Any failure fails the job before the push. Nothing is saved under previous/.
 *  - `carry-previous-release.sh <published digest>` runs after the push: it
 *    picks the predecessor pair (or the carried pair when the predecessor's
 *    digest is the published one) and moves it into previous/;
 *  - every API call's HTTP status is read: only a 404 on a by-job artifact
 *    file means "absent"; any other status, a non-JSON listing or a transport
 *    error fails, naming the status and URL, never the token.
 *
 * curl is stubbed on PATH by CURL_STUB below: it serves routes (status code,
 * headers, body, or a transport error) from a JSON file, and honours
 * --output, --write-out (%{http_code}, %header{name}), --dump-header,
 * --include and --fail the way curl does.
 *
 * Before saving, the script runs scripts/ci/verify-release-manifest.sh on each
 * staged pair (the manifest must verify against cosign.pub). That verifier is
 * the real one, not edited: its cosign check is stubbed through ORBIT_COSIGN
 * (a script that accepts, or rejects per STUB_COSIGN_REJECT /
 * STUB_COSIGN_REJECT_MATCH, and keeps a copy of every pair it was asked to
 * verify), and its openssl check runs for real against a throwaway P-256 key
 * (COSIGN_PUBLIC_KEY), so a "good" pair carries a genuine signature.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./carry-previous-release.sh", import.meta.url).pathname;
const repoRoot = new URL("../../", import.meta.url).pathname;

const API = "https://gitlab.example.test/api/v4";
const PROJECT = "42";
const TOKEN = "glcbt-TEST-TOKEN-NOT-REAL";
const CURRENT = `sha256:${"1".repeat(64)}`;
const OLDER = `sha256:${"2".repeat(64)}`;
const THIRD = `sha256:${"3".repeat(64)}`;
const SIG_BYTES = "STUB-SIG-AAAA+/==";
// The job running the carry: the listing can contain it, and it is never the predecessor.
const OWN_JOB = 9001;
// The usual predecessor: its record_image job, the sign_evidence job of the same pipeline, and that pipeline.
const REC = 501;
const SIGN = 502;
const PIPE = 7001;

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

// The commands the carry and the verifier use (and the usual coreutils beside them), linked into a bare PATH by start({ without }).
const TOOL_NAMES = [
  "bash", "env", "jq", "openssl", "cosign", "base64", "sha256sum", "mktemp", "rm", "mkdir", "mv", "cp", "ln", "chmod", "cat", "tr", "awk", "sed", "grep",
  "find", "sort", "basename", "dirname", "head", "tail", "wc", "tee", "cut", "dd", "od", "sleep", "date", "touch", "ls", "stat", "readlink", "realpath",
  "expr", "xargs", "cmp", "diff", "id", "uname", "true", "false", "test", "[",
];

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
  // A tool failure is not a verdict: cosign could not run (STUB_COSIGN_TOOL_FAIL), as against rejecting the signature.
  'if [ -n "${STUB_COSIGN_TOOL_FAIL:-}" ]; then echo "stub cosign: cannot run: the trust root could not be fetched" >&2; exit 2; fi',
  'if [ -n "${STUB_COSIGN_REJECT:-}" ]; then echo "stub cosign: invalid signature" >&2; exit 1; fi',
  'if [ -n "${STUB_COSIGN_REJECT_MATCH:-}" ] && grep -qF -- "$STUB_COSIGN_REJECT_MATCH" "$manifest"; then',
  '  echo "stub cosign: invalid signature" >&2; exit 1',
  "fi",
  "exit 0",
  "",
].join("\n");

// The curl stub: a CommonJS program run by node, behind a one-line bash `curl`
// on PATH. Kept as a string (not a function's toString) so no transform of
// this file can change it.
const CURL_STUB_JS = String.raw`
const fs = require("node:fs");
const argv = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.STUB_LOG, "curl" + argv.map(function (a) { return "\x1f" + a; }).join("") + "\x1e");

let output = "";
let url = "";
let headerOk = false;
let writeOut = "";
let dumpHeader = "";
let include = false;
let fail = false;
let failBody = false;
let maxFilesize = null;
// The token travels in a header file (curl -H @file), never in argv, so it
// cannot show in a process listing.
function takeHeader(h) {
  if (h.charAt(0) !== "@") return;
  try {
    if (fs.readFileSync(h.slice(1), "utf8").split("\n").indexOf("JOB-TOKEN: " + env.CI_JOB_TOKEN) >= 0) headerOk = true;
  } catch (e) {}
}
const takesValue = ["--retry", "--retry-delay", "--retry-max-time", "--connect-timeout", "--max-time", "-m", "--proto", "-X", "--request", "-A", "--user-agent", "--max-redirs"];
for (let i = 0; i < argv.length; i++) {
  let a = argv[i];
  let inline = null;
  const eq = a.slice(0, 2) === "--" ? a.indexOf("=") : -1;
  if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
  const val = function () { return inline !== null ? inline : argv[++i]; };
  if (a === "-o" || a === "--output") output = val();
  else if (a === "-H" || a === "--header") takeHeader(val());
  else if (a === "-w" || a === "--write-out") writeOut = val();
  else if (a === "-D" || a === "--dump-header") dumpHeader = val();
  else if (a === "--url") url = val();
  else if (a === "--max-filesize") maxFilesize = val();
  else if (a === "-i" || a === "--include") include = true;
  else if (a === "--fail") fail = true;
  else if (a === "--fail-with-body") { fail = true; failBody = true; }
  else if (takesValue.indexOf(a) >= 0) val();
  else if (/^https?:\/\//.test(a)) url = a;
  else if (/^-[A-Za-z]+$/.test(a)) {
    // Combined short flags such as -fsS or -sSfo file.
    for (const c of a.slice(1)) {
      if (c === "f") fail = true;
      else if (c === "i") include = true;
      else if (c === "o") output = argv[++i];
      else if (c === "H") takeHeader(argv[++i]);
      else if (c === "w") writeOut = argv[++i];
      else if (c === "D") dumpHeader = argv[++i];
    }
  }
}
if (!url) process.exit(2);

// A reader that closes early (head -c) ends the write the way it ends curl's: exit 23.
function writeFailed() {
  process.stderr.write("curl: (23) Failure writing output to destination\n");
  process.exit(23);
}
function out(text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off);
    } catch (e) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EPIPE") writeFailed();
      throw e;
    }
  }
}
function done(status, headers, code) {
  if (writeOut) {
    out(writeOut
      .replace(/%\{http_code\}/g, String(status).padStart(3, "0"))
      .replace(/%header\{([^}]*)\}/g, function (_m, name) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) return String(headers[k]);
        return "";
      })
      .replace(/%\{[^}]*\}/g, "")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r"));
  }
  process.exit(code);
}

const api = new URL(env.CI_API_V4_URL);
const u = new URL(url);
const requests = fs.readFileSync(env.STUB_LOG, "utf8").split("\x1e").length - 1;
const listing = "/projects/" + env.CI_PROJECT_ID + "/jobs";
let route;
if (u.origin !== api.origin || u.pathname.indexOf(api.pathname) !== 0) {
  route = { transport: 6 };
} else if (requests > 300) {
  route = { status: 500, body: '{"message":"stub: runaway requests"}' };
} else if (!headerOk) {
  // No token header means GitLab answers 401.
  route = { status: 401, body: '{"message":"401 Unauthorized"}' };
} else {
  const cfg = JSON.parse(fs.readFileSync(env.STUB_CONFIG, "utf8"));
  const path = u.pathname.slice(api.pathname.length);
  const page = u.searchParams.get("page") || "1";
  const key = path === listing ? listing + "#page=" + page : path;
  route = cfg.routes[key];
  if (route && Array.isArray(route.sequence)) {
    // A route served as a sequence of responses: the nth request for the same
    // key (this one is already in the log) gets the nth entry, the last one
    // repeating once the sequence is spent.
    const seen = fs.readFileSync(env.STUB_LOG, "utf8").split("\x1e").filter(Boolean).filter(function (rec) {
      return rec.split("\x1f").some(function (arg) {
        if (arg.indexOf(env.CI_API_V4_URL) !== 0) return false;
        const other = new URL(arg);
        const otherPath = other.pathname.slice(api.pathname.length);
        return (otherPath === listing ? listing + "#page=" + (other.searchParams.get("page") || "1") : otherPath) === key;
      });
    }).length;
    route = route.sequence[Math.min(seen, route.sequence.length) - 1];
  }
  if (!route && path === listing && cfg.endless) {
    route = { headers: { "X-Next-Page": String(Number(page) + 1) }, body: JSON.stringify(cfg.endless) };
  }
  if (!route) route = { status: 404, body: '{"message":"404 Not Found"}' };
}

const status = route.status || 200;
const headers = Object.assign({ "Content-Type": "application/json" }, route.chunked ? { "Transfer-Encoding": "chunked" } : {}, route.headers || {});
// --max-filesize N[KMG]: an answer larger than the limit ends curl with exit 63.
// A route marked oversize is larger than any limit, so a test need not know it.
let limit = null;
const sizeArg = maxFilesize === null ? null : /^(\d+)([KkMmGg]?)$/.exec(maxFilesize);
if (sizeArg) limit = Number(sizeArg[1]) * ({ "": 1, k: 1024, m: 1048576, g: 1073741824 })[sizeArg[2].toLowerCase()];
// A chunked route has no declared size, so --max-filesize cannot see it (as with curl): the body is sent whole.
if (limit !== null && !route.transport && !route.chunked && (route.oversize || Buffer.byteLength(route.body === undefined ? "" : route.body) > limit)) {
  process.stderr.write("curl: (63) Maximum file size exceeded\n");
  done(status, headers, 63);
}
if (route.transport) {
  process.stderr.write("curl: (" + route.transport + ") Failed to connect to the host\n");
  done(0, {}, route.transport);
}
if (fail && status >= 400 && !failBody) {
  process.stderr.write("curl: (22) The requested URL returned error: " + status + "\n");
  done(status, headers, 22);
}
const headText = "HTTP/1.1 " + status + " X\r\n" + Object.keys(headers).map(function (k) { return k + ": " + headers[k] + "\r\n"; }).join("") + "\r\n";
if (dumpHeader) {
  if (dumpHeader === "-") out(headText);
  else fs.writeFileSync(dumpHeader, headText);
}
const payload = (include ? headText : "") + (route.body === undefined ? "" : route.body);
if (output && output !== "-") {
  try {
    fs.writeFileSync(output, payload);
  } catch (e) {
    if (e.code === "EPIPE") writeFailed();
    throw e;
  }
} else out(payload);
done(status, headers, fail && status >= 400 ? 22 : 0);
`;
const curlStubFile = join(keyDir, "curl-stub.cjs");
writeFileSync(curlStubFile, CURL_STUB_JS);
const CURL_WRAPPER = `#!/usr/bin/env bash\nexec "${process.execPath}" "${curlStubFile}" "$@"\n`;

/*
 * Routes, keyed by path under CI_API_V4_URL (no query):
 *   { status = 200, headers, body, transport }  -- transport N is curl exit N
 * The job listing, GET /projects/:id/jobs, is keyed per page: "<path>#page=N".
 * A route may be { sequence: [route, ...] }: the nth request for it gets the nth
 * entry, the last repeating. { oversize: true } is an answer larger than any
 * --max-filesize (curl exit 63). { chunked: true } is an answer with no
 * length header (Transfer-Encoding: chunked), which --max-filesize cannot see:
 * the body is sent whole, however large. Anything unknown answers 404. `endless` (a jobs array) serves every listing
 * page without a route, each pointing at the next, to prove a page cap.
 * After 300 requests the stub answers 500 so a runaway loop ends.
 */
const listingKey = (page = 1) => `/projects/${PROJECT}/jobs#page=${page}`;
const pipelineKey = (pipeline) => `/projects/${PROJECT}/pipelines/${pipeline}/jobs`;
const artifactKey = (jobId, file) => `/projects/${PROJECT}/jobs/${jobId}/artifacts/.orbit-supply-chain/${file}`;
const jsonBody = (value) => ({ body: JSON.stringify(value) });
const job = (id, name, { pipeline = 6000 + id, ref = "main", status = "success" } = {}) => ({
  id,
  name,
  status,
  ref,
  stage: "publish",
  pipeline: { id: pipeline, project_id: Number(PROJECT), ref, status: "success" },
});
// A listing of pages, newest job first. Each page is a jobs array or a route
// object (a failing page). All but the last carry X-Next-Page, as GitLab does.
const listing = (...pages) =>
  Object.fromEntries(
    pages.map((page, i) => [
      listingKey(i + 1),
      { headers: { "X-Next-Page": i < pages.length - 1 ? String(i + 2) : "" }, ...(Array.isArray(page) ? jsonBody(page) : page) },
    ]),
  );
const without = (routes, key) => Object.fromEntries(Object.entries(routes).filter(([k]) => k !== key));

const manifest = (digest) =>
  `{\n  "image": {"repository": "registry.example/ai/orbit", "digest": "${digest}"},\n  "version": "1.4.0"\n}`;

const FILES = { manifest: "orbit-release-manifest.json", sig: "orbit-release-manifest.json.sig" };
const MANIFEST = FILES.manifest;
const SIG = FILES.sig;
// A manifest and its genuine signature (what the real verifier's openssl check accepts).
const pair = (digest) => {
  const body = manifest(digest);
  return { body, sig: signManifest(body) };
};

/*
 * What the API serves when the newest successful record_image job on main
 * (REC, in pipeline PIPE) recorded `own` (a { body, sig } pair) and carried
 * `carried` (a pair, or nothing); the same pipeline's sign_evidence job is
 * SIGN and holds the signature of `own`. `jobs` replaces the listing's first page.
 */
const world = (own, carried, { recId = REC, signId = SIGN, pipeline = PIPE, jobs } = {}) => ({
  ...listing(jobs ?? [job(recId, "record_image", { pipeline })]),
  [pipelineKey(pipeline)]: jsonBody([
    job(signId + 1, "build_image", { pipeline }),
    job(signId, "sign_evidence", { pipeline }),
    job(recId, "record_image", { pipeline }),
  ]),
  [artifactKey(recId, MANIFEST)]: { body: own.body },
  [artifactKey(signId, SIG)]: { body: own.sig },
  ...(carried
    ? {
        [artifactKey(recId, `previous/${MANIFEST}`)]: { body: carried.body },
        [artifactKey(recId, `previous/${SIG}`)]: { body: carried.sig },
      }
    : {}),
});

/*
 * One scripted environment: every call of the script in it shares the work
 * directory (so a --prepare is followed by the final call in the same place),
 * the curl log and the cosign log.
 * ref defaults to "main"; gap is the text of scripts/ci/carry-accepted-gap, when the case has one. Each environment gets its own empty TMPDIR, so
 * leftovers are visible. Verification defaults to accepting; env
 * { STUB_COSIGN_REJECT: "1" } rejects every pair, STUB_COSIGN_REJECT_MATCH
 * rejects only a manifest containing that text. verifications() lists the
 * pairs the verifier was asked about, in order.
 */
function start({ routes = {}, endless, ref = "main", env = {}, gap, shims = {}, without: missingTools = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "carry-previous-"));
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  const tmp = join(dir, "tmp");
  const cosignDir = join(dir, "cosign");
  for (const d of [bin, work, tmp, cosignDir]) mkdirSync(d);
  const cosignStub = join(dir, "cosign-stub.sh");
  writeFileSync(cosignStub, COSIGN_STUB);
  chmodSync(cosignStub, 0o755);
  writeFileSync(join(bin, "curl"), CURL_WRAPPER);
  chmodSync(join(bin, "curl"), 0o755);
  // shims: { name: script text } are commands put ahead of the real ones on PATH.
  for (const [name, text] of Object.entries(shims)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const configFile = join(dir, "routes.json");
  writeFileSync(configFile, JSON.stringify({ routes, endless }));

  // A committed break-glass file (scripts/ci/carry-accepted-gap) lives in the
  // repository, so a case that has one runs the carry from a copy of scripts/ci
  // inside the work directory: the file is then found whether the carry looks
  // beside itself or in the working directory.
  let scriptPath = script;
  if (gap !== undefined) {
    const copyDir = join(work, "scripts", "ci");
    mkdirSync(copyDir, { recursive: true });
    for (const name of ["carry-previous-release.sh", "verify-release-manifest.sh", "ensure-cosign.sh"]) copyFileSync(join(repoRoot, "scripts", "ci", name), join(copyDir, name));
    writeFileSync(join(copyDir, "carry-accepted-gap"), gap);
    scriptPath = join(copyDir, "carry-previous-release.sh");
  }

  // without: ["openssl"] runs the carry with PATH holding only the stub curl and
  // symlinks to the usual tools (TOOL_NAMES), minus those named: a tool that is
  // really missing, as against one that rejects.
  let toolPath = process.env.PATH;
  if (missingTools.length > 0) {
    const tools = join(dir, "tools");
    mkdirSync(tools);
    for (const name of TOOL_NAMES) {
      const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8", ...processGuard() }).stdout.trim();
      if (found.startsWith("/") && !missingTools.includes(name)) symlinkSync(found, join(tools, name));
    }
    toolPath = tools;
  }

  const invoke = (args) =>
    failOnProcessDeadline(
      spawnSync("bash", [scriptPath, ...args], {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${toolPath}`,
          CI_API_V4_URL: API,
          CI_PROJECT_ID: PROJECT,
          CI_COMMIT_REF_NAME: ref,
          CI_JOB_ID: String(OWN_JOB),
          CI_JOB_TOKEN: TOKEN,
          TMPDIR: tmp,
          STUB_LOG: logFile,
          STUB_CONFIG: configFile,
          STUB_COSIGN_DIR: cosignDir,
          ORBIT_COSIGN: cosignStub,
          COSIGN_PUBLIC_KEY: PUBLIC_KEY,
          // No pause between attempts of a retried call (#1607 note 48797), unless a case sets it.
          ORBIT_CARRY_RETRY_SECONDS: "0",
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
  const requestedUrls = () => calls().flatMap((argv) => argv.filter((arg) => arg.startsWith(API)));
  const requestedKeys = () => requestedUrls().map((url) => url.slice(API.length));
  // The request paths without their query string.
  const requestedPaths = () => requestedKeys().map((key) => key.split("?")[0]);
  // How many times a route (its key, as in the routes table) was asked for: "not retried" is exactly one.
  const routeKey = (url) => {
    const u = new URL(url);
    const path = u.pathname.slice(new URL(API).pathname.length);
    return path === `/projects/${PROJECT}/jobs` ? `${path}#page=${u.searchParams.get("page") || "1"}` : path;
  };
  const routeCalls = (key) => requestedUrls().filter((url) => routeKey(url) === key).length;
  const listingUrls = () => requestedUrls().filter((url) => url.split("?")[0] === `${API}/projects/${PROJECT}/jobs`);
  const previousDir = join(work, ".orbit-supply-chain", "previous");
  const hasPrevious = () => existsSync(previousDir);
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
  return {
    invoke,
    calls,
    requestedUrls,
    requestedKeys,
    requestedPaths,
    routeCalls,
    listingUrls,
    hasPrevious,
    previousFiles,
    previous,
    work,
    supplyChainEntries,
    tmpEntries,
    verifications,
  };
}

// One call of the script (default: --prepare).
function run({ args = ["--prepare"], ...options } = {}) {
  const session = start(options);
  return { ...session, result: session.invoke(args) };
}

/*
 * The job's two calls in order: `--prepare` before the push, then the
 * published digest after it (only if --prepare succeeded, as the job stops
 * otherwise). `result` is the last call made, the one that failed on a failure.
 */
function carry(options = {}, digest = CURRENT) {
  const session = start(options);
  const prepare = session.invoke(["--prepare"]);
  const final = prepare.status === 0 ? session.invoke([digest]) : null;
  return { ...session, prepare, final, result: final ?? prepare };
}

const expectNoToken = (result) => {
  expect(result.stdout).not.toContain(TOKEN);
  expect(result.stderr).not.toContain(TOKEN);
};
// The token goes in a header file (curl -H @file): never in curl's argv.
const expectTokenOnlyInHeaderFile = (r) => {
  expect(r.calls().length).toBeGreaterThan(0);
  for (const argv of r.calls()) {
    expect(argv.join("\n")).not.toContain(TOKEN);
    expect(argv.some((arg) => arg.startsWith("@"))).toBe(true);
  }
};
const output = (result) => `${result.stdout}${result.stderr}`;
// A missing or mismatched predecessor is an error that names its cause, never
// a silent skip: non-zero exit, a message matching cause (a regexp for the check
// that must be the one that refused; the fixtures carry genuine signatures, so
// the signature check cannot refuse in its place), and nothing under previous/.
const expectLoudFailure = ({ result, previousFiles, hasPrevious }, cause) => {
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBeNull();
  expect(output(result)).toMatch(cause);
  expect(hasPrevious()).toBe(false);
  expect(previousFiles()).toEqual([]);
};
// --prepare is what failed (so the job stops before the push), cleanly: no
// previous/, no staging directory, no header file left behind, no token printed.
const expectPrepareFailure = (r, cause) => {
  expect(r.prepare.status).not.toBe(0);
  expect(r.prepare.status).not.toBeNull();
  expect(r.final).toBeNull();
  expectLoudFailure(r, cause);
  expect(r.supplyChainEntries()).toEqual([]);
  expect(r.tmpEntries()).toEqual([]);
  expectNoToken(r.result);
};
// A failure after the push, at the final call: nothing under previous/, token never printed.
const expectFinalFailure = (r, cause) => {
  expect(r.prepare.status).toBe(0);
  expect(r.final).not.toBeNull();
  expectLoudFailure(r, cause);
  expect(r.tmpEntries()).toEqual([]);
  expectNoToken(r.result);
};
const savedPair = (r) => ({ body: r.previous(MANIFEST).toString(), sig: r.previous(SIG).toString() });
const FIRST_RELEASE = (ref = "main") => `no successful record_image job on ${ref}: first release, nothing carried`;
// A first release: the lookup found no predecessor, so --prepare logs it and
// exits 0, nothing is fetched or verified, and previous/ is never created, even
// by the final call (the job still has to pass).
const expectFirstRelease = (r, ref = "main") => {
  expect(r.prepare.status).toBe(0);
  expect(output(r.prepare)).toContain(FIRST_RELEASE(ref));
  expect(r.final).not.toBeNull();
  expect(r.final.status).toBe(0);
  expect(r.hasPrevious()).toBe(false);
  expect(r.previousFiles()).toEqual([]);
  expect(r.requestedPaths().filter((path) => path.includes("/artifacts/"))).toEqual([]);
  expect(r.verifications()).toEqual([]);
  expect(r.tmpEntries()).toEqual([]);
  expectNoToken(r.prepare);
  expectNoToken(r.final);
};

// The ways one API call can fail, with what the message must name.
const HTTP_FAILURES = [
  ["401", { status: 401, body: '{"message":"401 Unauthorized"}' }, /401/],
  ["403", { status: 403, body: '{"message":"403 Forbidden"}' }, /403/],
  ["500", { status: 500, body: '{"message":"500 Internal Server Error"}' }, /500/],
  ["a transport error", { transport: 7 }, /transport|curl|000|\(7\)|exit (status |code )?7|connect/i],
];

describe("carry-previous-release.sh", () => {
  it("normal case: --prepare then the digest saves the predecessor's manifest and signature byte-for-byte", () => {
    const own = pair(OLDER);
    const r = carry({ routes: world(own) });
    expect(r.prepare.status).toBe(0);
    expect(r.final.status).toBe(0);
    expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
    expectNoToken(r.prepare);
    expectNoToken(r.final);
    expect(r.tmpEntries()).toEqual([]);
  });

  it("looks the predecessor up by job: lists successful jobs on the ref, then lists that pipeline's jobs, and fetches the manifest from the record_image job, the signature from the same pipeline's sign_evidence job and the record_image job's own previous/ pair, all by job id, with the JOB-TOKEN header from a file, not argv", () => {
    const r = carry({ routes: world(pair(OLDER)) });
    expect(r.result.status).toBe(0);
    const urls = r.listingUrls();
    expect(urls.length).toBeGreaterThanOrEqual(1);
    const first = new URL(urls[0]).searchParams;
    expect(first.getAll("scope[]")).toEqual(["success"]);
    expect(first.get("ref")).toBe("main");
    expect(first.get("per_page")).toBe("100");
    // The signature comes from the sign_evidence job found in the predecessor's own pipeline.
    const pipelineUrl = r.requestedUrls().find((url) => url.split("?")[0] === `${API}${pipelineKey(PIPE)}`);
    expect(pipelineUrl).toBeDefined();
    // Listed with no scope filter, so a sign_evidence still in flight is seen (#1607 note 48548, item 3).
    expect(new URL(pipelineUrl).searchParams.getAll("scope[]")).toEqual([]);
    const paths = r.requestedPaths();
    expect(paths).toContain(artifactKey(REC, MANIFEST));
    expect(paths).toContain(artifactKey(SIGN, SIG));
    // The predecessor's own carried pair is looked for too (absent here: a 404).
    expect(paths).toContain(artifactKey(REC, `previous/${MANIFEST}`));
    expect(paths).toContain(artifactKey(REC, `previous/${SIG}`));
    // Never the latest-artifacts-by-ref shape, nor a job name in the query.
    expect(r.requestedKeys().filter((key) => key.includes("/jobs/artifacts/") || key.includes("job="))).toEqual([]);
    expectTokenOnlyInHeaderFile(r);
    // ...and the header file is deleted when the script ends: the script's TMPDIR is empty.
    expect(r.tmpEntries()).toEqual([]);
  });

  it("fetches the predecessor's manifest once: manifest and signature come from one build by job id, so there is no second download to compare", () => {
    const r = carry({ routes: world(pair(OLDER)) });
    expect(r.result.status).toBe(0);
    expect(r.requestedPaths().filter((path) => path === artifactKey(REC, MANIFEST))).toHaveLength(1);
    expect(r.requestedPaths().filter((path) => path === artifactKey(SIGN, SIG))).toHaveLength(1);
  });

  it("URL-encodes the slash in a branch name in the listing, and matches jobs on the decoded ref", () => {
    const own = pair(OLDER);
    const r = carry({
      ref: "hotfix/x",
      routes: world(own, undefined, {
        jobs: [job(601, "record_image", { ref: "hotfix/y", pipeline: 7101 }), job(REC, "record_image", { ref: "hotfix/x", pipeline: PIPE })],
      }),
    });
    expect(r.result.status).toBe(0);
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    const urls = r.listingUrls();
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(new URL(urls[0]).search).toContain("ref=hotfix%2Fx");
    expect(urls[0]).not.toContain("hotfix/x");
  });

  it("a predecessor whose digest is not the published one is picked even when it carries a pair of its own", () => {
    const own = pair(OLDER);
    const r = carry({ routes: world(own, pair(THIRD)) }, CURRENT);
    expect(r.result.status).toBe(0);
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
  });

  describe("--prepare and the digest call (#1607 item 4)", () => {
    it("--prepare alone does the lookup, fetches and verifies the pair against cosign.pub, and saves nothing under previous/", () => {
      const own = pair(OLDER);
      const r = run({ routes: world(own) });
      expect(r.result.status).toBe(0);
      expect(r.hasPrevious()).toBe(false);
      expect(r.previousFiles()).toEqual([]);
      expect(r.requestedPaths()).toContain(artifactKey(REC, MANIFEST));
      const seen = r.verifications();
      expect(seen).toHaveLength(1);
      expect(seen[0].manifest.equals(Buffer.from(own.body))).toBe(true);
      expect(seen[0].sig.equals(Buffer.from(own.sig))).toBe(true);
      expect(r.tmpEntries()).toEqual([]);
      expectNoToken(r.result);
    });

    it("the digest call without a --prepare before it fails, saying nothing was staged, and saves nothing", () => {
      const r = run({ args: [CURRENT], routes: world(pair(OLDER)) });
      expectLoudFailure(r, /stag|prepare/i);
      expectNoToken(r.result);
    });

    it("the digest call saves the pick in one rename: previous/ appears complete, with exactly the two files", () => {
      const own = pair(OLDER);
      const r = carry({ routes: world(own) });
      expect(r.prepare.status).toBe(0);
      expect(r.final.status).toBe(0);
      expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
    });
  });

  describe("finding the predecessor by record_image job (#1607 item 2)", () => {
    it("a web or schedule pipeline (no record_image) newer than the predecessor does not hide it", () => {
      const own = pair(OLDER);
      const r = carry({
        routes: world(own, undefined, {
          jobs: [
            job(701, "lint", { pipeline: 7201 }),
            job(702, "unit", { pipeline: 7201 }),
            job(703, "sign_evidence", { pipeline: 7201 }),
            job(REC, "record_image", { pipeline: PIPE }),
          ],
        }),
      });
      expect(r.result.status).toBe(0);
      expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
      expect(r.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
      // Nothing was fetched from the newer pipeline.
      expect(r.requestedKeys().filter((key) => key.includes("7201") || key.includes("/jobs/70"))).toEqual([]);
    });

    it("a predecessor on page 2 is found, following X-Next-Page", () => {
      const own = pair(OLDER);
      const r = carry({
        routes: {
          ...world(own),
          ...listing([job(701, "lint", { pipeline: 7201 }), job(702, "unit", { pipeline: 7201 })], [job(REC, "record_image", { pipeline: PIPE })]),
        },
      });
      expect(r.result.status).toBe(0);
      expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
      const urls = r.listingUrls();
      expect(urls).toHaveLength(2);
      expect(new URL(urls[1]).searchParams.get("page")).toBe("2");
      expect(new URL(urls[1]).searchParams.get("per_page")).toBe("100");
    });

    it("the newest record_image job wins over an older one", () => {
      const newer = pair(OLDER);
      const r = carry({
        routes: world(newer, undefined, {
          recId: 601,
          signId: 602,
          pipeline: 7101,
          jobs: [job(601, "record_image", { pipeline: 7101 }), job(REC, "record_image", { pipeline: PIPE })],
        }),
      });
      expect(r.result.status).toBe(0);
      expect(r.previous(MANIFEST).equals(Buffer.from(newer.body))).toBe(true);
      expect(r.requestedKeys().filter((key) => key.includes(`/jobs/${REC}/`) && !key.includes("/previous/"))).toEqual([]);
      expect(r.requestedKeys().filter((key) => key.includes(`/pipelines/${PIPE}/`))).toEqual([]);
    });

    it("a record_image job of another ref in the listing (ref is an undocumented filter) is skipped", () => {
      const own = pair(OLDER);
      const r = carry({
        routes: world(own, undefined, {
          jobs: [job(601, "record_image", { ref: "other", pipeline: 7101 }), job(REC, "record_image", { pipeline: PIPE })],
        }),
      });
      expect(r.result.status).toBe(0);
      expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
      expect(r.requestedKeys().filter((key) => key.includes("7101") || key.includes("/jobs/601/"))).toEqual([]);
    });

    it("CI_JOB_ID's own job is never picked, even when it is the newest record_image job listed", () => {
      const own = pair(OLDER);
      const r = carry({
        env: { CI_JOB_ID: "601" },
        routes: world(own, undefined, {
          jobs: [job(601, "record_image", { pipeline: 7101 }), job(REC, "record_image", { pipeline: PIPE })],
        }),
      });
      expect(r.result.status).toBe(0);
      expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
      expect(r.requestedKeys().filter((key) => key.includes("7101") || key.includes("/jobs/601/"))).toEqual([]);
    });

    describe("first release: no successful record_image job on the ref in the whole listing", () => {
      it.each([
        ["an empty listing", () => listing([])],
        ["a listing of other jobs only", () => listing([job(701, "lint", { pipeline: 7201 }), job(702, "sign_evidence", { pipeline: 7201 })])],
        ["only a record_image job of another ref", () => listing([job(601, "record_image", { ref: "other", pipeline: 7101 })])],
        ["only the running job itself", () => listing([job(OWN_JOB, "record_image", { pipeline: 7301 })])],
      ])("%s: logs the first-release line, saves nothing and exits 0", (_label, routes) => {
        expectFirstRelease(carry({ routes: routes() }));
      });

      it("every page is read before it is called a first release", () => {
        const r = carry({ routes: listing([job(701, "lint", { pipeline: 7201 })], [job(702, "unit", { pipeline: 7201 })], []) });
        expectFirstRelease(r);
        expect(r.listingUrls()).toHaveLength(3);
      });

      it("names the ref in the line", () => {
        expectFirstRelease(carry({ ref: "hotfix/x", routes: listing([]) }), "hotfix/x");
      });
    });

    it("the page cap reached with no match fails, saying the cap was reached, and is never read as a first release", () => {
      const r = carry({ endless: [job(701, "lint", { pipeline: 7201 }), job(702, "unit", { pipeline: 7201 })] });
      expectPrepareFailure(r, /cap|limit/i);
      expect(output(r.prepare)).not.toContain("first release, nothing carried");
      // It stopped by itself, at a fixed cap, not at the stub's runaway guard.
      const pages = r.listingUrls().length;
      expect(pages).toBeGreaterThan(1);
      expect(pages).toBeLessThan(300);
    });

    it("a predecessor whose pipeline has no successful sign_evidence fails, naming that pipeline and telling to retry its sign_evidence job, and does not fall back to an older build", () => {
      const r = carry({
        routes: {
          // An older build that would verify.
          ...world(pair(THIRD), undefined, { recId: 401, signId: 402, pipeline: 7000, jobs: [] }),
          ...world(pair(OLDER), undefined, {
            jobs: [job(REC, "record_image", { pipeline: PIPE }), job(401, "record_image", { pipeline: 7000 })],
          }),
          // The predecessor pipeline's successful jobs, with no sign_evidence among them.
          [pipelineKey(PIPE)]: jsonBody([job(503, "build_image", { pipeline: PIPE }), job(REC, "record_image", { pipeline: PIPE })]),
        },
      });
      expectPrepareFailure(r, /sign_evidence/);
      expect(output(r.prepare)).toContain(String(PIPE));
      expect(output(r.prepare)).toMatch(/retry/i);
      expect(r.requestedKeys().filter((key) => key.includes("/jobs/401/") || key.includes("/pipelines/7000/"))).toEqual([]);
    });
  });

  describe("telling \"not found\" from \"could not ask\" (#1607 item 3)", () => {
    const LISTING_URL = `${API}/projects/${PROJECT}/jobs`;

    describe.each([
      ["the job listing", () => `${LISTING_URL}`, (response) => ({ ...world(pair(OLDER)), [listingKey(1)]: response })],
      [
        "the second page of the job listing",
        () => `${LISTING_URL}`,
        (response) => ({
          ...world(pair(OLDER)),
          ...listing([job(701, "lint", { pipeline: 7201 })], response),
        }),
      ],
      [
        "the predecessor pipeline's job listing",
        () => `${API}${pipelineKey(PIPE)}`,
        (response) => ({ ...world(pair(OLDER)), [pipelineKey(PIPE)]: response }),
      ],
    ])("%s", (_where, url, routesWith) => {
      it.each(HTTP_FAILURES)("answering %s fails, naming the status and the URL, never the token", (_label, response, status) => {
        const r = carry({ routes: routesWith(response) });
        expectPrepareFailure(r, status);
        expect(output(r.prepare)).toContain(url());
      });

      it("answering 404 fails, naming the status and the URL: a 404 here is not \"absent\"", () => {
        const r = carry({ routes: routesWith({ status: 404, body: '{"message":"404 Not Found"}' }) });
        expectPrepareFailure(r, /404/);
        expect(output(r.prepare)).toContain(url());
        // Not mistaken for a first release.
        expect(output(r.prepare)).not.toContain("first release, nothing carried");
      });
    });

    it.each([
      ["not JSON", "<html>bad gateway</html>"],
      ["empty", ""],
    ])("a job listing that is %s fails, naming the URL, and is not a first release", (_label, body) => {
      const r = carry({ routes: { ...world(pair(OLDER)), [listingKey(1)]: { body } } });
      expectPrepareFailure(r, /json/i);
      expect(output(r.prepare)).toContain(LISTING_URL);
      expect(output(r.prepare)).not.toContain("first release, nothing carried");
    });

    describe.each([
      ["the predecessor's manifest", artifactKey(REC, MANIFEST)],
      ["the signature", artifactKey(SIGN, SIG)],
      ["the carried manifest", artifactKey(REC, `previous/${MANIFEST}`)],
      ["the carried signature", artifactKey(REC, `previous/${SIG}`)],
    ])("fetching %s", (_what, key) => {
      it.each(HTTP_FAILURES)("answering %s fails, naming the status and the URL, nothing written", (_label, response, status) => {
        const r = carry({ routes: { ...world(pair(OLDER), pair(THIRD)), [key]: response } });
        expectPrepareFailure(r, status);
        expect(output(r.prepare)).toContain(`${API}${key}`);
      });
    });

    it("a 404 on the predecessor's manifest fails loud naming record_image and the job, nothing written", () => {
      const r = carry({ routes: without(world(pair(OLDER)), artifactKey(REC, MANIFEST)) });
      expectPrepareFailure(r, /record_image/);
      expect(output(r.prepare)).toContain(String(REC));
      expect(output(r.prepare)).not.toContain("first release, nothing carried");
    });

    it("a 404 on the signature fails loud naming sign_evidence, and no manifest is left behind", () => {
      const r = carry({ routes: without(world(pair(OLDER)), artifactKey(SIGN, SIG)) });
      expectPrepareFailure(r, /sign_evidence/);
      expect(existsSync(join(r.work, ".orbit-supply-chain", "previous", MANIFEST))).toBe(false);
    });

    it("a 404 on the carried pair means that file is absent, not a failure of --prepare", () => {
      const r = run({ routes: world(pair(OLDER)) });
      expect(r.result.status).toBe(0);
      expect(r.hasPrevious()).toBe(false);
    });
  });

  describe("rebuild: the published digest is the predecessor's", () => {
    it("the digest call carries the predecessor's own previous/ pair, fetched by the predecessor's job id", () => {
      const carried = pair(OLDER);
      const own = pair(CURRENT);
      const r = carry({ routes: world(own, carried) }, CURRENT);
      expect(r.result.status).toBe(0);
      expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
      expect(r.previous(MANIFEST).equals(Buffer.from(carried.body))).toBe(true);
      expect(r.previous(SIG).equals(Buffer.from(carried.sig))).toBe(true);
      const paths = r.requestedPaths();
      expect(paths).toContain(artifactKey(REC, `previous/${MANIFEST}`));
      expect(paths).toContain(artifactKey(REC, `previous/${SIG}`));
      expect(r.requestedKeys().filter((key) => key.includes("/jobs/artifacts/") || key.includes("job="))).toEqual([]);
      expectNoToken(r.final);
    });

    it("without a carried pair: --prepare passes, the digest call fails naming the digest and the missing carried pair, nothing written", () => {
      const r = carry({ routes: world(pair(CURRENT)) }, CURRENT);
      expectFinalFailure(r, /carried|previous\//i);
      expect(output(r.final)).toContain(CURRENT);
    });

    it("with a carried manifest but no carried signature: fails loud naming the signature, nothing written", () => {
      const r = carry({ routes: without(world(pair(CURRENT), pair(OLDER)), artifactKey(REC, `previous/${SIG}`)) }, CURRENT);
      expectLoudFailure(r, /signature/i);
    });

    it("whose carried manifest is also the published digest: fails naming the digest, nothing written", () => {
      // The carried pair is genuine, so only the carried-is-published check can refuse it.
      const r = carry({ routes: world(pair(CURRENT), pair(CURRENT)) }, CURRENT);
      expectFinalFailure(r, /published digest|current digest|itself/i);
      expect(output(r.final)).toContain(CURRENT);
    });
  });

  it.each([
    ["not JSON", "this is not json {"],
    ["empty", ""],
    ["JSON with no image", JSON.stringify({ version: "1.4.0" })],
    ["image without a digest", JSON.stringify({ image: { repository: "r" } })],
    ["digest that is not a string", JSON.stringify({ image: { repository: "r", digest: 12345 } })],
  ])("fetched manifest is %s: fails loud naming the digest, nothing written", (_label, body) => {
    const r = carry({ routes: world({ body, sig: signManifest(body) }) });
    expectLoudFailure(r, /digest/i);
    expect(r.hasPrevious()).toBe(false);
  });

  it("never prints the job token, on success or on failure", () => {
    const ok = carry({ routes: world(pair(OLDER)) });
    expect(ok.result.status).toBe(0);
    expectNoToken(ok.prepare);
    expectNoToken(ok.final);
    const failed = carry({ routes: { ...world(pair(OLDER)), [listingKey(1)]: { status: 401, body: '{"message":"401 Unauthorized"}' } } });
    expect(failed.result.status).not.toBe(0);
    expectNoToken(failed.result);
    expectTokenOnlyInHeaderFile(failed);
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
    it("(a) the verifier rejects the staged pair: --prepare fails loud saying the manifest does not verify, previous/ absent, no leftovers, token never printed", () => {
      const { body, sig } = pair(OLDER);
      const r = carry({ env: { STUB_COSIGN_REJECT: "1" }, routes: world({ body, sig }) });
      expectPrepareFailure(r, /does not verify/i);
      // The verifier really ran on the pair the script fetched.
      const seen = r.verifications();
      expect(seen).toHaveLength(1);
      expect(seen[0].manifest.equals(Buffer.from(body))).toBe(true);
      expect(seen[0].sig.equals(Buffer.from(sig))).toBe(true);
    });

    it("(a) a signature that is not a real signature over the manifest (even if cosign were fooled) fails --prepare loud, nothing written", () => {
      const r = carry({ routes: world({ body: manifest(OLDER), sig: SIG_BYTES }) });
      expectPrepareFailure(r, /does not verify/i);
    });

    it("(b) the verifier accepts: the pair is saved byte-for-byte, and the verifier saw exactly that pair", () => {
      const { body, sig } = pair(OLDER);
      const r = carry({ routes: world({ body, sig }) });
      expect(r.result.status).toBe(0);
        expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
      expect(r.previous(MANIFEST).equals(Buffer.from(body))).toBe(true);
      expect(r.previous(SIG).equals(Buffer.from(sig))).toBe(true);
      const seen = r.verifications();
      expect(seen).toHaveLength(1);
      expect(seen[0].manifest.equals(Buffer.from(body))).toBe(true);
      expect(seen[0].sig.equals(Buffer.from(sig))).toBe(true);
      expect(r.tmpEntries()).toEqual([]);
      expectNoToken(r.final);
    });

    it("(c) the predecessor's carried pair is verified in --prepare too, and a rejecting verifier fails --prepare loud", () => {
      const own = pair(CURRENT);
      const carried = pair(OLDER);
      const r = carry({
        // Reject only the carried pair, so the predecessor's own pair cannot be what fails.
        env: { STUB_COSIGN_REJECT_MATCH: OLDER },
        routes: world(own, carried),
      });
      expectPrepareFailure(r, /does not verify/i);
      expect(r.verifications().some((v) => v.manifest.equals(Buffer.from(carried.body)))).toBe(true);
    });

    it("(c) rebuild: an accepted carried pair is saved byte-for-byte after both pairs were verified", () => {
      const own = pair(CURRENT);
      const carried = pair(OLDER);
      const r = carry({ routes: world(own, carried) });
      expect(r.result.status).toBe(0);
      expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
      expect(r.previous(MANIFEST).equals(Buffer.from(carried.body))).toBe(true);
      expect(r.previous(SIG).equals(Buffer.from(carried.sig))).toBe(true);
      const seen = r.verifications();
      expect(seen.some((v) => v.manifest.equals(Buffer.from(carried.body)))).toBe(true);
      expect(seen.some((v) => v.manifest.equals(Buffer.from(own.body)))).toBe(true);
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
    ])("(d) fetched digest with %s: fails loud, nothing written", (_label, digest) => {
      const r = carry({ routes: world(pair(digest)) });
      expectLoudFailure(r, /digest/i);
      expect(r.tmpEntries()).toEqual([]);
      expectNoToken(r.result);
    });

    it("(d) rebuild: a carried manifest whose digest is malformed fails loud, nothing written", () => {
      const r = carry({ routes: world(pair(CURRENT), pair(`SHA256:${HEX}`)) });
      expectLoudFailure(r, /digest/i);
      expectNoToken(r.result);
    });
  });

  /*
   * #1607 D-F1-1, D-F2-1. The agreed target is a fail-loud, idempotent carry:
   * a missing or mismatched predecessor is an error that names its cause; re-running
   * the carry (or the validation that feeds it) gives the same result; the manifest
   * and the signature saved together always come from the same build, which a job id
   * now guarantees (D-F5, a first release, is "finding the predecessor" above).
   */
  describe("fail loud and idempotent (#1607)", () => {
    describe("D-F1-1: validation re-run by hand on preview after a failed push", () => {
      it("a re-run of the same digest carries the same predecessor, however often it is re-run, and the next build then finds this build", () => {
        const older = pair(OLDER);
        const own = pair(CURRENT);
        const first = carry({ routes: world(older) });
        expect(first.result.status).toBe(0);
        // The re-run: the newest successful record_image job now recorded CURRENT and carried what `first` saved.
        const rerun1 = carry({ routes: world(own, savedPair(first)) }, CURRENT);
        const rerun2 = carry({ routes: world(own, savedPair(first)) }, CURRENT);
        for (const r of [rerun1, rerun2]) {
          expect(r.result.status).toBe(0);
          expect(r.previousFiles()).toEqual([MANIFEST, SIG].sort());
          expect(r.previous(MANIFEST).equals(Buffer.from(older.body))).toBe(true);
          expect(r.previous(SIG).equals(Buffer.from(older.sig))).toBe(true);
        }
        // The next build, a new digest, finds the re-run's own manifest, not nothing.
        const next = carry({ routes: world(own, savedPair(first)) }, THIRD);
        expect(next.result.status).toBe(0);
        expect(next.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
        expect(next.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
      });

      it("a re-run whose predecessor never carried a pair fails loud, naming the digest and the missing carried pair, the same way each time", () => {
        const own = pair(CURRENT);
        const first = carry({ routes: world(own) }, CURRENT);
        const second = carry({ routes: world(own) }, CURRENT);
        for (const r of [first, second]) {
          expectFinalFailure(r, /carried|previous\//i);
          expect(output(r.final)).toContain(CURRENT);
        }
        // Idempotent: the same inputs give the same refusal.
        expect(second.final.status).toBe(first.final.status);
        expect(output(second.final)).toBe(output(first.final));
      });
    });

    describe("D-F2-1: a re-run build mixing a manifest and a signature from different builds", () => {
      const MIX_CAUSE = /does not verify|not match|mismatch|different build/i;
      const signatureOfAnotherBuild = signManifest(manifest(THIRD));

      it("rebuild: a carried manifest with the carried signature of another build fails --prepare loud, nothing written", () => {
        const r = carry({ routes: world(pair(CURRENT), { body: manifest(OLDER), sig: signatureOfAnotherBuild }) }, CURRENT);
        expectPrepareFailure(r, MIX_CAUSE);
      });

      it("normal build: a manifest with a signature of another build fails --prepare loud, nothing written", () => {
        const r = carry({ routes: world({ body: manifest(OLDER), sig: signatureOfAnotherBuild }) });
        expectPrepareFailure(r, MIX_CAUSE);
      });

      it("a mismatch is refused the same way on every re-run", () => {
        const options = () => ({ routes: world(pair(CURRENT), { body: manifest(OLDER), sig: signatureOfAnotherBuild }) });
        const first = carry(options(), CURRENT);
        const second = carry(options(), CURRENT);
        expectPrepareFailure(first, MIX_CAUSE);
        expectPrepareFailure(second, MIX_CAUSE);
        expect(second.result.status).toBe(first.result.status);
      });

      it("whatever is saved is one build's manifest with that same build's signature", () => {
        const r = carry({ routes: world(pair(OLDER)) });
        expect(r.result.status).toBe(0);
        // The saved signature verifies the saved manifest, with the real key.
        const sigFile = join(keyDir, "saved.sig");
        const manifestFile = join(keyDir, "saved.json");
        writeFileSync(sigFile, Buffer.from(r.previous(SIG).toString(), "base64"));
        writeFileSync(manifestFile, r.previous(MANIFEST));
        const verified = openssl(["dgst", "-sha256", "-verify", PUBLIC_KEY, "-signature", sigFile, manifestFile]);
        expect(verified.toString()).toMatch(/Verified OK/);
      });
    });
  });
});

/*
 * The publish job's order (#1607 item 4): --prepare must run, and be able to
 * fail the job, before anything is pushed; the final carry comes after the push
 * because the registry digest exists only then. A static read of
 * .gitlab-ci.yml's record_image script (no YAML library in the repo, so the
 * job's block is cut out by its indentation and comment lines dropped).
 */
describe("record_image in .gitlab-ci.yml runs the carry around the push (#1607 item 4)", () => {
  const ci = readFileSync(join(repoRoot, ".gitlab-ci.yml"), "utf8").split("\n");
  const startLine = ci.findIndex((line) => line === "record_image:");
  const endLine = ci.findIndex((line, i) => i > startLine && /^[A-Za-z_.]/.test(line));
  const block = ci.slice(startLine, endLine === -1 ? undefined : endLine).filter((line) => !/^\s*#/.test(line));
  const text = block.join("\n");
  const indexOf = (needle) => text.indexOf(needle);
  const PREPARE = "carry-previous-release.sh --prepare";
  const FINAL = 'carry-previous-release.sh "$published_digest"';
  // The image push step is the one that sets published_digest (after the registry returns it).
  const PUSH = "published_digest=";

  it("finds the record_image job", () => {
    expect(startLine).toBeGreaterThanOrEqual(0);
    expect(text).toContain("script:");
  });

  it("calls carry-previous-release.sh --prepare, once, before the image push step", () => {
    expect(text.split(PREPARE).length - 1).toBe(1);
    expect(indexOf(PUSH)).toBeGreaterThan(0);
    expect(indexOf(PREPARE)).toBeGreaterThan(0);
    expect(indexOf(PREPARE)).toBeLessThan(indexOf(PUSH));
    expect(indexOf(PREPARE)).toBeLessThan(indexOf("publish-image.sh"));
  });

  it("calls carry-previous-release.sh \"$published_digest\" after the push, once", () => {
    expect(text.split(FINAL).length - 1).toBe(1);
    // --prepare is there too, so "after it" means something.
    expect(indexOf(PREPARE)).toBeGreaterThan(0);
    expect(indexOf(FINAL)).toBeGreaterThan(indexOf(PUSH));
    expect(indexOf(FINAL)).toBeGreaterThan(indexOf(PREPARE));
  });

  it("--prepare failing leaves no push: nothing on its line swallows the exit status, and it is a step of its own before the push", () => {
    const line = block.find((l) => l.includes(PREPARE));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/\|\||;|&\s*$|\|\s*true/);
    const finalLine = block.find((l) => l.includes(FINAL));
    expect(finalLine).toBeDefined();
    expect(finalLine).not.toMatch(/\|\||;|&\s*$|\|\s*true/);
    // Every script item before the one that pushes ends with --prepare passing (GitLab stops the job at the first failing item).
    expect(block.indexOf(line)).toBeLessThan(block.findIndex((l) => l.includes(PUSH)));
  });
});

describe("the ORBIT_CARRY_NO_PREDECESSOR override is gone (#1607 item 2)", () => {
  it.each([
    ["scripts/ci/carry-previous-release.sh"],
    [".gitlab-ci.yml"],
    ["docs/releasing.md"],
  ])("%s does not mention it", (file) => {
    expect(readFileSync(join(repoRoot, file), "utf8")).not.toContain("ORBIT_CARRY_NO_PREDECESSOR");
  });
});

/*
 * The three deadlocks of #1607 note 48548 (the ruling on the review of
 * fix/1607-check-gaps), and the Low about --max-filesize. The rule behind all
 * three: a stuck preview or hotfix release recovers by an ordinary push, a job
 * retry or waiting, never by a hand-started pipeline or a CI variable.
 */

// More throwaway keys, made at run time like the first one. Nothing here is
// committed; the private halves live in the temp directory only.
const makeKey = (name) => {
  const privateKey = join(keyDir, `${name}.pem`);
  const publicKey = join(keyDir, `${name}.pub`);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", privateKey]);
  openssl(["ec", "-in", privateKey, "-pubout", "-out", publicKey]);
  return { privateKey, publicKey };
};
const RETIRED_KEY = makeKey("retired");
const STRANGER_KEY = makeKey("stranger");
const pairSignedBy = (key, digest) => {
  const body = manifest(digest);
  return { body, sig: openssl(["dgst", "-sha256", "-sign", key.privateKey], Buffer.from(body)).toString("base64") };
};
const RETIRED_NAME = "2026-01-15.pub";

// A trust root as the repository has it: cosign.pub (the test key, so pairs from pair() verify)
// and, when asked, cosign-retired/<date>.pub beside it. The carry finds the directory next to
// COSIGN_PUBLIC_KEY, so no other setting is needed.
const trustRoot = (retired) => {
  const dir = mkdtempSync(join(tmpdir(), "carry-previous-root-"));
  copyFileSync(PUBLIC_KEY, join(dir, "cosign.pub"));
  if (retired.length > 0) {
    mkdirSync(join(dir, "cosign-retired"));
    for (const [name, file] of retired) copyFileSync(file, join(dir, "cosign-retired", name));
  }
  return { COSIGN_PUBLIC_KEY: join(dir, "cosign.pub") };
};

describe("key rotation: retired public keys verify old builds (#1607 note 48548, item 1)", () => {
  it("a pair signed by a retired key in cosign-retired/ beside cosign.pub passes --prepare, the log names that file, and the pair is carried", () => {
    const own = pairSignedBy(RETIRED_KEY, OLDER);
    const r = carry({ routes: world(own), env: trustRoot([[RETIRED_NAME, RETIRED_KEY.publicKey]]) });
    expect(r.prepare.status).toBe(0);
    expect(output(r.prepare)).toContain(RETIRED_NAME);
    expect(r.final.status).toBe(0);
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
    expectNoToken(r.prepare);
    expectNoToken(r.final);
  });

  it("a pair signed by neither cosign.pub nor a retired key fails --prepare, naming both files", () => {
    const r = carry({
      routes: world(pairSignedBy(STRANGER_KEY, OLDER)),
      env: trustRoot([[RETIRED_NAME, RETIRED_KEY.publicKey]]),
    });
    expectPrepareFailure(r, /cosign\.pub/);
    expect(output(r.prepare)).toContain(RETIRED_NAME);
  });

  describe("with no cosign-retired/ directory, behaving exactly as before", () => {
    it("a pair signed by cosign.pub passes and is carried", () => {
      const own = pair(OLDER);
      const r = carry({ routes: world(own), env: trustRoot([]) });
      expect(r.result.status).toBe(0);
      expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    });

    it("a pair signed by any other key fails, naming cosign.pub and no retired file", () => {
      const r = carry({ routes: world(pairSignedBy(RETIRED_KEY, OLDER)), env: trustRoot([]) });
      expectPrepareFailure(r, /does not verify against cosign\.pub/);
      expect(output(r.prepare)).not.toContain("cosign-retired");
    });
  });
});

describe("artifact expiry: records are retained, and a lost predecessor has a recorded break-glass (#1607 note 48548, item 2)", () => {
  // The same by-indentation cut as the record_image checks above: a job's block
  // from its key to the next top-level key, comment lines dropped.
  const ci = readFileSync(join(repoRoot, ".gitlab-ci.yml"), "utf8").split("\n");
  const jobText = (name) => {
    const start = ci.findIndex((line) => line === `${name}:`);
    expect(start, `job ${name} exists`).toBeGreaterThanOrEqual(0);
    const end = ci.findIndex((line, i) => i > start && /^[A-Za-z_.]/.test(line));
    return ci
      .slice(start, end === -1 ? undefined : end)
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
  };

  it.each(["record_image", "sign_evidence"])("%s keeps its artifacts: expire_in is never, and is declared once", (name) => {
    const lines = jobText(name)
      .split("\n")
      .filter((line) => /^\s+expire_in:/.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\s+expire_in:\s*["']?never["']?\s*$/);
  });

  describe("a 404 on the predecessor's pair when the job has expired", () => {
    const EXPIRY = "2026-08-30T10:11:12.345Z";
    const expiringWorld = (own) => ({
      ...world(own),
      ...listing([{ ...job(REC, "record_image", { pipeline: PIPE }), artifacts_expire_at: EXPIRY }]),
      [pipelineKey(PIPE)]: jsonBody([
        job(SIGN + 1, "build_image", { pipeline: PIPE }),
        { ...job(SIGN, "sign_evidence", { pipeline: PIPE }), artifacts_expire_at: EXPIRY },
        { ...job(REC, "record_image", { pipeline: PIPE }), artifacts_expire_at: EXPIRY },
      ]),
    });

    it.each([
      ["manifest", artifactKey(REC, MANIFEST)],
      ["signature", artifactKey(SIGN, SIG)],
    ])("on the %s names the expiry date and says the artifacts have expired, and names the break-glass file", (_what, key) => {
      const r = carry({ routes: without(expiringWorld(pair(OLDER)), key) });
      expectPrepareFailure(r, /expired/i);
      expect(output(r.prepare)).toContain("2026-08-30");
      expect(output(r.prepare)).toContain("carry-accepted-gap");
    });
  });

  describe("scripts/ci/carry-accepted-gap, the committed break-glass file", () => {
    const REASON = "key rotated, the predecessor's artifacts expired";
    const noManifest = (own = pair(OLDER)) => without(world(own), artifactKey(REC, MANIFEST));
    const noSignature = (own = pair(OLDER)) => without(world(own), artifactKey(SIGN, SIG));
    const wrongSignature = () => world({ body: manifest(OLDER), sig: signManifest(manifest(THIRD)) });
    const STALE = /stale/i;
    const ACCEPTED = /gap accepted/i;

    it.each([
      ["a 404 on its manifest", noManifest],
      ["a 404 on its signature", noSignature],
      ["a verification failure", wrongSignature],
    ])("a matching line passes --prepare after %s: logs the acceptance, carries nothing, and the digest call saves nothing", (_failure, routes) => {
      const gap = ["# the break-glass entries", "", `main ${REC} ${REASON}`, ""].join("\n");
      const r = carry({ routes: routes(), gap });
      expect(r.prepare.status).toBe(0);
      expect(output(r.prepare)).toContain(`gap accepted for record_image job ${REC} on main (${REASON})`);
      expect(r.final).not.toBeNull();
      expect(r.final.status).toBe(0);
      expect(r.hasPrevious()).toBe(false);
      expect(r.previousFiles()).toEqual([]);
      expect(r.tmpEntries()).toEqual([]);
      expectNoToken(r.prepare);
      expectNoToken(r.final);
    });

    it.each([
      ["another job id", `main ${REC + 1} ${REASON}`, STALE],
      ["another ref", `release/9 ${REC} ${REASON}`, STALE],
    ])("a line for %s is logged as stale and ignored: the 404 still fails --prepare", (_what, line, logged) => {
      const r = carry({ routes: noManifest(), gap: `${line}\n` });
      expectPrepareFailure(r, /record_image/);
      expect(output(r.prepare)).toMatch(logged);
      expect(output(r.prepare)).not.toMatch(ACCEPTED);
    });

    it.each([
      ["a 500 on the manifest", () => ({ ...world(pair(OLDER)), [artifactKey(REC, MANIFEST)]: { status: 500, body: '{"message":"500"}' } }), /500/],
      ["a 500 on the signature", () => ({ ...world(pair(OLDER)), [artifactKey(SIGN, SIG)]: { status: 500, body: '{"message":"500"}' } }), /500/],
      [
        "a missing sign_evidence",
        () => ({
          ...world(pair(OLDER)),
          [pipelineKey(PIPE)]: jsonBody([job(503, "build_image", { pipeline: PIPE }), job(REC, "record_image", { pipeline: PIPE })]),
        }),
        /sign_evidence/,
      ],
    ])("a matching line does not excuse %s: --prepare still fails", (_what, routes, cause) => {
      const r = carry({ routes: routes(), gap: `main ${REC} ${REASON}\n` });
      expectPrepareFailure(r, cause);
      expect(output(r.prepare)).not.toMatch(ACCEPTED);
    });

    // "Naming it": the offending line's text, or its line number (the note does not say which).
    it.each([
      ["a job id that is not a number", "main abc not-a-job-id", "not-a-job-id"],
      ["a line with one field", "lonelyfield", "lonelyfield"],
    ])("a malformed line (%s) fails --prepare, naming it, even beside a matching line", (_what, bad, token) => {
      const gap = [`main ${REC} ${REASON}`, bad, ""].join("\n");
      const r = carry({ routes: noManifest(), gap });
      expectPrepareFailure(r, new RegExp(`${token}|line 2`));
      expect(output(r.prepare)).not.toMatch(ACCEPTED);
    });
  });
});

describe("sign_evidence still running: a bounded wait on an in-flight dependency (#1607 note 48548, item 3)", () => {
  const IN_FLIGHT = ["created", "pending", "running", "preparing", "waiting_for_resource", "scheduled"];
  const evidenceJobs = (status) => [
    job(SIGN + 1, "build_image", { pipeline: PIPE }),
    job(SIGN, "sign_evidence", { pipeline: PIPE, status }),
    job(REC, "record_image", { pipeline: PIPE }),
  ];
  const pipelineRequests = (r) => r.requestedUrls().filter((url) => url.split("?")[0] === `${API}${pipelineKey(PIPE)}`);
  const polling = { ORBIT_CARRY_POLL_SECONDS: "0" };

  it.each(IN_FLIGHT)("a sign_evidence that is %s and then succeeds: the carry waits, then carries normally", (status) => {
    const own = pair(OLDER);
    const routes = {
      ...world(own),
      [pipelineKey(PIPE)]: { sequence: [jsonBody(evidenceJobs(status)), jsonBody(evidenceJobs(status)), jsonBody(evidenceJobs("success"))] },
    };
    const r = carry({ routes, env: polling });
    expect(r.prepare.status).toBe(0);
    expect(r.final.status).toBe(0);
    expect(pipelineRequests(r)).toHaveLength(3);
    for (const url of pipelineRequests(r)) expect(new URL(url).searchParams.getAll("scope[]")).toEqual([]);
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
  });

  it.each(IN_FLIGHT)("a sign_evidence that stays %s past the poll cap fails, saying it is still running and to run this job again", (status) => {
    const routes = { ...world(pair(OLDER)), [pipelineKey(PIPE)]: jsonBody(evidenceJobs(status)) };
    const r = carry({ routes, env: polling });
    expectPrepareFailure(r, /still running/i);
    expect(output(r.prepare)).toMatch(/run this job again/i);
    expect(output(r.prepare)).toContain(String(PIPE));
    // 20 polls: the note says "for 20 polls"; whether the first look counts as one is not stated, so 20 or 21 requests.
    expect(pipelineRequests(r).length).toBeGreaterThanOrEqual(20);
    expect(pipelineRequests(r).length).toBeLessThanOrEqual(21);
  });

  it.each(["failed", "canceled"])("a sign_evidence that is %s is not waited for: fails at once, saying to retry its sign_evidence job", (status) => {
    const routes = { ...world(pair(OLDER)), [pipelineKey(PIPE)]: jsonBody(evidenceJobs(status)) };
    const r = carry({ routes, env: polling });
    expectPrepareFailure(r, /retry its sign_evidence job, then run this job again/);
    expect(output(r.prepare)).not.toMatch(/still running/i);
    expect(output(r.prepare)).toContain(String(PIPE));
    expect(pipelineRequests(r)).toHaveLength(1);
  });
});

describe("--max-filesize on every curl call (#1607 note 48548, Lows)", () => {
  const limitOf = (argv) => {
    const at = argv.findIndex((arg) => arg === "--max-filesize" || arg.startsWith("--max-filesize="));
    if (at < 0) return null;
    return argv[at].includes("=") ? argv[at].split("=")[1] : argv[at + 1];
  };

  it("every curl call of a full rebuild carry (listings, manifest, signature, carried pair) passes a positive --max-filesize", () => {
    const r = carry({ routes: world(pair(CURRENT), pair(OLDER)) }, CURRENT);
    expect(r.result.status).toBe(0);
    expect(r.calls().length).toBeGreaterThanOrEqual(6);
    for (const argv of r.calls()) {
      const limit = limitOf(argv);
      expect(limit, `--max-filesize in: curl ${argv.filter((arg) => arg.startsWith(API)).join(" ")}`).not.toBeNull();
      expect(limit).toMatch(/^[1-9][0-9]*[KkMmGg]?$/);
    }
  });

  it.each([
    ["the job listing", listingKey(1)],
    ["the pipeline's job listing", pipelineKey(PIPE)],
    ["the predecessor's manifest", artifactKey(REC, MANIFEST)],
    ["the signature", artifactKey(SIGN, SIG)],
    ["the carried manifest", artifactKey(REC, `previous/${MANIFEST}`)],
  ])("an answer larger than the limit (curl exit 63) for %s fails the carry, naming the URL", (_what, key) => {
    const routes = world(pair(OLDER), pair(THIRD));
    const r = carry({ routes: { ...routes, [key]: { ...routes[key], oversize: true } } });
    expectPrepareFailure(r, /63|file size|too (large|big)/i);
    expect(output(r.prepare)).toContain(`${API}${key.split("#")[0]}`);
  });
});

/*
 * #1607 note 48718, the five Lows from the inline review of a7cf6709:
 *  1. a gap line excuses only the predecessor's own pair (a 404 on it, or a
 *     failure to verify it), never the carried previous/ pair;
 *  2. "does not verify" (the verifier ran and rejected the signature) is told
 *     apart from a tooling failure (cosign cannot be downloaded or run, openssl
 *     is missing): a tooling failure always fails, names the tool, and no gap
 *     line excuses it;
 *  3. a chunked answer (no length header, so --max-filesize cannot see it) is
 *     bounded by the bytes actually read;
 *  4. a 404 with artifacts_expire_at null says the artifacts are gone and points
 *     at scripts/ci/carry-accepted-gap, as the expired case does;
 *  5. ADR-0031 carries a dated note that record_image and sign_evidence keep
 *     artifacts with no expiry; ORBIT_CARRY_POLL_SECONDS is capped at 60 and a
 *     non-number is rejected.
 */
describe("a gap line excuses only the predecessor's own pair (#1607 note 48718, Low 1)", () => {
  const REASON = "key rotated, the predecessor's artifacts expired";
  const gap = `main ${REC} ${REASON}\n`;
  const ACCEPTED = /gap accepted/i;

  it.each([
    ["the verifier rejects it", () => ({ env: { STUB_COSIGN_REJECT_MATCH: OLDER }, routes: world(pair(CURRENT), pair(OLDER)) })],
    [
      "its signature is not a signature over it",
      () => ({ routes: world(pair(CURRENT), { body: manifest(OLDER), sig: signManifest(manifest(THIRD)) }) }),
    ],
  ])("a carried pair that fails verification (%s) fails --prepare with a matching gap line", (_how, options) => {
    const r = carry({ ...options(), gap });
    expectPrepareFailure(r, /carried/i);
    expect(output(r.prepare)).toMatch(/does not verify/i);
    expect(output(r.prepare)).not.toMatch(ACCEPTED);
    // The predecessor's own pair verified; it was the carried one that failed.
    expect(r.verifications().length).toBeGreaterThanOrEqual(2);
  });
});

describe("a verifier rejection is told apart from a tooling failure (#1607 note 48718, Low 2)", () => {
  const REASON = "key rotated, the predecessor's artifacts expired";
  const gap = `main ${REC} ${REASON}\n`;
  const ACCEPTED = /gap accepted/i;
  const cosignCache = join(keyDir, "cosign-cache");
  mkdirSync(cosignCache, { recursive: true });

  it("a verifier that rejects the signature, with a matching gap line, is excused: a first release, nothing carried", () => {
    const r = carry({ routes: world(pair(OLDER)), env: { STUB_COSIGN_REJECT: "1" }, gap });
    expect(r.prepare.status).toBe(0);
    expect(output(r.prepare)).toMatch(ACCEPTED);
    expect(r.final.status).toBe(0);
    expect(r.hasPrevious()).toBe(false);
    expect(r.verifications().length).toBeGreaterThanOrEqual(1);
  });

  // Each case: how the tool fails, the tool the message must name, and proof
  // that the scenario is the one meant (the failing step really was reached).
  const TOOL_FAILURES = [
    [
      "cosign cannot be downloaded",
      { env: { ORBIT_COSIGN: "", ORBIT_COSIGN_DIR: cosignCache }, without: ["cosign"] },
      /cosign/i,
      (r) => expect(r.calls().some((argv) => argv.some((arg) => arg.includes("sigstore/cosign")))).toBe(true),
    ],
    [
      "openssl is missing",
      { without: ["openssl"] },
      /openssl/i,
      // cosign accepted; it is openssl that could not run.
      (r) => expect(r.verifications().length).toBeGreaterThanOrEqual(1),
    ],
    ["cosign fails as a tool, with no verdict", { env: { STUB_COSIGN_TOOL_FAIL: "1" } }, /cosign/i, (r) => expect(r.verifications().length).toBeGreaterThanOrEqual(1)],
  ];

  it.each(TOOL_FAILURES.flatMap(([what, options, tool, proof]) => [true, false].map((withGap) => [what, withGap, options, tool, proof])))(
    "%s (matching gap line: %s): --prepare fails naming the tool, never as 'does not verify', and the gap line does not excuse it",
    (_what, withGap, options, tool, proof) => {
      const r = carry({ routes: world(pair(OLDER)), ...options, env: { ...options.env }, ...(withGap ? { gap } : {}) });
      expectPrepareFailure(r, tool);
      expect(output(r.prepare)).not.toMatch(/does not verify/i);
      expect(output(r.prepare)).not.toMatch(ACCEPTED);
      proof(r);
    },
  );
});

describe("a chunked answer is bounded by the bytes read (#1607 note 48718, Low 3)", () => {
  const LIMIT = 1024 * 1024;
  // Valid content padded to an exact size, so the size is the only thing wrong with it.
  const padded = (text, size, fill = " ") => text + fill.repeat(size - Buffer.byteLength(text));
  const bigPair = (digest, size) => {
    const body = padded(manifest(digest), size);
    return { body, sig: signManifest(body) };
  };
  // A route with no length header: the stub sends it whole, whatever --max-filesize says.
  const chunked = (body) => ({ chunked: true, body });
  const limitMessage = /size limit|limit|more than|too (large|big)|exceed/i;

  it("a manifest of one byte over the limit, sent with no length header, fails the carry, naming the URL", () => {
    const own = bigPair(OLDER, LIMIT + 1);
    const routes = { ...world(own), [artifactKey(REC, MANIFEST)]: chunked(own.body) };
    const r = carry({ routes });
    expectPrepareFailure(r, limitMessage);
    expect(output(r.prepare)).toContain(`${API}${artifactKey(REC, MANIFEST)}`);
  });

  it("a signature over the limit, sent with no length header, fails the carry, naming the URL", () => {
    const own = pair(OLDER);
    const routes = { ...world(own), [artifactKey(SIGN, SIG)]: chunked(padded(own.sig, LIMIT + 1, "\n")) };
    const r = carry({ routes });
    expectPrepareFailure(r, limitMessage);
    expect(output(r.prepare)).toContain(`${API}${artifactKey(SIGN, SIG)}`);
  });

  it("a carried manifest over the limit, sent with no length header, fails the carry, naming the URL", () => {
    const carried = bigPair(THIRD, LIMIT + 1);
    const routes = { ...world(pair(OLDER), carried), [artifactKey(REC, `previous/${MANIFEST}`)]: chunked(carried.body) };
    const r = carry({ routes });
    expectPrepareFailure(r, limitMessage);
    expect(output(r.prepare)).toContain(`${API}${artifactKey(REC, `previous/${MANIFEST}`)}`);
  });

  it("a chunked manifest of exactly the limit is read whole and carried byte-for-byte (the cap is limit + 1, not limit)", () => {
    const own = bigPair(OLDER, LIMIT);
    expect(Buffer.byteLength(own.body)).toBe(LIMIT);
    const routes = { ...world(own), [artifactKey(REC, MANIFEST)]: chunked(own.body) };
    const r = carry({ routes });
    expect(r.prepare.status).toBe(0);
    expect(r.final.status).toBe(0);
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
  });
});

describe("a 404 with artifacts_expire_at null says the artifacts are gone (#1607 note 48718, Low 4)", () => {
  const goneWorld = (own) => ({
    ...world(own),
    ...listing([{ ...job(REC, "record_image", { pipeline: PIPE }), artifacts_expire_at: null }]),
    [pipelineKey(PIPE)]: jsonBody([
      job(SIGN + 1, "build_image", { pipeline: PIPE }),
      { ...job(SIGN, "sign_evidence", { pipeline: PIPE }), artifacts_expire_at: null },
      { ...job(REC, "record_image", { pipeline: PIPE }), artifacts_expire_at: null },
    ]),
  });

  it.each([
    ["manifest", artifactKey(REC, MANIFEST)],
    ["signature", artifactKey(SIGN, SIG)],
  ])("on the %s: says the artifacts are gone (deleted or never kept) and names scripts/ci/carry-accepted-gap and the line to add", (_what, key) => {
    const r = carry({ routes: without(goneWorld(pair(OLDER)), key) });
    expectPrepareFailure(r, /gone|deleted|never kept/i);
    expect(output(r.prepare)).toContain("carry-accepted-gap");
    expect(output(r.prepare)).toContain(`main ${REC} `);
  });
});

describe("ORBIT_CARRY_POLL_SECONDS is capped at 60 and must be a number (#1607 note 48718)", () => {
  it.each(["61", "100", "3600"])("%s is rejected, not clamped: --prepare fails naming the variable and the cap", (value) => {
    const r = carry({ routes: world(pair(OLDER)), env: { ORBIT_CARRY_POLL_SECONDS: value } });
    expectPrepareFailure(r, /ORBIT_CARRY_POLL_SECONDS/);
    expect(output(r.prepare)).toMatch(/60/);
  });

  it.each(["abc", "1.5", "-5", "10s", "0x10"])("'%s' is not a number: --prepare fails naming the variable", (value) => {
    const r = carry({ routes: world(pair(OLDER)), env: { ORBIT_CARRY_POLL_SECONDS: value } });
    expectPrepareFailure(r, /ORBIT_CARRY_POLL_SECONDS/);
  });

  it.each(["0", "60"])("%s is within the cap and carries normally", (value) => {
    const own = pair(OLDER);
    const r = carry({ routes: world(own), env: { ORBIT_CARRY_POLL_SECONDS: value } });
    expect(r.prepare.status).toBe(0);
    expect(r.final.status).toBe(0);
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
  });
});

describe("ADR-0031 records that the artifacts have no expiry (#1607 note 48718, Low 5)", () => {
  // The ADR is hard-wrapped and uses backticks for names: compare on one line of plain words.
  const adr = readFileSync(join(repoRoot, "docs", "adr", "0031-signed-launcher-shipped-with-orbit.md"), "utf8")
    .replace(/`/g, "")
    .replace(/\s+/g, " ");
  const NOTE = "record_image and sign_evidence keep artifacts with no expiry";

  it("has the note in at least two places", () => {
    expect(adr.split(NOTE).length - 1).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["§3 Build, beside 'Artifacts kept 90 days'", "Artifacts kept 90 days, like record_image's."],
    ["the implementation slices, beside the .sig '90 days'", "wired into sign_evidence, artifact .sig 90 days"],
  ])("%s: a dated 'since #1607' note follows the original text, which stays", (_where, anchor) => {
    const at = adr.indexOf(anchor);
    expect(at, `the original text '${anchor}' stays (a note, not a rewrite)`).toBeGreaterThanOrEqual(0);
    const after = adr.slice(at + anchor.length, at + anchor.length + 400);
    expect(after).toContain(NOTE);
    expect(after).toMatch(/since #1607/);
    expect(after).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

/*
 * The carry retries in the script, one fresh buffer per attempt (#1607 note
 * 48797). curl's own --retry cannot rewind stdout, so a 5xx followed by a 200
 * gave the failed body, the good one and the status in one stream. The script
 * now makes at most 3 attempts per call (1 plus 2 retries), each into a fresh,
 * emptied buffer through the same byte cap, and retries only a transport error
 * (a curl exit other than 0 or the cap's own 63) or an HTTP 408, 429 or 5xx,
 * pausing ORBIT_CARRY_RETRY_SECONDS (default 2, digits only, at most 30)
 * between attempts. Any other status, or the byte cap, is final at once; only
 * the last attempt's body and status are used. After the last attempt the
 * failure names the status or the curl exit, the URL and "after 3 attempts".
 *
 * The curl stub serves { sequence: [...] } routes (the nth request gets the nth
 * entry) and ignores --retry, so a retry in these tests can only be the
 * script's own loop; r.routeCalls(key) counts the calls a route got.
 */
describe("the carry retries in the script with a fresh buffer each attempt (#1607 note 48797)", () => {
  const retrying = { ORBIT_CARRY_RETRY_SECONDS: "0" };
  const LIMIT = 1024 * 1024;
  // A busy answer longer than any good body it precedes, so a buffer that is not emptied shows.
  const busy = (status = 503) => ({ status, body: `<html>${"the gateway is busy, ".repeat(400)}</html>` });
  const own = pair(OLDER);
  const carried = pair(THIRD);
  const fullWorld = world(own, carried);
  // Every call the carry makes, by route key: the retry applies to all of them.
  const TARGETS = [
    ["the job listing", listingKey(1)],
    ["the predecessor pipeline's job listing", pipelineKey(PIPE)],
    ["the predecessor's manifest", artifactKey(REC, MANIFEST)],
    ["the signature", artifactKey(SIGN, SIG)],
    ["the carried manifest", artifactKey(REC, `previous/${MANIFEST}`)],
    ["the carried signature", artifactKey(REC, `previous/${SIG}`)],
  ];
  const sequence = (key, ...answers) => ({ ...fullWorld, [key]: { sequence: answers } });
  const good = (key) => fullWorld[key];
  // The carry went through with the clean answers: both pairs were verified as served, the predecessor's is saved byte for byte.
  const expectCleanCarry = (r) => {
    expect(r.prepare.status).toBe(0);
    expect(r.final.status).toBe(0);
    expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    expect(r.previous(SIG).equals(Buffer.from(own.sig))).toBe(true);
    const verified = r.verifications();
    expect(verified).toHaveLength(2);
    expect(verified[0].manifest.equals(Buffer.from(own.body))).toBe(true);
    expect(verified[0].sig.equals(Buffer.from(own.sig))).toBe(true);
    expect(verified[1].manifest.equals(Buffer.from(carried.body))).toBe(true);
    expect(verified[1].sig.equals(Buffer.from(carried.sig))).toBe(true);
  };

  describe.each(TARGETS)("%s", (_what, key) => {
    it("a 503 then a 200: the carry uses the clean second answer", () => {
      const r = carry({ routes: sequence(key, busy(), good(key)), env: retrying });
      expectCleanCarry(r);
      expect(r.routeCalls(key)).toBe(2);
    });

    it("a transport error (curl exit 7) then a 200: retried the same way", () => {
      const r = carry({ routes: sequence(key, { transport: 7 }, good(key)), env: retrying });
      expectCleanCarry(r);
      expect(r.routeCalls(key)).toBe(2);
    });

    it("three failures in a row (503, 503, 503) fail, naming 503, the URL and 'after 3 attempts', with no fourth attempt", () => {
      const r = carry({ routes: sequence(key, busy(), busy(), busy(), good(key)), env: retrying });
      expectPrepareFailure(r, /after 3 attempts/);
      expect(output(r.prepare)).toMatch(/503/);
      expect(output(r.prepare)).toContain(`${API}${key.split("#")[0]}`);
      expect(r.routeCalls(key)).toBe(3);
    });

    it("three transport errors in a row fail, naming the curl exit, the URL and 'after 3 attempts'", () => {
      const r = carry({ routes: sequence(key, { transport: 7 }, { transport: 7 }, { transport: 7 }, good(key)), env: retrying });
      expectPrepareFailure(r, /after 3 attempts/);
      expect(output(r.prepare)).toMatch(/curl exit status 7/);
      expect(output(r.prepare)).toContain(`${API}${key.split("#")[0]}`);
      expect(r.routeCalls(key)).toBe(3);
    });
  });

  it("the answer of the last attempt is the one used: two failures of different kinds, then a 200, is the third attempt", () => {
    const key = artifactKey(REC, MANIFEST);
    const r = carry({ routes: sequence(key, busy(502), { transport: 7 }, good(key)), env: retrying });
    expectCleanCarry(r);
    expect(r.routeCalls(key)).toBe(3);
  });

  it("the last attempt's status is the one named: 503, 503, then a 404 on a by-job file is 'absent' (a gap), not 'after 3 attempts' of 503", () => {
    const key = artifactKey(SIGN, SIG);
    const r = carry({ routes: sequence(key, busy(), busy(), { status: 404, body: '{"message":"404 Not Found"}' }), env: retrying });
    expectPrepareFailure(r, /404/);
    expect(output(r.prepare)).not.toMatch(/after 3 attempts/);
    expect(r.routeCalls(key)).toBe(3);
  });

  it.each([408, 429, 500, 502, 504])("an HTTP %i is retried like a 503", (status) => {
    const key = artifactKey(REC, MANIFEST);
    const r = carry({ routes: sequence(key, busy(status), good(key)), env: retrying });
    expectCleanCarry(r);
    expect(r.routeCalls(key)).toBe(2);
  });

  it.each([6, 28, 35, 52, 56])("a transport error with curl exit %i is retried", (exit) => {
    const key = artifactKey(SIGN, SIG);
    const r = carry({ routes: sequence(key, { transport: exit }, good(key)), env: retrying });
    expectCleanCarry(r);
    expect(r.routeCalls(key)).toBe(2);
  });

  describe("an answer that is final at once is never retried: exactly one call", () => {
    const listingKeys = TARGETS.slice(0, 2);
    const artifactKeys = TARGETS.slice(2);

    describe.each(listingKeys)("%s", (_what, key) => {
      it.each([400, 401, 403, 404, 302])("an HTTP %i fails at once, naming the status", (status) => {
        const r = carry({ routes: sequence(key, { status, body: `{"message":"${status}"}` }, good(key)), env: retrying });
        expectPrepareFailure(r, new RegExp(String(status)));
        expect(output(r.prepare)).not.toMatch(/after \d+ attempts/);
        expect(r.routeCalls(key)).toBe(1);
      });
    });

    describe.each(artifactKeys)("%s", (_what, key) => {
      it.each([401, 403])("an HTTP %i fails at once, naming the status", (status) => {
        const r = carry({ routes: sequence(key, { status, body: `{"message":"${status}"}` }, good(key)), env: retrying });
        expectPrepareFailure(r, new RegExp(String(status)));
        expect(output(r.prepare)).not.toMatch(/after \d+ attempts/);
        expect(r.routeCalls(key)).toBe(1);
      });
    });

    it.each(artifactKeys.slice(0, 2))("a 404 on %s is 'absent' at once, never retried", (_what, key) => {
      const r = carry({ routes: sequence(key, { status: 404, body: '{"message":"404 Not Found"}' }, good(key)), env: retrying });
      expectPrepareFailure(r, /404/);
      expect(r.routeCalls(key)).toBe(1);
    });

    it("a 404 on a carried file is 'absent' at once, never retried: the carry goes on without a carried pair", () => {
      const key = artifactKey(REC, `previous/${MANIFEST}`);
      const r = carry({ routes: sequence(key, { status: 404, body: '{"message":"404 Not Found"}' }, good(key)), env: retrying });
      // The carried signature exists with no carried manifest: its own failure, after exactly one call for the manifest.
      expectPrepareFailure(r, /carried a signature/);
      expect(r.routeCalls(key)).toBe(1);
    });

    it("a body over --max-filesize (curl exit 63) fails at once as over the limit, never retried", () => {
      const key = artifactKey(REC, MANIFEST);
      const r = carry({ routes: sequence(key, { oversize: true }, good(key)), env: retrying });
      expectPrepareFailure(r, /size limit/i);
      expect(output(r.prepare)).toContain(`${API}${key}`);
      expect(output(r.prepare)).not.toMatch(/after \d+ attempts/);
      expect(r.routeCalls(key)).toBe(1);
    });

    it("a job listing over --max-filesize fails at once as over the limit, never retried", () => {
      const key = listingKey(1);
      const r = carry({ routes: sequence(key, { oversize: true }, good(key)), env: retrying });
      expectPrepareFailure(r, /size limit/i);
      expect(output(r.prepare)).not.toMatch(/after \d+ attempts/);
      expect(r.routeCalls(key)).toBe(1);
    });

    it("a chunked body over the byte cap (no length header) fails at once as over the limit, never retried", () => {
      const key = artifactKey(REC, MANIFEST);
      const text = manifest(OLDER);
      const r = carry({ routes: sequence(key, { chunked: true, body: text + " ".repeat(LIMIT + 1 - Buffer.byteLength(text)) }, good(key)), env: retrying });
      expectPrepareFailure(r, /size limit/i);
      expect(output(r.prepare)).toContain(`${API}${key}`);
      expect(output(r.prepare)).not.toMatch(/after \d+ attempts/);
      expect(r.routeCalls(key)).toBe(1);
    });

    it("a chunked signature over the byte cap fails at once as over the limit, never retried", () => {
      const key = artifactKey(SIGN, SIG);
      const r = carry({ routes: sequence(key, { chunked: true, body: own.sig + "\n".repeat(LIMIT + 1 - Buffer.byteLength(own.sig)) }, good(key)), env: retrying });
      expectPrepareFailure(r, /size limit/i);
      expect(output(r.prepare)).not.toMatch(/after \d+ attempts/);
      expect(r.routeCalls(key)).toBe(1);
    });
  });

  describe("the pause between attempts is ORBIT_CARRY_RETRY_SECONDS", () => {
    const timedPrepare = (answers, seconds) => {
      const key = artifactKey(REC, MANIFEST);
      const s = start({ routes: sequence(key, ...answers.map((a) => (a === "good" ? good(key) : a))), env: { ORBIT_CARRY_RETRY_SECONDS: seconds } });
      const began = performance.now();
      const result = s.invoke(["--prepare"]);
      return { result, ms: performance.now() - began, calls: s.routeCalls(key) };
    };

    it("one retry waits the number of seconds set (1): the second attempt is not made at once", () => {
      const { result, ms, calls } = timedPrepare([busy(), "good"], "1");
      expect(result.status).toBe(0);
      expect(calls).toBe(2);
      expect(ms).toBeGreaterThanOrEqual(900);
    });

    it("two retries wait twice, between each pair of attempts and not after the last", () => {
      const { result, ms, calls } = timedPrepare([busy(), busy(), "good"], "1");
      expect(result.status).toBe(0);
      expect(calls).toBe(3);
      expect(ms).toBeGreaterThanOrEqual(1900);
    });
  });

  describe("ORBIT_CARRY_RETRY_SECONDS is digits only and at most 30", () => {
    it.each(["31", "100", "3600", "99999999999"])("%s is rejected, not clamped: --prepare fails naming the variable and the cap", (value) => {
      const r = carry({ routes: world(pair(OLDER)), env: { ORBIT_CARRY_RETRY_SECONDS: value } });
      expectPrepareFailure(r, /ORBIT_CARRY_RETRY_SECONDS/);
      expect(output(r.prepare)).toMatch(/30/);
    });

    it.each(["abc", "1.5", "-5", "10s", "0x10"])("'%s' is not a whole number: --prepare fails naming the variable", (value) => {
      const r = carry({ routes: world(pair(OLDER)), env: { ORBIT_CARRY_RETRY_SECONDS: value } });
      expectPrepareFailure(r, /ORBIT_CARRY_RETRY_SECONDS/);
    });

    it.each(["0", "2", "30"])("%s is within the cap and carries normally", (value) => {
      const r = carry({ routes: world(own), env: { ORBIT_CARRY_RETRY_SECONDS: value } });
      expect(r.prepare.status).toBe(0);
      expect(r.final.status).toBe(0);
      expect(r.previous(MANIFEST).equals(Buffer.from(own.body))).toBe(true);
    });
  });

  it("curl is not asked to retry: no --retry on any call the carry makes", () => {
    const r = carry({ routes: world(own), env: retrying });
    expect(r.calls().length).toBeGreaterThan(0);
    for (const argv of r.calls()) expect(argv.filter((arg) => arg.startsWith("--retry"))).toEqual([]);
  });

  it("the carry script has no --retry in its code (comments aside)", () => {
    const code = readFileSync(script, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/--retry/);
  });
});

describe("an empty signature and a verifier that fails without a verdict (#1607 note 48797, Lows)", () => {
  const gap = `main ${REC} key rotated, the predecessor's artifacts expired\n`;
  const ACCEPTED = /gap accepted/i;

  // An empty signature is the carry's own failure, found before the verifier runs.
  it.each([
    ["the predecessor's signature", () => ({ ...world(pair(OLDER)), [artifactKey(SIGN, SIG)]: { body: "" } }), 0],
    ["the carried signature", () => ({ ...world(pair(OLDER), pair(THIRD)), [artifactKey(REC, `previous/${SIG}`)]: { body: "" } }), 1],
  ])("%s empty fails as its own error, never a verdict, with or without a matching gap line", (_what, routes, verified) => {
    for (const withGap of [false, true]) {
      const r = carry({ routes: routes(), ...(withGap ? { gap } : {}) });
      expectPrepareFailure(r, /empty/i);
      expect(output(r.prepare)).toContain(SIG);
      expect(output(r.prepare)).not.toMatch(/does not verify/i);
      expect(output(r.prepare)).not.toMatch(ACCEPTED);
      // The verifier never ran on it: no line of it in the output; cosign saw only the pairs before it.
      expect(output(r.prepare)).not.toContain("verify-release-manifest");
      expect(r.verifications()).toHaveLength(verified);
    }
  });

  // A "full TMPDIR": the verifier's own mktemp (it runs without the job token) fails, so it exits 1 before cosign
  // runs and no cosign status is written. That is a tool failure, never "does not verify", and no gap line excuses it.
  const FULL_TMPDIR = {
    mktemp: `#!/usr/bin/env bash\nif [ -z "\${CI_JOB_TOKEN:-}" ]; then echo "mktemp: failed to create file: No space left on device" >&2; exit 1; fi\nexec "${spawnSync("bash", ["-c", "command -v mktemp"], { encoding: "utf8", ...processGuard() }).stdout.trim()}" "$@"\n`,
  };

  it.each([false, true])("a verifier exit 1 with no cosign status (matching gap line: %s) fails as a tool failure, not excused", (withGap) => {
    const r = carry({ routes: world(pair(OLDER)), shims: FULL_TMPDIR, ...(withGap ? { gap } : {}) });
    expectPrepareFailure(r, /tooling failure, not a verdict/i);
    expect(output(r.prepare)).not.toMatch(/does not verify/i);
    expect(output(r.prepare)).not.toMatch(ACCEPTED);
    // cosign never ran: the verifier failed before it.
    expect(r.verifications()).toEqual([]);
  });
});

describe("scripts/ci/carry-accepted-gap says what a line never excuses (#1607 note 48797, Low)", () => {
  it("its header says a line never excuses a carried previous/ pair or a tooling failure", () => {
    const header = readFileSync(join(repoRoot, "scripts", "ci", "carry-accepted-gap"), "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("#"))
      .map((line) => line.replace(/^\s*#\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(header).toMatch(/never[^.]*carried previous\/ pair[^.]*tooling failure/i);
  });
});
