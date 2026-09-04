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

const fastPatterns = [
  /^docs\//u,
  /^\.github\/ISSUE_TEMPLATE\//u,
  /^\.github\/pull_request_template\.md$/u,
  /^\.github\/supply-chain-policy\.json$/u,
  /^\.github\/dependency-review-config\.yml$/u,
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
  /^docker-compose(?:\.[^/]+)?\.ya?ml$/u,
  /^config\//u,
  /^package\.json$/u,
  /^playwright\.config\.[cm]?[jt]s$/u,
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

export function ciRequirements(changedPaths, options = {}) {
  const risk = classifyCiRisk(changedPaths, options);
  const dependencySnapshotChanged = Array.isArray(changedPaths)
    && changedPaths.some((path) => dependencySnapshotPaths.has(normalizePath(path)));
  return {
    risk,
    build: risk !== CI_RISK.FAST || dependencySnapshotChanged,
    integration: risk === CI_RISK.INTEGRATION || risk === CI_RISK.SYSTEM,
    system: risk === CI_RISK.SYSTEM,
    web: touchesWeb(changedPaths),
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
  console.log(
    `CI risk classification: risk=${risk} build=${build} integration=${integration} system=${system} web=${web} (${reason}).`,
  );
  if (graphChanged !== undefined) {
    console.log(`Production dependency graph changed: ${graphChanged}.`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `risk=${risk}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `integration=${integration}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `system=${system}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `web=${web}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
