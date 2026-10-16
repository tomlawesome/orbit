import { describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import { buildDiscoveryUrl, classifyOidcFetchResult, validateDiscoveryDocument } from "./oidc-discovery";

// Parity between scripts/install.sh's OIDC discovery handling and this
// module's pure functions (issue #295 slice 3), against what the bash
// produced, captured from 9757e42f before #1212 deleted it
// (src/lib/__fixtures__/README.md). Golden-file characterization: the
// fixtures are bash's, never regenerated from this module.
//
//  1. `oidc_discovery_parser` (the JS install.sh ran in a sandboxed
//     container, guarantee #27): its exit code per document, compared with
//     validateDiscoveryDocument.
//  2. `verify_oidc_discovery`, run as bash against a stub `curl` (answering
//     from the case's `curl` entry; a URL with no entry got exit 6 and
//     status "000") and a stub `docker` (exiting `dockerExitCode`). Each
//     golden records the URLs bash requested and its reason/action/message.
//     The engine's orchestration is not compared here; only the pure
//     buildDiscoveryUrl and classifyOidcFetchResult are. Goldens with no
//     engine assertion yet are kept for when the orchestration is compared
//     again (listed in the fixtures README).

const FLOW = "oidc-discovery";

interface ParserGolden {
  cases: Array<{ name: string; issuer: string; document?: string; oversizedLength?: number; bash: { exitCode: number } }>;
}

interface VerifyGolden {
  name: string;
  envOrbit: string;
  issuer: string | null;
  curl: { curlExitCode: number; httpStatus: string; body?: string; oversizedBodyLength?: number } | null;
  dockerExitCode: number;
  symlinkedDestination?: boolean;
  bash: {
    status: number;
    stdout: string;
    stderr: string;
    requestedUrls: string[];
    failure: { reason: string; action: string; message: string } | null;
  };
}

/** What the capture-time stub curl answered for a URL with no scenario entry. */
const STUB_CURL_NO_ENTRY = { curlExitCode: 6, httpStatus: "000" };

describe("oidc_discovery_parser parity, guarantee #27 (golden)", () => {
  const parser = readGolden<ParserGolden>(FLOW, "oidc discovery parser");

  it("has every captured document", () => {
    expect(parser.cases.length).toBe(10);
  });

  for (const testCase of parser.cases) {
    it(`agrees: ${testCase.name}`, () => {
      const document = testCase.document ?? "x".repeat(testCase.oversizedLength ?? 0);
      expect(validateDiscoveryDocument(testCase.issuer, document)).toBe(testCase.bash.exitCode === 0);
    });
  }
});

// Where bash stopped, by case: at the fetch (curl's exit code or HTTP
// status decided), or after a fetch that passed (the on-disk file checks or
// the sandboxed validator decided, or nothing failed).
const FETCH_DECIDED = [
  "curl exit 63 max filesize exceeded",
  "curl exit 7 unreachable provider",
  "HTTP 500 response",
  "issuer with trailing slash",
];
const FETCH_PASSED = [
  "valid discovery response succeeds",
  "symlinked destination refused",
  "oversized on-disk file refused",
  "sandboxed validator rejects document",
];
// Decided before any fetch; no pure function covers it yet.
const NO_FETCH = ["OIDC_ISSUER missing"];

function verifyGolden(name: string): VerifyGolden {
  return readGolden<VerifyGolden>(FLOW, `verify ${name}`);
}

describe("verify_oidc_discovery: the discovery URL (golden)", () => {
  for (const name of [...FETCH_DECIDED, ...FETCH_PASSED]) {
    it(`agrees: ${name}`, () => {
      const golden = verifyGolden(name);
      expect(golden.bash.requestedUrls).toEqual([buildDiscoveryUrl(golden.issuer ?? "")]);
    });
  }

  for (const name of NO_FETCH) {
    it(`bash requested nothing: ${name}`, () => {
      expect(verifyGolden(name).bash.requestedUrls).toEqual([]);
    });
  }
});

describe("verify_oidc_discovery: fetch classification (golden)", () => {
  for (const name of FETCH_DECIDED) {
    it(`agrees: ${name}`, () => {
      const golden = verifyGolden(name);
      expect(golden.bash.status).toBe(1);
      const result = classifyOidcFetchResult(golden.curl ?? STUB_CURL_NO_ENTRY);
      expect(result).toEqual({ status: "failed", ...golden.bash.failure });
    });
  }

  for (const name of FETCH_PASSED) {
    it(`passes the fetch like bash did: ${name}`, () => {
      const golden = verifyGolden(name);
      expect(golden.curl).not.toBeNull();
      expect(classifyOidcFetchResult(golden.curl ?? STUB_CURL_NO_ENTRY)).toBeNull();
    });
  }
});
