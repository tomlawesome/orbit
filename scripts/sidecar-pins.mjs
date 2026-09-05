// Keep the pinned sidecar images honest (#771).
//
// A digest pin is frozen by design; the advisory database is not. So the gap
// between "what we pin" and "what upstream ships" does not announce itself --
// it accumulates, and an operator's deployment carries it. Nothing in Orbit
// looked at the sidecars until this: `Base image freshness` covers only
// `ghcr.io/tomlawesome/orbit-base-image`, and Dependabot cannot read the
// bespoke JSON in `.github/supply-chain-policy.json` at all.
//
// Three ways a sidecar pin can be behind, and the report says which, because
// the remedies differ:
//
//   0. Drift. A pin lives in two places -- a file (`docker-compose.yml`,
//      `tests/oidc/Dockerfile`, `scripts/test-integration.mjs`) and the policy
//      -- and they disagree. This is what a Dependabot bump looks like before
//      anyone runs `sync`. Needs no network, so CI runs it on every pull
//      request.
//   1. The tag moved. Upstream republished; the tag we pinned from now
//      resolves elsewhere. Remedy: re-pin both places, which `sync` does.
//   2. The pinned image's own packages are stale. The digest is still current
//      but its distribution has published fixes since it was built. There is
//      nothing to re-pin to: either upstream rebuilds, or the finding becomes
//      a named expiring entry in the policy's `exceptions[]` (see #740).
//
// Nothing is committed automatically. This reports, and a person acts.
//
// The Orbit base image is deliberately out of scope. Its digest comes from its
// own build pipeline at `gitlab.tomlawson.io/ai/orbit-base-image`, not from a
// registry tag anybody here should re-resolve, and #708 owns its freshness.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateSupplyChainPolicy } from "./supply-chain-policy.mjs";

const REPO_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY_PATH = ".github/supply-chain-policy.json";

// The one entry this tool never touches: #708's, and its digest must come from
// its own pipeline rather than from re-resolving a registry tag here.
export const BASE_IMAGE_TAG_PREFIX = "ghcr.io/tomlawesome/orbit-base-image";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HEX = "0123456789abcdef";

// Long enough for a slow registry, short enough that a wedged call fails the
// job rather than burning its whole timeout.
const RESOLVE_TIMEOUT_MS = 120_000;
// Axis 2 pulls the image first, and ollama and tika are large.
const SIMULATE_TIMEOUT_MS = 600_000;

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function pinPattern(tag) {
  return new RegExp(`${escapeForRegExp(tag)}@sha256:[0-9a-f]{64}`, "u");
}

function digestOf(reference) {
  return reference.slice(reference.lastIndexOf("@") + 1);
}

/**
 * Every policy entry this tool covers: all pinned container images except the
 * Orbit base image, optionally narrowed to those whose tag contains `only`.
 */
export function sidecarEntries(policy, only) {
  return policy.containerImages.filter(
    (entry) =>
      !entry.tag.startsWith(BASE_IMAGE_TAG_PREFIX) &&
      (only === undefined || only === "" || entry.tag.includes(only)),
  );
}

/**
 * A syntactically valid digest that is deliberately not the pinned one: the
 * last eight hex characters each move one place along. Used only by --red, in
 * memory, to prove the check fires on a stale pin rather than assuming it.
 */
export function rotateDigest(digest) {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`Cannot rotate '${digest}': it is not a sha256 digest.`);
  }
  const head = digest.slice(0, -8);
  const tail = [...digest.slice(-8)]
    .map((character) => HEX[(HEX.indexOf(character) + 1) % HEX.length])
    .join("");
  return `${head}${tail}`;
}

/** The upgrade lines each package manager prints when it simulates an upgrade. */
export function pendingUpgrades(manager, output) {
  const lines = (output ?? "").split("\n");
  if (manager === "apk") {
    return lines.filter((line) => /^\(\d+\/\d+\) Upgrading /u.test(line));
  }
  if (manager === "apt") {
    return lines.filter((line) => line.startsWith("Inst "));
  }
  return [];
}

// --- The real registry and container calls -----------------------------------

/**
 * Resolve a tag's current identity. `.digest` on the manifest is the index
 * digest; the `.manifests[]` entries carry the per-platform digests. A
 * single-architecture image has no `manifests` at all, and there is then no
 * platform manifest to compare the pin against.
 */
export function dockerResolveTag(tag) {
  const result = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: RESOLVE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (result.error) {
    throw new Error(`docker could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `docker buildx imagetools inspect ${tag} failed: ${(result.stderr || "").trim()}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    throw new Error(`docker returned a manifest for ${tag} that is not JSON.`);
  }
  const manifests = Array.isArray(manifest?.manifests) ? manifest.manifests : [];
  if (manifests.length === 0) {
    return { indexDigest: null, platformDigest: null };
  }
  const platform = manifests.find(
    (entry) =>
      entry?.platform?.os === "linux" && entry?.platform?.architecture === "amd64",
  );
  return {
    indexDigest: typeof manifest.digest === "string" ? manifest.digest : null,
    platformDigest: platform?.digest ?? null,
  };
}

/**
 * Ask the pinned image itself whether its distribution has published fixes it
 * does not carry. Runs as uid 0 because both package managers need to write a
 * cache; nothing is committed back, the container is removed either way.
 */
export function dockerSimulatePackages(reference) {
  const script = [
    'if command -v apk >/dev/null 2>&1; then',
    '  echo "__ORBIT_MANAGER__ apk"',
    '  apk update >/dev/null 2>&1 || exit 3',
    '  apk upgrade --simulate 2>&1',
    'elif command -v apt-get >/dev/null 2>&1; then',
    '  echo "__ORBIT_MANAGER__ apt"',
    '  apt-get update -qq >/dev/null 2>&1 || exit 3',
    '  apt-get -s upgrade 2>&1',
    'else',
    '  echo "__ORBIT_MANAGER__ none"',
    'fi',
  ].join("\n");
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--user", "0", "--entrypoint", "sh", reference, "-c", script],
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: SIMULATE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (result.error) {
    throw new Error(`docker could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `could not query packages inside ${reference}: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  const lines = (result.stdout ?? "").split("\n");
  const markerIndex = lines.findIndex((line) => line.startsWith("__ORBIT_MANAGER__ "));
  if (markerIndex === -1) {
    throw new Error(`${reference} did not report which package manager it has.`);
  }
  return {
    manager: lines[markerIndex].slice("__ORBIT_MANAGER__ ".length).trim(),
    output: lines.slice(markerIndex + 1).join("\n"),
  };
}

// --- Axis 0: drift between the two places a pin lives ------------------------

function checkDrift(entry, repoDir) {
  const pattern = pinPattern(entry.tag);
  const files = entry.locations.map((location) => {
    let content;
    try {
      content = readFileSync(join(repoDir, location), "utf8");
    } catch {
      return { path: location, status: "missing-file", found: null };
    }
    if (content.includes(entry.reference)) {
      return { path: location, status: "aligned", found: entry.reference };
    }
    const match = pattern.exec(content);
    if (match) {
      return { path: location, status: "different-digest", found: match[0] };
    }
    return { path: location, status: "no-pin", found: null };
  });
  const drifted = files.filter((file) => file.status !== "aligned");
  return {
    status: drifted.length === 0 ? "aligned" : "drifted",
    files,
    summary:
      drifted.length === 0
        ? `every location holds ${entry.reference}`
        : `${drifted.length} of ${files.length} location(s) do not hold the pin the policy records`,
  };
}

// --- Axis 1: has the tag moved on? -------------------------------------------

async function checkTag(entry, resolveTag) {
  const pinnedDigest = digestOf(entry.reference);
  let resolution;
  try {
    resolution = await resolveTag(entry.tag);
  } catch (error) {
    return {
      status: "unreachable",
      pinnedDigest,
      pinnedIndexDigest: entry.indexDigest,
      currentDigest: null,
      currentIndexDigest: null,
      summary: `could not resolve ${entry.tag} from its registry: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    };
  }
  const currentDigest = resolution?.platformDigest ?? null;
  const currentIndexDigest = resolution?.indexDigest ?? null;
  const shared = {
    pinnedDigest,
    pinnedIndexDigest: entry.indexDigest,
    currentDigest,
    currentIndexDigest,
  };
  if (currentDigest === null) {
    // A single-architecture image publishes no index, so there is no
    // linux/amd64 entry to compare the pin against, as the base image check
    // also reports rather than guessing.
    return {
      ...shared,
      status: "no-platform-entry",
      summary: `${entry.tag} has no linux/amd64 entry to compare; the moved-tag check is skipped`,
    };
  }
  const manifestMoved = currentDigest !== pinnedDigest;
  const indexMoved = currentIndexDigest !== null && currentIndexDigest !== entry.indexDigest;
  if (!manifestMoved && !indexMoved) {
    return {
      ...shared,
      status: "current",
      summary: `the pinned digest is still the current linux/amd64 manifest of ${entry.tag}`,
    };
  }
  return {
    ...shared,
    status: "moved",
    summary: manifestMoved
      ? `${entry.tag} now resolves to a different linux/amd64 manifest`
      : `${entry.tag} still resolves to the pinned manifest, but its index digest moved`,
  };
}

// --- Axis 2: are the pinned image's own packages behind? ---------------------

async function checkPackages(entry, simulatePackages) {
  let simulation;
  try {
    simulation = await simulatePackages(entry.reference);
  } catch (error) {
    return {
      status: "unreachable",
      manager: null,
      pending: [],
      summary: `could not query packages inside ${entry.reference}: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    };
  }
  const manager = simulation?.manager ?? "none";
  if (manager !== "apk" && manager !== "apt") {
    return {
      status: "no-package-manager",
      manager: null,
      pending: [],
      summary: `${entry.tag} has neither apk nor apt-get, so its packages cannot be checked this way`,
    };
  }
  const pending = pendingUpgrades(manager, simulation.output);
  if (pending.length === 0) {
    return {
      status: "current",
      manager,
      pending,
      summary: `packages are current for the release ${entry.tag} was built from`,
    };
  }
  return {
    status: "stale",
    manager,
    pending,
    summary: `${pending.length} package upgrade(s) are available inside the pinned image`,
  };
}

// --- The check ---------------------------------------------------------------

const BEHIND_STATUSES = new Set(["drifted", "moved", "stale"]);
const BLIND_STATUSES = new Set(["unreachable", "no-package-manager"]);

const SKIPPED_TAG_AXIS = {
  status: "skipped",
  pinnedDigest: null,
  pinnedIndexDigest: null,
  currentDigest: null,
  currentIndexDigest: null,
  summary: "not checked (offline)",
};
const SKIPPED_PACKAGE_AXIS = {
  status: "skipped",
  manager: null,
  pending: [],
  summary: "not checked (pass --packages, which pulls every image)",
};

/**
 * Run the axes over every covered entry. `resolveTag` and `simulatePackages`
 * are injectable so the unit tests can run all three axes without docker.
 */
export async function checkPins({
  policy,
  repoDir = REPO_DIR,
  resolveTag = dockerResolveTag,
  simulatePackages = dockerSimulatePackages,
  packages = false,
  offline = false,
  drift = true,
  only,
  today = new Date().toISOString().slice(0, 10),
}) {
  const images = [];
  for (const entry of sidecarEntries(policy, only)) {
    const axes = {
      drift: drift
        ? checkDrift(entry, repoDir)
        : { status: "skipped", files: [], summary: "not checked" },
      tag: offline ? SKIPPED_TAG_AXIS : await checkTag(entry, resolveTag),
      packages:
        offline || !packages
          ? SKIPPED_PACKAGE_AXIS
          : await checkPackages(entry, simulatePackages),
    };
    images.push({
      name: entry.name,
      tag: entry.tag,
      reference: entry.reference,
      indexDigest: entry.indexDigest,
      locations: entry.locations,
      axes,
    });
  }
  const statuses = images.flatMap((image) => Object.values(image.axes).map((a) => a.status));
  const behind = statuses.some((status) => BEHIND_STATUSES.has(status));
  const blind = statuses.some((status) => BLIND_STATUSES.has(status));
  return {
    generatedOn: today,
    offline,
    packagesChecked: packages && !offline,
    images,
    behind,
    blind,
    // A check that cannot see is not a pass, so "could not look" is exit 2
    // rather than exit 0. Something actually being behind outranks it: the
    // report is still worth acting on.
    exitCode: behind ? 1 : blind ? 2 : 0,
  };
}

const DRIFT_FILE_WORDING = {
  aligned: "holds the pinned reference",
  "different-digest": "pins a different digest",
  "no-pin": "does not pin this tag at all",
  "missing-file": "could not be read",
};

/** The human-readable report: printed, and written to --report for an issue body. */
export function renderReport(result) {
  const lines = [];
  lines.push("# Sidecar pin freshness");
  lines.push("");
  lines.push(
    `Checked ${result.images.length} pinned image(s) on ${result.generatedOn}. The Orbit base image is not included: its digest comes from its own build pipeline (#708).`,
  );
  lines.push("");
  if (result.images.length === 0) {
    lines.push("No pinned image matched.");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }
  for (const image of result.images) {
    lines.push(`## ${image.tag}`);
    lines.push("");
    lines.push(`${image.name}. Pinned to \`${image.reference}\`.`);
    lines.push("");

    lines.push(`- **Pin locations**: ${image.axes.drift.summary}`);
    for (const file of image.axes.drift.files) {
      if (file.status === "aligned") continue;
      lines.push(
        `  - \`${file.path}\` ${DRIFT_FILE_WORDING[file.status]}${
          file.found ? `: \`${file.found}\`` : ""
        }`,
      );
    }
    if (image.axes.drift.status === "drifted") {
      lines.push(
        "  - Remedy: run `node scripts/sidecar-pins.mjs sync` so the policy and the files agree again, review the diff, and commit it.",
      );
    }

    lines.push(`- **Upstream tag**: ${image.axes.tag.summary}`);
    if (image.axes.tag.status === "moved") {
      lines.push(`  - pinned manifest: \`${image.axes.tag.pinnedDigest}\``);
      lines.push(`  - current manifest: \`${image.axes.tag.currentDigest}\``);
      lines.push(`  - pinned index: \`${image.axes.tag.pinnedIndexDigest}\``);
      lines.push(`  - current index: \`${image.axes.tag.currentIndexDigest}\``);
      lines.push(
        "  - Remedy: adopt the new digest in the file, then run `node scripts/sidecar-pins.mjs sync` to re-pin both places.",
      );
    }

    lines.push(`- **Packages inside the pin**: ${image.axes.packages.summary}`);
    for (const pending of image.axes.packages.pending) {
      lines.push(`  - ${pending}`);
    }
    if (image.axes.packages.status === "stale") {
      lines.push(
        "  - Remedy: none here. The tag has not moved, so there is nothing to re-pin to. Wait for upstream to rebuild, or record a named, expiring entry in the policy's `exceptions[]` with an owner and a tracking issue (#740).",
      );
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    result.behind
      ? "At least one pin is behind. See the remedy under each image above."
      : result.blind
        ? "Nothing was found to be behind, but at least one image could not be checked, which is not the same as a pass."
        : result.offline
          ? "Every pin matches the policy. The upstream tag and the packages inside each pin were not checked: this was an offline run."
          : result.packagesChecked
            ? "Every checked pin is in step with its upstream tag and its own packages."
            : "Every checked pin matches the policy and is still the current manifest of its tag. The packages inside each pin were not checked.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// --- sync --------------------------------------------------------------------

function readPolicy(policyPath) {
  try {
    return JSON.parse(readFileSync(policyPath, "utf8"));
  } catch {
    throw new Error(`Supply-chain policy at ${policyPath} is missing or invalid JSON.`);
  }
}

/**
 * Bring the policy back into step with the files. After a Dependabot bump the
 * file is the source of truth -- Dependabot rewrote it and cannot touch the
 * policy -- so the pin in the first location wins, its index digest is
 * re-resolved from the registry, and every other location is rewritten to match.
 */
export async function syncPins({
  policyPath,
  repoDir = REPO_DIR,
  resolveTag = dockerResolveTag,
  only,
  today = new Date().toISOString().slice(0, 10),
}) {
  const policy = readPolicy(policyPath);
  const changes = [];
  for (const entry of sidecarEntries(policy, only)) {
    const pattern = pinPattern(entry.tag);
    const sourceLocation = entry.locations[0];
    const sourcePath = join(repoDir, sourceLocation);
    let sourceContent;
    try {
      sourceContent = readFileSync(sourcePath, "utf8");
    } catch {
      throw new Error(`${sourceLocation} could not be read, so ${entry.tag} cannot be synced.`);
    }
    const match = pattern.exec(sourceContent);
    if (!match) {
      throw new Error(
        `${sourceLocation} holds no digest pin for ${entry.tag}; sync cannot guess one.`,
      );
    }
    const reference = match[0];
    const resolution = await resolveTag(entry.tag);
    const indexDigest = resolution?.indexDigest ?? entry.indexDigest;

    const rewritten = [];
    for (const location of entry.locations.slice(1)) {
      const path = join(repoDir, location);
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        throw new Error(`${location} could not be read, so ${entry.tag} cannot be synced.`);
      }
      if (!pattern.test(content)) {
        throw new Error(
          `${location} holds no digest pin for ${entry.tag}; sync cannot guess one.`,
        );
      }
      const updated = content.replace(new RegExp(pattern.source, "gu"), reference);
      if (updated !== content) {
        writeFileSync(path, updated, "utf8");
        rewritten.push(location);
      }
    }

    const policyChanged =
      entry.reference !== reference || entry.indexDigest !== indexDigest;
    if (!policyChanged && rewritten.length === 0) continue;

    changes.push({
      tag: entry.tag,
      previousReference: entry.reference,
      reference,
      previousIndexDigest: entry.indexDigest,
      indexDigest,
      sourceLocation,
      rewritten,
    });
    entry.reference = reference;
    entry.indexDigest = indexDigest;
    entry.resolvedOn = today;
  }
  if (changes.length > 0) {
    // 2-space and a trailing newline, which is byte-for-byte how the policy
    // file is already written; only the changed fields move.
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  }
  return { changes };
}

// --- CLI ---------------------------------------------------------------------

const VALUE_FLAGS = new Set(["policy", "only", "report"]);
const BOOLEAN_FLAGS = new Set(["packages", "offline", "red"]);

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "sync") {
    throw new Error("Sidecar pins command must be check or sync.");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Unexpected argument '${flag}'; options are --name value pairs.`);
    }
    const name = flag.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(`Unknown option '${flag}'.`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option '${flag}' needs a value.`);
    }
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

async function runRedSelfTest({ policy, repoDir, resolveTag, only, today, write }) {
  const entries = sidecarEntries(policy, only);
  if (entries.length === 0) {
    write("sidecar pins: --red found no image to test against.\n");
    return 1;
  }
  const entry = entries[0];
  const staleDigest = rotateDigest(digestOf(entry.reference));
  write(
    `sidecar pins: self-test. Pretending ${entry.tag} is pinned to ${staleDigest}, which it is not, and asking the check whether the tag has moved. Nothing is written.\n`,
  );
  const result = await checkPins({
    policy: {
      ...policy,
      containerImages: [
        { ...entry, reference: `${entry.tag}@${staleDigest}`, indexDigest: staleDigest },
      ],
    },
    repoDir,
    resolveTag,
    drift: false,
    packages: false,
    today,
  });
  const axis = result.images[0]?.axes.tag;
  if (axis?.status === "moved") {
    write(
      `sidecar pins: self-test passed. The check reported the deliberately stale pin as moved (${axis.pinnedDigest} -> ${axis.currentDigest}), so it is known to fire.\n`,
    );
    return 0;
  }
  // The status alone hides the cause -- pipeline 278 read "unreachable" and
  // nothing about the missing Docker client behind it -- so the axis's own
  // summary, which carries the error message, goes on the line as well.
  const detail = axis?.summary ? ` (${axis.summary})` : "";
  write(
    `sidecar pins: self-test FAILED. The check did not fire on a deliberately stale pin for ${entry.tag}; it reported '${axis?.status ?? "nothing"}'${detail}. Do not trust a green run from this check until that is fixed.\n`,
  );
  return 1;
}

export async function runSidecarPins(argv, deps = {}) {
  const {
    repoDir = REPO_DIR,
    resolveTag = dockerResolveTag,
    simulatePackages = dockerSimulatePackages,
    today = new Date().toISOString().slice(0, 10),
    write = (text) => process.stdout.write(text),
    writeError = (text) => process.stderr.write(text),
  } = deps;

  let command;
  let options;
  try {
    ({ command, options } = parseArguments(argv));
  } catch (error) {
    writeError(`sidecar pins: ${error.message}\n`);
    return 2;
  }

  const policyPath = options.policy ?? join(repoDir, DEFAULT_POLICY_PATH);
  let policy;
  try {
    policy = readPolicy(policyPath);
    validateSupplyChainPolicy(policy, today);
  } catch (error) {
    writeError(`sidecar pins: ${error.message}\n`);
    return 2;
  }

  if (command === "sync") {
    try {
      const { changes } = await syncPins({
        policyPath,
        repoDir,
        resolveTag,
        only: options.only,
        today,
      });
      if (changes.length === 0) {
        write("sidecar pins: nothing to sync; the policy already matches every file.\n");
        return 0;
      }
      for (const change of changes) {
        write(`sidecar pins: ${change.tag} synced from ${change.sourceLocation}\n`);
        write(`  reference: ${change.previousReference}\n`);
        write(`          -> ${change.reference}\n`);
        write(`  index:     ${change.previousIndexDigest}\n`);
        write(`          -> ${change.indexDigest}\n`);
        write(`  resolvedOn: ${today}\n`);
        for (const location of change.rewritten) {
          write(`  rewrote:   ${location}\n`);
        }
      }
      write(
        `sidecar pins: ${changes.length} entry/entries updated. Review the diff before committing.\n`,
      );
      return 0;
    } catch (error) {
      writeError(`sidecar pins: ${error.message}\n`);
      return 1;
    }
  }

  if (options.red) {
    return runRedSelfTest({
      policy,
      repoDir,
      resolveTag,
      only: options.only,
      today,
      write,
    });
  }

  const result = await checkPins({
    policy,
    repoDir,
    resolveTag,
    simulatePackages,
    packages: options.packages === true,
    offline: options.offline === true,
    only: options.only,
    today,
  });

  const report = renderReport(result);
  write(report);
  if (options.report) {
    writeFileSync(options.report, report, "utf8");
  }

  if (result.exitCode === 1) {
    writeError(
      "sidecar pins: at least one pin is behind. A moved tag is re-pinned with `node scripts/sidecar-pins.mjs sync`; stale packages inside a current pin have no re-pin remedy and need upstream or a named expiring exception (#740).\n",
    );
  } else if (result.exitCode === 2) {
    writeError(
      "sidecar pins: at least one image could not be checked, so this run proves nothing. Treated as a failure rather than a pass.\n",
    );
  } else {
    write("sidecar pins: nothing is behind.\n");
  }
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  runSidecarPins(process.argv.slice(2))
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(
        `sidecar pins: ${error instanceof Error ? error.message : "failed."}\n`,
      );
      process.exitCode = 2;
    });
}
