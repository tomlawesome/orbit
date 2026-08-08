import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STABLE_VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const CHANNELS = new Set(["preview", "hotfix"]);

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

/**
 * Calculates one candidate version for a release train. Stable tags are the
 * durable source of truth; package.json is used only to bootstrap repositories
 * that predate the first stable Git tag.
 */
export function calculateReleaseTrainVersion({ tags, fallbackVersion, channel }) {
  if (!CHANNELS.has(channel)) {
    throw new Error("Version channel must be preview or hotfix.");
  }

  const stableVersions = tags.map(parseVersion).filter((version) => version !== null);
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

  return channel === "hotfix"
    ? `v${major}.${minor}.${patch + 1}`
    : `v${major}.${minor + 1}.0`;
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
  const version = calculateReleaseTrainVersion({
    tags: repositoryTags(repositoryRoot),
    fallbackVersion: packageManifest.version,
    channel: requestedChannel(process.argv.slice(2)),
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
