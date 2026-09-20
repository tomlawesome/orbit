// Keep the pinned sidecar images honest (#771).
//
// A digest pin is frozen by design; the advisory database is not. So the gap
// between "what we pin" and "what upstream ships" does not announce itself --
// it accumulates, and an operator's deployment carries it. Nothing in Orbit
// looked at the sidecars until this: `Base image freshness` covers only
// `ghcr.io/tomlawesome/orbit-base-image`, and Dependabot cannot read the
// bespoke JSON in `.github/supply-chain-policy.json` at all.
//
// Four ways a sidecar pin can be behind, and the report says which, because
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
//   3. Upstream has published a newer stable release, and the tag we pinned
//      has *not* moved -- it still resolves to exactly the manifest we think
//      it does, so axis 1 has nothing to say. A digest pin only ever answers
//      "is this the tag I already named still what I think it is"; it cannot
//      answer "has something newer shipped", because it was never told what
//      "newer" would look like. This is why `ollama/ollama` pinned at 0.33.3
//      read as current for months after 0.34.0 and 0.34.1 shipped (#1042):
//      nothing ever asked upstream's tag list the question. Remedy: bump the
//      tag to the new release, resolve its digest, and run `sync`. A rolling
//      tag with no version in it (`node:24-alpine`, `postgres:18-alpine`) has
//      nothing to compare, so this axis is skipped for it; a pre-release or
//      differently-suffixed tag (`-rc*`, `-SNAPSHOT`, `-rocm`, `-slim`, ...)
//      is never offered as the upgrade.
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
// One HTTP round trip; a wedged registry should not hang the whole check.
const REGISTRY_FETCH_TIMEOUT_MS = 30_000;
// Docker Hub paginates tags/list at ~100 per page; ollama alone has 1000+
// tags, so this is a real cap, not a formality, but still far more than any
// repo here has ever needed.
const MAX_TAG_LIST_PAGES = 20;

// A pre-release marker never worth offering as an upgrade, wherever it lands
// among a tag's hyphen-separated segments.
const PRERELEASE_SEGMENT_PATTERN = /^(?:rc\d*|snapshot|beta\d*|alpha\d*)$/iu;
// A tag's version part: one or more dot-separated numbers. A single number
// with no dot (`24`, `18`) is a bare major -- a rolling tag, not a release.
const VERSION_SEGMENT_PATTERN = /^\d+(?:\.\d+)*$/u;

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

/**
 * Split a policy tag reference (`ollama/ollama:0.33.3`, `node:24-alpine`)
 * into the repository and the tag name, on the last colon after the last
 * slash so a registry host with a port never gets mistaken for a tag.
 */
function splitTagReference(tagRef) {
  const lastSlash = tagRef.lastIndexOf("/");
  const lastColon = tagRef.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return { repository: tagRef.slice(0, lastColon), tagName: tagRef.slice(lastColon + 1) };
  }
  return { repository: tagRef, tagName: "latest" };
}

/**
 * Read a tag name as a release: its version, whether that version is a bare
 * major with nothing to compare (`24`, `18-alpine`), whether it carries a
 * pre-release marker, and the variant suffix left once that marker is set
 * aside (so `4.1.0-SNAPSHOT-full` reads as variant `full`, pre-release
 * `true` -- excluded on the pre-release rule even though its variant would
 * otherwise match `4.0.0-full`).
 */
function parseVersionTag(tagName) {
  const segments = tagName.split("-");
  const versionSegment = segments[0];
  if (!VERSION_SEGMENT_PATTERN.test(versionSegment)) {
    return { valid: false, rolling: false, prerelease: false, variant: null, versionParts: [] };
  }
  const versionParts = versionSegment.split(".").map(Number);
  const rest = segments.slice(1);
  const prerelease = rest.some((segment) => PRERELEASE_SEGMENT_PATTERN.test(segment));
  const variantSegments = rest.filter((segment) => !PRERELEASE_SEGMENT_PATTERN.test(segment));
  return {
    valid: true,
    rolling: versionParts.length < 2,
    prerelease,
    variant: variantSegments.length > 0 ? variantSegments.join("-") : null,
    versionParts,
  };
}

/** Compare two dot-separated version part arrays numerically, component by component. */
function compareVersionParts(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** One less than a version, for --red to fabricate a pin it knows is old. `null` if it cannot go lower. */
function decrementVersionParts(versionParts) {
  const decremented = [...versionParts];
  for (let index = decremented.length - 1; index >= 0; index -= 1) {
    if (decremented[index] > 0) {
      decremented[index] -= 1;
      return decremented;
    }
  }
  return null;
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

/** Where a repository's tags live, and the anonymous token scope to read them. */
function registryForRepository(repository) {
  if (repository.startsWith("ghcr.io/")) {
    const repoPath = repository.slice("ghcr.io/".length);
    return {
      repoPath,
      registryHost: "https://ghcr.io",
      tokenUrl: `https://ghcr.io/token?service=ghcr.io&scope=repository:${repoPath}:pull`,
    };
  }
  // Docker Hub's official images (`node`, `postgres`) live under `library/`;
  // an org-owned repository (`ollama/ollama`, `apache/tika`) already has its
  // own namespace.
  const repoPath = repository.includes("/") ? repository : `library/${repository}`;
  return {
    repoPath,
    registryHost: "https://registry-1.docker.io",
    tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repoPath}:pull`,
  };
}

function nextTagsPageUrl(linkHeader, registryHost) {
  if (!linkHeader) return null;
  const match = /<([^>]+)>;\s*rel="next"/u.exec(linkHeader);
  if (!match) return null;
  return match[1].startsWith("http") ? match[1] : `${registryHost}${match[1]}`;
}

/**
 * Every tag a repository currently publishes. The docker CLI can resolve a
 * tag it is already given but cannot list what exists, so this goes straight
 * to the registry v2 HTTP API with an anonymous bearer token -- every image
 * this tool pins is public, so no credential is needed to read its tag list.
 * Works against Docker Hub and GHCR.
 */
export async function dockerListTags(repository) {
  const { repoPath, registryHost, tokenUrl } = registryForRepository(repository);
  const tokenResponse = await fetch(tokenUrl, {
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `could not get an anonymous token for ${repository}: HTTP ${tokenResponse.status}`,
    );
  }
  const tokenBody = await tokenResponse.json();
  const token = tokenBody.token ?? tokenBody.access_token;
  if (!token) {
    throw new Error(`registry did not return an anonymous token for ${repository}`);
  }

  const tags = [];
  let url = `${registryHost}/v2/${repoPath}/tags/list?n=100`;
  let pages = 0;
  while (url && pages < MAX_TAG_LIST_PAGES) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${repository} tag list request failed: HTTP ${response.status}`);
    }
    const body = await response.json();
    if (Array.isArray(body.tags)) tags.push(...body.tags);
    url = nextTagsPageUrl(response.headers.get("link"), registryHost);
    pages += 1;
  }
  return tags;
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

// --- Axis 3: has upstream published a newer release? -------------------------

/**
 * Ask whether upstream has shipped a release beyond the one we pinned from --
 * a question the digest axis cannot answer, because a digest pin only checks
 * whether the tag we already named still resolves where we left it. A
 * rolling tag with no version (`node:24-alpine`) has nothing to compare, so
 * it is reported `rolling`, not `current` -- "nothing found to be newer" and
 * "there was nothing to compare" are different findings with different
 * remedies (none, versus none needed).
 */
async function checkRelease(entry, listTags) {
  const { repository, tagName } = splitTagReference(entry.tag);
  const pinned = parseVersionTag(tagName);
  if (!pinned.valid) {
    return {
      status: "not-versioned",
      pinnedVersion: null,
      latestVersion: null,
      latestTag: null,
      summary: `${entry.tag} does not carry a version this axis can read, so the upstream-release check does not apply`,
    };
  }
  if (pinned.rolling) {
    return {
      status: "rolling",
      pinnedVersion: pinned.versionParts.join("."),
      latestVersion: null,
      latestTag: null,
      summary: `${entry.tag} is a rolling tag with no version to compare against, so the upstream-release check does not apply`,
    };
  }
  const pinnedVersion = pinned.versionParts.join(".");
  let tags;
  try {
    tags = await listTags(repository);
  } catch (error) {
    return {
      status: "unreachable",
      pinnedVersion,
      latestVersion: null,
      latestTag: null,
      summary: `could not list ${repository}'s tags from its registry: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    };
  }
  let latest = null;
  for (const candidateTag of tags) {
    const candidate = parseVersionTag(candidateTag);
    // Never a rolling tag, never a pre-release, and only ever the same
    // variant as the pin -- a `-full` pin compares only against other
    // `-full` tags, never a bare release or a `-rocm`/`-slim` build.
    if (!candidate.valid || candidate.rolling || candidate.prerelease) continue;
    if (candidate.variant !== pinned.variant) continue;
    if (!latest || compareVersionParts(candidate.versionParts, latest.versionParts) > 0) {
      latest = { versionParts: candidate.versionParts, tag: candidateTag };
    }
  }
  if (!latest || compareVersionParts(latest.versionParts, pinned.versionParts) <= 0) {
    return {
      status: "current",
      pinnedVersion,
      latestVersion: latest ? latest.versionParts.join(".") : pinnedVersion,
      latestTag: latest ? latest.tag : null,
      summary: `${repository} has not published a stable release newer than the pinned ${tagName}`,
    };
  }
  return {
    status: "behind",
    pinnedVersion,
    latestVersion: latest.versionParts.join("."),
    latestTag: latest.tag,
    summary: `${repository} has published ${latest.tag}, newer than the pinned ${tagName}`,
  };
}

// --- The check ---------------------------------------------------------------

const BEHIND_STATUSES = new Set(["drifted", "moved", "stale", "behind"]);
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
const SKIPPED_RELEASE_AXIS = {
  status: "skipped",
  pinnedVersion: null,
  latestVersion: null,
  latestTag: null,
  summary: "not checked (offline)",
};

/**
 * Run the axes over every covered entry. `resolveTag`, `simulatePackages` and
 * `listTags` are injectable so the unit tests can run every axis without
 * docker or a real registry.
 */
export async function checkPins({
  policy,
  repoDir = REPO_DIR,
  resolveTag = dockerResolveTag,
  simulatePackages = dockerSimulatePackages,
  listTags = dockerListTags,
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
      release: offline ? SKIPPED_RELEASE_AXIS : await checkRelease(entry, listTags),
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

    lines.push(`- **Upstream release**: ${image.axes.release.summary}`);
    if (image.axes.release.status === "behind") {
      lines.push(`  - pinned release: \`${image.axes.release.pinnedVersion}\``);
      lines.push(
        `  - latest release: \`${image.axes.release.latestVersion}\` (\`${image.axes.release.latestTag}\`)`,
      );
      lines.push(
        "  - Remedy: bump the tag to the new release, resolve its digest, and run `node scripts/sidecar-pins.mjs sync` to pin both places.",
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
          ? "Every pin matches the policy. The upstream tag, the newest upstream release and the packages inside each pin were not checked: this was an offline run."
          : result.packagesChecked
            ? "Every checked pin is in step with its upstream tag, the newest release upstream has published, and its own packages."
            : "Every checked pin matches the policy, is still the current manifest of its tag, and is not behind the newest release upstream has published. The packages inside each pin were not checked.",
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

/** Axis 1's half of --red: fabricate a stale digest and insist the check calls it moved. */
async function runTagRedCheck({ policy, repoDir, resolveTag, entry, today, write }) {
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
    return true;
  }
  // The status alone hides the cause -- pipeline 278 read "unreachable" and
  // nothing about the missing Docker client behind it -- so the axis's own
  // summary, which carries the error message, goes on the line as well.
  const detail = axis?.summary ? ` (${axis.summary})` : "";
  write(
    `sidecar pins: self-test FAILED. The check did not fire on a deliberately stale pin for ${entry.tag}; it reported '${axis?.status ?? "nothing"}'${detail}. Do not trust a green run from this check until that is fixed.\n`,
  );
  return false;
}

/**
 * Axis 3's half of --red: fabricate a pin one release older than it really
 * is and insist the check calls it behind. Needs an entry with an actual
 * version to step back from, so it picks its own entry rather than reusing
 * axis 1's -- entries[0] is often a rolling tag (`node:24-alpine`), which
 * this axis never has anything to say about.
 */
async function runReleaseRedCheck({ policy, repoDir, listTags, entries, today, write }) {
  const entry = entries.find((candidate) => {
    const { tagName } = splitTagReference(candidate.tag);
    const parsed = parseVersionTag(tagName);
    return parsed.valid && !parsed.rolling;
  });
  if (!entry) {
    write(
      "sidecar pins: --red found no version-comparable image to test the upstream-release axis against; that part of the self-test is skipped.\n",
    );
    return true;
  }
  const { repository, tagName } = splitTagReference(entry.tag);
  const parsed = parseVersionTag(tagName);
  const decremented = decrementVersionParts(parsed.versionParts);
  if (!decremented) {
    write(
      `sidecar pins: --red cannot step ${entry.tag} back any further to test the upstream-release axis; that part of the self-test is skipped.\n`,
    );
    return true;
  }
  const fakeTagName = `${decremented.join(".")}${parsed.variant ? `-${parsed.variant}` : ""}`;
  const fakeTag = `${repository}:${fakeTagName}`;
  write(
    `sidecar pins: self-test. Pretending ${entry.tag} is pinned to ${fakeTag}, an older release than it really is, and asking the check whether upstream has published something newer. Nothing is written.\n`,
  );
  const result = await checkPins({
    policy: { ...policy, containerImages: [{ ...entry, tag: fakeTag }] },
    repoDir,
    listTags,
    // Only the release axis is under test here; give axis 1 a resolver that
    // never shells out to the real docker CLI, so this half of --red does
    // not depend on Docker being present.
    resolveTag: async () => ({ indexDigest: null, platformDigest: null }),
    drift: false,
    packages: false,
    today,
  });
  const axis = result.images[0]?.axes.release;
  if (axis?.status === "behind") {
    write(
      `sidecar pins: self-test passed. The check reported the deliberately old pin as behind (${axis.pinnedVersion} -> ${axis.latestVersion}), so it is known to fire.\n`,
    );
    return true;
  }
  const detail = axis?.summary ? ` (${axis.summary})` : "";
  write(
    `sidecar pins: self-test FAILED. The check did not fire on a deliberately old release pin for ${fakeTag}; it reported '${axis?.status ?? "nothing"}'${detail}. Do not trust a green run from this check until that is fixed.\n`,
  );
  return false;
}

async function runRedSelfTest({ policy, repoDir, resolveTag, listTags, only, today, write }) {
  const entries = sidecarEntries(policy, only);
  if (entries.length === 0) {
    write("sidecar pins: --red found no image to test against.\n");
    return 1;
  }
  const tagPassed = await runTagRedCheck({
    policy,
    repoDir,
    resolveTag,
    entry: entries[0],
    today,
    write,
  });
  const releasePassed = await runReleaseRedCheck({
    policy,
    repoDir,
    listTags,
    entries,
    today,
    write,
  });
  return tagPassed && releasePassed ? 0 : 1;
}

export async function runSidecarPins(argv, deps = {}) {
  const {
    repoDir = REPO_DIR,
    resolveTag = dockerResolveTag,
    simulatePackages = dockerSimulatePackages,
    listTags = dockerListTags,
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
      listTags,
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
    listTags,
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
      "sidecar pins: at least one pin is behind. A moved tag, or a tag behind on releases, is re-pinned with `node scripts/sidecar-pins.mjs sync`; stale packages inside a current pin have no re-pin remedy and need upstream or a named expiring exception (#740).\n",
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
