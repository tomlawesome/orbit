import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export const CI_RISK = Object.freeze({
  FAST: "fast",
  INTEGRATION: "integration",
  SYSTEM: "system",
});

// A lane is a whole-diff verdict, not a per-path one: it applies only when
// *every* changed path belongs to it, and one file outside it puts the change
// back in the ordinary classified pipeline. Where `CI_RISK` says how deep to
// go, a lane says which jobs exist at all -- see the lists in `.gitlab-ci.yml`'s
// `orbit_lane_admits` (#889).
export const CI_LANE = Object.freeze({
  FULL: "full",
  IGNORE_POLICY: "ignore_policy",
  CI: "ci",
});

const riskRank = new Map([
  [CI_RISK.FAST, 0],
  [CI_RISK.INTEGRATION, 1],
  [CI_RISK.SYSTEM, 2],
]);

const dependencySnapshotPaths = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml"]);

// The v19 front end and the two things that decide what its visual gate
// builds and compares. Narrower than system risk on purpose: fidelity is the
// only automatic check that layer has (#620), and it should run whenever that
// layer moves without charging every system-risk change for it.
const webPatterns = [/^web\//u, /^pnpm-lock\.yaml$/u, /^pnpm-workspace\.yaml$/u];

// What the `licence_policy` job (#815) reaches for: a change to any of these
// can add or move a dependency, so the installed-tree licence walk needs to
// run. Narrower than a full dependency-snapshot change on purpose -- unlike
// `pathRisk`'s dependencySnapshotPaths, this does not fall back to a
// production-graph comparison, because the licence walk covers the whole
// installed tree regardless of whether production dependencies moved.
const licencePolicyPaths = new Set([
  "pnpm-lock.yaml",
  "package.json",
  "web/package.json",
  "pnpm-workspace.yaml",
  "supply-chain/licence-policy.yml",
]);

// What decides whether an ordinary merge request needs the launcher install
// check at all. It began as the two paths the retired
// `.github/workflows/launcher-install-compat.yml` watched: the installer's own
// contract with orbit-launcher, and the gate's own definition. `.gitlab-ci.yml` is that definition's new home on GitLab (see
// the `launcher_install_compat` job, #819) — it also already falls into the
// default system lane below through the unmatched-path catch-all, so this
// list exists to narrow *this one job's* reach, not to change classifyCiRisk.
//
// Since !895 (ADR-0019) the image also carries the eleven deployment assets an
// install uses, so `install.sh` fetches its helpers out of the digest rather
// than from a source revision. That makes every bundled asset part of what
// this job proves, and a change to one visible to it: the Dockerfile lines
// that copy them, what .dockerignore lets into that build context, the two
// compose files, the example environment file, the Tika configuration and the
// seven helper scripts under ./deploy/scripts/.
const launcherCompatPatterns = [
  /^scripts\/install\.sh$/u,
  /^\.gitlab-ci\.yml$/u,
  /^Dockerfile$/u,
  /^\.dockerignore$/u,
  /^docker-compose\.yml$/u,
  /^docker-compose\.mail\.yml$/u,
  /^\.env-orbit\.example$/u,
  /^config\/tika-config\.json$/u,
  /^scripts\/(?:configure|installer-ui|configuration|backup|restore|repair|engine-check)\.sh$/u,
];

// The ignore/policy lane (#889). Both files record what a scanner is allowed
// to pass over: .gitleaksignore is a list of exact commit/file/line
// fingerprints the secret scan has already been shown, and
// supply-chain/licence-policy.yml is the SPDX allow-list
// scripts/ci/licence-policy.mjs reads. A change confined to the two can move
// what `gitleaks`, `licence_policy` and `supply_chain_source` conclude and
// nothing else, so those are the only jobs the lane runs.
const ignorePolicyLanePaths = new Set([".gitleaksignore", "supply-chain/licence-policy.yml"]);

// The CI-definition lane (#889): the pipeline's own definition, the scripts
// its jobs call, and the classifier that decides which of them run. A change
// confined to these builds no image and stands up no stack, so the lane runs
// `fast` -- where the unit suites that read .gitlab-ci.yml live -- plus
// `gitleaks` and `supply_chain_source`.
//
// scripts/ci/ is in scope by the owner's decision on #889, and it is the wide
// part of it: several of those scripts are the acceptance stage's own checks
// (verify-privacy-boundary.sh, verify-installed-image.sh and the rest), so a
// change to one is not exercised until the merge into `dev`, where every
// pipeline runs everything again. That is a later red, not an unrun check.
const ciLanePatterns = [
  /^\.gitlab-ci\.yml$/u,
  /^scripts\/ci\//u,
  /^scripts\/classify-changed-paths(?:\.test)?\.mjs$/u,
  // The unit test that pins the lane lists themselves. It runs in `fast`,
  // which this lane runs, so the lane still checks its own definition.
  /^scripts\/gitlab-ci-lanes\.test\.mjs$/u,
];

const fastPatterns = [
  /^docs\//u,
  /^\.github\/ISSUE_TEMPLATE\//u,
  /^\.github\/pull_request_template\.md$/u,
  /^\.github\/supply-chain-policy\.json$/u,
  /^supply-chain\/licence-policy\.yml$/u,
  /^[^/]+\.md$/u,
  /^\.gitignore$/u,
  /^LICENSE$/u,
  /^scripts\/(?:supply-chain-policy|stable-promotion-policy)(?:\.test)?\.mjs$/u,
  /^scripts\/[^/]*(?:policy|workflow)\.test\.mjs$/u,
  /^src\/.*\.test\.[cm]?[jt]sx?$/u,
];

const systemPatterns = [
  /^\.github\/workflows\//u,
  /^Dockerfile$/u,
  // The two deployment compose files stay at the root (installer contract,
  // ADR-0019); the test/CI-only overlays live in compose/ since #442. Both
  // carry system risk, so both are pinned here.
  /^docker-compose(?:\.[^/]+)?\.ya?ml$/u,
  /^compose\//u,
  /^config\//u,
  /^package\.json$/u,
  /^drizzle\//u,
  /^tests\/e2e\//u,
  // The v19 front end IS the shipped application server since the cut (#735):
  // the Dockerfile's web-builder stage builds it and the runner copies it in,
  // and the e2e suite drives it directly. It reached the same lane through the
  // catch-all default below, which was right by accident: this states it
  // (#620).
  /^web\//u,
  /^src\/lib\/(?:auth|env|notifications|runtime-secret)(?:[./-]|$)/u,
  /* `boot` is the startup sequence Next's instrumentation hook used to call
     and SvelteKit's `init` now does (#735): migrate-on-boot and the workers
     both start there, so a change to it carries system risk. */
  /^src\/server\/(?:boot|document|documents|imap|notification|portable|push|readiness|recovery|storage)(?:[./-]|$)/u,
  /^scripts\/(?:backup|build-container|configure|container-entrypoint|deploy-container|export-recovery-bundle|generate-vapid|import-recovery-bundle|install|recovery-crypto|restore|test-backup-restore|test-frontend|test-malware-scanner|test-tika-processor|update-and-start|web-deploy|web-pdfjs-runtime-check)\.[^.]+$/u,
];

const integrationPatterns = [
  /^src\/(?:db|lib|server)\//u,
  /^tests\/integration\//u,
  /^scripts\/test-integration\.mjs$/u,
];

function normalizePath(path) {
  return String(path ?? "").replaceAll("\\", "/").trim();
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

/**
 * Returns the cheapest lane that still exercises the boundary affected by a
 * single path. Classification is deliberately allowlisted: unknown paths and
 * dependency snapshots without a proven production-graph comparison run the
 * broad exact-image system lane.
 */
export function pathRisk(path, { productionDependencyGraphChanged } = {}) {
  const normalized = normalizePath(path);
  if (normalized.length === 0) return CI_RISK.SYSTEM;

  if (dependencySnapshotPaths.has(normalized)) {
    return productionDependencyGraphChanged === false ? CI_RISK.FAST : CI_RISK.SYSTEM;
  }
  if (matchesAny(normalized, fastPatterns)) return CI_RISK.FAST;
  if (matchesAny(normalized, systemPatterns)) return CI_RISK.SYSTEM;
  if (matchesAny(normalized, integrationPatterns)) return CI_RISK.INTEGRATION;
  return CI_RISK.SYSTEM;
}

export function classifyCiRisk(changedPaths, options = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return CI_RISK.SYSTEM;

  let selected = CI_RISK.FAST;
  for (const path of changedPaths) {
    const candidate = pathRisk(path, options);
    if (riskRank.get(candidate) > riskRank.get(selected)) selected = candidate;
  }
  return selected;
}

/**
 * True when a change can move what the v19 fidelity gate photographs. Fails
 * safe: no usable list of changed paths means run it.
 */
export function touchesWeb(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  return changedPaths.some((path) => matchesAny(normalizePath(path), webPatterns));
}

/**
 * True when a change can move what the `licence_policy` gate checks. Fails
 * safe the same way `touchesWeb` does: no usable list of changed paths means
 * run it.
 */
export function touchesLicencePolicy(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  return changedPaths.some((path) => licencePolicyPaths.has(normalizePath(path)));
}

/**
 * True when a change can move whether `launcher_install_compat` has anything
 * new to prove. Fails safe: no usable list of changed paths means run it.
 */
export function touchesLauncherInstallCompat(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  return changedPaths.some((path) => matchesAny(normalizePath(path), launcherCompatPatterns));
}

/**
 * The narrow lane a whole change falls in, or `full` for everything else
 * (#889). Fails safe the same way the risk classifier does: no usable list of
 * changed paths, or a path that normalises to nothing, means the full
 * pipeline. A lane never relaxes a delivery gate -- `.gitlab-ci.yml`'s
 * `classify` job forces `full` on a push to a delivery branch and on the
 * merge request into `main`, both of which run everything.
 */
export function classifyCiLane(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return CI_LANE.FULL;
  const paths = changedPaths.map((path) => normalizePath(path));
  if (paths.some((path) => path.length === 0)) return CI_LANE.FULL;
  if (paths.every((path) => ignorePolicyLanePaths.has(path))) return CI_LANE.IGNORE_POLICY;
  if (paths.every((path) => matchesAny(path, ciLanePatterns))) return CI_LANE.CI;
  return CI_LANE.FULL;
}

export function ciRequirements(changedPaths, options = {}) {
  const risk = classifyCiRisk(changedPaths, options);
  const dependencySnapshotChanged = Array.isArray(changedPaths)
    && changedPaths.some((path) => dependencySnapshotPaths.has(normalizePath(path)));
  return {
    risk,
    lane: classifyCiLane(changedPaths),
    build: risk !== CI_RISK.FAST || dependencySnapshotChanged,
    integration: risk === CI_RISK.INTEGRATION || risk === CI_RISK.SYSTEM,
    system: risk === CI_RISK.SYSTEM,
    web: touchesWeb(changedPaths),
    licence: touchesLicencePolicy(changedPaths),
    launcherCompat: touchesLauncherInstallCompat(changedPaths),
  };
}

/** Compatibility helper retained for existing callers and tests. */
export function isNonExecutablePath(path) {
  return pathRisk(path, { productionDependencyGraphChanged: false }) === CI_RISK.FAST;
}

/** Compatibility helper retained for existing callers and tests. */
export function requiresExecutableValidation(changedPaths) {
  return classifyCiRisk(changedPaths) !== CI_RISK.FAST;
}

function changedFilesFromGit(base, head) {
  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter(Boolean);
}

function assertCommitSha(value, name) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? "")) {
    throw new Error(`${name} is not an exact commit SHA`);
  }
}

function writeSnapshotFile(ref, path, targetRoot) {
  const content = execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const target = join(targetRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
}

function productionGraphAt(ref) {
  const snapshotRoot = mkdtempSync(join(tmpdir(), "orbit-production-graph-"));
  try {
    for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      writeSnapshotFile(ref, path, snapshotRoot);
    }
    const output = execFileSync(
      "pnpm",
      ["list", "--prod", "--depth", "Infinity", "--json", "--lockfile-only", "--dir", snapshotRoot],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, CI: "true", NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const graph = JSON.parse(output);
    const identities = new Set();

    function collect(value) {
      if (Array.isArray(value)) {
        for (const entry of value) collect(entry);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (typeof value.from === "string" && typeof value.version === "string") {
        identities.add(`${value.from}@${value.version}|${value.resolved ?? ""}`);
      }
      for (const child of Object.values(value)) collect(child);
    }

    collect(graph);
    return [...identities].sort();
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

export function productionDependencyGraphChanged(base, head) {
  assertCommitSha(base, "ORBIT_BASE_SHA");
  assertCommitSha(head, "ORBIT_HEAD_SHA");
  const baseGraph = productionGraphAt(base);
  const headGraph = productionGraphAt(head);
  return JSON.stringify(baseGraph) !== JSON.stringify(headGraph);
}

function main() {
  const base = process.env.ORBIT_BASE_SHA;
  const head = process.env.ORBIT_HEAD_SHA;

  let risk = CI_RISK.SYSTEM;
  let reason = "no pull-request comparison available";
  let changedPaths = [];
  let graphChanged;
  let comparisonProven = false;

  if (base && head) {
    try {
      assertCommitSha(base, "ORBIT_BASE_SHA");
      assertCommitSha(head, "ORBIT_HEAD_SHA");
      changedPaths = changedFilesFromGit(base, head);
      if (changedPaths.some((path) => dependencySnapshotPaths.has(normalizePath(path)))) {
        graphChanged = productionDependencyGraphChanged(base, head);
      }
      risk = classifyCiRisk(changedPaths, { productionDependencyGraphChanged: graphChanged });
      reason = `${changedPaths.length} changed path(s)`;
      comparisonProven = true;
      for (const path of changedPaths) {
        console.log(`${pathRisk(path, { productionDependencyGraphChanged: graphChanged }).padEnd(11)} ${path}`);
      }
    } catch (error) {
      risk = CI_RISK.SYSTEM;
      reason = "the change comparison or dependency graph could not be proven";
      console.error(`CI risk classification fell back to system validation: ${String(error?.message ?? error)}`);
    }
  }

  const requirements = ciRequirements(changedPaths, {
    productionDependencyGraphChanged: graphChanged,
  });
  // A comparison failure above leaves risk at system even if changedPaths is
  // empty, so preserve that fail-safe result instead of recomputing it.
  const build = risk === CI_RISK.SYSTEM || requirements.build;
  const integration = risk === CI_RISK.SYSTEM || requirements.integration;
  const system = risk === CI_RISK.SYSTEM || requirements.system;
  const web = requirements.web;
  const licence = requirements.licence;
  const launcherCompat = requirements.launcherCompat;
  // A lane is a claim about the whole diff, so a diff that could not be proven
  // has no lane at all -- the same fail-safe the three axes above apply.
  const lane = comparisonProven ? requirements.lane : CI_LANE.FULL;
  console.log(
    `CI risk classification: risk=${risk} lane=${lane} build=${build} integration=${integration} system=${system} web=${web} licence=${licence} launcher_compat=${launcherCompat} (${reason}).`,
  );
  if (graphChanged !== undefined) {
    console.log(`Production dependency graph changed: ${graphChanged}.`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `risk=${risk}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `integration=${integration}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `system=${system}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `web=${web}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `licence=${licence}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `launcher_compat=${launcherCompat}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
