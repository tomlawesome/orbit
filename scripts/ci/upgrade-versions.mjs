import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compareVersions,
  parseVersion,
  repositoryTags,
  retractedTagList,
} from "../calculate-version.mjs";

// How many of the latest releases the upgrade matrix updates from (owner
// answer 40a on #1647). #1667's installer refusal reads the same constant.
export const UPGRADE_FROM_COUNT = 3;

// Paths whose change can alter what an update does (#1661). Matched like
// classify-changed-paths.mjs: anchored regexes over repo-relative paths.
export const UPGRADE_MATRIX_PATTERNS = Object.freeze([
  /^scripts\/install\.sh$/u,
  /^scripts\/configure\.sh$/u,
  /^scripts\/installer-ui\.sh$/u,
  /^scripts\/configuration[^/]*\.sh$/u,
  /^\.env-orbit\.example$/u,
  /^docker-compose[^/]*\.yml$/u,
  /^src\/db\/migrations\//u,
  /^src\/lib\/install-orchestrator\.ts$/u,
  /^src\/lib\/install-orchestrator\//u,
]);

const LAUNCHER_PIN = "launcher/pin.json";

/** Plain vMAJOR.MINOR.PATCH tags that are not retracted, newest first. */
export function stableReleases({ tags, retractedTags }) {
  const retracted = new Set(retractedTags);
  return tags
    .filter((tag) => !retracted.has(tag) && parseVersion(tag) !== null)
    .sort((left, right) => compareVersions(parseVersion(right), parseVersion(left)));
}

/** `latest-1` .. `latest-count`; a slot with no release is "". */
export function upgradeSlots({ tags, retractedTags, count }) {
  const releases = stableReleases({ tags, retractedTags });
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`latest-${index + 1}`, releases[index] ?? ""]),
  );
}

export function upgradeMatrixNeeded(changedPaths) {
  return changedPaths.some((path) => UPGRADE_MATRIX_PATTERNS.some((pattern) => pattern.test(path)));
}

function changedSince(tag) {
  const output = execFileSync("git", ["diff", "--name-only", `${tag}..HEAD`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return output.split(/\r?\n/u).filter(Boolean);
}

function runCli() {
  const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const retractedTags = retractedTagList(repositoryRoot);
  let tags = [];
  try {
    tags = repositoryTags(process.cwd());
  } catch {
    // No readable tags: the slots stay empty and the matrix runs.
  }
  const slots = upgradeSlots({ tags, retractedTags, count: UPGRADE_FROM_COUNT });
  const since = stableReleases({ tags, retractedTags })[0] ?? "";

  // Fail safe (#1597): an unreadable diff runs everything.
  let matrix = true;
  let launcher = true;
  if (since) {
    try {
      const changed = changedSince(since);
      matrix = upgradeMatrixNeeded(changed);
      launcher = matrix || changed.includes(LAUNCHER_PIN);
    } catch {
      // keep the fail-safe values
    }
  }

  const lines = [
    `ORBIT_UPGRADE_MATRIX=${matrix}`,
    `ORBIT_UPGRADE_LAUNCHER=${launcher}`,
    `ORBIT_UPGRADE_SINCE=${since}`,
    ...Object.entries(slots).map(
      ([slot, tag]) => `ORBIT_UPGRADE_SLOT_${slot.toUpperCase().replaceAll("-", "_")}=${tag}`,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
