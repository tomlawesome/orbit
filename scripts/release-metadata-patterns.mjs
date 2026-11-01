// The Node twin of scripts/release-metadata-patterns.sh (#1363): the same
// digest and image-reference expressions, defined once per language. Keep the
// two files in step; scripts/release-metadata-patterns.test.mjs checks that
// they agree on a table of values. Bash-only patterns (the awk and suffix
// forms) have no twin.
//
// The one spelling difference: Bash writes "not whitespace" as [:space:],
// which a JavaScript RegExp has no equivalent for, so here it is \s.

// sha256: and exactly 64 lowercase hex characters, with no anchors.
export const ORBIT_DIGEST_TOKEN_PATTERN = /sha256:[0-9a-f]{64}/u;

// The whole string is one digest.
export const ORBIT_DIGEST_PATTERN = new RegExp(`^${ORBIT_DIGEST_TOKEN_PATTERN.source}$`, "u");

// Loose image reference: anything that is neither @ nor whitespace, then @ and a digest.
export const ORBIT_IMAGE_REFERENCE_PATTERN = new RegExp(`^[^@\\s]+@${ORBIT_DIGEST_TOKEN_PATTERN.source}$`, "u");

// Strict registry reference, for evidence: host[:port]/path[/path...]@digest, no tag.
export const ORBIT_REGISTRY_REFERENCE_PATTERN = new RegExp(
  `^[A-Za-z0-9._-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)+@${ORBIT_DIGEST_TOKEN_PATTERN.source}$`,
  "u",
);
