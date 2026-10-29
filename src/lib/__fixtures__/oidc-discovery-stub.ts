import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeOidcDiscoveryStub } from "../../../scripts/engine-docker-shim.mjs";

// #1454: a spawned `orbit configure` now fetches the OIDC provider's discovery
// document when it is asked for the issuer, and a test has no provider. The
// child is started with the preload scripts/engine-docker-shim.mjs writes,
// which answers every discovery request with the issuer the test names or,
// failing that, the discovery URL minus ".well-known/openid-configuration"
// (so an issuer entered with its trailing slash matches).

/** Environment for a spawned engine whose OIDC discovery requests are answered by the stub. */
export function envWithOidcDiscoveryStub(base: NodeJS.ProcessEnv, publishedIssuer?: string): NodeJS.ProcessEnv {
  const preload = writeOidcDiscoveryStub(mkdtempSync(join(tmpdir(), "orbit-oidc-stub-")));
  return {
    ...base,
    NODE_OPTIONS: [base.NODE_OPTIONS, `--require ${preload}`].filter(Boolean).join(" "),
    ...(publishedIssuer === undefined ? {} : { ORBIT_TEST_OIDC_PUBLISHED_ISSUER: publishedIssuer }),
  };
}
