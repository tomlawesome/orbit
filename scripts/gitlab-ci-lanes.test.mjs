import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CI_LANE, CI_RISK, pathRisk } from "./classify-changed-paths.mjs";

// #889: `classify` hands the pipeline a lane, and each job decides for itself
// whether that lane runs it. Nothing else checks the two halves agree -- a
// mistyped job name in `orbit_lane_admits` reads as a job the lane never
// names, so it would skip in every narrow lane and no test would notice until
// somebody wondered where a check had gone. This is that test.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level blocks by name, the same shape scripts/gitlab-ci-runner-hygiene
// .test.mjs reads: a line that is `name:` at column zero, with or without an
// `&anchor |` after it, up to the next such line.
function blocks() {
  const found = new Map();
  const headers = [...gitlabCi.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):\s*(?:&\S+\s*\|?\s*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : gitlabCi.length;
    found.set(match[1], gitlabCi.slice(start, end));
  });
  return found;
}

const allBlocks = blocks();
const jobs = [...allBlocks].filter(([name]) => !name.startsWith("."));

// The lane membership this pipeline is meant to have. `gitleaks` is named in
// both lanes for the record but has no guard of its own to check: it starts
// before `classify`, so it never sees ORBIT_LANE and always runs.
const laneMembers = {
  [CI_LANE.IGNORE_POLICY]: ["gitleaks", "licence_policy", "supply_chain_source"],
  [CI_LANE.CI]: ["fast", "fast_docker", "gitleaks", "supply_chain_source"],
};

function guardedJobs() {
  return jobs
    .filter(([, block]) => /orbit_lane_admits /u.test(block))
    .map(([name, block]) => ({ name, block }));
}

// A job's `needs:` as text, following the shared anchors #898 introduced: the
// gating waits are written once and taken by name, so the list a job really
// has is the anchor's, not the one line that references it.
function needsOf(block) {
  const reference = block.match(/^ {2}needs: \*(\S+)$/mu);
  if (!reference) return block;
  const anchor = allBlocks.get(`.${reference[1]}`);
  expect(anchor, `no hidden key defines *${reference[1]}`).toBeDefined();
  return anchor;
}

// Every `<lane>:<job>)` pattern the shell function matches, as pairs. The
// function is a `case` over "$ORBIT_LANE:$jobname", so its patterns are the
// membership lists themselves.
function admissions() {
  const helper = allBlocks.get(".reach_helpers");
  const body = helper.slice(helper.indexOf("orbit_lane_admits() {"));
  const arms = [...body.matchAll(/^ {6}(\S.*?)\) return 0 ;;$/gmu)];
  return arms.flatMap((arm) =>
    arm[1].split(" | ").map((pattern) => {
      const [lane, job] = pattern.split(":");
      return [lane, job];
    }),
  );
}

// The half of `classify` that turns the classifier's output into the dotenv
// artifact every other job reads: the delivery-branch and promotion collapse
// (#883/#889) and the `ci: acceptance` override (#572) all live in it. Run,
// not read: these are shell decisions, and a regex over them would pass on a
// version that decided the opposite.
function classifyEnvScript() {
  const classify = allBlocks.get("classify");
  const start = classify.indexOf("      set -eu\n      # Runs in a command substitution");
  const end = classify.indexOf("      cat classify.env");
  expect(start, "the classify env block moved").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return classify
    .slice(start, end + "      cat classify.env".length)
    .split("\n")
    .map((line) => line.replace(/^ {6}/u, ""))
    .join("\n");
}

// One run of that block against a synthetic classifier output, returning the
// dotenv it wrote. The output says `fast` and the CI lane throughout, so
// anything that comes back `true` came from an override rather than the diff.
function runClassifyEnv(environment = {}) {
  const directory = mkdtempSync(join(tmpdir(), "orbit-classify-env-"));
  try {
    writeFileSync(
      join(directory, "classify-output.txt"),
      [
        "risk=fast",
        "lane=ci",
        "build=false",
        "integration=false",
        "system=false",
        "web=false",
        "licence=false",
        "launcher_compat=false",
        "",
      ].join("\n"),
      "utf8",
    );
    const stdout = execFileSync("sh", ["-c", classifyEnvScript()], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...environment },
    });
    const written = readFileSync(join(directory, "classify.env"), "utf8");
    return {
      stdout,
      variables: Object.fromEntries(
        written
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")),
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const everythingOn = {
  ORBIT_RISK: "system",
  ORBIT_BUILD: "true",
  ORBIT_INTEGRATION: "true",
  ORBIT_SYSTEM: "true",
  ORBIT_WEB: "true",
  ORBIT_LICENCE: "true",
  ORBIT_LAUNCHER_COMPAT: "true",
  ORBIT_LANE: "full",
};

describe("pipeline lanes", () => {
  it("guards every job a narrow lane can skip", () => {
    // sidecar_images left this list in #944 (owner ruling on #923 rec 16a,
    // 2026-09-09): it no longer waits for ORBIT_LANE/ORBIT_SYSTEM inside
    // `script:`, and decides entirely from `rules: changes:` instead, which
    // needs no dotenv artifact and so needs no wait for one.
    expect(guardedJobs().map(({ name }) => name).sort()).toEqual([
      "acceptance",
      "base_image",
      "build_image",
      "fast",
      "fast_docker",
      "fidelity",
      "integration",
      // #1076: it consumes build_image's artifact, so it has to stop on a
      // lane that skipped the build rather than load the placeholder.
      "launcher_install_compat",
      "licence_policy",
      "repair_journeys",
      "smoke",
      "smoke_local_only",
      "supply_chain_image",
      "supply_chain_source",
    ]);
  });

  it("passes each job its own name, so a lane list means what it says", () => {
    for (const { name, block } of guardedJobs()) {
      const calls = [...block.matchAll(/orbit_lane_admits (\S+)/gu)].map((match) => match[1]);
      expect(calls).toEqual([name]);
    }
  });

  it("defines the helpers before calling them, and waits for the lane", () => {
    for (const { name, block } of guardedJobs()) {
      // Same shell, so *reach_helpers has to come first in `script:`.
      expect(block.indexOf("*reach_helpers"), name).toBeGreaterThan(-1);
      expect(block.indexOf("*reach_helpers"), name).toBeLessThan(block.indexOf("orbit_lane_admits"));
      // ORBIT_LANE arrives as a dotenv artifact, so a job that reads it must
      // need `classify` and take its artifacts.
      expect(/- job: classify\n\s+artifacts: true\n/u.test(needsOf(block)), name).toBe(true);
    }
  });

  it("names the classifier's lanes and only those", () => {
    const named = new Set(admissions().map(([lane]) => lane));
    expect([...named].sort()).toEqual([CI_LANE.CI, CI_LANE.FULL, CI_LANE.IGNORE_POLICY].sort());
  });

  it("runs exactly the jobs each lane is meant to run", () => {
    for (const [lane, expected] of Object.entries(laneMembers)) {
      const admitted = admissions()
        .filter(([candidate]) => candidate === lane)
        .map(([, job]) => job);
      expect([...new Set(admitted)].sort(), lane).toEqual([...expected].sort());
    }
    // The full lane admits everything with one wildcard rather than a list.
    expect(admissions().filter(([lane]) => lane === CI_LANE.FULL)).toEqual([[CI_LANE.FULL, "*"]]);
  });

  /*
   * #572's opt-in half. Everything else here reads the diff, so a merge
   * request could only ever be made cheaper; `ci: acceptance` is how one asks
   * for the whole pipeline back.
   */
  it("leaves the classifier's verdict alone without the label", () => {
    for (const labels of [undefined, "", "bug,area: ci", "ci: acceptance-later", "ci"]) {
      const { variables, stdout } = runClassifyEnv(
        labels === undefined ? {} : { CI_MERGE_REQUEST_LABELS: labels },
      );
      expect(variables, String(labels)).toEqual({
        ORBIT_RISK: "fast",
        ORBIT_BUILD: "false",
        ORBIT_INTEGRATION: "false",
        ORBIT_SYSTEM: "false",
        ORBIT_WEB: "false",
        ORBIT_LICENCE: "false",
        // The CI lane does not run launcher_install_compat, and the lane
        // survives because nothing overrode it.
        ORBIT_LAUNCHER_COMPAT: "false",
        ORBIT_LANE: "ci",
      });
      expect(stdout).not.toMatch(/ci: acceptance/u);
    }
  });

  it("turns every flag on for a merge request labelled ci: acceptance", () => {
    for (const labels of [
      "ci: acceptance",
      "bug,ci: acceptance,area: ci",
      // GitLab joins with bare commas today; a spaced join still matches.
      "bug, ci: acceptance, area: ci",
    ]) {
      const { variables, stdout } = runClassifyEnv({ CI_MERGE_REQUEST_LABELS: labels });
      expect(variables, labels).toEqual(everythingOn);
      // It says so, so a full run on a trivial diff is never a mystery.
      expect(stdout).toMatch(/labelled 'ci: acceptance'/u);
    }
  });

  it("still collapses the lane for a delivery push and the promotion gate", () => {
    expect(runClassifyEnv({ CI_COMMIT_BRANCH: "dev" }).variables.ORBIT_LANE).toBe("full");
    expect(runClassifyEnv({ CI_COMMIT_BRANCH: "main" }).variables.ORBIT_LANE).toBe("full");
    expect(runClassifyEnv({ CI_COMMIT_BRANCH: "hotfix/x" }).variables.ORBIT_LANE).toBe("full");
    expect(runClassifyEnv({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" }).variables.ORBIT_LANE)
      .toBe("full");
    // A delivery push widens the lane without claiming the diff was riskier
    // than it was: only the label rewrites the axes.
    expect(runClassifyEnv({ CI_COMMIT_BRANCH: "dev" }).variables.ORBIT_SYSTEM).toBe("false");
  });

  it("hands the lane on from classify as a dotenv variable", () => {
    const classify = allBlocks.get("classify");
    expect(classify).toMatch(/printf 'ORBIT_LANE=%s\\n' "\$lane" >> classify\.env/u);
    // A lane is a merge-request economy: every delivery push and the merge
    // request into `main` collapse it to `full` and run everything.
    expect(classify).toMatch(/dev \| preview \| main \| hotfix\/\*\) lane=full ;;/u);
    expect(classify).toMatch(/CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-\}" = "main" \]/u);
  });
});

// #1078 (owner ruling 2026-09-21): a push to `dev` now tests what the push
// changed, and the full gate -- the catch-all sanity check against accidental
// drift -- moves to the dev -> preview merge request. These run the real
// `.reach_helpers` and `.system_lane_gate` shell against a synthetic event,
// the same way `runClassifyEnv` above runs `classify`'s own shell: read, not
// re-implemented, so a change to the real gate is what these see.
function hiddenBlockScript(name) {
  return allBlocks
    .get(name)
    .split("\n")
    .slice(1) // drop the "<name>: &<anchor> |" header line
    .map((line) => line.replace(/^ {2}/u, ""))
    .join("\n");
}

// Ends with a marker so a run that falls through the gate (rather than
// hitting its own `exit 0`) is distinguishable from one that never reached
// the marker for some unrelated reason.
function runSystemLaneGate(environment = {}) {
  const script = `${hiddenBlockScript(".reach_helpers")}\n${hiddenBlockScript(".system_lane_gate")}\necho REACHED_AFTER_GATE`;
  return execFileSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });
}

describe("orbit_on_delivery_branch / orbit_full_gate / .system_lane_gate (#1078)", () => {
  it("no longer treats a push to dev as the full gate", () => {
    const stdout = runSystemLaneGate({ CI_COMMIT_BRANCH: "dev", ORBIT_LANE: "full", ORBIT_SYSTEM: "false" });
    expect(stdout).toContain("skipped: no system-risk change");
    expect(stdout).not.toContain("REACHED_AFTER_GATE");
  });

  it("still runs the system lane on a dev push that carries system risk", () => {
    const stdout = runSystemLaneGate({ CI_COMMIT_BRANCH: "dev", ORBIT_LANE: "full", ORBIT_SYSTEM: "true" });
    expect(stdout).not.toContain("skipped");
    expect(stdout).toContain("REACHED_AFTER_GATE");
  });

  it("still runs the system lane unconditionally on preview, main and hotfix pushes", () => {
    for (const branch of ["preview", "main", "hotfix/x"]) {
      const stdout = runSystemLaneGate({ CI_COMMIT_BRANCH: branch, ORBIT_LANE: "full", ORBIT_SYSTEM: "false" });
      expect(stdout, branch).not.toContain("skipped");
      expect(stdout, branch).toContain("REACHED_AFTER_GATE");
    }
  });

  it("runs the full gate on the dev -> preview merge request, whatever the diff holds", () => {
    const stdout = runSystemLaneGate({
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview",
      ORBIT_LANE: "full",
      ORBIT_SYSTEM: "false",
    });
    expect(stdout).not.toContain("skipped");
    expect(stdout).toContain("REACHED_AFTER_GATE");
  });

  it("still runs the full gate on the preview -> main merge request", () => {
    const stdout = runSystemLaneGate({
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
      ORBIT_LANE: "full",
      ORBIT_SYSTEM: "false",
    });
    expect(stdout).not.toContain("skipped");
    expect(stdout).toContain("REACHED_AFTER_GATE");
  });

  it("skips an ordinary merge request with no system risk, same as before", () => {
    const stdout = runSystemLaneGate({
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev",
      ORBIT_LANE: "full",
      ORBIT_SYSTEM: "false",
    });
    expect(stdout).toContain("skipped: no system-risk change");
    expect(stdout).not.toContain("REACHED_AFTER_GATE");
  });
});

// A `dir/**/*` pattern or an exact path, which is all sidecar_images' list
// (below) uses -- enough to check the list against the classifier's own
// verdict without a real glob library.
function matchesChangesPattern(pattern, path) {
  if (!pattern.includes("*")) return pattern === path;
  if (pattern.endsWith("/**/*")) {
    const dir = pattern.slice(0, -"/**/*".length);
    return path === dir || path.startsWith(`${dir}/`);
  }
  throw new Error(`unhandled changes: pattern shape: ${pattern}`);
}

// #944 (owner ruling on #923 rec 16a, 2026-09-09): sidecar_images used to
// queue for a `big` slot and only then, inside `script:`, read ORBIT_SYSTEM
// from classify's dotenv artifact and decide there was nothing to do.
// `rules:` cannot read that artifact -- it is evaluated before any job runs
// -- so the decision moved to `rules: changes:`, which reads the merge diff
// directly.
describe("sidecar_images: the system-lane gate moved into rules: changes: (#944)", () => {
  const sidecarImages = () => allBlocks.get("sidecar_images");

  function changesList(job) {
    const start = job.indexOf("      changes:\n");
    const end = job.indexOf("\n    - when: manual", start);
    expect(start, "no changes: block on sidecar_images' merge-request rule").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return [...job.slice(start, end).matchAll(/^ {10}- (\S+)$/gmu)].map((match) => match[1]);
  }

  it("no longer waits on ORBIT_LANE or ORBIT_SYSTEM inside script:", () => {
    const job = sidecarImages();
    const script = job.slice(job.indexOf("\n  script:\n"));
    // Comments above the job still explain the move away from these in
    // prose; only the script's own use of them (now removed) matters here.
    expect(script).not.toContain("orbit_lane_admits sidecar_images");
    expect(script).not.toContain("*system_lane_gate");
    expect(script).not.toContain("*reach_helpers");
  });

  it("always runs on every delivery branch and on a merge request into main, unconditionally", () => {
    const job = sidecarImages();
    // Neither rule carries a `changes:` clause, matching what
    // `orbit_full_gate` gave every job that still calls `.system_lane_gate`.
    expect(job).toMatch(
      /- if: \$CI_COMMIT_BRANCH == "dev" \|\| \$CI_COMMIT_BRANCH == "preview" \|\| \$CI_COMMIT_BRANCH == "main" \|\| \$CI_COMMIT_BRANCH =~ \/\^hotfix\\\/\/\n {4}- if: \$CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"\n {4}- if: \$CI_PIPELINE_SOURCE == "merge_request_event"\n/u,
    );
  });

  it("covers every path the classifier calls explicit system risk", () => {
    const listed = changesList(sidecarImages());
    const explicitSystemPaths = [
      ".github/workflows/deploy.yml",
      "Dockerfile",
      "docker-compose.yml",
      "compose/docker-compose.test.yml",
      "config/some-setting.json",
      "package.json",
      "drizzle/0001_init.sql",
      "tests/e2e/some.spec.ts",
      "web/src/App.svelte",
      "src/lib/auth/session.ts",
      "src/server/boot/index.ts",
      "scripts/backup.sh",
    ];
    for (const path of explicitSystemPaths) {
      expect(pathRisk(path), path).toBe(CI_RISK.SYSTEM);
      expect(
        listed.some((pattern) => matchesChangesPattern(pattern, path)),
        `${path} not covered by sidecar_images' changes: list`,
      ).toBe(true);
    }
  });

  it("also covers the classifier's catch-all default, including .gitleaksignore", () => {
    const listed = changesList(sidecarImages());
    // classifyCiRisk defaults an unmatched path to system risk -- the
    // fail-safe `rules:` cannot read (there is no dotenv to fall back to),
    // so the list has to be wide enough to catch it too. .gitleaksignore is
    // the sharpest example: nothing in fastPatterns or systemPatterns names
    // it, so it is system risk by that same default, even though the now-
    // removed `ignore_policy` lane used to keep it away from this job by a
    // different route entirely.
    const catchAllPaths = ["cosign.pub", "tsconfig.json", "demo-tls/ca.pem", "design/notes.fig", ".gitleaksignore"];
    for (const path of catchAllPaths) {
      expect(pathRisk(path), path).toBe(CI_RISK.SYSTEM);
      expect(listed.some((pattern) => matchesChangesPattern(pattern, path)), path).toBe(true);
    }
  });

  it("leaves out only what the classifier calls fast: docs, root markdown, LICENSE, .gitignore", () => {
    const listed = changesList(sidecarImages());
    for (const path of ["docs/setup.md", "README.md", "AGENTS.md", "LICENSE", ".gitignore"]) {
      expect(pathRisk(path), path).not.toBe(CI_RISK.SYSTEM);
      expect(listed.some((pattern) => matchesChangesPattern(pattern, path)), path).toBe(false);
    }
  });
});
