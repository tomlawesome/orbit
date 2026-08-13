// Image identity resolution (issue #295 slice 5), ported from
// scripts/install.sh's inline digest/revision/version resolution
// (install.sh:1264-1310 — this sequence has no named function of its own,
// unlike every guarantee ported by slices 1-4, so there is nothing for a
// source-extraction parity test to awk out; the exact regex patterns and
// line references below are cited instead, and src/lib/image-resolution.test.ts
// exercises each one against literal fixture values). Guarantee numbers cite
// docs/installer-guarantees.md, Part 1 / install.sh.
//
// This module is pure: it never calls `docker` itself. install.sh's own
// three `docker image inspect` calls and the `docker run --banner` call are
// each a single method on the caller-supplied adapter below (the same "thin
// adapter at the edge" shape every prior slice established) — the production
// implementation is src/lib/install-docker-adapter.ts, shipped this slice.

/** ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ (install.sh:1288). */
const IMMUTABLE_IMAGE_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/;
/** ^[0-9a-f]{40}$ (install.sh:1296). */
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
/** ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ (install.sh:1302). */
const SEMVER_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export type ImageResolutionFailureReason =
  | "pull-failed"
  | "inspect-failed"
  | "digest-not-resolved"
  | "revision-inspect-failed"
  | "revision-invalid"
  | "version-inspect-failed"
  | "version-invalid"
  | "banner-failed";

export interface ImageResolutionFailure {
  status: "failed";
  reason: ImageResolutionFailureReason;
  message: string;
}

export interface ImageIdentity {
  status: "ok";
  /** install.sh's $resolved_reference: "<imageRepository>@sha256:<64 hex>". */
  resolvedReference: string;
  /** install.sh's $revision: the 40-hex source git SHA (guarantee #42). */
  revision: string;
  /** install.sh's $image_version: strict semver (guarantee #43). */
  imageVersion: string;
  /** install.sh's $applied_digest: resolvedReference's own "sha256:<64 hex>" suffix. */
  appliedDigest: string;
}

export type ImageResolutionOutcome = ImageIdentity | ImageResolutionFailure;

function failure(reason: ImageResolutionFailureReason, message: string): ImageResolutionFailure {
  return { status: "failed", reason, message };
}

/**
 * Finds the first `imageRepository@sha256:<64 hex>` line in `docker image
 * inspect`'s `{{range .RepoDigests}}{{println .}}{{end}}` output
 * (install.sh:1278-1288, guarantee #41) and validates it against the same
 * strict pattern install.sh itself checks — the moving channel tag is never
 * what gets returned.
 */
export function resolveRepoDigest(imageRepository: string, repoDigestsOutput: string): string | undefined {
  const prefix = `${imageRepository}@sha256:`;
  let resolved = "";
  for (const candidate of repoDigestsOutput.split("\n")) {
    if (candidate.startsWith(prefix)) {
      resolved = candidate;
      break;
    }
  }
  return IMMUTABLE_IMAGE_PATTERN.test(resolved) ? resolved : undefined;
}

/** validates a `docker image inspect` revision label against guarantee #42's 40-hex pattern. */
export function validateRevisionLabel(revisionLabel: string): string | undefined {
  return REVISION_PATTERN.test(revisionLabel) ? revisionLabel : undefined;
}

/** validates a `docker image inspect` version label against guarantee #43's strict semver pattern. */
export function validateVersionLabel(versionLabel: string): string | undefined {
  return SEMVER_PATTERN.test(versionLabel) ? versionLabel : undefined;
}

export interface ImageIdentityAdapter {
  /** docker pull --quiet "<imageRepository>:<channel>" (install.sh:1268-1269). Returns whether the pull succeeded. */
  pull(imageRepository: string, channel: string): boolean;
  /** docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "<imageRepository>:<channel>" (install.sh:1271-1272). Null on any inspect failure. */
  inspectRepoDigests(imageRepository: string, channel: string): string | null;
  /** docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' <resolvedReference> (install.sh:1295). Null on any inspect failure. */
  inspectRevisionLabel(resolvedReference: string): string | null;
  /** docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' <resolvedReference> (install.sh:1301). Null on any inspect failure. */
  inspectVersionLabel(resolvedReference: string): string | null;
  /** docker run --rm --entrypoint /opt/orbit/scripts/container-entrypoint.sh <resolvedReference> --banner (install.sh:1306-1310, guarantee #44). */
  runBanner(resolvedReference: string): boolean;
}

/**
 * resolveImageIdentity (install.sh:1264-1310): resolves the requested
 * channel to an immutable digest, reads the source revision (#42) and
 * semantic version (#43) OCI labels off the resolved image, and requires the
 * image's own entrypoint to actually render its banner (#44) before any
 * deployment asset is fetched or written — a digest that pulls but can't
 * execute its own entrypoint is rejected up front.
 */
export function resolveImageIdentity(
  imageRepository: string,
  channel: string,
  adapter: ImageIdentityAdapter,
): ImageResolutionOutcome {
  if (!adapter.pull(imageRepository, channel)) {
    return failure(
      "pull-failed",
      `Could not pull ${imageRepository}:${channel}. If the image is private, authenticate with the registry first.`,
    );
  }

  const repoDigestsOutput = adapter.inspectRepoDigests(imageRepository, channel);
  if (repoDigestsOutput === null) {
    return failure("inspect-failed", `Could not inspect ${imageRepository}:${channel} to resolve an immutable digest.`);
  }
  const resolvedReference = resolveRepoDigest(imageRepository, repoDigestsOutput);
  if (resolvedReference === undefined) {
    return failure(
      "digest-not-resolved",
      `The registry did not return an immutable digest for ${imageRepository}:${channel}.`,
    );
  }

  const revisionLabel = adapter.inspectRevisionLabel(resolvedReference);
  if (revisionLabel === null) {
    return failure("revision-inspect-failed", `Could not inspect ${resolvedReference} for its source revision.`);
  }
  const revision = validateRevisionLabel(revisionLabel);
  if (revision === undefined) {
    return failure("revision-invalid", "The published image does not record the source revision that produced it.");
  }

  const versionLabel = adapter.inspectVersionLabel(resolvedReference);
  if (versionLabel === null) {
    return failure("version-inspect-failed", "Could not inspect the published image for its semantic version.");
  }
  const imageVersion = validateVersionLabel(versionLabel);
  if (imageVersion === undefined) {
    return failure("version-invalid", "The published image does not record a valid semantic version.");
  }

  if (!adapter.runBanner(resolvedReference)) {
    return failure("banner-failed", "The resolved Orbit image could not render its canonical banner.");
  }

  return {
    status: "ok",
    resolvedReference,
    revision,
    imageVersion,
    appliedDigest: resolvedReference.slice(resolvedReference.indexOf("@") + 1),
  };
}
