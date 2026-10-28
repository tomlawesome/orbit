import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STABLE_VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const CHANNELS = new Set(["preview", "hotfix"]);
const RELEASE_LINE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function parseVersion(value) {
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function parseReleaseLine(value) {
  const match = typeof value === "string" ? RELEASE_LINE.exec(value) : null;
  if (!match) {
    throw new Error("The release line must be written vMAJOR.MINOR, for example v0.4.");
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("The release line must be written vMAJOR.MINOR, for example v0.4.");
  }
  return parts;
}

/**
 * Calculates one candidate version for a release train. Stable tags are the
 * durable source of truth; package.json is used only to bootstrap repositories
 * that predate the first stable Git tag. Retracted tags (published versions
 * that must never be stood on) are dropped before the baseline is chosen.
 *
 * Every train bumps the patch. A preview train moves to a new minor or major
 * only when the declared release line (scripts/release-line.json) is above the
 * baseline's; once that line's first version is tagged the same declaration
 * gives patches again, so it never needs resetting (#1499).
 */
export function calculateReleaseTrainVersion({
  tags,
  fallbackVersion,
  channel,
  retractedTags = [],
  releaseLine,
}) {
  if (!CHANNELS.has(channel)) {
    throw new Error("Version channel must be preview or hotfix.");
  }
  const line = channel === "preview" ? parseReleaseLine(releaseLine) : null;

  const retracted = new Set(retractedTags);
  const stableVersions = tags
    .filter((tag) => !retracted.has(tag))
    .map(parseVersion).filter((version) => version !== null);
  let baseline;
  if (stableVersions.length > 0) {
    baseline = stableVersions.reduce((latest, version) =>
      compareVersions(version, latest) > 0 ? version : latest,
    );
  } else {
    baseline = parseVersion(`v${fallbackVersion}`);
    if (!baseline) {
      throw new Error("The package version must be a stable semantic version.");
    }
  }
  const [major, minor, patch] = baseline;

  if (line && compareVersions(line, [major, minor]) > 0) {
    return `v${line[0]}.${line[1]}.0`;
  }
  return `v${major}.${minor}.${patch + 1}`;
}

function repositoryTags(repositoryRoot) {
  const result = spawnSync("git", ["tag", "--list", "v*"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Could not read stable Git tags for version calculation.");
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

function retractedTagList(repositoryRoot) {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "scripts", "retracted-tags.json"), "utf8"),
  );
  if (!Array.isArray(manifest.tags) || !manifest.tags.every((tag) => typeof tag === "string")) {
    throw new Error("scripts/retracted-tags.json must list retracted tags as strings.");
  }
  return manifest.tags;
}

function declaredReleaseLine(repositoryRoot) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "scripts", "release-line.json"), "utf8"),
    );
  } catch {
    throw new Error("scripts/release-line.json must exist and hold { \"line\": \"vMAJOR.MINOR\" }.");
  }
  const line = manifest?.line;
  parseReleaseLine(line);
  return line;
}

function requestedChannel(argv) {
  const channelIndex = argv.indexOf("--channel");
  if (channelIndex < 0 || !argv[channelIndex + 1] || argv.length !== 2) {
    throw new Error("Usage: node scripts/calculate-version.mjs --channel <preview|hotfix>");
  }
  return argv[channelIndex + 1];
}

function runCli() {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packageManifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const channel = requestedChannel(process.argv.slice(2));
  const version = calculateReleaseTrainVersion({
    tags: repositoryTags(repositoryRoot),
    fallbackVersion: packageManifest.version,
    channel,
    retractedTags: retractedTagList(repositoryRoot),
    // Only a preview train reads the release line; a hotfix branch can be cut
    // from a tag older than release-line.json, and docs/releasing.md says a
    // hotfix ignores the file.
    releaseLine: channel === "preview" ? declaredReleaseLine(repositoryRoot) : undefined,
  });
  process.stdout.write(`${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Version calculation failed."}\n`);
    process.exitCode = 1;
  }
}
