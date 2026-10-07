/* Types for engine-docker-shim.mjs, so TypeScript tests under src/ can use the same fake docker. */
export function writeEngineDockerShim(
  binDir: string,
  options?: { imagePresent?: boolean; pullSucceeds?: boolean; rootless?: boolean },
): string;
