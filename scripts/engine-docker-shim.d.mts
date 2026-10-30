/* Types for engine-docker-shim.mjs, so TypeScript tests under src/ can use the same fake docker. */
export function writeEngineDockerShim(
  binDir: string,
  options?: { imagePresent?: boolean; pullSucceeds?: boolean; rootless?: boolean; oidcDiscoveryStub?: boolean },
): string;
/** Writes the OIDC discovery stub preload (#1454) into `dir` and returns its path. */
export function writeOidcDiscoveryStub(dir: string): string;
