import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/ci/verify-validation-evidence.sh is the one shared verifier every
 * publishing hop runs before giving a validated digest a consumer-visible
 * name (#661). Each refusal path here is driven with a crafted input and
 * asserted by its *specific message and exit code*, never merely a non-zero
 * exit: an untested failure path is how #659 and ai/orbit-base-image#3 both
 * shipped, and #877 will be held to the same standard when it wires
 * promote_stable to this script.
 *
 * cosign is stubbed on PATH (the scripts/promote-stable.test.mjs pattern):
 * the stub stands in for signature verification only -- everything after
 * "cosign says these envelopes verified" is the real script judging real
 * crafted payloads.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ci/verify-validation-evidence.sh", import.meta.url).pathname;
const attestScript = new URL("./ci/attest-tested-image.sh", import.meta.url).pathname;

const PREDICATE_TYPE = "https://tomlawson.io/attestations/orbit-validation/v1";
const IMAGE = "registry.tomlawson.io/ai/orbit";
const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const POLICY = `sha256:${"3".repeat(64)}`;
const OTHER_POLICY = `sha256:${"4".repeat(64)}`;

const COSIGN_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "# cosign is a Cobra CLI: an unknown subcommand and an unknown flag both exit",
  "# 1, printing `unknown command \"x\" for \"cosign\"` / `unknown flag: --x`.",
  "# Checked against the pinned cosign v3.1.3 binary on 2026-09-08",
  "# (scripts/ci/ensure-cosign.sh names the pin); scripts/tool-parity.test.mjs",
  "# re-asserts it whenever a cosign of that version is on PATH. Before #616",
  "# this stub answered every subcommand and every flag alike, so the caller",
  "# could have grown a flag cosign has never had and stayed green.",
  "refuse() {",
  "  printf 'Error: %s\\n' \"$1\" >&2",
  "  printf 'error during command execution: %s\\n' \"$1\" >&2",
  "  exit 1",
  "}",
  "printf 'cosign\\x1f%s\\x1e' \"$*\" >> \"$STUB_LOG\"",
  '[ "${1:-}" = "verify-attestation" ] || refuse "unknown command \\"${1:-}\\" for \\"cosign\\""',
  "shift",
  '# scripts/ci/verify-validation-evidence.sh issues exactly --key, --type and',
  '# --insecure-ignore-tlog=true, then the subject. Anything else is a drift',
  '# this stub must refuse rather than absorb.',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --key)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: $1"',
  "      shift 2",
  "      ;;",
  '    --type)',
  '      [ "$#" -ge 2 ] || refuse "flag needs an argument: $1"',
  '      verify_type="$2"',
  "      shift 2",
  "      ;;",
  '    --insecure-ignore-tlog|--insecure-ignore-tlog=*)',
  '      case "$1" in *=*) shift ;; *) shift 2 ;; esac',
  "      ;;",
  '    --*) refuse "unknown flag: ${1%%=*}" ;;',
  "    *) shift ;;",
  "  esac",
  "done",
  'if [ -n "${STUB_COSIGN_FAIL:-}" ]; then',
  "  printf '%s\\n' \"$STUB_COSIGN_FAIL\" >&2",
  "  exit 1",
  "fi",
  '# D-S6 43a: the SBOM is verified with a second call, --type spdxjson, which',
  '# prints one DSSE line per verified SBOM attestation (cosign 3.1.4); with',
  '# none it fails like cosign does.',
  'if [ "${verify_type:-}" = "spdxjson" ]; then',
  '  [ -s "${STUB_COSIGN_SBOM_OUTPUT:-/nonexistent}" ] || refuse "no matching attestations: none of the attestations match the predicate type: spdxjson"',
  '  cat "$STUB_COSIGN_SBOM_OUTPUT"',
  "  exit 0",
  "fi",
  'cat "$STUB_COSIGN_OUTPUT"',
  "exit 0",
  "",
].join("\n");

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** One verified DSSE envelope line, the shape `cosign verify-attestation` prints. */
function envelope({
  subjectDigest = DIGEST,
  imageDigest = DIGEST,
  commit = COMMIT,
  ref = "preview",
  pipelineId = 4242,
  pipelineUrl = "https://gitlab.tomlawson.io/ai/orbit/-/pipelines/4242",
  policyVersion = POLICY,
  recordedAt = isoDaysAgo(0),
  sbomSha256 = undefined,
  predicateType = PREDICATE_TYPE,
  predicateOverride = null,
} = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType,
    subject: [{ name: IMAGE, digest: { sha256: subjectDigest.replace(/^sha256:/u, "") } }],
    predicate: predicateOverride ?? {
      commit,
      ref,
      pipelineId,
      pipelineUrl,
      imageDigest,
      policyVersion,
      recordedAt,
      ...(sbomSha256 === undefined ? {} : { sbomSha256 }),
    },
  };
  return JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ keyid: "", sig: "c3R1Yg==" }],
  });
}

const SPDX_TYPE = "https://spdx.dev/Document";

/** One verified spdxjson DSSE line: an in-toto statement whose predicate is the SPDX document. */
function sbomEnvelope({ document, created, subjectDigest = DIGEST, predicateType = SPDX_TYPE } = {}) {
  const doc = document ?? { spdxVersion: "SPDX-2.3", name: "orbit", creationInfo: { created } };
  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType,
    subject: [{ name: IMAGE, digest: { sha256: subjectDigest.replace(/^sha256:/u, "") } }],
    predicate: doc,
  };
  return JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ keyid: "", sig: "c3R1Yg==" }],
  });
}

function run({ lines = [envelope()], sbomLines = null, cosignFail = null, env = {}, withOutput = false, scriptPath = script } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-evidence-"));
  const cosign = join(dir, "cosign");
  writeFileSync(cosign, COSIGN_STUB);
  chmodSync(cosign, 0o755);
  const outputFile = join(dir, "cosign-output");
  writeFileSync(outputFile, lines.join("\n") + (lines.length ? "\n" : ""));
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const publicKey = join(dir, "cosign.pub");
  writeFileSync(publicKey, "-----BEGIN PUBLIC KEY-----\nTEST-NOT-A-REAL-KEY\n-----END PUBLIC KEY-----\n");
  const sbomOutputFile = join(dir, "cosign-sbom-output");
  if (sbomLines !== null) writeFileSync(sbomOutputFile, sbomLines.join("\n") + (sbomLines.length ? "\n" : ""));
  const githubOutput = join(dir, "github-output");
  if (withOutput) writeFileSync(githubOutput, "");

  const result = failOnProcessDeadline(
    spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ORBIT_IMAGE: IMAGE,
        ORBIT_DIGEST: DIGEST,
        ORBIT_COMMIT: COMMIT,
        ORBIT_REF: "preview",
        ORBIT_POLICY_VERSION: POLICY,
        ORBIT_COSIGN: cosign,
        COSIGN_PUBLIC_KEY: publicKey,
        STUB_LOG: logFile,
        STUB_COSIGN_OUTPUT: outputFile,
        STUB_COSIGN_SBOM_OUTPUT: sbomOutputFile,
        ...(cosignFail ? { STUB_COSIGN_FAIL: cosignFail } : {}),
        ...(withOutput ? { GITHUB_OUTPUT: githubOutput } : {}),
        ...env,
      },
      ...processGuard(),
    }),
    { label: "verify-validation-evidence" },
  );
  const calls = () =>
    readFileSync(logFile, "utf8")
      .split("\x1e")
      .filter(Boolean)
      .map((call) => call.split("\x1f").filter(Boolean));
  const output = () => (withOutput ? readFileSync(githubOutput, "utf8") : "");
  return { result, calls, output };
}

describe("verify-validation-evidence.sh", () => {
  it("accepts one fresh matching attestation and reports what it accepted", () => {
    const { result, calls, output } = run({ withOutput: true });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`accepted ${DIGEST}`);
    expect(result.stdout).toContain(`commit ${COMMIT}`);
    expect(result.stdout).toContain(`policy ${POLICY}`);
    expect(output()).toContain("pipeline_url=https://gitlab.tomlawson.io/ai/orbit/-/pipelines/4242");
    expect(output()).toContain(`policy_version=${POLICY}`);
    // The verification cosign was asked for: committed key, expected type,
    // no transparency log (the attestor signs without uploading to one), and
    // the exact digest -- never a tag.
    const [cosignCall] = calls();
    expect(cosignCall[1]).toContain("verify-attestation");
    expect(cosignCall[1]).toContain(`--type ${PREDICATE_TYPE}`);
    expect(cosignCall[1]).toContain("--insecure-ignore-tlog=true");
    expect(cosignCall[1]).toContain(`${IMAGE}@${DIGEST}`);
  });

  // D-S6 43a (#1848): the SBOM is attested itself (cosign --type spdxjson),
  // so the verifier no longer binds a file to an sbomSha256. Given an output
  // path in ORBIT_SBOM_OUT it verifies the SBOM attestations over the digest
  // (a second cosign call, --type spdxjson), takes the one with the newest
  // signed SPDX creationInfo.created, and writes that SPDX document, verified,
  // to the path for publishing. Callers that set no ORBIT_SBOM_OUT
  // (countersign, promote-stable) are unchanged. Refusals: no SBOM attestation
  // or a missing/unparseable created is exit 11 (missing); two different
  // documents at the same instant is exit 12 (ambiguous), naming both digests.
  describe("the SBOM attestation (D-S6 43a)", () => {
    const OLD = { spdxVersion: "SPDX-2.3", name: "older", creationInfo: { created: "2026-11-01T10:00:00Z" } };
    const NEW = { spdxVersion: "SPDX-2.3", name: "newer", creationInfo: { created: "2026-11-01T11:30:00Z" } };
    // The output path has to be known before the run, so it is built here and passed in.
    const withOut = (options) => {
      const dir = mkdtempSync(join(tmpdir(), "verify-sbom-out-"));
      const out = join(dir, "image.spdx.json");
      const r = run({ ...options, env: { ...(options.env ?? {}), ORBIT_SBOM_OUT: out } });
      return { ...r, out, written: () => (existsSync(out) ? readFileSync(out, "utf8") : null) };
    };

    it("writes the SPDX document of a single SBOM attestation, verified, to ORBIT_SBOM_OUT", () => {
      const { result, written } = withOut({ sbomLines: [sbomEnvelope({ document: NEW })] });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(written())).toEqual(NEW);
    });

    it("asks cosign for the SBOM with the committed key, --type spdxjson and the exact digest", () => {
      const { calls } = withOut({ sbomLines: [sbomEnvelope({ document: NEW })] });
      const sbomCall = calls().map((call) => call[1]).find((call) => /--type spdxjson(\s|$)/u.test(call));
      expect(sbomCall, "a verify-attestation --type spdxjson call").toBeDefined();
      expect(sbomCall).toContain("verify-attestation");
      expect(sbomCall).toContain("--key ");
      expect(sbomCall).toContain("--insecure-ignore-tlog=true");
      expect(sbomCall).toContain(`${IMAGE}@${DIGEST}`);
    });

    for (const order of ["older first", "newer first"]) {
      it(`picks the attestation with the newer created, ${order}`, () => {
        const lines = [sbomEnvelope({ document: OLD }), sbomEnvelope({ document: NEW })];
        const { result, written } = withOut({ sbomLines: order === "older first" ? lines : lines.reverse() });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(JSON.parse(written())).toEqual(NEW);
      });
    }

    for (const order of ["first", "last"]) {
      it(`compares created as instants, not text: a lexically larger +02:00 stamp that is earlier loses (${order})`, () => {
        // 12:00+02:00 is 10:00Z, earlier than 11:00Z although the string sorts later.
        const early = { spdxVersion: "SPDX-2.3", name: "early", creationInfo: { created: "2026-11-01T12:00:00+02:00" } };
        const late = { spdxVersion: "SPDX-2.3", name: "late", creationInfo: { created: "2026-11-01T11:00:00Z" } };
        const lines = order === "first" ? [sbomEnvelope({ document: early }), sbomEnvelope({ document: late })] : [sbomEnvelope({ document: late }), sbomEnvelope({ document: early })];
        const { result, written } = withOut({ sbomLines: lines });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(written())).toEqual(late);
      });
    }

    it("accepts two byte-identical documents at the same instant, in either order", () => {
      const { result, written } = withOut({ sbomLines: [sbomEnvelope({ document: NEW }), sbomEnvelope({ document: NEW })] });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(written())).toEqual(NEW);
    });

    it("refuses (ambiguous, exit 12) different documents at the same instant, naming both digests, writing nothing", () => {
      const a = { ...NEW, name: "one" };
      const b = { ...NEW, name: "two" };
      for (const lines of [[a, b], [b, a]]) {
        const { result, written } = withOut({ sbomLines: lines.map((document) => sbomEnvelope({ document })) });
        expect(result.status, result.stderr).toBe(12);
        expect(result.stderr).toContain("refused (ambiguous)");
        expect(result.stderr).toMatch(/SBOM/u);
        // Both documents' digests (sha256, 64 hex) are named, and they differ.
        const named = new Set(result.stderr.match(/\b[0-9a-f]{64}\b/gu) ?? []);
        expect(named.size).toBeGreaterThanOrEqual(2);
        expect(written()).toBeNull();
      }
    });

    it("treats the same instant written with different offsets as the same instant", () => {
      const a = { ...NEW, name: "one", creationInfo: { created: "2026-11-01T11:30:00Z" } };
      const b = { ...NEW, name: "two", creationInfo: { created: "2026-11-01T13:30:00+02:00" } };
      const { result, written } = withOut({ sbomLines: [a, b].map((document) => sbomEnvelope({ document })) });
      expect(result.status, result.stderr).toBe(12);
      expect(written()).toBeNull();
    });

    for (const [label, creationInfo] of [
      ["no creationInfo", undefined],
      ["no created", {}],
      ["a non-string created", { created: 20261101 }],
      ["an unparseable created", { created: "yesterday" }],
      ["a date without a time", { created: "2026-11-01" }],
      ["an empty created", { created: "" }],
    ]) {
      it(`refuses (missing, exit 11) an SBOM with ${label}, writing nothing`, () => {
        const bad = { spdxVersion: "SPDX-2.3", name: "bad", ...(creationInfo === undefined ? {} : { creationInfo }) };
        const { result, written } = withOut({ sbomLines: [sbomEnvelope({ document: bad })] });
        expect(result.status, result.stderr).toBe(11);
        expect(result.stderr).toContain("refused (missing)");
        expect(result.stderr).toContain("creationInfo.created");
        expect(written()).toBeNull();
      });
    }

    it("refuses when any one of several SBOM attestations has a bad created, even if another is fine", () => {
      const bad = { spdxVersion: "SPDX-2.3", name: "bad", creationInfo: { created: "nope" } };
      const { result, written } = withOut({ sbomLines: [sbomEnvelope({ document: NEW }), sbomEnvelope({ document: bad })] });
      expect(result.status).toBe(11);
      expect(written()).toBeNull();
    });

    it("refuses (missing, exit 11) when no SBOM attestation verifies, naming the SBOM", () => {
      const { result, written } = withOut({ sbomLines: null });
      expect(result.status).toBe(11);
      expect(result.stderr).toContain("refused (missing)");
      expect(result.stderr).toMatch(/SBOM/u);
      expect(written()).toBeNull();
    });

    it("refuses (missing, exit 11) when cosign prints no SBOM lines at all", () => {
      const { result, written } = withOut({ sbomLines: [] });
      expect(result.status).toBe(11);
      expect(result.stderr).toMatch(/SBOM/u);
      expect(written()).toBeNull();
    });

    it("refuses (missing, exit 11) an SBOM payload that is not decodable in-toto JSON", () => {
      const { result, written } = withOut({ sbomLines: ["not json"] });
      expect(result.status).toBe(11);
      expect(written()).toBeNull();
    });

    it("does not count a verified attestation of another predicate type as an SBOM", () => {
      const other = sbomEnvelope({ document: NEW, predicateType: "https://example.com/other/v1" });
      const { result, written } = withOut({ sbomLines: [other] });
      expect(result.status).toBe(11);
      expect(written()).toBeNull();
    });

    it("still applies every validation check first and writes nothing when one refuses", () => {
      const { result, written } = withOut({
        lines: [envelope({ commit: OTHER_COMMIT })],
        sbomLines: [sbomEnvelope({ document: NEW })],
      });
      expect(result.status).toBe(10);
      expect(result.stderr).toContain("evidence is for commit");
      expect(written()).toBeNull();
    });

    it("ignores any sbomSha256 in an old record: it no longer binds or refuses anything", () => {
      const { result, written } = withOut({
        lines: [envelope({ sbomSha256: "f".repeat(64) })],
        sbomLines: [sbomEnvelope({ document: NEW })],
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(written())).toEqual(NEW);
    });

    it("refuses (mismatch, exit 10) an SBOM attestation whose subject is another digest, naming both, writing nothing (D-S6 43a addendum 1)", () => {
      const { result, written } = withOut({ sbomLines: [sbomEnvelope({ document: NEW, subjectDigest: OTHER_DIGEST })] });
      expect(result.status, result.stderr).toBe(10);
      expect(result.stderr).toContain("refused (mismatch)");
      expect(result.stderr).toContain(OTHER_DIGEST);
      expect(result.stderr).toContain(DIGEST);
      expect(written()).toBeNull();
    });

    it("refuses a wrong-subject SBOM even when a right-subject one is also verified, writing nothing", () => {
      const { result, written } = withOut({
        sbomLines: [sbomEnvelope({ document: OLD }), sbomEnvelope({ document: NEW, subjectDigest: OTHER_DIGEST })],
      });
      expect(result.status, result.stderr).toBe(10);
      expect(written()).toBeNull();
    });

    // Bounded reads (D-S6 43a addendum 3). The fakes are shell scripts that
    // generate their output on the fly, so no large fixture is kept on disk.
    it("logs the sha256 of exactly the bytes it writes to ORBIT_SBOM_OUT, so it equals sha256sum of the file (D-S6 43a addendum 2)", () => {
      const { result, written, out } = withOut({ sbomLines: [sbomEnvelope({ document: NEW })] });
      expect(result.status, result.stderr).toBe(0);
      const logged = /SBOM sha256 ([0-9a-f]{64})\b/u.exec(result.stdout)?.[1];
      expect(logged).toBeDefined();
      const fileSha = createHash("sha256").update(readFileSync(out)).digest("hex");
      expect(written()).not.toBeNull();
      expect(logged).toBe(fileSha);
    });

    describe("bounded reads", () => {
      const MAX_SBOM_BYTES = 64 * 1024 * 1024;
      const fakeCosign = (spdxBody) => {
        const dir = mkdtempSync(join(tmpdir(), "verify-fake-cosign-"));
        const path = join(dir, "cosign");
        writeFileSync(
          path,
          ["#!/usr/bin/env bash", 'case "$*" in', "  *spdxjson*)", `    ${spdxBody}`, "    ;;", "  *) cat \"$STUB_COSIGN_OUTPUT\" ;;", "esac", ""].join("\n"),
        );
        chmodSync(path, 0o755);
        return path;
      };

      it("refuses (missing, exit 11) a cosign SBOM output larger than 64 MiB, before parsing it, writing nothing", () => {
        const cosign = fakeCosign(`head -c ${MAX_SBOM_BYTES + 1} /dev/zero`);
        const { result, written } = withOut({ env: { ORBIT_COSIGN: cosign } });
        expect(result.status, result.stderr.slice(0, 500)).toBe(11);
        expect(result.stderr).toContain("refused (missing)");
        expect(result.stderr).toMatch(/SBOM/u);
        // Refused for its size, not merely for being undecodable.
        expect(result.stderr).toMatch(/64 ?MiB|67108864|too large|larger than|exceeds|size limit/iu);
        expect(written()).toBeNull();
      });

      // The validation path gets the same limit (#1862). The fake prints the
      // real envelope for the validation call, then pads or generates bytes on
      // the fly; a node stub on PATH records any attempt to parse.
      describe("the validation path (#1862)", () => {
        const nodeStub = () => {
          const dir = mkdtempSync(join(tmpdir(), "verify-fake-node-"));
          const log = join(dir, "node.log");
          writeFileSync(join(dir, "node"), `#!/usr/bin/env bash\necho called >> '${log}'\nexit 99\n`);
          chmodSync(join(dir, "node"), 0o755);
          return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0) };
        };
        // A cosign whose validation call (no spdxjson in its arguments) runs `body`.
        const validationCosign = (body) => {
          const dir = mkdtempSync(join(tmpdir(), "verify-fake-cosign-"));
          const path = join(dir, "cosign");
          writeFileSync(path, ["#!/usr/bin/env bash", 'case "$*" in', "  *spdxjson*) exit 1 ;;", `  *) ${body} ;;`, "esac", ""].join("\n"));
          chmodSync(path, 0o755);
          return path;
        };
        // The envelope line, a newline, then spaces (blank to the parser) up to `total` bytes.
        const paddedCosign = (total) => {
          const pad = total - Buffer.byteLength(`${envelope()}\n`);
          return validationCosign(`cat "$STUB_COSIGN_OUTPUT"; head -c ${pad} /dev/zero | tr '\\0' ' '`);
        };

        it("refuses (missing, exit 11) a validation cosign output larger than 64 MiB, before parsing it, with no node parse attempted", () => {
          const node = nodeStub();
          const cosign = paddedCosign(MAX_SBOM_BYTES + 1);
          const { result } = run({ env: { ORBIT_COSIGN: cosign, PATH: `${node.dir}:${process.env.PATH}` } });
          expect(result.status, result.stderr.slice(0, 500)).toBe(11);
          expect(result.stderr).toContain("refused (missing)");
          expect(result.stderr).toMatch(/64 ?MiB|67108864|too large|larger than|exceeds|size limit/iu);
          expect(result.stderr).toMatch(/validation/iu);
          expect(node.calls()).toBe(0);
        });

        it("refuses a validation cosign output of unparseable garbage over 64 MiB for its size, not for being undecodable", () => {
          const cosign = validationCosign(`head -c ${MAX_SBOM_BYTES + 1} /dev/zero`);
          const { result } = run({ env: { ORBIT_COSIGN: cosign } });
          expect(result.status, result.stderr.slice(0, 500)).toBe(11);
          expect(result.stderr).toMatch(/64 ?MiB|67108864|too large|larger than|exceeds|size limit/iu);
          expect(result.stderr).not.toContain("not decodable");
        });

        it("accepts a validation cosign output of exactly 64 MiB", () => {
          const cosign = paddedCosign(MAX_SBOM_BYTES);
          const { result } = run({ env: { ORBIT_COSIGN: cosign } });
          expect(result.stderr).toBe("");
          expect(result.status).toBe(0);
          expect(result.stdout).toContain(`accepted ${DIGEST}`);
        });
      });

      it("lists the validation output's 64 MiB refusal in the script's header of refusals", () => {
        const header = readFileSync(script, "utf8").split("\nset -Eeuo pipefail")[0];
        expect(header).toMatch(/validation[^.]{0,80}(output|read)[^.]{0,80}64 MiB|64 MiB[^.]{0,80}validation/iu);
      });

      it("cuts the cosign stderr echoed on a validation refusal to at most 4096 bytes (D-S6 43a addendum 2)", () => {
        const cosign = fakeCosign("exit 0");
        // The validation call (no spdxjson in its arguments) fails with 200000 bytes of stderr.
        writeFileSync(
          cosign,
          ["#!/usr/bin/env bash", 'case "$*" in', "  *spdxjson*) exit 0 ;;", "esac", "head -c 200000 /dev/zero | tr '\\0' 'Z' >&2; echo >&2; exit 1", ""].join("\n"),
        );
        const { result, written } = withOut({ env: { ORBIT_COSIGN: cosign } });
        expect(result.status, result.stderr.slice(0, 500)).toBe(11);
        expect(result.stderr).toContain("refused (missing)");
        expect(result.stderr).toContain("no verifiable validation attestation");
        const zs = Buffer.byteLength(result.stderr.replace(/[^Z]/gu, ""));
        expect(zs).toBeGreaterThan(0);
        expect(zs).toBeLessThanOrEqual(4096);
        expect(written()).toBeNull();
      });

      it("cuts the cosign stderr echoed on an SBOM refusal to at most 4096 bytes", () => {
        const cosign = fakeCosign("head -c 200000 /dev/zero | tr '\\0' 'Z' >&2; echo >&2; exit 1");
        const { result, written } = withOut({ env: { ORBIT_COSIGN: cosign } });
        expect(result.status, result.stderr.slice(0, 500)).toBe(11);
        const longestRun = Math.max(0, ...(result.stderr.match(/Z+/gu) ?? []).map((run) => run.length));
        expect(longestRun).toBeGreaterThan(0);
        expect(Buffer.byteLength(result.stderr.replace(/[^Z]/gu, ""))).toBeLessThanOrEqual(4096);
        expect(written()).toBeNull();
      });
    });

    it("without ORBIT_SBOM_OUT makes no SBOM call and needs no SBOM attestation (countersign, promote-stable)", () => {
      const { result, calls } = run({ sbomLines: null });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(calls()).toHaveLength(1);
      expect(calls()[0][1]).toContain(`--type ${PREDICATE_TYPE}`);
    });

    it("no longer reads ORBIT_SBOM_FILE or checks an sbomSha256", () => {
      const source = readFileSync(script, "utf8");
      const codeOnly = source.split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
      expect(codeOnly).not.toContain("ORBIT_SBOM_FILE");
      expect(codeOnly).not.toContain("sbomSha256");
      expect(codeOnly).not.toContain("ORBIT_SBOM_SHA256");
    });
  });

  // 43a: matching validation records are selected from what cosign prints;
  // anything else it printed is ignored and counted in the log, and the
  // ambiguity and mismatch checks run on the matching ones only.
  describe("selecting the validation records (D-S6 43a)", () => {
    const sbomLine = () => sbomEnvelope({ created: "2026-11-01T10:00:00Z" });

    it("ignores attestations of another predicate type, saying how many, and accepts the validation record", () => {
      const { result } = run({ lines: [sbomLine(), envelope(), sbomLine()] });
      expect(result.stderr + result.stdout).toMatch(/ignored 2\b/u);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`accepted ${DIGEST}`);
    });

    it("runs the mismatch checks on the validation records only: another type's subject or content never refuses", () => {
      const foreign = sbomEnvelope({ created: "2026-11-01T10:00:00Z", subjectDigest: OTHER_DIGEST });
      const { result } = run({ lines: [foreign, envelope()] });
      expect(result.status, result.stderr).toBe(0);
    });

    it("refuses (missing, exit 11) when nothing printed is a validation record, however many other attestations there are", () => {
      const { result } = run({ lines: [sbomLine(), sbomLine()] });
      expect(result.status).toBe(11);
      expect(result.stderr).toContain("refused (missing)");
    });

    for (const [field, a, b] of [
      ["commit", {}, { commit: OTHER_COMMIT }],
      ["ref", {}, { ref: "dev" }],
      ["pipeline", {}, { pipelineId: 4243 }],
      ["policy", {}, { policyVersion: OTHER_POLICY }],
    ]) {
      it(`still refuses (ambiguous, exit 12) matching validation records that disagree on ${field}, with SBOM lines mixed in`, () => {
        const { result } = run({ lines: [envelope(a), sbomLine(), envelope(b)] });
        expect(result.status, result.stderr).toBe(12);
        expect(result.stderr).toContain("refused (ambiguous)");
      });
    }
  });

  it("refuses (mismatch, exit 10) evidence naming a different digest", () => {
    const { result } = run({ lines: [envelope({ imageDigest: OTHER_DIGEST })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain(
      `refused (mismatch): evidence names digest ${OTHER_DIGEST}, not the digest being published (${DIGEST})`,
    );
  });

  it("refuses (mismatch, exit 10) an attestation whose subject is another digest", () => {
    const { result } = run({ lines: [envelope({ subjectDigest: OTHER_DIGEST })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain("refused (mismatch)");
    expect(result.stderr).toContain(`not the digest being published (${DIGEST})`);
  });

  it("refuses (mismatch, exit 10) evidence for another commit", () => {
    const { result } = run({ lines: [envelope({ commit: OTHER_COMMIT })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain(
      `refused (mismatch): evidence is for commit ${OTHER_COMMIT}, not the commit being published (${COMMIT})`,
    );
  });

  it("refuses (mismatch, exit 10) evidence for another ref when ORBIT_REF is set", () => {
    const { result } = run({ lines: [envelope({ ref: "dev" })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain(
      "refused (mismatch): evidence is for ref dev, not the ref being published (preview)",
    );
  });

  it("refuses (mismatch, exit 10) evidence judged under an older policy, and says to re-validate", () => {
    const { result } = run({ lines: [envelope({ policyVersion: OTHER_POLICY })] });
    expect(result.status).toBe(10);
    expect(result.stderr).toContain("refused (mismatch): the policy changed since validation");
    expect(result.stderr).toContain(`judged under policy ${OTHER_POLICY}`);
    expect(result.stderr).toContain(`this checkout carries ${POLICY}`);
    expect(result.stderr).toContain("re-validate the digest");
  });

  it("refuses (missing, exit 11) when cosign verifies nothing, and shows cosign's reason", () => {
    const { result } = run({ cosignFail: "no matching attestations: crafted registry error" });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain("cosign: no matching attestations: crafted registry error");
    expect(result.stderr).toContain(
      `refused (missing): no verifiable validation attestation of type ${PREDICATE_TYPE} for ${IMAGE}@${DIGEST}`,
    );
  });

  it("refuses (missing, exit 11) a digest the registry cannot resolve", () => {
    // The registry answering MANIFEST_UNKNOWN and the digest having no
    // attestation are one ground to a publisher: no evidence for this exact
    // digest. Both must land on `missing`, never on a pass.
    const { result } = run({
      cosignFail: "GET https://registry.tomlawson.io/v2/ai/orbit/manifests/sha256:...: MANIFEST_UNKNOWN",
    });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain("cosign: ");
    expect(result.stderr).toContain("MANIFEST_UNKNOWN");
    expect(result.stderr).toContain(
      `refused (missing): no verifiable validation attestation of type ${PREDICATE_TYPE} for ${IMAGE}@${DIGEST}`,
    );
  });

  it("refuses (missing, exit 11) verified attestations of only some other predicate type", () => {
    const { result } = run({
      lines: [envelope({ predicateType: "https://slsa.dev/provenance/v1" })],
    });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain(
      `refused (missing): cosign verified 1 attestation(s) for the digest, but none carries predicate type ${PREDICATE_TYPE}`,
    );
  });

  it("refuses (missing, exit 11) a verified attestation whose predicate is malformed", () => {
    const { result } = run({
      lines: [envelope({ predicateOverride: { commit: COMMIT, recordedAt: "yesterday-ish" } })],
    });
    expect(result.status).toBe(11);
    expect(result.stderr).toContain("refused (missing):");
    expect(result.stderr).toContain("no well-formed");
    expect(result.stderr).toContain("unusable as evidence");
  });

  it("refuses (ambiguous, exit 12) two verified attestations that disagree", () => {
    const { result } = run({
      lines: [envelope({ pipelineId: 4242 }), envelope({ pipelineId: 9999 })],
    });
    expect(result.status).toBe(12);
    expect(result.stderr).toContain(
      "refused (ambiguous): 2 verified attestations make 2 conflicting claims about what was validated",
    );
    expect(result.stderr).toContain("refusing to choose between them");
  });

  it("treats identical claims differing only in recordedAt as one item, newest governing expiry", () => {
    // The older stamp is past the window; the newest is fresh. A retried
    // attesting job must not be read as a conflict, and must not expire the
    // evidence its retry refreshed.
    const { result } = run({
      lines: [envelope({ recordedAt: isoDaysAgo(8) }), envelope({ recordedAt: isoDaysAgo(1) })],
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`accepted ${DIGEST}`);
  });

  it("refuses (expired, exit 13) evidence eight days old, and says to re-validate", () => {
    const stamp = isoDaysAgo(8);
    const { result } = run({ lines: [envelope({ recordedAt: stamp })] });
    expect(result.status).toBe(13);
    expect(result.stderr).toContain(
      `refused (expired): evidence recorded at ${stamp} is older than 7 days; re-validate the digest before publishing`,
    );
  });

  it("refuses (expired, exit 13) evidence stamped in the future", () => {
    const stamp = isoDaysAgo(-1);
    const { result } = run({ lines: [envelope({ recordedAt: stamp })] });
    expect(result.status).toBe(13);
    expect(result.stderr).toContain(
      `refused (expired): evidence recorded at ${stamp} is in the future; refusing evidence from a skewed clock`,
    );
  });

  it("fails closed, naming the file, when the committed public key is absent", () => {
    const { result } = run({ env: { COSIGN_PUBLIC_KEY: "/nonexistent/cosign.pub" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("the validation public key is not at /nonexistent/cosign.pub");
    expect(result.stderr).toContain("without it nothing can be verified");
  });

  it("rejects a malformed digest as misconfiguration, not a refusal", () => {
    const { result } = run({ env: { ORBIT_DIGEST: "sha256:short" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ORBIT_DIGEST is not an immutable manifest digest");
  });

  it("carries the same predicate type as the attestor, so the two cannot drift", () => {
    const constant = (path) =>
      readFileSync(path, "utf8").match(/PREDICATE_TYPE="([^"]+)"/u)?.[1];
    expect(constant(script)).toBe(PREDICATE_TYPE);
    expect(constant(attestScript)).toBe(PREDICATE_TYPE);
  });
});

/*
 * The script takes the digest pattern from scripts/release-metadata-patterns.sh,
 * which it sources itself, so a test cannot empty ORBIT_DIGEST_PATTERN (or
 * ORBIT_DIGEST_SOURCE, which the script derives from it) from outside. These
 * cases drive the real script from a copy of the repository layout whose
 * patterns file defines the digest pattern as empty, or not at all (#1363).
 * An empty pattern matches every string, so without a guard the verifier
 * would accept any digest and any policy version.
 */
describe("verify-validation-evidence.sh without a digest pattern (#1363)", () => {
  const repoRoot = dirname(dirname(dirname(script)));
  const patternsFile = join(repoRoot, "scripts", "release-metadata-patterns.sh");

  /** A copy of the scripts the verifier needs, with the digest pattern line replaced (or dropped when `replacement` is null). */
  function copyWithDigestPattern(replacement) {
    const root = mkdtempSync(join(tmpdir(), "verify-evidence-root-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    cpSync(join(repoRoot, "scripts", "ci"), join(root, "scripts", "ci"), { recursive: true });
    const definition = /^(?:readonly\s+)?ORBIT_DIGEST_PATTERN=.*$/mu;
    const original = readFileSync(patternsFile, "utf8");
    expect(original, "the patterns file defines ORBIT_DIGEST_PATTERN on one line").toMatch(definition);
    writeFileSync(join(root, "scripts", "release-metadata-patterns.sh"), original.replace(definition, replacement ?? ""));
    return join(root, "scripts", "ci", "verify-validation-evidence.sh");
  }

  it("refuses, naming the pattern, when the digest pattern is empty -- never matches everything", () => {
    const { result } = run({ scriptPath: copyWithDigestPattern("ORBIT_DIGEST_PATTERN=''") });
    expect(result.status, `stdout: ${result.stdout}`).not.toBe(0);
    expect(result.stdout).not.toContain("accepted");
    expect(result.stderr).toMatch(/ORBIT_DIGEST_SOURCE|ORBIT_DIGEST_PATTERN|shared (?:digest )?pattern/u);
  });

  it("refuses, naming the pattern, when the digest pattern is not defined at all", () => {
    const { result } = run({ scriptPath: copyWithDigestPattern(null) });
    expect(result.status, `stdout: ${result.stdout}`).not.toBe(0);
    expect(result.stdout).not.toContain("accepted");
    expect(result.stderr).toMatch(/ORBIT_DIGEST_SOURCE|ORBIT_DIGEST_PATTERN|shared (?:digest )?pattern/u);
  });

  it("the unmodified copy still accepts, so the two refusals above come from the pattern alone", () => {
    const original = readFileSync(patternsFile, "utf8");
    const definition = /^(?:readonly\s+)?ORBIT_DIGEST_PATTERN=.*$/mu;
    const { result } = run({ scriptPath: copyWithDigestPattern(original.match(definition)[0]) });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

// D-S6 43a addendum 1, item 5: the docs say what the verifier now does. Matched
// loosely, by key phrases.
describe("docs for the SBOM attestation (D-S6 43a addendum 1)", () => {
  const releasing = readFileSync(new URL("../docs/releasing.md", import.meta.url), "utf8");
  const adrFull = readFileSync(
    new URL("../docs/adr/0020-validation-evidence-binds-digest-and-policy.md", import.meta.url),
    "utf8",
  );
  const start = adrFull.indexOf("### Amendment (2026-11-16, #1848");
  const adr = start === -1 ? "" : adrFull.slice(start);
  for (const [name, text] of [["docs/releasing.md", releasing], ["the ADR-0020 amendment", adr]]) {
    describe(name, () => {
      it("exists", () => {
        expect(text.length).toBeGreaterThan(0);
      });
      it("says a wrong-subject SBOM attestation is refused with exit 10", () => {
        expect(text).toMatch(/subject[\s\S]{0,300}exit 10|exit 10[\s\S]{0,300}subject/iu);
      });
      it("says the logged SBOM sha256 is of the written, re-serialised file, matching sha256sum, not GitLab's image.spdx.json", () => {
        expect(text).toMatch(/sha256sum/u);
        expect(text).toMatch(/re-?serialis/iu);
        expect(text).toMatch(/image\.spdx\.json/u);
        expect(text).toMatch(/ORBIT_SBOM_OUT/u);
      });
      it("says digests attested before 43a have no SBOM attestation, GitHub refuses them, and they must be re-validated on GitLab", () => {
        expect(text).toMatch(/before 43a/iu);
        expect(text).toMatch(/no SBOM attestation/iu);
        expect(text).toMatch(/re-?validate/iu);
        expect(text).toMatch(/GitLab/u);
      });
    });
  }
});
