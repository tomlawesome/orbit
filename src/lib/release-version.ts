/**
 * The one place a release version is read and compared (#1618). A release is
 * `vX.Y.Z`: three numbers without leading zeros; nothing else (no pre-release
 * or build suffix) is a version.
 */
const RELEASE_VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export type ParsedReleaseVersion = [number, number, number];

/** The three numbers of a `vX.Y.Z` string, or null for anything else. */
export function parseReleaseVersion(text: unknown): ParsedReleaseVersion | null {
  if (typeof text !== "string") return null;
  const match = RELEASE_VERSION.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0 or 1, comparing each part as a number. Throws on a malformed input. */
export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new TypeError("Not a release version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}
