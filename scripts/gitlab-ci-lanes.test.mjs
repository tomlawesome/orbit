import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { CI_LANE, CI_RISK, pathRisk } from "./classify-changed-paths.mjs";
// A namespace import: a missing export fails the one test that reads it, not the file.
import * as nightlyBrowsers from "./ci/nightly-browsers.mjs";
import { UPGRADE_FROM_COUNT } from "./ci/upgrade-versions.mjs";
import { jobBlocks } from "./test-support/gitlab-ci.mjs";

// #889: `classify` hands the pipeline a lane, and each job decides for itself
// whether that lane runs it. Nothing else checks the two halves agree -- a
// mistyped job name in `orbit_lane_admits` reads as a job the lane never
// names, so it would skip in every narrow lane and no test would notice until
// somebody wondered where a check had gone. This is that test.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level blocks by name: the shared reader (#1362).
const allBlocks = jobBlocks(gitlabCi);
// The text of a job's `rules:` entries, indented four spaces. A job whose
// `rules:` is one alias (`rules: *browser_suite_rules`, #1362) reads it from
// the hidden key that holds the list.
function rulesText(name) {
  const block = allBlocks.get(name);
  const whole = block.match(/\n {2}rules: \*(\S+)\n/u);
  if (whole) {
    const hidden = allBlocks.get(`.${whole[1]}`);
    return hidden
      .split("\n")
      .slice(1)
      .map((line) => (line === "" ? line : `  ${line}`))
      .join("\n");
  }
  return block.match(/\n {2}rules:\n((?: {4}[^\n]*\n| *\n)*)/u)?.[1] ?? null;
}

const jobs = [...allBlocks].filter(([name]) => !name.startsWith("."));

// The lane membership this pipeline is meant to have. `gitleaks` is named in
// both lanes for the record but has no guard of its own to check: it starts
// before `classify`, so it never sees ORBIT_LANE and always runs. So does
// `private-details` (#1562).
const laneMembers = {
  [CI_LANE.IGNORE_POLICY]: ["gitleaks", "licence_policy", "private-details", "supply_chain_source"],
  [CI_LANE.CI]: ["fast", "fast_checks", "fast_docker", "gitleaks", "private-details", "supply_chain_source"],
  // #1597: a proven empty diff runs the same four as the ignore/policy lane.
  // Spelled as a literal, not CI_LANE.NO_CHANGE, so the key means what it says
  // whether or not the classifier exports the constant yet.
  no_change: ["gitleaks", "licence_policy", "private-details", "supply_chain_source"],
};

function guardedJobs() {
  return jobs
    .map(([name, block]) => ({ name, ...withTemplate(name, block) }))
    .filter(({ block }) => /orbit_lane_admits /u.test(block));
}

// A job's text with the hidden template it `extends:`, and the name its lane
// check goes by: the template's, when the check is in the template
// (build_launcher and build_launcher_branch share .build_launcher's script and
// are one job to the lanes, #1608).
function withTemplate(name, block) {
  const parent = block.match(/^ {2}extends: (\.\S+)$/mu);
  if (!parent || !allBlocks.has(parent[1])) return { block, lane: name };
  const template = allBlocks.get(parent[1]);
  const lane = /orbit_lane_admits /u.test(block) ? name : parent[1].slice(1);
  return { block: `${block}\n${template}`, lane };
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
// `classifierLane` is what the classifier said the lane was (#1597 added
// `no_change`, which comes with every axis off).
function runClassifyEnv(environment = {}, classifierLane = "ci") {
  const directory = mkdtempSync(join(tmpdir(), "orbit-classify-env-"));
  try {
    // The block reads the branch table from the repository (#1362), so the
    // scratch directory the job runs in carries that one script.
    mkdirSync(join(directory, "scripts", "ci"), { recursive: true });
    copyFileSync(new URL("./ci/branch-class.sh", import.meta.url), join(directory, "scripts", "ci", "branch-class.sh"));
    writeFileSync(
      join(directory, "classify-output.txt"),
      [
        "risk=fast",
        `lane=${classifierLane}`,
        "build=false",
        "integration=false",
        "system=false",
        "web=false",
        "e2e=false",
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
  ORBIT_E2E: "true",
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
      // ADR-0031 #3: builds the pinned launcher, but needs nothing from
      // build_image -- it is guarded because it shares *launcher_compat_rules
      // with launcher_install_compat (which does consume build_image), not
      // because it has the #1076 placeholder problem itself.
      "build_launcher",
      // #1608: the same build on every ref but the release branches.
      "build_launcher_branch",
      "fast",
      "fast_checks",
      "fast_docker",
      // #1692: the phone film, split out of rig_webkit.
      "film_webkit",
      "integration",
      // #1076: it consumes build_image's artifact, so it has to stop on a
      // lane that skipped the build rather than load the placeholder.
      "launcher_install_compat",
      "licence_policy",
      // #1616: the nightly tap-floor measurement.
      "pocket_measure",
      "repair_journeys",
      // #1615 (ADR-0039 section 4): the rig jobs replace fidelity and
      // fidelity_webkit; Firefox runs the rig, so smoke_firefox is gone.
      "rig_chromium",
      "rig_firefox",
      "rig_webkit",
      // #1546: the Chromium pixel screens left rig_chromium and are guarded like it.
      "screens_chromium",
      "smoke",
      "smoke_local_only",
      "smoke_webkit",
      "smoke_webkit_mobile",
      "supply_chain_image",
      "supply_chain_source",
      // #1665: the upgrade matrix (the merge request into preview and hotfix pushes, 59a).
      "upgrade_cell",
      "upgrade_cell_launcher",
    ]);
  });

  it("passes each job its own name, so a lane list means what it says", () => {
    for (const { name, block, lane } of guardedJobs()) {
      const calls = [...block.matchAll(/orbit_lane_admits (\S+)/gu)].map((match) => match[1]);
      expect(calls, name).toEqual([lane]);
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
    expect([...named].sort()).toEqual([CI_LANE.CI, CI_LANE.FULL, CI_LANE.IGNORE_POLICY, "no_change"].sort());
  });

  it("exports no_change as a lane value", () => {
    expect(CI_LANE.NO_CHANGE).toBe("no_change");
  });

  // #1597: the empty-diff lane runs gitleaks, licence_policy, private-details
  // and supply_chain_source, and every other guarded job reports itself
  // skipped. Run, not read: the shell function itself, once per job.
  it("admits exactly four jobs in the no_change lane and no others (#1597)", () => {
    const helpers = hiddenBlockScript(".reach_helpers");
    const verdict = (lane, job) => {
      try {
        const stdout = execFileSync("sh", ["-c", `${helpers}\norbit_lane_admits ${job}`], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, ORBIT_LANE: lane },
        });
        return { admitted: true, stdout };
      } catch (error) {
        return { admitted: false, stdout: String(error.stdout) };
      }
    };
    const everyJob = new Set(["classify", "flake_check", ...jobs.map(([name]) => name), ...laneMembers.no_change]);
    const admitted = [...everyJob].filter((job) => verdict("no_change", job).admitted).sort();
    expect(admitted).toEqual(["gitleaks", "licence_policy", "private-details", "supply_chain_source"]);
    for (const job of ["fast", "fast_checks", "fast_docker", "build_image", "integration", "smoke", "acceptance"]) {
      const { admitted: ran, stdout } = verdict("no_change", job);
      expect(ran, job).toBe(false);
      expect(stdout.trim(), job).toBe(`skipped: the no_change lane does not run ${job} (#889)`);
    }
  });

  it("documents the no_change lane in the lane comment block (#1597)", () => {
    const helper = allBlocks.get(".reach_helpers");
    const comment = helper.slice(0, helper.indexOf("orbit_lane_admits() {"));
    expect(comment).toMatch(/^ {2}#\s+no_change\s/mu);
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
  /**
   * #1092, found while building #1078: `orbit_lane_admits` is consulted before
   * `orbit_full_gate` is ever reached, so a promotion sitting in a narrow lane
   * would skip the acceptance stage however emphatically the full gate said
   * yes. That was survivable while a `dev` push ran everything. #1078 moved
   * that catch-all onto this promotion, so a promotion that can still skip is
   * the one thing it cannot afford.
   *
   * Asserted against the lane the classifier actually emits, not against a
   * handed-in `ORBIT_LANE: "full"` -- the gate tests below assume the lane is
   * already full, which is precisely the assumption that was wrong.
   */
  it("collapses the lane to full on both promotions, even on a narrow diff", () => {
    for (const target of ["preview", "main"]) {
      const { variables } = runClassifyEnv({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: target });
      expect(variables.ORBIT_LANE, `${target}: a promotion must not sit in a narrow lane`).toBe("full");
    }
  });

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
        ORBIT_E2E: "false",
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

  /*
   * #1597: `no_change` is a merge-request and branch-pipeline economy like the
   * other narrow lanes. The classifier says it with every axis off; the events
   * that run everything must still turn it into `full`.
   */
  it("passes no_change through on an ordinary merge request or branch pipeline (#1597)", () => {
    for (const environment of [
      {},
      { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev" },
      { CI_COMMIT_BRANCH: "feature/x" },
      { CI_MERGE_REQUEST_LABELS: "bug,area: ci" },
    ]) {
      const { variables } = runClassifyEnv(environment, "no_change");
      expect(variables.ORBIT_LANE, JSON.stringify(environment)).toBe("no_change");
      expect(variables.ORBIT_RISK).toBe("fast");
      expect(variables.ORBIT_BUILD).toBe("false");
      expect(variables.ORBIT_INTEGRATION).toBe("false");
      expect(variables.ORBIT_SYSTEM).toBe("false");
      expect(variables.ORBIT_WEB).toBe("false");
      expect(variables.ORBIT_E2E).toBe("false");
      expect(variables.ORBIT_LICENCE).toBe("false");
      expect(variables.ORBIT_LAUNCHER_COMPAT).toBe("false");
    }
  });

  it("collapses no_change to full on every event that runs everything (#1597)", () => {
    for (const environment of [
      { CI_COMMIT_BRANCH: "dev" },
      { CI_COMMIT_BRANCH: "preview" },
      { CI_COMMIT_BRANCH: "main" },
      { CI_COMMIT_BRANCH: "hotfix/x" },
      { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview" },
      { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" },
      { CI_MERGE_REQUEST_LABELS: "ci: acceptance" },
      { CI_MERGE_REQUEST_LABELS: "bug, ci: acceptance" },
      { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", ORBIT_NIGHTLY_BROWSERS: "true" },
      { CI_PIPELINE_SOURCE: "schedule", ORBIT_NIGHTLY_BROWSERS: "true" },
    ]) {
      const { variables } = runClassifyEnv(environment, "no_change");
      expect(variables.ORBIT_LANE, JSON.stringify(environment)).toBe("full");
    }
  });

  it("still turns every axis on for the label when the classifier said no_change (#1597)", () => {
    const { variables } = runClassifyEnv({ CI_MERGE_REQUEST_LABELS: "ci: acceptance" }, "no_change");
    expect(variables).toEqual(everythingOn);
  });

  // #1181: the browser suite has its own axis, and every job that runs it
  // reads that axis rather than the front-end one the rig jobs read.
  it("gates every browser-suite job on ORBIT_E2E", () => {
    for (const name of ["smoke", "smoke_webkit", "smoke_webkit_mobile"]) {
      const block = allBlocks.get(name);
      const suite = block.indexOf("bash scripts/test-frontend.sh");
      const gate = block.lastIndexOf('if [ "${ORBIT_E2E:-true}" != "true" ]; then', suite);
      expect(gate, `${name}: the browser suite is not behind ORBIT_E2E`).toBeGreaterThan(-1);
      expect(block, name).not.toMatch(/\$\{ORBIT_WEB/u);
    }
    expect(runClassifyEnv().variables.ORBIT_E2E).toBe("false");
  });

  /*
   * #1186: the promotion is where the whole suite runs again (#1078), but the
   * browser checks read their own axes, which came from the diff alone. A
   * promotion with no web change skipped `fidelity` and both browser suites.
   * The events `orbit_full_gate` names now switch those axes on; a `dev` push
   * still tests only what it changed.
   */
  it("runs every browser check on the promotions and on delivery pushes (#1186)", () => {
    for (const environment of [
      { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview" },
      { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" },
      { CI_COMMIT_BRANCH: "preview" },
      { CI_COMMIT_BRANCH: "main" },
      { CI_COMMIT_BRANCH: "hotfix/x" },
    ]) {
      const { variables } = runClassifyEnv(environment);
      const event = JSON.stringify(environment);
      expect(variables.ORBIT_WEB, event).toBe("true");
      expect(variables.ORBIT_E2E, event).toBe("true");
      // Only the browser axes: the rest still say what the diff carried.
      expect(variables.ORBIT_SYSTEM, event).toBe("false");
    }
    for (const environment of [
      { CI_COMMIT_BRANCH: "dev" },
      { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev" },
      { CI_COMMIT_BRANCH: "feature/x" },
    ]) {
      const { variables } = runClassifyEnv(environment);
      expect(variables.ORBIT_WEB, JSON.stringify(environment)).toBe("false");
      expect(variables.ORBIT_E2E, JSON.stringify(environment)).toBe("false");
    }
  });

  /*
   * #1187: a run that skipped its browser suite must leave no reuse evidence,
   * or a later merge-request pipeline with the same key -- the promotion
   * among them -- stands on it and never runs the suite. Run, not read: the
   * gate entry and everything after it share one shell, so what matters is
   * whether the shell gets as far as `*reuse_evidence`.
   */
  it("leaves no reuse evidence when a smoke job skips its browser suite (#1187)", () => {
    for (const name of ["smoke", "smoke_webkit", "smoke_webkit_mobile"]) {
      const block = allBlocks.get(name);
      const scriptStart = block.indexOf("\n  script:\n");
      const scriptEnd = block.indexOf("\n  after_script:\n");
      const entries = block
        .slice(scriptStart, scriptEnd)
        .split(/\n {4}- /u)
        .slice(1);
      const gate = entries.findIndex((entry) => entry.includes('"${ORBIT_E2E:-true}" != "true"'));
      expect(gate, `${name}: no ORBIT_E2E gate`).toBeGreaterThan(-1);
      const after = entries.slice(gate + 1);
      expect(after.some((entry) => entry.startsWith("bash scripts/test-frontend.sh")), name).toBe(true);
      /* Evidence is the last step, but for #1447's warning exit after it. */
      const tail = after.at(-1).startsWith("if [ -f .quarantine-failed ]") ? after.at(-2) : after.at(-1);
      expect(tail.split("\n")[0], name).toBe("*reuse_evidence");
      // The gate entry itself, then a stand-in for every later entry.
      const shell = `${entries[gate].replace(/^\|\n/u, "").replace(/^ {6}/gmu, "")}\necho REACHED_EVIDENCE\n`;
      const run = (value) =>
        execFileSync("sh", ["-c", shell], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, ORBIT_E2E: value },
        });
      expect(run("false"), `${name}: a skipped suite reached *reuse_evidence`).not.toMatch(/REACHED_EVIDENCE/u);
      expect(run("true"), name).toMatch(/REACHED_EVIDENCE/u);
    }
  });

  it("shows a failed quarantined test as a warning, after the gate and its evidence (#1447, owner 13a)", () => {
    for (const name of ["rig_chromium", "rig_firefox", "rig_webkit", "film_webkit", "screens_chromium", "smoke", "smoke_webkit", "smoke_webkit_mobile"]) {
      const block = allBlocks.get(name);
      expect(block, `${name}: only exit 3 is allowed to fail`).toMatch(/\n  allow_failure:\n    exit_codes:\n      - 3\n/u);
      // Commented-out lines do not run (T-Q37): look for the quarantine run in the
      // job's commands only, so deleting or commenting it out cannot hide behind the word.
      const commands = block.split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
      expect(commands, `${name}: the quarantine run marks its failure`).toMatch(/--quarantine|:quarantine/u);
      expect(commands, name).toMatch(/\|\| \{ echo "[a-z_]+: a quarantined test failed[^"]*"; touch \.quarantine-failed; \}/u);
      expect(block, `${name}: the warning exit comes straight after the evidence`)
        .toMatch(/\n {4}- \*reuse_evidence\n(?: {4}#[^\n]*\n)* {4}- if \[ -f \.quarantine-failed \]; then exit 3; fi\n/u);
    }
  });

  /*
   * #1536 G3-R2: `allow_failure: exit_codes: [3]` is the job's whole tolerance
   * (a quarantined test failed). A rule-level `allow_failure: true` on the
   * manual rule replaces it for the pipelines that rule matches, so a failed
   * suite in a manually started smoke job showed as a warning. The rules a job
   * names by anchor (`- *not_scheduled`) are read from their hidden key too.
   */
  it("lets no rule of a smoke job override its allow_failure exit code list (#1536 G3-R2)", () => {
    for (const name of ["smoke", "smoke_webkit", "smoke_webkit_mobile"]) {
      const block = allBlocks.get(name);
      expect(block, name).toBeDefined();
      const rules = rulesText(name);
      expect(rules, `${name}: no rules block`).not.toBeNull();
      const entries = rules.split(/\n(?= {4}- )/u);
      for (const entry of entries) {
        const reference = entry.match(/^ {4}- \*(\S+)\s*$/u);
        const text = reference ? (allBlocks.get(`.${reference[1]}`) ?? entry) : entry;
        expect(text, `${name}: rule ${entry.trim()} sets allow_failure: true, which overrides exit_codes: [3]`)
          .not.toMatch(/allow_failure:\s*true\b/u);
      }
      // The job's own list is still what decides.
      expect(block, name).toMatch(/\n {2}allow_failure:\n {4}exit_codes:\n {6}- 3\n/u);
    }
  });

  it("hands the lane on from classify as a dotenv variable", () => {
    const classify = allBlocks.get("classify");
    expect(classify).toMatch(/printf 'ORBIT_LANE=%s\\n' "\$lane" >> classify\.env/u);
    // A lane is a merge-request economy: every delivery push and both
    // promotions collapse it to `full` and run everything. `preview` joined
    // `main` on #1092, because #1078 made that promotion the catch-all.
    expect(classify).toMatch(/dev \| preview \| main \| hotfix\) lane=full ;;/u);
    expect(classify).toMatch(/CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-\}" in\n\s+preview \| main\) lane=full ;;/u);
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

/*
 * #1412 (owner ruling 2026-10-22): browsers are slow, so a merge request into
 * `dev` and the push that lands it start none of the seven browser jobs. They
 * run at promotion (the dev -> preview merge request and the `preview` push)
 * and every night on `dev` from one named schedule.
 *
 * Which jobs a pipeline event starts is decided by `workflow:rules` and each
 * job's `rules:`, evaluated here with the small subset of GitLab's rule
 * language this file uses (`==`, `!=`, `=~`, `&&`, `||`, parentheses, bare
 * variables) rather than read as text: a regex over the rules would pass on a
 * rule that said the opposite.
 */
const BROWSER_JOBS = [
  "smoke",
  "smoke_webkit",
  "smoke_webkit_mobile",
  "smoke_local_only",
  // #1615 (ADR-0039 section 4): the rig, on the light runners.
  "rig_chromium",
  "rig_firefox",
  "rig_webkit",
  // #1692: the phone film, split out of rig_webkit.
  "film_webkit",
  // #1546: the Chromium pixel screens, split out of rig_chromium.
  "screens_chromium",
];
// #1763: these four run only in the nightly browser pipeline; the other
// browser jobs keep their promotion rules.
const NIGHTLY_ONLY_JOBS = ["rig_chromium", "rig_firefox", "rig_webkit", "film_webkit"];
const PROMOTION_BROWSER_JOBS = BROWSER_JOBS.filter((name) => !NIGHTLY_ONLY_JOBS.includes(name));
// What the nightly needs besides the browsers: the build and the image.
// fast_checks since #1831: it publishes the web/build the rig jobs serve.
const NIGHTLY_SUPPORT_JOBS = ["classify", "fast", "fast_checks", "build_image"];

// The `rules:` list of a block as [{ if, when }], with `- *alias` entries
// replaced by the hidden key's own rule (or, when the hidden key is itself a
// rules list, by its rules, flattened as GitLab does, #1608), and
// `rules: *alias` followed to the hidden list. A `changes:` condition is not
// evaluated (nothing here asks about one). A job with no `rules:` at all
// starts in every pipeline, as it does in GitLab, so it comes back as one rule
// that always matches.
function rulesOf(name) {
  const block = allBlocks.get(name);
  const lines = block.split("\n");
  const whole = lines.find((line) => /^ {2}rules: \*\S+$/u.test(line));
  if (whole) return listRules(allBlocks.get(`.${whole.match(/\*(\S+)$/u)[1]}`).split("\n").slice(1), 2);
  const start = lines.indexOf("  rules:");
  if (start === -1) return [{}];
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/u.test(line)) break; // the next key of the job
    entries.push(line);
  }
  return listRules(entries, 4);
}

function listRules(entries, indent) {
  const lead = " ".repeat(indent);
  const rules = [];
  for (const line of entries) {
    if (/^\s*(#.*)?$/u.test(line)) continue;
    const alias = line.match(new RegExp(`^${lead}- \\*(\\S+)$`, "u"));
    if (alias) {
      const hidden = allBlocks.get(`.${alias[1]}`);
      expect(hidden, `no hidden key defines *${alias[1]}`).toBeDefined();
      const body = hidden.split("\n").slice(1);
      if (body.some((entry) => /^ {2}- /u.test(entry))) {
        rules.push(...listRules(body, 2));
        continue;
      }
      const rule = {};
      for (const entry of hidden.split("\n").slice(1)) {
        const pair = entry.match(/^ {2}(if|when|allow_failure): (.*)$/u);
        if (pair) rule[pair[1]] = pair[2];
      }
      rules.push(rule);
      continue;
    }
    const first = line.match(new RegExp(`^${lead}- (if|when|changes): ?(.*)$`, "u"));
    if (first) {
      rules.push({ [first[1]]: first[2] });
      continue;
    }
    const more = line.match(new RegExp(`^${lead}  (if|when|allow_failure): (.*)$`, "u"));
    if (more && rules.length > 0) rules[rules.length - 1][more[1]] = more[2];
  }
  return rules;
}

function evaluate(expression, env) {
  const value = (name) => {
    const found = env[name];
    return found === undefined || found === "" ? null : found;
  };
  const match = (subject, pattern, negate) => {
    const hit = subject !== null && pattern.test(subject);
    return negate ? !hit : hit;
  };
  const source = expression
    .replace(
      /\$([A-Z][A-Z0-9_]*)\s*(=~|!~)\s*\/((?:\\\/|[^/])*)\//gu,
      (_all, name, operator, pattern) => `match(value("${name}"), new RegExp(${JSON.stringify(pattern.replace(/\\\//gu, "/"))}, "u"), ${operator === "!~"})`,
    )
    .replace(/\$([A-Z][A-Z0-9_]*)/gu, (_all, name) => `value("${name}")`);
  return Boolean(new Function("value", "match", `return (${source});`)(value, match));
}

// "run" | "manual" | "failure" | "never" for the first rule that matches.
function verdictOf(rules, env) {
  for (const rule of rules) {
    if (rule.if !== undefined && !evaluate(rule.if, env)) continue;
    const when = rule.when ?? "on_success";
    if (when === "never") return "never";
    if (when === "manual") return "manual";
    if (when === "on_failure") return "failure";
    return "run";
  }
  return "never";
}

// What an event does to a job: no pipeline at all, or the job's own verdict.
function jobVerdict(name, env) {
  if (verdictOf(rulesOf("workflow"), env) === "never") return "never";
  return verdictOf(rulesOf(name), env);
}

const events = {
  devMergeRequest: {
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev",
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/x",
  },
  devPush: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "dev" },
  promotionMergeRequest: {
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview",
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "dev",
  },
  previewPush: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "preview" },
  mainPush: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "main" },
  nightly: { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", ORBIT_NIGHTLY_BROWSERS: "true" },
};

describe("browser jobs by event (#1412)", () => {
  it("starts no browser job on a merge request into dev, or on the push that lands it", () => {
    for (const event of ["devMergeRequest", "devPush"]) {
      for (const name of BROWSER_JOBS) {
        expect(jobVerdict(name, events[event]), `${name} on ${event}`).toBe("never");
      }
    }
  });

  it("keeps the fast checks, the build and the non-browser journeys on a merge request into dev", () => {
    for (const name of ["classify", "fast", "build_image", "integration", "acceptance", "repair_journeys", "launcher_install_compat"]) {
      expect(jobVerdict(name, events.devMergeRequest), name).toBe("run");
    }
  });

  it("starts every browser job but the four nightly-only ones at promotion: the preview push and the merge request into main (#1546, #1763)", () => {
    for (const environment of [
      events.previewPush,
      { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" },
    ]) {
      for (const name of PROMOTION_BROWSER_JOBS) {
        // #1692 removed the one-off preview skip of rig_webkit (owner decision 61).
        expect(jobVerdict(name, environment), `${name} on ${JSON.stringify(environment)}`).toBe("run");
      }
    }
  });

  it("runs the short gate on a hotfix push: local smoke only, no other browser or acceptance job (owner decision 48, #1636)", () => {
    const hotfixPush = { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "hotfix/x" };
    for (const name of [...BROWSER_JOBS.filter((job) => job !== "smoke_local_only"), "acceptance", "repair_journeys"]) {
      expect(jobVerdict(name, hotfixPush), name).toBe("never");
    }
    for (const name of ["classify", "fast", "integration", "build_image", "supply_chain_image", "smoke_local_only", "build_launcher", "launcher_install_compat", "record_image", "sign_evidence", "publish_channel"]) {
      expect(jobVerdict(name, hotfixPush), name).toBe("run");
    }
  });

  it("runs the same short gate on the merge request into a hotfix branch (owner decision 48, #1636)", () => {
    const hotfixMergeRequest = {
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "hotfix/x",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "fix/y",
    };
    for (const name of [...BROWSER_JOBS.filter((job) => job !== "smoke_local_only"), "acceptance", "repair_journeys"]) {
      expect(jobVerdict(name, hotfixMergeRequest), name).toBe("never");
    }
    // A merge request builds the launcher in build_launcher_branch; build_launcher
    // is the release-branch push job (#1608).
    for (const name of ["classify", "fast", "integration", "build_image", "supply_chain_image", "smoke_local_only", "build_launcher_branch", "launcher_install_compat"]) {
      expect(jobVerdict(name, hotfixMergeRequest), name).toBe("run");
    }
  });

  it("starts the same jobs on the dev -> preview merge request as on a merge request into dev (#1546)", () => {
    /* Except the upgrade cells: owner answer 59a (#1665) runs them on this
       merge request alone, overriding #1546 for these two jobs only. Their own
       rules are checked under "upgrade matrix wiring (#1665)". */
    const everyJob = jobs
      .filter(([, block]) => /^ {2}stage: /mu.test(block))
      .map(([name]) => name)
      .filter((name) => name !== "upgrade_cell" && name !== "upgrade_cell_launcher");
    for (const name of everyJob) {
      expect(jobVerdict(name, events.promotionMergeRequest), name).toBe(jobVerdict(name, events.devMergeRequest));
    }
    for (const name of [...BROWSER_JOBS, "launch_timing"]) {
      expect(jobVerdict(name, events.promotionMergeRequest), name).toBe("never");
    }
  });

  it("starts nothing but promote_stable on a push to main (#1546)", () => {
    const everyJob = jobs.filter(([, block]) => /^ {2}stage: /mu.test(block)).map(([name]) => name);
    const started = everyJob.filter((name) => jobVerdict(name, events.mainPush) !== "never");
    expect(started).toEqual(["promote_stable"]);
    expect(jobVerdict("promote_stable", events.mainPush)).toBe("manual");
  });

  it("leaves a pipeline started by hand on dev as it was, except the four nightly-only jobs (#1763)", () => {
    for (const name of PROMOTION_BROWSER_JOBS) {
      expect(jobVerdict(name, { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" }), name).toBe("run");
    }
    for (const name of NIGHTLY_ONLY_JOBS) {
      expect(jobVerdict(name, { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" }), name).toBe("never");
    }
  });

  // #1763: the nightly-only browser jobs.
  describe("rig and film jobs run only in the nightly browser pipeline (#1763)", () => {
    const elsewhere = {
      "a preview push": events.previewPush,
      "a merge request into dev": events.devMergeRequest,
      "a merge request into preview": events.promotionMergeRequest,
      "a push to dev": events.devPush,
      "a push to main": events.mainPush,
    };

    it.each(NIGHTLY_ONLY_JOBS)("%s is never started outside the nightly", (name) => {
      for (const [kind, environment] of Object.entries(elsewhere)) {
        expect(jobVerdict(name, environment), `${name} on ${kind}`).toBe("never");
      }
    });

    it.each(NIGHTLY_ONLY_JOBS)("%s runs on the nightly browser schedule", (name) => {
      expect(jobVerdict(name, events.nightly)).toBe("run");
    });

    it("keeps screens_chromium running on a preview push and the nightly", () => {
      expect(jobVerdict("screens_chromium", events.previewPush)).toBe("run");
      expect(jobVerdict("screens_chromium", events.nightly)).toBe("run");
    });

    it("leaves record_image needing screens_chromium and none of the four", () => {
      const needs = needsOf(allBlocks.get("record_image"));
      expect(needs).toMatch(/- job: screens_chromium\n/u);
      for (const name of NIGHTLY_ONLY_JOBS) expect(needs, name).not.toMatch(new RegExp(`job: ${name}\\n`, "u"));
    });

    it("has no job with a non-optional need on one of the four (the pipeline stays valid on a preview push)", () => {
      const offenders = [];
      for (const [name, block] of jobs) {
        const lines = needsOf(block).split("\n");
        lines.forEach((line, at) => {
          const need = line.match(/^\s*- job: (\S+)\s*$/u);
          if (!need || !NIGHTLY_ONLY_JOBS.includes(need[1])) return;
          // The entry runs to the next "- " item or a line of lesser indent.
          const indent = line.search(/\S/u);
          let optional = false;
          for (const next of lines.slice(at + 1)) {
            if (/^\s*#/u.test(next) || next.trim() === "") continue;
            if (next.search(/\S/u) <= indent) break;
            if (/^\s*optional: true\s*$/u.test(next)) optional = true;
          }
          if (!optional) offenders.push(`${name} -> ${need[1]}`);
        });
      }
      expect(offenders).toEqual([]);
    });
  });

  it("starts every browser job, and only the jobs they need, on the nightly schedule", () => {
    for (const name of [...BROWSER_JOBS, ...NIGHTLY_SUPPORT_JOBS]) {
      expect(jobVerdict(name, events.nightly), `${name} on the nightly`).toBe("run");
    }
    const everyJob = jobs.filter(([, block]) => /^ {2}stage: /mu.test(block)).map(([name]) => name);
    const started = everyJob.filter((name) => jobVerdict(name, events.nightly) !== "never");
    expect(started.sort()).toEqual([...BROWSER_JOBS, ...NIGHTLY_SUPPORT_JOBS, "pocket_measure", "pocket_measure_filing", "nightly_report", "browser_report"].sort());
    // The alarm waits for a failure; it does not run on a green night, so a
    // green night never needs its token. A tap-floor miss is filed by
    // pocket_measure_filing, which installs nothing (#1616, D-SEC2).
    expect(jobVerdict("nightly_report", events.nightly)).toBe("failure");
  });

  it("starts no browser job, and not the nightly's jobs, on any other schedule on dev", () => {
    const others = [
      { RENOVATE: "true" },
      { BASE_IMAGE_REPIN: "true" },
      { DOOR_IMPORT: "true" },
      { SIDECAR_FRESHNESS: "true" },
      { INSTALL_BOOTSTRAP: "true" },
      { TIDY_FRESHNESS: "true" },
      {},
      { ORBIT_NIGHTLY_BROWSERS: "false" },
    ];
    for (const variables of others) {
      const environment = { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", ...variables };
      for (const name of [...BROWSER_JOBS, ...NIGHTLY_SUPPORT_JOBS, "pocket_measure", "nightly_report"]) {
        expect(jobVerdict(name, environment), `${name} on ${JSON.stringify(variables)}`).toBe("never");
      }
    }
  });

  it("starts the other schedules' jobs only on their own schedule, not on the nightly", () => {
    for (const name of ["renovate", "sidecar_pin_freshness", "install_bootstrap", "base_image_repin", "door_import", "tidy_freshness"]) {
      expect(jobVerdict(name, events.nightly), name).toBe("never");
    }
    expect(jobVerdict("base_image_repin", { CI_PIPELINE_SOURCE: "schedule", BASE_IMAGE_REPIN: "true" })).toBe("run");
  });

  // #1544 (owner decision 5a): promotion no longer waits on a nightly.
  it("has no nightly_not_red job: the promotion merge request is not gated on a nightly", () => {
    expect(allBlocks.has("nightly_not_red")).toBe(false);
    const uncommented = gitlabCi
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .filter((line) => line.includes("nightly_not_red"));
    expect(uncommented).toEqual([]);
  });

  it("says nowhere in the docs that promotion waits on, or stops on, a nightly", () => {
    for (const file of ["quality-strategy.md", "releasing.md"]) {
      const text = readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8");
      expect(text, file).not.toContain("nightly_not_red");
    }
  });

  it("turns every axis on for the nightly, and only for a schedule that names it", () => {
    const nightly = runClassifyEnv({ ...events.nightly });
    expect(nightly.variables).toEqual(everythingOn);
    expect(nightly.stdout).toMatch(/nightly browser run/u);
    const renovate = runClassifyEnv({ CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", RENOVATE: "true" });
    expect(renovate.variables.ORBIT_WEB).toBe("false");
    expect(renovate.variables.ORBIT_E2E).toBe("false");
    // The variable alone, off a schedule, changes nothing.
    expect(runClassifyEnv({ ORBIT_NIGHTLY_BROWSERS: "true" }).variables.ORBIT_E2E).toBe("false");
  });

  it("stops every job the nightly starts when dev has not moved (the nightly_idle lane)", () => {
    for (const name of [...BROWSER_JOBS, "pocket_measure", "fast", "build_image"]) {
      const script = `${hiddenBlockScript(".reach_helpers")}\norbit_lane_admits ${name} && echo ADMITTED || echo STOPPED`;
      const stdout = execFileSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ORBIT_LANE: "nightly_idle" },
      });
      expect(stdout, name).toMatch(/dev has not moved/u);
      expect(stdout, name).toMatch(/STOPPED/u);
      expect(stdout, name).not.toMatch(/ADMITTED/u);
    }
  });

  it("makes classify set that lane only when the nightly script says idle", () => {
    const classify = allBlocks.get("classify");
    const start = classify.indexOf('      if [ "${CI_PIPELINE_SOURCE:-}" = "schedule" ] && [ "${ORBIT_NIGHTLY_BROWSERS:-}" = "true" ]; then\n        verdict=');
    expect(start, "the nightly idle step moved").toBeGreaterThan(-1);
    const end = classify.indexOf("\n  artifacts:", start);
    const step = `set -eu\n${classify
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^ {6}/u, ""))
      .join("\n")}`;
    const run = (verdict, environment) => {
      const directory = mkdtempSync(join(tmpdir(), "orbit-nightly-idle-"));
      try {
        writeFileSync(join(directory, "classify.env"), "ORBIT_WEB=true\nORBIT_LANE=full\n", "utf8");
        writeFileSync(join(directory, "node"), `#!/bin/sh\necho ${verdict}\n`, { mode: 0o755 });
        execFileSync("sh", ["-c", step], {
          cwd: directory,
          encoding: "utf8",
          env: { PATH: `${directory}:${process.env.PATH}`, ...environment },
        });
        return readFileSync(join(directory, "classify.env"), "utf8");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    const nightly = { CI_PIPELINE_SOURCE: "schedule", ORBIT_NIGHTLY_BROWSERS: "true" };
    expect(run("idle", nightly)).toBe("ORBIT_WEB=true\nORBIT_LANE=nightly_idle\n");
    expect(run("run", nightly)).toBe("ORBIT_WEB=true\nORBIT_LANE=full\n");
    // Not the nightly: even an `idle` answer changes nothing.
    expect(run("idle", { CI_PIPELINE_SOURCE: "merge_request_event" })).toBe("ORBIT_WEB=true\nORBIT_LANE=full\n");
  });
});

// L-S1 (#1584): the next night's `moved` reads classify's log back for the
// verdict, so the line classify prints and the pattern that reads it are one
// contract split across two files.
describe("the nightly verdict line classify prints (L-S1)", () => {
  it("is a line VERDICT_LINE reads back, with the verdict as its first group", () => {
    const classify = allBlocks.get("classify");
    const start = classify.indexOf('      if [ "${CI_PIPELINE_SOURCE:-}" = "schedule" ] && [ "${ORBIT_NIGHTLY_BROWSERS:-}" = "true" ]; then\n        verdict=');
    expect(start, "the nightly idle step moved").toBeGreaterThan(-1);
    const end = classify.indexOf("\n  artifacts:", start);
    const step = `set -eu\n${classify
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^ {6}/u, ""))
      .join("\n")}`;
    const { VERDICT_LINE } = nightlyBrowsers;
    expect(VERDICT_LINE, "nightly-browsers.mjs exports no VERDICT_LINE").toBeInstanceOf(RegExp);
    for (const verdict of ["run", "idle", "yield"]) {
      const directory = mkdtempSync(join(tmpdir(), "orbit-nightly-verdict-"));
      try {
        writeFileSync(join(directory, "classify.env"), "ORBIT_WEB=true\nORBIT_LANE=full\n", "utf8");
        writeFileSync(join(directory, "node"), `#!/bin/sh\necho ${verdict}\n`, { mode: 0o755 });
        const stdout = execFileSync("sh", ["-c", step], {
          cwd: directory,
          encoding: "utf8",
          env: { PATH: `${directory}:${process.env.PATH}`, CI_PIPELINE_SOURCE: "schedule", ORBIT_NIGHTLY_BROWSERS: "true" },
        });
        const match = new RegExp(VERDICT_LINE.source, VERDICT_LINE.flags.replace("g", "")).exec(stdout);
        expect(match, `no line for ${verdict} in: ${stdout}`).not.toBeNull();
        expect(match[1]).toBe(verdict);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});

// v0.3.2 audit D-F9/D-F18. Fails on current code: build_image starts with
// base_image_from_ghcr=false and flips it to true only inside the branch that
// needs both pull credentials, so with them unset the build points buildx at
// the GitLab registry with a job token that cannot read it.
describe("build_image base image source (D-F9/D-F18)", () => {
  const script = allBlocks.get("build_image");

  it("defaults base_image_from_ghcr to true before the credential check", () => {
    const credentialCheck = script.indexOf('if [ -n "${ORBIT_BASE_IMAGE_PULL_USER');
    const defaultTrue = script.indexOf("base_image_from_ghcr=true");
    expect(credentialCheck).toBeGreaterThan(-1);
    expect(defaultTrue).toBeGreaterThan(-1);
    expect(defaultTrue).toBeLessThan(credentialCheck);
    expect(script.slice(0, credentialCheck)).not.toContain("base_image_from_ghcr=false");
  });

  it("sets base_image_from_ghcr=false only after base_image_pulled=true", () => {
    const pulled = script.indexOf('if [ "$base_image_pulled" = true ]; then');
    const falses = [...script.matchAll(/base_image_from_ghcr=false/gu)].map((match) => match.index);
    expect(pulled).toBeGreaterThan(-1);
    expect(falses.length).toBeGreaterThan(0);
    for (const index of falses) expect(index).toBeGreaterThan(pulled);
  });
});

// v0.3.2 audit security finding, owner decision 11a (2026-10-28). The two
// read-only tokens -- ORBIT_REUSE_TOKEN and the base-image pull pair -- stay
// unprotected and masked, and are scoped in the project's CI/CD settings to
// the `ci-read-tokens` environment, so GitLab hands them only to jobs that
// declare it. A job that reads them without the block silently loses them; a
// job that declares it without reading them is given them for nothing.
describe("read-only tokens reach only the jobs that read them (audit 11a)", () => {
  const TOKEN = /\bORBIT_REUSE_TOKEN\b|\bORBIT_BASE_IMAGE_PULL_(?:USER|TOKEN)\b/u;
  const ciDir = new URL("./ci/", import.meta.url);
  // Helper scripts that read a token, found by reading them rather than listed.
  const readingScripts = readdirSync(ciDir, { withFileTypes: true })
    .filter((entry) => entry.isFile()) // upgrade-shapes/ holds data, not scripts
    .map((entry) => entry.name)
    .filter((file) => !/\.test\.[cm]?[jt]s$/u.test(file))
    .filter((file) => TOKEN.test(readFileSync(new URL(file, ciDir), "utf8")));
  // nightly-browsers.mjs reads ORBIT_REUSE_TOKEN only in `moved`; since #1588
  // `report` uses SIDECAR_ISSUE_TOKEN alone, so it must not be handed the other.
const TOKEN_MODES = { "nightly-browsers.mjs": ["moved"] };

  function code(block) {
    return block
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n");
  }

  function readsToken(block) {
    const text = code(block);
    if (TOKEN.test(text)) return true;
    return readingScripts.some((file) => {
      const calls = [...text.matchAll(new RegExp(`scripts/ci/${file.replace(".", "\\.")}(?:\\s+(\\S+))?`, "gu"))];
      const modes = TOKEN_MODES[file];
      return calls.some((call) => !modes || modes.includes(call[1]));
    });
  }

  const ENVIRONMENT = /^ {2}environment:\n {4}name: ci-read-tokens\n {4}action: prepare$/mu;
  const readers = jobs.filter(([, block]) => readsToken(block)).map(([name]) => name);

  it("finds the scripts and jobs that read the tokens", () => {
    expect(readingScripts).toEqual(expect.arrayContaining(["reuse-lookup.mjs", "nightly-browsers.mjs"]));
    expect(readers).toEqual(expect.arrayContaining(["build_image"]));
    // Hidden blocks are spliced into jobs by anchor; one reading a token would
    // hand it to jobs this test cannot see.
    const hiddenReaders = [...allBlocks].filter(([name, block]) => name.startsWith(".") && readsToken(block));
    expect(hiddenReaders.map(([name]) => name)).toEqual([]);
  });

  it("every job that reads a token declares environment ci-read-tokens with action: prepare", () => {
    const missing = readers.filter((name) => !ENVIRONMENT.test(allBlocks.get(name)));
    expect(missing).toEqual([]);
  });

  it("no other job declares the ci-read-tokens environment", () => {
    const declaring = jobs.filter(([, block]) => /ci-read-tokens/u.test(code(block))).map(([name]) => name);
    expect(declaring.sort()).toEqual([...readers].sort());
  });
});

// #1642 (L1): every file vitest.config.ts excludes under ORBIT_TEST_SKIP_DOCKER
// (the `fast` job sets it) must be run by `fast_docker`, the only job that has
// the docker binary. An excluded file nobody runs is a test that never executes.
describe("every docker-skipped vitest file runs in fast_docker (#1642)", () => {
  const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
  const start = config.indexOf('process.env.ORBIT_TEST_SKIP_DOCKER === "true"');
  const list = config.slice(start, config.indexOf("]", start));
  const skipped = [...list.matchAll(/^\s*"([^"]+\.test\.[cm]?[jt]sx?)",?\s*$/gmu)].map((m) => m[1]);
  const fastDocker = allBlocks.get("fast_docker") ?? "";
  const run = fastDocker
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line) && /vitest run/u.test(line))
    .join(" ");

  it("finds the skipped files and the fast_docker vitest command", () => {
    expect(start).toBeGreaterThan(-1);
    expect(skipped.length).toBeGreaterThan(0);
    expect(run).not.toBe("");
  });

  it("fast_docker lists every file excluded under ORBIT_TEST_SKIP_DOCKER", () => {
    const listed = run.split(/[\s'"]+/u);
    expect(skipped.filter((file) => !listed.includes(file))).toEqual([]);
  });
});

// #1414 (ADR-0039 section 6): a merge request runs only the tests reachable from
// what it changed (`vitest run --changed <merge base>`), without coverage and
// without the coverage-floor check; the push that lands the merge on `dev`,
// promotion and the nightly run everything, and `fast` keeps the ratchet. These
// are shell decisions, so the job's own script items are run against stubs, not
// pattern-matched: a regex would pass on a version that decided the opposite.
const MERGE_BASE = "0123abcd0123abcd0123abcd0123abcd0123abcd";

// The `script:` items of a job, each as the shell text it runs. An item is a
// `    - ` line (one command, or `|` and an indented block) up to the next item
// or comment at the same indent.
function scriptItems(name) {
  const block = allBlocks.get(name);
  const start = block.search(/^ {2}script:\s*$/mu);
  expect(start, `${name} has no script:`).toBeGreaterThan(-1);
  const lines = block.slice(start).split("\n").slice(1);
  const items = [];
  let current = null;
  for (const line of lines) {
    if (/^ {2}\S/u.test(line)) break;
    if (/^ {4}- /u.test(line)) {
      current = [line.slice(6)];
      items.push(current);
    } else if (/^ {4}#/u.test(line) || line.trim() === "") {
      current = null;
    } else if (current) {
      current.push(line.slice(6));
    }
  }
  return items.map((item) => (item[0] === "|" ? item.slice(1) : item).join("\n"));
}

// What the stubbed program saw, one `key=value` line per variable.
function runItems(items, environment, directory) {
  const result = spawnSync("sh", ["-c", items.join("\n")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: `${join(directory, "bin")}:${process.env.PATH}`, ...environment },
  });
  expect(result.error, result.stderr).toBeUndefined();
  return result;
}

const mergeRequestEnv = { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_DIFF_BASE_SHA: MERGE_BASE };
const fullRunEvents = {
  "a push to dev": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "dev" },
  "a push to preview": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "preview" },
  "a hotfix push": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "hotfix/1.2" },
  "the nightly schedule": { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", ORBIT_NIGHTLY_BROWSERS: "true" },
};

// The `git` the job's scripts see. Only `cat-file -e <sha>^{commit}` is
// answered: it succeeds for the one commit named in GIT_STUB_PRESENT (the
// merge base by default; empty or another sha means "not in the clone"), and
// every call is logged. Anything else fails, as a bare directory would.
const GIT_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_GIT_LOG"
if [ "$1" = "cat-file" ] && [ "$2" = "-e" ] && [ -n "$GIT_STUB_PRESENT" ] && [ "$3" = "$GIT_STUB_PRESENT^{commit}" ]; then
  exit 0
fi
exit 1
`;

// scripts/ci/reuse-evidence.sh stands in as a logger: the observable is whether
// it is called, because the real one writes the evidence the next pipeline reads.
const EVIDENCE_STUB = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STUB_EVIDENCE_LOG"\n';

// An item that is a YAML alias (`*reuse_evidence`) is the text its anchor holds.
function expandAlias(item) {
  const alias = item.trim().match(/^\*([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (!alias) return item;
  const definition = gitlabCi.match(new RegExp(`^\\.[\\w-]+: &${alias[1]} (.+)$`, "mu"));
  expect(definition, `no anchor &${alias[1]}`).not.toBeNull();
  return definition[1];
}

function stubBin(directory, extra = {}) {
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "scripts", "ci"), { recursive: true });
  writeFileSync(join(directory, "bin", "git"), GIT_STUB);
  chmodSync(join(directory, "bin", "git"), 0o755);
  writeFileSync(join(directory, "scripts", "ci", "reuse-evidence.sh"), EVIDENCE_STUB);
  for (const [name, body] of Object.entries(extra)) {
    writeFileSync(join(directory, "bin", name), body);
    chmodSync(join(directory, "bin", name), 0o755);
  }
}

// What a job leaves behind that the tests read: the evidence calls and the text.
function observed(directory, result) {
  const evidenceLog = join(directory, "evidence.log");
  return {
    evidence: existsSync(evidenceLog) ? readFileSync(evidenceLog, "utf8").split("\n").filter(Boolean) : [],
    output: `${result.stdout}\n${result.stderr}`,
  };
}

const jobEnvironment = (directory, environment) => ({
  STUB_GIT_LOG: join(directory, "git.log"),
  STUB_EVIDENCE_LOG: join(directory, "evidence.log"),
  GIT_STUB_PRESENT: MERGE_BASE,
  CI_JOB_NAME: "job",
  ...environment,
});

// `variables:` of one job, as the lines under it.
function jobVariables(name) {
  const section = allBlocks.get(name).match(/^ {2}variables:\s*\n((?: {4}.*\n|[ \t]*\n)*)/mu);
  expect(section, `${name} has no variables:`).not.toBeNull();
  return section[1].split("\n").filter((line) => !/^\s*#/u.test(line));
}

// The sentence a job prints when it falls back to the whole suite.
const BASE_MISSING_LINE = /merge base.*not in the clone.*whole suite|whole suite.*merge base.*not in the clone/iu;

describe("merge requests run changed-reachable tests, the dev push runs everything (#1414)", () => {
  // `fast`: the job decides what it hands scripts/test-backend.sh.
  describe("fast", () => {
    function fastDecision(environment) {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-fast-decision-")));
      try {
        mkdirSync(join(directory, "scripts"));
        writeFileSync(
          join(directory, "scripts", "test-backend.sh"),
          [
            "#!/bin/sh",
            'echo "ran"',
            'echo "coverage=${ORBIT_TEST_COVERAGE:-}"',
            'echo "base=${ORBIT_TEST_CHANGED_BASE:-}"',
            'echo "skip_docker=${ORBIT_TEST_SKIP_DOCKER:-}"',
            "",
          ].join("\n"),
        );
        stubBin(directory);
        // The items that decide the environment of the test run and what is
        // recorded afterwards: the ones that name the run's variables, the
        // script itself, the merge base check or the reuse evidence, in job
        // order. They share one shell, as in the job.
        const relevant = scriptItems("fast")
          .map(expandAlias)
          .filter((item) =>
            /ORBIT_TEST_CHANGED_BASE|ORBIT_TEST_COVERAGE|test-backend\.sh|reuse-evidence|cat-file|CI_MERGE_REQUEST/u.test(item),
          );
        expect(relevant.some((item) => /test-backend\.sh/u.test(item))).toBe(true);
        const prelude = 'orbit_as_node() { sh -c "$1"; }';
        const result = runItems([prelude, ...relevant], jobEnvironment(directory, environment), directory);
        const seen = Object.fromEntries(
          result.stdout
            .split("\n")
            .filter((line) => /^(coverage|base|skip_docker)=/u.test(line))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        );
        return { ran: /^ran$/mu.test(result.stdout), ...seen, ...observed(directory, result) };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it("on a merge request hands test-backend.sh the merge base and leaves coverage off", () => {
      const seen = fastDecision(mergeRequestEnv);
      expect(seen.ran).toBe(true);
      expect(seen.base).toBe(MERGE_BASE);
      expect(seen.coverage).not.toBe("true");
      expect(seen.skip_docker).toBe("true");
    });

    for (const [event, environment] of Object.entries(fullRunEvents)) {
      it(`on ${event} runs the full suite with coverage and no changed-only base`, () => {
        const seen = fastDecision(environment);
        expect(seen.ran).toBe(true);
        expect(seen.base).toBe("");
        expect(seen.coverage).toBe("true");
        expect(seen.skip_docker).toBe("true");
      });
    }

    // #1812 step 2: a batch -> dev merge request is the last gate before dev, so it
    // runs the whole suite with the coverage floors, as the preview push does.
    // Every other merge request keeps the narrowed, no-coverage run.
    const mergeRequestFor = (source, target) => ({
      ...mergeRequestEnv,
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: source,
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: target,
    });

    for (const batch of ["batch-a", "batch-b"]) {
      it(`on a ${batch} -> dev merge request runs the whole suite with coverage (#1812)`, () => {
        const seen = fastDecision(mergeRequestFor(batch, "dev"));
        expect(seen.ran).toBe(true);
        expect(seen.base).toBe("");
        expect(seen.coverage).toBe("true");
        expect(seen.skip_docker).toBe("true");
      });
    }

    for (const [label, source, target] of [
      ["a feature -> batch-b", "fix/1815-changelog-lows", "batch-b"],
      ["a batch-a -> preview", "batch-a", "preview"],
      ["a batch-b -> main", "batch-b", "main"],
      ["a non-batch -> dev", "fix/1815-changelog-lows", "dev"],
      ["a branch merely named like a batch -> dev", "batch-abc", "dev"],
    ]) {
      it(`on ${label} merge request keeps the narrowed run without coverage (#1812)`, () => {
        const seen = fastDecision(mergeRequestFor(source, target));
        expect(seen.ran).toBe(true);
        expect(seen.base).toBe(MERGE_BASE);
        expect(seen.coverage).not.toBe("true");
        expect(seen.skip_docker).toBe("true");
      });
    }

    it("does not treat a merge base variable on a non-merge-request pipeline as a reason to narrow", () => {
      // A variable alone changes nothing: the pipeline source decides.
      const seen = fastDecision({ CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "dev", CI_MERGE_REQUEST_DIFF_BASE_SHA: MERGE_BASE });
      expect(seen.base).toBe("");
      expect(seen.coverage).toBe("true");
    });

    it("clones the whole history, so the merge base is there to compare against", () => {
      expect(jobVariables("fast").some((line) => /^ {4}GIT_DEPTH: ["']?0["']?\s*(#.*)?$/u.test(line))).toBe(true);
    });

    it("on a merge request whose base is in the clone narrows the run and writes no reuse evidence", () => {
      const seen = fastDecision(mergeRequestEnv);
      expect(seen.base).toBe(MERGE_BASE);
      expect(seen.coverage).not.toBe("true");
      expect(seen.evidence).toEqual([]);
      expect(seen.output).not.toMatch(BASE_MISSING_LINE);
    });

    for (const [absence, base, present] of [
      ["is not in the clone", MERGE_BASE, "ffffffffffffffffffffffffffffffffffffffff"],
      ["is empty", "", MERGE_BASE],
    ]) {
      it(`on a merge request whose base ${absence} says so and runs the whole suite with coverage`, () => {
        const seen = fastDecision({ ...mergeRequestEnv, CI_MERGE_REQUEST_DIFF_BASE_SHA: base, GIT_STUB_PRESENT: present });
        expect(seen.ran).toBe(true);
        expect(seen.output).toMatch(BASE_MISSING_LINE);
        expect(seen.base).toBe("");
        expect(seen.coverage).toBe("true");
        expect(seen.skip_docker).toBe("true");
      });

      it(`on a merge request whose base ${absence} still writes reuse evidence, as the full run it is`, () => {
        const seen = fastDecision({ ...mergeRequestEnv, CI_MERGE_REQUEST_DIFF_BASE_SHA: base, GIT_STUB_PRESENT: present });
        expect(seen.evidence).toEqual(["job"]);
      });
    }

    for (const [event, environment] of Object.entries(fullRunEvents)) {
      it(`on ${event} writes reuse evidence and never asks about the merge base`, () => {
        const seen = fastDecision(environment);
        expect(seen.evidence).toEqual(["job"]);
        expect(seen.output).not.toMatch(BASE_MISSING_LINE);
      });
    }
  });

  // scripts/test-backend.sh: the checks run every time; only the Vitest step narrows.
  // Each test runs the script as a child with a 60 s deadline, so the test's
  // own limit sits above it: Vitest's 5 s default killed passing runs on a
  // busy machine (#1634).
  describe("scripts/test-backend.sh", { timeout: 75_000 }, () => {
    const SCRIPT = new URL("./test-backend.sh", import.meta.url).pathname;
    const STUB = (name) => `#!/bin/sh\nprintf '${name}\\t%s\\n' "$*" >> "$STUB_LOG"\nexit 0\n`;

    // `changed`: files committed after the base commit; when given and the
    // environment has no ORBIT_TEST_CHANGED_BASE, it is set to that base.
    function runBackend(environment, changed = null) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "orbit-test-backend-")));
      try {
        const repo = join(root, "repo");
        const stubs = join(root, "stubs");
        const log = join(root, "calls.log");
        mkdirSync(join(repo, "scripts"), { recursive: true });
        mkdirSync(join(repo, "web"), { recursive: true });
        mkdirSync(stubs);
        copyFileSync(SCRIPT, join(repo, "scripts", "test-backend.sh"));
        writeFileSync(join(repo, "pnpm-lock.yaml"), "");
        const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
        git("init", "-q");
        git("add", "pnpm-lock.yaml");
        git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
        let base = null;
        if (changed) {
          base = git("rev-parse", "HEAD").toString().trim();
          for (const file of changed) {
            mkdirSync(dirname(join(repo, file)), { recursive: true });
            writeFileSync(join(repo, file), "changed\n");
            git("add", file);
          }
          git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "change");
        }
        for (const name of ["node", "pnpm"]) {
          writeFileSync(join(stubs, name), STUB(name));
          chmodSync(join(stubs, name), 0o755);
        }
        // test-backend.sh stops at once without poppler (#1793); stubs keep it going.
        for (const name of ["pdfinfo", "pdftoppm"]) {
          writeFileSync(join(stubs, name), "#!/bin/sh\nexit 0\n");
          chmodSync(join(stubs, name), 0o755);
        }
        const env = { ...process.env, PATH: `${stubs}:/usr/bin:/bin`, STUB_LOG: log, ...(base ? { ORBIT_TEST_CHANGED_BASE: base } : {}), ...environment };
        for (const key of ["CI", "ORBIT_TEST_COVERAGE", "ORBIT_TEST_CHANGED_BASE", "ORBIT_TEST_PHASE"]) if (!(key in environment) && !(key === "ORBIT_TEST_CHANGED_BASE" && base)) delete env[key];
        const result = spawnSync("bash", [join(repo, "scripts", "test-backend.sh")], {
          cwd: repo,
          encoding: "utf8",
          timeout: 60_000,
          killSignal: "SIGKILL",
          env,
        });
        expect(result.status, result.stderr).toBe(0);
        const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
        return calls.map((line) => line.replace("\t", " "));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const checks = ["pnpm typecheck", "pnpm lint", "node scripts/check-rolldown-jsdoc-trap.mjs", "node scripts/check-v19-types.mjs"];

    it("with a merge base runs only the changed-reachable default-project tests, no coverage, no floor check", () => {
      const calls = runBackend({ ORBIT_TEST_CHANGED_BASE: MERGE_BASE });
      expect(calls).toContain(`pnpm exec vitest run --changed ${MERGE_BASE}`);
      expect(calls.filter((call) => /coverage/u.test(call) && !/lockfile|test\.mjs/u.test(call))).toEqual([]);
      expect(calls).not.toContain("pnpm test");
      expect(calls.some((call) => call.includes("scripts/ci/coverage-floor-check.mjs"))).toBe(false);
      expect(calls.some((call) => call.includes("--project integration"))).toBe(false);
    });

    it("with a merge base still runs typecheck, lint and the other checks", () => {
      const calls = runBackend({ ORBIT_TEST_CHANGED_BASE: MERGE_BASE });
      for (const check of checks) expect(calls, check).toContain(check);
    });

    it("with a merge base ignores ORBIT_TEST_COVERAGE: a narrowed run never measures coverage", () => {
      const calls = runBackend({ ORBIT_TEST_CHANGED_BASE: MERGE_BASE, ORBIT_TEST_COVERAGE: "true" });
      expect(calls).toContain(`pnpm exec vitest run --changed ${MERGE_BASE}`);
      expect(calls).not.toContain("pnpm test:coverage");
      expect(calls.some((call) => call.includes("scripts/ci/coverage-floor-check.mjs"))).toBe(false);
    });

    it("with no merge base and coverage on runs the coverage suite and then the floor check", () => {
      const calls = runBackend({ ORBIT_TEST_COVERAGE: "true" });
      const coverage = calls.indexOf("pnpm test:coverage");
      const floor = calls.findIndex((call) => call.includes("scripts/ci/coverage-floor-check.mjs"));
      expect(coverage).toBeGreaterThan(-1);
      expect(floor).toBeGreaterThan(coverage);
      expect(calls.some((call) => call.includes("--changed"))).toBe(false);
      for (const check of checks) expect(calls, check).toContain(check);
    });

    // Tests that read non-code files (CI YAML, Dockerfile, compose files) are
    // not reached by `--changed`, so a change to one must run the whole suite.
    for (const file of [".gitlab-ci.yml", "Dockerfile", "docker-compose.yml", "docker-compose.prod.yml"]) {
      it(`with a merge base and a changed ${file} runs the whole suite, not --changed`, () => {
        const calls = runBackend({}, [file, "src/lib/example.ts"]);
        expect(calls.some((call) => call.includes("--changed"))).toBe(false);
        expect(calls).toContain("pnpm test");
      });
    }

    // Owner decision 34b: Markdown files never trigger the whole-suite fallback.
    it("with a merge base and only Markdown files changed keeps --changed", () => {
      const calls = runBackend({}, ["docs/x.md", "README.md"]);
      expect(calls.some((call) => /vitest run --changed [0-9a-f]{40}$/u.test(call))).toBe(true);
      expect(calls).not.toContain("pnpm test");
    });

    it("with a merge base and Markdown plus a source file changed keeps --changed", () => {
      const calls = runBackend({}, ["docs/x.md", "src/a.ts"]);
      expect(calls.some((call) => /vitest run --changed [0-9a-f]{40}$/u.test(call))).toBe(true);
      expect(calls).not.toContain("pnpm test");
    });

    it("with a merge base and Markdown plus .gitlab-ci.yml changed still runs the whole suite", () => {
      const calls = runBackend({}, ["docs/x.md", ".gitlab-ci.yml"]);
      expect(calls.some((call) => call.includes("--changed"))).toBe(false);
      expect(calls).toContain("pnpm test");
    });

    it("with a merge base and only JavaScript, TypeScript and Svelte changes still runs --changed", () => {
      const files = ["a.js", "b.mjs", "c.cjs", "d.ts", "e.mts", "f.cts", "web/g.svelte"];
      const calls = runBackend({}, files);
      expect(calls.some((call) => /vitest run --changed [0-9a-f]{40}$/u.test(call))).toBe(true);
      expect(calls).not.toContain("pnpm test");
    });

    it("with neither set runs the full suite, as today", () => {
      const calls = runBackend({});
      expect(calls).toContain("pnpm test");
      expect(calls.some((call) => call.includes("--changed"))).toBe(false);
    });
  });

  // `integration`: one shell item, branching on the pipeline source.
  describe("integration", () => {
    function integrationRun(environment) {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-integration-decision-")));
      try {
        const log = join(directory, "calls.log");
        stubBin(directory, { pnpm: STUB_LOGGER("pnpm"), node: STUB_LOGGER("node") });
        // The vitest step, plus whatever else in the job checks the merge base
        // or records the reuse evidence; they share one shell, as in the job.
        const items = scriptItems("integration")
          .map(expandAlias)
          .filter((text) => /vitest run --project integration|reuse-evidence|cat-file/u.test(text));
        expect(items.some((text) => /vitest run --project integration/u.test(text)), "integration has no vitest step").toBe(true);
        const result = runItems(items, jobEnvironment(directory, {
          STUB_LOG: log,
          ORBIT_INTEGRATION: "true",
          POSTGRES_USER: "orbit_test",
          POSTGRES_PASSWORD: "test-only",
          POSTGRES_DB: "orbit_integration",
          CI_JOB_ID: "1",
          CI_NODE_INDEX: "2",
          CI_NODE_TOTAL: "4",
          ...environment,
        }), directory);
        const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
        return {
          vitest: calls.filter((call) => call.startsWith("pnpm\texec vitest")).map((call) => call.split("\t")[1]),
          ...observed(directory, result),
        };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    const integrationVitestCalls = (environment) => integrationRun(environment).vitest;
    const STUB_LOGGER = (name) => `#!/bin/sh\nprintf '${name}\\t%s\\n' "$*" >> "$STUB_LOG"\nexit 0\n`;

    it("on a merge request runs only the changed-reachable integration tests", () => {
      expect(integrationVitestCalls(mergeRequestEnv)).toEqual([`exec vitest run --project integration --changed ${MERGE_BASE} --shard=2/4 --passWithNoTests`]);
    });

    for (const [event, environment] of Object.entries(fullRunEvents)) {
      it(`on ${event} runs the whole integration project`, () => {
        expect(integrationVitestCalls(environment)).toEqual(["exec vitest run --project integration --shard=2/4 --passWithNoTests"]);
      });
    }

    it("never adds coverage to either run", () => {
      for (const environment of [mergeRequestEnv, ...Object.values(fullRunEvents)]) {
        expect(integrationVitestCalls(environment).join("\n")).not.toMatch(/--coverage/u);
      }
    });

    it("clones the whole history, so the merge base is there to compare against", () => {
      expect(jobVariables("integration").some((line) => /^ {4}GIT_DEPTH: ["']?0["']?\s*(#.*)?$/u.test(line))).toBe(true);
    });

    it("on a merge request whose base is in the clone writes no reuse evidence", () => {
      const run = integrationRun(mergeRequestEnv);
      expect(run.vitest).toEqual([`exec vitest run --project integration --changed ${MERGE_BASE} --shard=2/4 --passWithNoTests`]);
      expect(run.evidence).toEqual([]);
      expect(run.output).not.toMatch(BASE_MISSING_LINE);
    });

    for (const [absence, base, present] of [
      ["is not in the clone", MERGE_BASE, "ffffffffffffffffffffffffffffffffffffffff"],
      ["is empty", "", MERGE_BASE],
    ]) {
      it(`on a merge request whose base ${absence} says so and runs the whole integration project`, () => {
        const run = integrationRun({ ...mergeRequestEnv, CI_MERGE_REQUEST_DIFF_BASE_SHA: base, GIT_STUB_PRESENT: present });
        expect(run.output).toMatch(BASE_MISSING_LINE);
        expect(run.vitest).toEqual(["exec vitest run --project integration --shard=2/4 --passWithNoTests"]);
      });

      it(`on a merge request whose base ${absence} still writes reuse evidence, as the full run it is`, () => {
        const run = integrationRun({ ...mergeRequestEnv, CI_MERGE_REQUEST_DIFF_BASE_SHA: base, GIT_STUB_PRESENT: present });
        expect(run.evidence).toEqual(["job"]);
      });
    }

    for (const [event, environment] of Object.entries(fullRunEvents)) {
      it(`on ${event} writes reuse evidence and never asks about the merge base`, () => {
        const run = integrationRun(environment);
        expect(run.evidence).toEqual(["job"]);
        expect(run.output).not.toMatch(BASE_MISSING_LINE);
      });
    }
  });

  it("docs/quality-strategy.md states the accepted gap of the narrowed merge request run", () => {
    const text = readFileSync(new URL("../docs/quality-strategy.md", import.meta.url), "utf8");
    expect(text).toContain("--changed");
    expect(text).toMatch(/without importing/iu);
  });
});

// #1620: `fast` carries lint, typecheck, the web build and the coverage run, so
// its timeout is a hang detector sized to about 1.5x its slowest green run, not
// the shared 15m. `fast_docker` is a smaller job and keeps 15m.
describe("job timeouts (#1620)", () => {
  const timeoutOf = (name) => allBlocks.get(name).match(/^ {2}timeout: (\S+)\s*$/mu)?.[1];

  it("gives fast a 20m timeout", () => {
    expect(timeoutOf("fast")).toBe("20m");
  });

  it("gives fast_checks a 10m timeout (#1831)", () => {
    expect(timeoutOf("fast_checks")).toBe("10m");
  });

  it("keeps fast_docker at 15m", () => {
    expect(timeoutOf("fast_docker")).toBe("15m");
  });

  it("gives each integration shard a 15m timeout (#1806)", () => {
    expect(timeoutOf("integration")).toBe("15m");
  });
});

/*
 * #1615 (ADR-0039 sections 4-6): CI jobs by runner. The rig runs on the
 * `light` runners with no Docker, in three jobs extending `fidelity`'s old
 * shape; `fidelity_webkit` folds into `rig_webkit` and `smoke_firefox`
 * retires (Firefox runs the rig). The full tap-floor measurement runs in
 * its own job, `pocket_measure`, on the nightly only, and never fails it (#1616).
 */
describe("rig jobs by runner (#1615, ADR-0039)", () => {
  // #1692: film_webkit is rig_webkit's phone film, split out to fit the timeout.
  // #1546: the Chromium pixel screens left rig_chromium and are their own job.
  const RIG_JOBS = ["rig_chromium", "rig_firefox", "rig_webkit", "film_webkit", "screens_chromium"];
  const RETIRED = ["smoke_firefox", "fidelity", "fidelity_webkit"];
  const commandsOf = (name) =>
    allBlocks
      .get(name)
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n");

  // The job's `needs:` as [{job, artifacts, optional}], resolving a YAML alias
  // (the file has no YAML parser in scope). Plain `- job: x` / `artifacts:` /
  // `optional:` entries are all the pipeline uses.
  const jobNeeds = (name) => {
    const listAfter = (text, headRe) => {
      const lines = text.split("\n");
      const start = lines.findIndex((line) => headRe.test(line));
      if (start < 0) return null;
      const out = [];
      for (const line of lines.slice(start + 1)) {
        if (/^\s*#/u.test(line)) continue;
        if (!/^\s*(- |\S)/u.test(line) || (line.trim() !== "" && !/^\s{2,}/u.test(line))) break;
        out.push(line);
      }
      return out;
    };
    const block = allBlocks.get(name);
    const alias = /^ {2}needs: \*(\S+)$/mu.exec(block);
    let lines;
    if (alias) lines = listAfter(gitlabCi, new RegExp(`^\\.[\\w]+: &${alias[1]}$`, "u"));
    else {
      lines = listAfter(block, /^ {2}needs:\s*$/u);
      if (lines) lines = lines.filter((line) => /^ {4}/u.test(line));
    }
    expect(lines, `${name}: needs is a list or an alias`).not.toBeNull();
    const needs = [];
    for (const line of lines) {
      const job = /^\s*- job: (\S+)$/u.exec(line);
      if (job) needs.push({ job: job[1] });
      const flag = /^\s+(artifacts|optional): (true|false)$/u.exec(line);
      if (flag && needs.length) needs[needs.length - 1][flag[1]] = flag[2] === "true";
    }
    return needs;
  };

  it("retires smoke_firefox, fidelity and fidelity_webkit everywhere the pipeline names a job", () => {
    for (const name of RETIRED) expect(allBlocks.has(name), name).toBe(false);
    const commands = gitlabCi
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n");
    expect(commands).not.toMatch(/smoke_firefox|fidelity_webkit|job: fidelity\b|orbit_lane_admits fidelity\b/u);
    const inputs = JSON.parse(readFileSync(new URL("./ci/job-inputs.json", import.meta.url), "utf8"));
    for (const name of RETIRED) expect(Object.keys(inputs.jobs), name).not.toContain(name);
    for (const name of RIG_JOBS) expect(Object.keys(inputs.jobs), name).toContain(name);
  });

  it("runs each rig job on the light runners in the Playwright image, with no Docker and the fast-built web app", () => {
    for (const name of RIG_JOBS) {
      const block = allBlocks.get(name);
      expect(block, `${name} is not defined`).toBeDefined();
      expect(block, name).toMatch(/^ {2}stage: acceptance$/mu);
      expect(block, name).toMatch(/^ {2}tags: \[light\]$/mu);
      expect(block, name).toMatch(/^ {4}name: \$PLAYWRIGHT_IMAGE$/mu);
      // Behaviour, not spelling (see jobNeeds): every need the gated set has, kept as it is.
      const gated = jobNeeds("integration").filter((need) => need.job !== "integration");
      expect(gated.length, "the gated set").toBeGreaterThan(0);
      const needs = jobNeeds(name);
      for (const need of gated) expect(needs, `${name}: keeps need ${need.job}`).toContainEqual(need);
      expect(needs.find((need) => need.job === "fast_checks"), `${name}: fast_checks with artifacts (#1831)`).toMatchObject({ artifacts: true });
      expect(block, `${name}: no Docker`).not.toMatch(/^ {2}(extends|services|resource_group):/mu);
      expect(commandsOf(name), `${name}: no Docker`).not.toMatch(/docker/u);
      // Workers are set, not taken from the host's CPU count: os.cpus() in a
      // job container sees the whole host, not the per-job cap (ADR-0039 section 5).
      // film_webkit runs the film project, which keeps its own one worker (#1692);
      // screens_chromium runs the pixel screens, one worker by design (#1148, #1546).
      if (name === "film_webkit" || name === "screens_chromium") expect(block, `${name}: no rig workers`).not.toMatch(/ORBIT_RIG_WORKERS/u);
      else expect(block, `${name}: the configured workers`).toMatch(/^ {4}ORBIT_RIG_WORKERS: "\d+"$/mu);
      // Gated on the front end, before any Playwright run.
      const commands = commandsOf(name);
      const gate = commands.indexOf('if [ "${ORBIT_WEB:-true}" != "true" ]; then');
      expect(gate, `${name}: no ORBIT_WEB gate`).toBeGreaterThan(-1);
      expect(gate, name).toBeLessThan(commands.search(/pnpm --filter orbit-web (rig|fidelity)\b/u));
    }
  });

  it("makes each rig job wait for integration to finish, without its artifacts and only if integration exists (#1615, pipeline 3494)", () => {
    for (const name of RIG_JOBS) {
      const wait = jobNeeds(name).find((need) => need.job === "integration");
      expect(wait, `${name}: needs integration`).toBeDefined();
      expect(wait, name).toMatchObject({ artifacts: false, optional: true });
    }
    // integration's own needs do not change: it does not wait for itself or the rigs.
    const own = jobNeeds("integration").map((need) => need.job);
    expect(own).not.toContain("integration");
    for (const name of RIG_JOBS) expect(own, name).not.toContain(name);
  });

  // #1546 review: Playwright's blob reporter empties web/blob-report at the start
  // of each run, so the quarantine run that follows the main run would wipe the
  // main run's blob on a passing shard. PWTEST_BLOB_DO_NOT_REMOVE=1 stops that.
  it("keeps the main run's blob when the quarantine run starts (#1546 review)", () => {
    for (const name of RIG_JOBS) {
      const lines = commandsOf(name).split("\n");
      const at = lines.findIndex((line) => /pnpm --filter orbit-web \S+:quarantine\b/u.test(line));
      expect(at, `${name}: has a quarantine run`).toBeGreaterThan(-1);
      const before = lines.slice(0, at).join("\n");
      const sameLine = /\bPWTEST_BLOB_DO_NOT_REMOVE=1\b.*pnpm --filter orbit-web/u.test(lines[at]);
      const exported = /^\s*(?:- )?export PWTEST_BLOB_DO_NOT_REMOVE=1\s*$/mu.test(before);
      expect(sameLine || exported, `${name}: the quarantine run sets PWTEST_BLOB_DO_NOT_REMOVE=1`).toBe(true);
    }
  });

  it("relies on a Playwright that honours PWTEST_BLOB_DO_NOT_REMOVE (1.63)", () => {
    const runner = new URL("../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/lib/runner/index.js", import.meta.url);
    expect(readFileSync(runner, "utf8")).toContain("PWTEST_BLOB_DO_NOT_REMOVE");
  });

  it("runs the projects ADR-0039 section 4 names in each rig job", () => {
    // The package scripts each job runs (`exec svelte-kit sync` is preparation).
    const runs = (name) =>
      [...commandsOf(name).matchAll(/pnpm --filter orbit-web (\S+)/gu)].map((match) => match[1]).filter((script) => script !== "exec");
    // Chromium desktop and phone journeys; the pixel screens are their own job
    // since #1546 (one worker cannot shard), and the measurement is another
    // nightly job (next test).
    expect(runs("rig_chromium")).toEqual(["rig:chromium", "rig:chromium:quarantine"]);
    expect(runs("screens_chromium")).toEqual(["fidelity", "fidelity:quarantine"]);
    expect(runs("rig_firefox")).toEqual(["rig:firefox", "rig:firefox:quarantine"]);
    // #1692: the pocket-webkit film (folded into rig_webkit by #1615) is its own job,
    // so each of the two fits its timeout.
    expect(runs("rig_webkit")).toEqual(["rig:webkit", "rig:webkit:quarantine"]);
    expect(runs("film_webkit")).toEqual(["fidelity:webkit", "fidelity:webkit:quarantine"]);
    const { scripts } = JSON.parse(readFileSync(new URL("../web/package.json", import.meta.url), "utf8"));
    expect(scripts["rig:chromium"]).toMatch(/--project=rig-desktop --project=rig-phone /u);
    // #1546: changed from "... and --project=fidelity": the screens left for screens_chromium.
    expect(scripts["rig:chromium"]).not.toMatch(/--project=fidelity\b/u);
    expect(scripts["rig:chromium:quarantine"]).not.toMatch(/--project=fidelity\b/u);
    expect(scripts["rig:chromium"]).not.toMatch(/pocket-measure/u);
    expect(scripts["rig:webkit"]).toMatch(/--project=rig-webkit-desktop --project=rig-webkit-phone/u);
    expect(scripts["fidelity:webkit"]).toMatch(/--project=pocket-webkit/u);
    expect(scripts["pocket-measure"]).toMatch(/--project=pocket-measure/u);
    // No job but pocket_measure runs the measurement.
    for (const [name] of jobs) {
      // The filer only reads pocket_measure's log (D-SEC2).
      if (name === "pocket_measure" || name === "pocket_measure_filing") continue;
      expect(commandsOf(name), name).not.toMatch(/pocket-measure/u);
    }
  });

  /*
   * #1616 item 3 (owner, 2026-11-01): the full tap-floor measurement is its
   * own job, nightly only, and nowhere else. A miss is a Low: the job files
   * the screens itself and ends as an allowed warning (exit 3). Any other
   * failure -- install, server, runner, a log that names no screen -- fails
   * the job for real, so nightly_report files it with the night.
   */
  it("measures the tap floor in its own nightly-only job (#1616)", () => {
    const block = allBlocks.get("pocket_measure");
    expect(block, "pocket_measure is not defined").toBeDefined();
    expect(block).toMatch(/^ {2}tags: \[light\]$/mu);
    expect(block).toMatch(/^ {4}name: \$PLAYWRIGHT_IMAGE$/mu);
    expect(block).toMatch(/^ {2}needs: \*needs_gated_with_fast_artifacts$/mu);
    expect(block).toMatch(/\n {2}allow_failure:\n {4}exit_codes:\n {6}- 3\n/u);
    expect(block).not.toMatch(/allow_failure: true/u);
    expect(commandsOf("pocket_measure")).toMatch(/pnpm --filter orbit-web pocket-measure\b/u);
    // It stops on an idle or yielding night like the others, and never stands
    // on an earlier run: no other job measures, so no evidence could cover it.
    expect(commandsOf("pocket_measure")).toMatch(/orbit_lane_admits pocket_measure \|\| exit 0/u);
    expect(commandsOf("pocket_measure")).not.toMatch(/reuse_gate|reuse-gate|reuse_evidence|reuse-evidence/u);
    expect(jobVerdict("pocket_measure", events.nightly)).toBe("run");
    for (const [event, environment] of Object.entries({
      ...events,
      hotfixPush: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "hotfix/x" },
      mainMergeRequest: { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" },
      byHand: { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" },
      labelled: { ...events.devMergeRequest, CI_MERGE_REQUEST_LABELS: "ci: acceptance" },
    })) {
      if (event === "nightly") continue;
      expect(jobVerdict("pocket_measure", environment), event).toBe("never");
    }
  });

  /* Run, not read: the measurement step with a stub `pnpm` and a stub filer. */
  function measureExit(pnpmExit) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-pocket-measure-")));
    try {
      stubBin(directory, { pnpm: `#!/bin/sh\necho "  1) [pocket-measure] › x.spec.js:1:1 › a › /inbox · empty meets the pocket floors"\nexit ${pnpmExit}\n` });
      const items = scriptItems("pocket_measure").filter((item) => /pocket-measure/u.test(item));
      expect(items, "one measurement step").toHaveLength(1);
      expect(items[0], "the measurement step holds no install").not.toMatch(/install/u);
      const result = spawnSync("sh", ["-c", `${items[0]}\nexit 0`], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: `${join(directory, "bin")}:${process.env.PATH}` },
      });
      expect(result.error, result.stderr).toBeUndefined();
      return { status: result.status, missed: existsSync(join(directory, "pocket-measure.missed")), stdout: result.stdout };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("ends a tap-floor miss as a warning, leaves the log and a marker for the filer, and files nothing itself (#1616, D-SEC2)", () => {
    const green = measureExit(0);
    expect(green.status).toBe(0);
    expect(green.missed, "a green night leaves no marker").toBe(false);
    // The log is shown in the job, and handed to the filer.
    expect(green.stdout).toMatch(/\/inbox · empty/u);
    const missed = measureExit(1);
    expect(missed.status).toBe(3);
    expect(missed.missed).toBe(true);
  });

  /* Run, not read: the measurement steps with a stub `pnpm` that logs its arguments. */
  function measureBoth({ main, quarantine }) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-pocket-quarantine-")));
    try {
      stubBin(directory, {
        pnpm: `#!/bin/sh
echo "$*" >> calls.log
case "$*" in
  *pocket-measure:quarantine*) echo "quarantine output"; exit ${quarantine} ;;
  *pocket-measure*) echo "main output"; exit ${main} ;;
esac
exit 0
`,
      });
      const items = scriptItems("pocket_measure").filter((item) => /pocket-measure/u.test(item));
      const result = spawnSync("bash", ["-e", "-c", `${items.join("\n")}\nexit 0`], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: `${join(directory, "bin")}:${process.env.PATH}` },
      });
      expect(result.error, result.stderr).toBeUndefined();
      const read = (name) => (existsSync(join(directory, name)) ? readFileSync(join(directory, name), "utf8") : null);
      return {
        status: result.status,
        missed: existsSync(join(directory, "pocket-measure.missed")),
        calls: (read("calls.log") ?? "").trim().split("\n").filter(Boolean),
        mainLog: read("pocket-measure.log"),
        quarantineLog: read("pocket-measure-quarantine.log"),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("also runs the quarantined tests after the main measurement, in their own log, without changing the verdict (#1670 W-F3)", () => {
    for (const [main, quarantine, status, missed] of [
      [0, 0, 0, false],
      [0, 1, 0, false],
      [1, 0, 3, true],
      [1, 1, 3, true],
    ]) {
      const label = `main ${main}, quarantine ${quarantine}`;
      const run = measureBoth({ main, quarantine });
      expect(run.calls, label).toEqual([
        "--filter orbit-web pocket-measure",
        "--filter orbit-web pocket-measure:quarantine",
      ]);
      expect(run.status, label).toBe(status);
      expect(run.missed, label).toBe(missed);
      expect(run.quarantineLog, label).toContain("quarantine output");
      expect(run.quarantineLog, label).not.toContain("main output");
      expect(run.mainLog, label).toContain("main output");
      expect(run.mainLog, label).not.toContain("quarantine output");
    }
  });

  it("keeps the quarantine log as an artifact and no longer says the main run includes the quarantined tests (#1670 W-F3)", () => {
    const block = allBlocks.get("pocket_measure");
    expect(block).toMatch(/^ {6}- pocket-measure-quarantine\.log$/mu);
    const comments = block
      .split("\n")
      .filter((line) => /^\s*#/u.test(line))
      .join("\n");
    expect(comments).not.toMatch(/the quarantined ones too|every test/iu);
  });

  it("keeps rig_chromium off merge requests into dev until three measured runs under 10 minutes are recorded (#1412, #1517)", () => {
    for (const environment of [
      events.devMergeRequest,
      { ...events.devMergeRequest, ORBIT_WEB: "true" },
    ]) {
      expect(jobVerdict("rig_chromium", environment)).toBe("never");
    }
    // The rule is written, switched off, with its condition beside it.
    const rules = rulesText("rig_chromium");
    const off = rules.split("\n").filter((line) => /^\s*#/u.test(line)).join("\n");
    expect(off).toMatch(/#\s*- if: .*\$CI_PIPELINE_SOURCE == "merge_request_event".*\$CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "dev"/u);
    expect(off).toMatch(/three/u);
    expect(off).toMatch(/10 minutes/u);
    expect(off).toMatch(/#1517/u);
  });

  it("gates publication on the promotion job list of ADR-0039 section 4", () => {
    const needs = needsOf(allBlocks.get("record_image"));
    // #1763: the four rig and film jobs left the list; screens_chromium stays.
    for (const name of ["screens_chromium", "smoke", "smoke_webkit", "smoke_webkit_mobile"]) {
      expect(needs, name).toMatch(new RegExp(`- job: ${name}\\n\\s+optional: true\\n`, "u"));
    }
    expect(needs).toMatch(/- job: smoke_local_only\n/u);
    for (const name of NIGHTLY_ONLY_JOBS) expect(needs, name).not.toMatch(new RegExp(`job: ${name}\\n`, "u"));
    for (const name of RETIRED) expect(needs, name).not.toMatch(new RegExp(`job: ${name}\\n`, "u"));
  });

  // #1546 changed this: "gives rig_webkit and film_webkit 35 minutes each" (#1692).
  // Sharded, no browser job comes near a limit (the worst shard is about 11 minutes).
  it("gives each browser job its sharded timeout, and leaves no one-off skip in any job's rules (#1546, #1692)", () => {
    const timeout = (name) => allBlocks.get(name)?.match(/^ {2}timeout: (\S+)\s*$/mu)?.[1];
    expect(timeout("rig_chromium")).toBe("15m");
    expect(timeout("rig_firefox")).toBe("15m");
    expect(timeout("rig_webkit")).toBe("20m");
    expect(timeout("film_webkit")).toBe("20m");
    expect(timeout("screens_chromium")).toBe("15m");
    for (const [name] of jobs) {
      expect(rulesText(name) ?? "", `${name}: rules still carry owner decision 61`).not.toMatch(/decision 61/u);
    }
    expect(rulesText("rig_webkit")).toBe(rulesText("film_webkit"));
  });

  // #1546 changed this from eight (#1692): screens_chromium is the ninth browser job.
  it("counts screens_chromium among nine browser jobs in the nightly's and the hotfix gate's comments (#1546)", () => {
    for (const hidden of [".nightly_browsers", ".not_on_hotfix"]) {
      const start = gitlabCi.indexOf(`${hidden}: &`);
      const text = gitlabCi.slice(gitlabCi.lastIndexOf("\n\n", start), start);
      expect(text, hidden).toMatch(/nine browser jobs/u);
      expect(text, hidden).not.toMatch(/(seven|eight) browser jobs/u);
    }
  });

  it("names the rig jobs in the nightly's and the hotfix gate's job lists", () => {
    for (const hidden of [".nightly_browsers", ".not_on_hotfix"]) {
      const start = gitlabCi.indexOf(`${hidden}: &`);
      const text = gitlabCi.slice(gitlabCi.lastIndexOf("\n\n", start), start);
      for (const name of RIG_JOBS) expect(text, `${hidden}: ${name}`).toContain(`\`${name}\``);
      expect(text, hidden).not.toMatch(/smoke_firefox|fidelity_webkit/u);
    }
  });

  it("marks docs/quality-strategy.md's \"What runs where\" table live", () => {
    const text = readFileSync(new URL("../docs/quality-strategy.md", import.meta.url), "utf8");
    const start = text.indexOf("### What runs where");
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf("\n#", start + 4));
    expect(section).not.toMatch(/The target once/u);
    expect(section).toMatch(/[Ll]ive/u);
    for (const name of RIG_JOBS) expect(section, name).toContain(`\`${name}\``);
  });

  /*
   * #1546 (design note 52876, owner decision 97a): the browser jobs are
   * GitLab `parallel:` shards, Playwright's own `--shard` set from CI_NODE_*
   * by web/playwright.config.js. job-inputs.json holds the count the evidence
   * machinery expands to `name 1/N` ... `name N/N`, so the two must agree or
   * evidence would name jobs the pipeline never runs.
   */
  const SHARDED = { rig_chromium: 2, rig_firefox: 2, rig_webkit: 3, film_webkit: 2 };
  const inputsJson = () => JSON.parse(readFileSync(new URL("./ci/job-inputs.json", import.meta.url), "utf8"));
  const parallelOf = (name) => allBlocks.get(name).match(/^ {2}parallel: (\S+)\s*(?:#.*)?$/mu)?.[1];

  it("gives each sharded job a `parallel:` count equal to its `shards` in job-inputs.json (#1546)", () => {
    for (const [name, count] of Object.entries(SHARDED)) {
      expect(inputsJson().jobs[name]?.shards, `${name}: shards in job-inputs.json`).toBe(count);
      expect(parallelOf(name), `${name}: parallel:`).toBe(String(count));
    }
  });

  it("splits integration into four `parallel:` jobs, equal to its `shards` in job-inputs.json (#1806)", () => {
    expect(inputsJson().jobs.integration?.shards, "integration: shards in job-inputs.json").toBe(4);
    expect(parallelOf("integration"), "integration: parallel:").toBe("4");
  });

  it("shards no other job by `shards`, and gives screens_chromium no `parallel:` (one worker cannot shard, #1148)", () => {
    for (const [name, declared] of Object.entries(inputsJson().jobs)) {
      if (name in SHARDED || name === "integration") continue;
      expect(declared.shards, `${name}: shards`).toBeUndefined();
    }
    expect(parallelOf("screens_chromium")).toBeUndefined();
  });

  it("puts the rig's gate, rules, needs and evidence on screens_chromium as on the other rig jobs (#1546)", () => {
    const block = allBlocks.get("screens_chromium");
    expect(block, "screens_chromium is defined").toBeDefined();
    expect(block).toMatch(/^ {2}rules: \*rig_rules$/mu);
    expect(block).toMatch(/^ {2}needs: \*needs_rig$/mu);
    expect(commandsOf("screens_chromium")).toMatch(/orbit_lane_admits screens_chromium \|\| exit 0/u);
    expect(commandsOf("screens_chromium")).toMatch(/^\s+- \*reuse_gate$/mu);
    expect(block, "no Docker").not.toMatch(/^ {2}(extends|services|resource_group):/mu);
    expect(block).toMatch(/\n {2}allow_failure:\n {4}exit_codes:\n {6}- 3\n/u);
    expect(commandsOf("screens_chromium")).toMatch(/^\s+- \*reuse_evidence$/mu);
    expect(commandsOf("screens_chromium")).toMatch(/- if \[ -f \.quarantine-failed \]; then exit 3; fi/u);
  });

  it("starts screens_chromium on a preview push, unlike the nightly-only rig jobs (#1546, #1763)", () => {
    expect(jobVerdict("screens_chromium", events.previewPush)).toBe("run");
    expect(rulesText("screens_chromium")).not.toBe(rulesText("rig_webkit"));
  });

  it("makes every sharded rig job and screens_chromium resource-peak-aware: the `resource peak` trap, before the browsers run (#1546, b0a12513)", () => {
    for (const name of [...RIG_JOBS, "pocket_measure"]) {
      const commands = commandsOf(name);
      expect(commands, `${name}: the resource peak trap`).toMatch(/^\s+- \*resource_peak$/mu);
      expect(commands.search(/- \*resource_peak/u), `${name}: trap set before any browser run`)
        .toBeLessThan(commands.search(/pnpm --filter orbit-web (rig|fidelity|pocket-measure)\b/u));
    }
    // The anchor is the existing one: it prints the line the design reads back.
    expect(allBlocks.get(".resource_peak")).toMatch(/resource peak: memory=/u);
  });

  it("adds the blob reporter's directory, web/blob-report/, to every shard's and screens_chromium's artifacts (#1546)", () => {
    for (const name of [...Object.keys(SHARDED), "screens_chromium"]) {
      const block = allBlocks.get(name);
      const paths = block.match(/\n {2}artifacts:\n(?:(?: {4,}[^\n]*)?\n)*/u)?.[0] ?? "";
      expect(paths, `${name}: artifacts`).toMatch(/^ {6}- web\/blob-report\/$/mu);
      expect(paths, `${name}: keeps test-results and evidence`).toMatch(/^ {6}- web\/test-results\/$/mu);
      expect(paths, `${name}: keeps evidence`).toMatch(/^ {6}- ci-evidence\/$/mu);
      expect(paths, `${name}: when: always`).toMatch(/^ {4}when: always$/mu);
    }
  });

  describe("browser_report (#1546)", () => {
    const REPORTED = [...Object.keys(SHARDED), "screens_chromium"];

    it("is an acceptance-stage light job with a 5m limit that is no reuse candidate", () => {
      const block = allBlocks.get("browser_report");
      expect(block, "browser_report is defined").toBeDefined();
      expect(block).toMatch(/^ {2}stage: acceptance$/mu);
      expect(block).toMatch(/^ {2}tags: \[light\]$/mu);
      expect(block).toMatch(/^ {2}timeout: 5m\s*$/mu);
      expect(inputsJson().jobs.browser_report).toBeUndefined();
      expect(commandsOf("browser_report")).not.toMatch(/reuse_gate|reuse-gate|reuse_evidence|reuse-evidence/u);
    });

    it("needs every rig-lane job for its artifacts", () => {
      const needs = jobNeeds("browser_report");
      for (const name of REPORTED) {
        expect(needs.find((need) => need.job === name), `needs ${name}`).toMatchObject({ artifacts: true });
      }
    });

    it("always runs, and is always allowed to fail", () => {
      const block = allBlocks.get("browser_report");
      expect(block).toMatch(/^ {2}when: always$/mu);
      expect(block).toMatch(/^ {2}allow_failure: true$/mu);
    });

    it("merges the blobs into one html and junit report, and publishes the junit for the Tests tab", () => {
      const block = allBlocks.get("browser_report");
      expect(commandsOf("browser_report")).toMatch(/playwright merge-reports\b.*--reporter[= ]html,junit|merge-reports.*html,junit/u);
      expect(commandsOf("browser_report")).toMatch(/web\/blob-report|blob-report/u);
      expect(block).toMatch(/\n {4}reports:\n {6}junit: \S*\.xml\n/u);
    });

    it("is needed by nothing", () => {
      const needing = gitlabCi
        .split("\n")
        .filter((line) => !/^\s*#/u.test(line))
        .filter((line) => /job: browser_report\b/u.test(line));
      expect(needing).toEqual([]);
      expect(allBlocks.get("browser_report"), "defined, so the check above means something").toBeDefined();
    });
  });
});

/*
 * #1665 (part of #1647, design note 50439 "Job graph"): the upgrade matrix is
 * wired into the promotion pipeline. `classify` fetches the tags and appends
 * the matrix keys to its dotenv artefact; `upgrade_cell` is one job per
 * SLOT x SHAPE; `upgrade_cell_launcher` is the one job for #1647f. Both run on
 * the merge request into `preview` and on pushes to `hotfix/*`, nowhere else.
 */
describe("upgrade matrix wiring (#1665)", () => {
  const UPGRADE_JOBS = ["upgrade_cell", "upgrade_cell_launcher"];
  const SHAPES = ["plain", "mail", "secrets-file", "oidc", "all-keys"];

  const blockOf = (name) => {
    const block = allBlocks.get(name);
    expect(block, `${name} is not defined in .gitlab-ci.yml`).toBeDefined();
    return block;
  };
  const withoutComments = (text) =>
    text
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n");
  // One key's value inside the job's `parallel: matrix:` entry, flow list
  // (`[a, b]`) or block list (`- a`).
  const matrixValues = (block, key) => {
    const text = withoutComments(block);
    const flow = text.match(new RegExp(`^\\s+(?:- )?${key}: \\[([^\\]]*)\\]\\s*$`, "mu"));
    if (flow) return flow[1].split(",").map((item) => item.trim().replace(/^["']|["']$/gu, ""));
    const listed = text.match(new RegExp(`^(\\s+)(?:- )?${key}:\\s*\\n((?:\\1 +- .*\\n?)+)`, "mu"));
    expect(listed, `no ${key} list in the matrix`).not.toBeNull();
    return [...listed[2].matchAll(/- (.*)$/gmu)].map((item) => item[1].trim().replace(/^["']|["']$/gu, ""));
  };
  const needsJobs = (block) => [...needsOf(block).matchAll(/- job: (\S+)/gu)].map((match) => match[1]);

  const allEvents = {
    ...events,
    hotfixPush: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "hotfix/1.2" },
    hotfixMergeRequest: {
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "hotfix/1.2",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "fix/y",
    },
    mainMergeRequest: { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" },
    byHand: { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" },
    labelledDevMergeRequest: { ...events.devMergeRequest, CI_MERGE_REQUEST_LABELS: "ci: acceptance" },
    scheduleOnMain: { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "main" },
  };
  // Owner answer 59a (supersedes 43a, which ran the cells on the preview push): the merge
  // request into preview, and pushes to hotfix/*. Nothing else.
  const RUNS_ON = ["promotionMergeRequest", "hotfixPush"];

  it.each(UPGRADE_JOBS)("%s exists, in the acceptance stage", (name) => {
    expect(blockOf(name)).toMatch(/^ {2}stage: acceptance$/mu);
  });

  it("gives upgrade_cell the settings #1665 lists", () => {
    const block = blockOf("upgrade_cell");
    expect(block).toMatch(/^ {2}extends: \.privileged_runner$|^ {2}extends:\n {4}- \.privileged_runner$/mu);
    expect(block).toMatch(/^ {2}image: \$ORBIT_ACCEPTANCE_IMAGE$|^ {2}image:\n {4}name: \$ORBIT_ACCEPTANCE_IMAGE$/mu);
    expect(block).not.toMatch(/^ {2}resource_group:/mu);
    expect(block).toMatch(/^ {2}timeout: 8m$/mu);
    // interruptible: true comes from `default:`; job-inputs.test.mjs keeps that the only place it is written.
    expect(block).not.toMatch(/^ {2}interruptible:/mu);
    expect(block).toMatch(/^ {2}allow_failure: false$/mu);
  });

  it("gives upgrade_cell_launcher its own 25m timeout (#1666 note 52634)", () => {
    expect(blockOf("upgrade_cell_launcher")).toMatch(/^ {2}timeout: 25m$/mu);
  });

  it("starts the in-job Docker daemon and tears it down, as every *docker_in_job job does (#823)", () => {
    blockOf("upgrade_cell");
    const items = scriptItems("upgrade_cell");
    expect(items).toContain("*reach_helpers");
    expect(items).toContain("*docker_in_job");
    expect(items.indexOf("*reach_helpers")).toBeLessThan(items.indexOf("*docker_in_job"));
    const after = blockOf("upgrade_cell").match(/\n {2}after_script:\n((?: {4}.*\n?)+)/u);
    expect(after, "after_script is missing").not.toBeNull();
    expect([...after[1].matchAll(/^ {4}- (.*)$/gmu)].map((match) => match[1].trim()).at(-1)).toBe("*docker_in_job_teardown");
  });

  it("runs scripts/ci/upgrade-cell.sh", () => {
    expect(withoutComments(blockOf("upgrade_cell"))).toMatch(/scripts\/ci\/upgrade-cell\.sh/u);
  });

  it.each(UPGRADE_JOBS)("%s needs classify (with its artefacts) and build_image", (name) => {
    const needs = needsJobs(blockOf(name));
    expect(needs).toContain("classify");
    expect(needs).toContain("build_image");
    expect(/- job: classify\n\s+artifacts: true\n/u.test(needsOf(blockOf(name)))).toBe(true);
    expect(/- job: build_image\n\s+artifacts: true\n/u.test(needsOf(blockOf(name)))).toBe(true);
  });

  it("keeps upgrade-cells/ always, and the JUnit report, as upgrade_cell artefacts", () => {
    const section = blockOf("upgrade_cell").match(/\n {2}artifacts:\n((?: {4}.*\n|[ \t]*\n)+)/u);
    expect(section, "artifacts: is missing").not.toBeNull();
    const text = withoutComments(section[1]);
    expect(text).toMatch(/^ {4}when: always$/mu);
    expect(text).toMatch(/^ {6}- upgrade-cells\/$/mu);
    expect(text).toMatch(/^ {4}reports:\n {6}junit: \S*upgrade-cells\//mu);
  });

  it("runs upgrade_cell over SLOT x SHAPE in one matrix entry", () => {
    const text = withoutComments(blockOf("upgrade_cell"));
    expect(text).toMatch(/^ {2}parallel:\n {4}matrix:\n/mu);
    expect(text.match(/^\s+- SLOT:/gmu), "one matrix entry").toHaveLength(1);
  });

  // The one place in CI that repeats UPGRADE_FROM_COUNT.
  it("lists latest-1 .. latest-UPGRADE_FROM_COUNT as the matrix SLOT, no more and no fewer", () => {
    const expected = Array.from({ length: UPGRADE_FROM_COUNT }, (_, index) => `latest-${index + 1}`);
    expect(matrixValues(blockOf("upgrade_cell"), "SLOT")).toEqual(expected);
  });

  it("lists the five shapes as the matrix SHAPE, each with a shape file", () => {
    const listed = matrixValues(blockOf("upgrade_cell"), "SHAPE");
    expect([...listed].sort()).toEqual([...SHAPES].sort());
    const directory = new URL("./ci/upgrade-shapes/", import.meta.url);
    const files = readdirSync(directory).filter((file) => file.endsWith(".sh") && file !== "lib.sh");
    expect(files.map((file) => file.replace(/\.sh$/u, "")).sort()).toEqual([...listed].sort());
  });

  it("runs the upgrade cells in parallel: upgrade_cell has no resource_group (#1751, replaces owner 39a)", () => {
    expect(blockOf("upgrade_cell")).not.toMatch(/^ {2}resource_group:/mu);
  });

  it("leaves upgrade_cell_launcher without a resource_group, as before (#1751)", () => {
    expect(blockOf("upgrade_cell_launcher")).not.toMatch(/^ {2}resource_group:/mu);
  });

  it.each(UPGRADE_JOBS)("starts %s on the merge request into preview and on a hotfix push, and on no other event (59a)", (name) => {
    blockOf(name);
    for (const [event, environment] of Object.entries(allEvents)) {
      expect(jobVerdict(name, environment), `${name} on ${event}`).toBe(RUNS_ON.includes(event) ? "run" : "never");
    }
  });

  it("runs scripts/ci/upgrade-cell-launcher.sh in upgrade_cell_launcher, not a stub (#1666)", () => {
    const text = withoutComments(blockOf("upgrade_cell_launcher"));
    expect(text).toMatch(/scripts\/ci\/upgrade-cell-launcher\.sh/u);
    expect(text).not.toMatch(/blocked on ai\/orbit-launcher#331/u);
    expect(needsJobs(blockOf("upgrade_cell_launcher"))).toContain("build_launcher");
  });

  it("starts the in-job daemon in upgrade_cell_launcher, after the helpers (#1666)", () => {
    const items = scriptItems("upgrade_cell_launcher");
    expect(items).toContain("*docker_in_job");
    expect(items.indexOf("*reach_helpers")).toBeLessThan(items.indexOf("*docker_in_job"));
  });

  it("keeps upgrade-cells/ always, and the JUnit report, as upgrade_cell_launcher artefacts (#1666)", () => {
    const section = blockOf("upgrade_cell_launcher").match(/\n {2}artifacts:\n((?: {4}.*\n|[ \t]*\n)+)/u);
    expect(section, "artifacts: is missing").not.toBeNull();
    const text = withoutComments(section[1]);
    expect(text).toMatch(/^ {4}when: always$/mu);
    expect(text).toMatch(/^ {6}- upgrade-cells\/$/mu);
    expect(text).toMatch(/^ {4}reports:\n {6}junit: \S*upgrade-cells\//mu);
  });

  // The seven pipeline kinds the spec names, spelled out so a new event in allEvents cannot hide a gap.
  it.each(UPGRADE_JOBS)("%s: the verdict on each of the seven pipeline kinds (59a)", (name) => {
    const expected = {
      "a merge request into preview": [allEvents.promotionMergeRequest, "run"],
      "a push to hotfix/*": [allEvents.hotfixPush, "run"],
      "a push to preview": [allEvents.previewPush, "never"],
      "a push to main": [allEvents.mainPush, "never"],
      "a schedule": [allEvents.nightly, "never"],
      "a merge request into dev": [allEvents.devMergeRequest, "never"],
      "a merge request into hotfix/*": [allEvents.hotfixMergeRequest, "never"],
    };
    for (const [kind, [environment, verdict]] of Object.entries(expected)) {
      expect(jobVerdict(name, environment), `${name} on ${kind}`).toBe(verdict);
    }
    // Any merge request into preview, whatever its source branch.
    const fromFeature = { ...allEvents.promotionMergeRequest, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/z" };
    expect(jobVerdict(name, fromFeature), `${name} on a merge request into preview from a feature branch`).toBe("run");
  });

  it("gives upgrade_cell_launcher the same rules as upgrade_cell", () => {
    blockOf("upgrade_cell_launcher");
    blockOf("upgrade_cell");
    expect(rulesOf("upgrade_cell_launcher")).toEqual(rulesOf("upgrade_cell"));
  });

  it("names both jobs in the lane gate, guarded by their own names", () => {
    const guarded = guardedJobs();
    for (const name of UPGRADE_JOBS) {
      const found = guarded.find((job) => job.name === name);
      expect(found, `${name} does not call orbit_lane_admits`).toBeDefined();
      expect(found.lane).toBe(name);
    }
    // Narrow lanes skip them (the lane lists name neither); the full lane admits them by wildcard.
    const named = admissions().map(([, job]) => job);
    for (const name of UPGRADE_JOBS) expect(named, name).not.toContain(name);
  });

  describe("skip guard (#1665, 60a)", () => {
    const admitsIndex = (items, name) => items.findIndex((item) => new RegExp(`^orbit_lane_admits ${name}( |$)`, "u").test(item.trim()));
    const guardIndex = (items) => items.findIndex((item) => /UPGRADE_CELLS\b/u.test(item) && /upgrade-cell SKIP/u.test(item));
    const SKIP_REASON = (since) => `reason="nothing update-relevant changed since ${since} (#1665)"`;

    // The items between the lane gate and the point that must come after the guard (inclusive of the guard,
    // exclusive of that point), then a marker that only prints if nothing exited. Run in one shell, as GitLab does.
    const runGuard = (name, stop, environment) => {
      const items = scriptItems(name);
      const from = admitsIndex(items, name);
      const to = stop(items);
      expect(from, `${name} does not call orbit_lane_admits`).toBeGreaterThan(-1);
      expect(to, `${name}: the point the guard must precede is missing`).toBeGreaterThan(from);
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-skip-guard-")));
      try {
        stubBin(directory);
        const marker = "GUARD-FELL-THROUGH";
        const result = runItems([...items.slice(from + 1, to), `echo ${marker}`], jobEnvironment(directory, environment), directory);
        return { result, ranCell: result.stdout.includes(marker), out: result.stdout };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    // upgrade_cell: the guard must precede the daemon. upgrade_cell_launcher has no daemon: it must precede the cell body.
    const CELLS = {
      upgrade_cell: { stop: (items) => items.indexOf("*docker_in_job"), shape: "oidc", slot: "latest-2", version: "v0.3.5" },
      upgrade_cell_launcher: {
        stop: (items) => items.indexOf("*docker_in_job"),
        shape: "launcher",
        slot: undefined,
        version: "-",
      },
    };

    it.each(UPGRADE_JOBS)("%s: the guard follows orbit_lane_admits and precedes the Docker daemon", (name) => {
      const items = scriptItems(name);
      const admits = admitsIndex(items, name);
      const guard = guardIndex(items);
      expect(admits, `${name} does not call orbit_lane_admits`).toBeGreaterThan(-1);
      expect(guard, `${name} has no UPGRADE_CELLS skip guard`).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(admits);
      const docker = items.findIndex((item) => item === "*docker_in_job" || /\bdockerd\b/u.test(item));
      if (docker !== -1) expect(guard).toBeLessThan(docker);
      expect(guard, "the guard comes before the cell itself").toBeLessThan(CELLS[name].stop(items));
    });

    it.each(UPGRADE_JOBS)("%s: UPGRADE_CELLS=skip prints the SKIP line and ends the job green", (name) => {
      const cell = CELLS[name];
      const environment = {
        UPGRADE_CELLS: "skip",
        UPGRADE_CELLS_SINCE: "9f8e7d6c",
        SHAPE: name === "upgrade_cell_launcher" ? "" : cell.shape,
        ...(cell.slot ? { SLOT: cell.slot, ORBIT_UPGRADE_SLOT_LATEST_2: "v0.3.5" } : {}),
      };
      const { result, ranCell, out } = runGuard(name, cell.stop, environment);
      expect(result.status, result.stderr).toBe(0);
      expect(ranCell, "the job went on past the guard").toBe(false);
      expect(out).toContain(`upgrade-cell SKIP version=${cell.version} shape=${cell.shape} ${SKIP_REASON("9f8e7d6c")}`);
    });

    it("upgrade_cell: a slot with no tag prints version=-", () => {
      const { result, ranCell, out } = runGuard("upgrade_cell", CELLS.upgrade_cell.stop, {
        UPGRADE_CELLS: "skip",
        UPGRADE_CELLS_SINCE: "abc123",
        SLOT: "latest-3",
        SHAPE: "mail",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(ranCell).toBe(false);
      expect(out).toContain(`upgrade-cell SKIP version=- shape=mail ${SKIP_REASON("abc123")}`);
    });

    it("upgrade_cell: with no SHAPE the line says shape=plain", () => {
      const { result, out } = runGuard("upgrade_cell", CELLS.upgrade_cell.stop, {
        UPGRADE_CELLS: "skip",
        UPGRADE_CELLS_SINCE: "abc123",
        SLOT: "latest-1",
        ORBIT_UPGRADE_SLOT_LATEST_1: "v0.3.4",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(out).toContain(`upgrade-cell SKIP version=v0.3.4 shape=plain ${SKIP_REASON("abc123")}`);
    });

    const NOT_SKIP = { "unset": undefined, "empty": "", run: "run", SKIP: "SKIP", Skip: "Skip", "skip with a space": "skip ", skipped: "skipped", "true": "true", "0": "0" };
    it.each(UPGRADE_JOBS)("%s: any value but exactly 'skip' runs the cell", (name) => {
      for (const [label, value] of Object.entries(NOT_SKIP)) {
        const environment = { UPGRADE_CELLS_SINCE: "abc123", SLOT: "latest-1", SHAPE: "plain", ORBIT_UPGRADE_SLOT_LATEST_1: "v0.3.6" };
        if (value !== undefined) environment.UPGRADE_CELLS = value;
        const { result, ranCell, out } = runGuard(name, CELLS[name].stop, environment);
        expect(result.status, `${name} with UPGRADE_CELLS ${label}: ${result.stderr}`).toBe(0);
        expect(ranCell, `${name} with UPGRADE_CELLS ${label} must run the cell`).toBe(true);
        expect(out, `${name} with UPGRADE_CELLS ${label}`).not.toMatch(/upgrade-cell SKIP[^\n]*#1665/u);
      }
    });
  });

  describe("classify", () => {
    it("fetches the tags and appends the upgrade-versions output to classify.env, in that order", () => {
      const script = withoutComments(blockOf("classify"));
      const fetch = script.search(/git fetch\b[^\n]*--tags\b/u);
      const append = script.search(/node scripts\/ci\/upgrade-versions\.mjs >> classify\.env/u);
      expect(fetch, "classify does not run git fetch --tags").toBeGreaterThan(-1);
      expect(append, "classify does not append upgrade-versions.mjs output to classify.env").toBeGreaterThan(-1);
      expect(fetch).toBeLessThan(append);
      // After classify.env exists: the lane line is the last of its base keys.
      expect(script.indexOf("printf 'ORBIT_LANE=%s\\n' \"$lane\" >> classify.env")).toBeLessThan(append);
    });

    // 59a/60a gate. Run, not read, for the shell decisions; text for the artefact list.
    const GATE_ARGS = "scripts/ci/upgrade-cells-gate.mjs .orbit-upgrade/gate.env";
    const gateItems = () => scriptItems("classify").filter((item) => /upgrade-cells-gate\.mjs/u.test(item));

    // node stub: logs its arguments; `upgrade-cells-gate.mjs` does what GATE_MODE says; anything else prints nothing.
    const NODE_GATE_STUB = [
      "#!/bin/sh",
      'printf "%s\\n" "node $*" >> "$STUB_GIT_LOG"',
      'case "$1" in',
      "  scripts/ci/upgrade-cells-gate.mjs)",
      '    case "$GATE_MODE" in',
      '      skip) mkdir -p "$(dirname "$2")"; printf "UPGRADE_CELLS=skip\\nUPGRADE_CELLS_SINCE=feedface\\n" > "$2" ;;',
      '      run) mkdir -p "$(dirname "$2")"; printf "UPGRADE_CELLS=run\\n" > "$2" ;;',
      '      skip-then-fail) mkdir -p "$(dirname "$2")"; printf "UPGRADE_CELLS=skip\\nUPGRADE_CELLS_SINCE=feedface\\n" > "$2"; exit 1 ;;',
      "      fail) exit 1 ;;",
      "      nothing) exit 0 ;;",
      "    esac ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n");

    const runGate = (mode) => {
      const step = gateItems();
      expect(step, "classify has no step that runs upgrade-cells-gate.mjs").toHaveLength(1);
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-classify-gate-")));
      try {
        stubBin(directory, { node: NODE_GATE_STUB });
        writeFileSync(join(directory, "classify.env"), "ORBIT_LANE=full\n", "utf8");
        const result = runItems(step, jobEnvironment(directory, { GATE_MODE: mode }), directory);
        const calls = readFileSync(join(directory, "git.log"), "utf8").split("\n").filter(Boolean);
        return { result, calls, env: readFileSync(join(directory, "classify.env"), "utf8") };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };

    it("runs the gate with .orbit-upgrade/gate.env after the upgrade-versions step", () => {
      const items = scriptItems("classify");
      const versions = items.findIndex((item) => /upgrade-versions\.mjs/u.test(item));
      const gate = items.findIndex((item) => /upgrade-cells-gate\.mjs/u.test(item));
      expect(gate, "classify never runs upgrade-cells-gate.mjs").toBeGreaterThan(-1);
      expect(gate).toBeGreaterThanOrEqual(versions);
      if (gate === versions) {
        expect(items[gate].search(/upgrade-versions\.mjs/u)).toBeLessThan(items[gate].search(/upgrade-cells-gate\.mjs/u));
      }
      const { calls } = runGate("run");
      expect(calls).toContain(`node ${GATE_ARGS}`);
    });

    it("appends what the gate wrote to classify.env, keeping the lines already there", () => {
      const { result, env } = runGate("skip");
      expect(result.status, result.stderr).toBe(0);
      expect(env).toBe("ORBIT_LANE=full\nUPGRADE_CELLS=skip\nUPGRADE_CELLS_SINCE=feedface\n");
    });

    it("appends a run verdict as the gate wrote it", () => {
      const { result, env } = runGate("run");
      expect(result.status, result.stderr).toBe(0);
      expect(env).toBe("ORBIT_LANE=full\nUPGRADE_CELLS=run\n");
    });

    it("falls back to UPGRADE_CELLS=run when the gate exits non-zero, and does not fail the job", () => {
      const { result, env } = runGate("fail");
      expect(result.status, result.stderr).toBe(0);
      expect(env).toBe("ORBIT_LANE=full\nUPGRADE_CELLS=run\n");
    });

    it("falls back to run when the gate exits non-zero after writing a skip: a failed gate is never a skip", () => {
      const { result, env } = runGate("skip-then-fail");
      expect(result.status, result.stderr).toBe(0);
      expect(env).not.toMatch(/UPGRADE_CELLS=skip/u);
      expect(env).not.toMatch(/UPGRADE_CELLS_SINCE/u);
      expect(env).toMatch(/^UPGRADE_CELLS=run$/mu);
    });

    it("falls back to UPGRADE_CELLS=run when the gate exits 0 but writes no file", () => {
      const { result, env } = runGate("nothing");
      expect(result.status, result.stderr).toBe(0);
      expect(env).toBe("ORBIT_LANE=full\nUPGRADE_CELLS=run\n");
    });

    it("keeps .orbit-upgrade/gate.env as a classify artefact, next to the reuse file and the dotenv report", () => {
      const section = blockOf("classify").match(/\n {2}artifacts:\n((?: {4}.*\n|[ \t]*\n)+)/u);
      expect(section, "classify has no artifacts:").not.toBeNull();
      const paths = withoutComments(section[1]).match(/^ {4}paths:\n((?: {6}- .*\n)+)/mu);
      expect(paths, "classify artifacts has no paths:").not.toBeNull();
      const listed = [...paths[1].matchAll(/- (.*)$/gmu)].map((item) => item[1].trim());
      expect(listed).toContain(".orbit-upgrade/gate.env");
      expect(listed).toContain(".orbit-reuse/reuse.env");
      expect(section[1]).toMatch(/^ {6}dotenv: classify\.env$/mu);
    });

    // The tag fetch, run with a git whose fetch fails (or succeeds). Strict means the step fails.
    const fetchItems = () => scriptItems("classify").filter((item) => /git fetch\b[^\n]*--tags\b/u.test(item));
    const runFetch = (environment, fetchSucceeds) => {
      const items = fetchItems();
      expect(items.length, "classify does not run git fetch --tags").toBeGreaterThan(0);
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-classify-fetch-")));
      try {
        stubBin(directory, {
          git: `#!/bin/sh\nprintf '%s\\n' "$*" >> "$STUB_GIT_LOG"\n[ "$1" = fetch ] && exit ${fetchSucceeds ? 0 : 1}\nexit 1\n`,
          node: NODE_GATE_STUB,
        });
        writeFileSync(join(directory, "classify.env"), "ORBIT_LANE=full\n", "utf8");
        return runItems(items, jobEnvironment(directory, { GATE_MODE: "run", ...environment }), directory);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    const FETCH_EVENTS = {
      "a merge request into preview": [allEvents.promotionMergeRequest, true],
      "a push to hotfix/*": [allEvents.hotfixPush, true],
      "a push to preview": [allEvents.previewPush, false],
      "a push to main": [allEvents.mainPush, false],
      "a push to dev": [allEvents.devPush, false],
      "a schedule": [allEvents.nightly, false],
      "a merge request into dev": [allEvents.devMergeRequest, false],
      "a merge request into hotfix/*": [allEvents.hotfixMergeRequest, false],
    };

    for (const [kind, [environment, strict]] of Object.entries(FETCH_EVENTS)) {
      it(`${strict ? "fails" : "does not fail"} classify on a failed tag fetch on ${kind}`, () => {
        const result = runFetch(environment, false);
        if (strict) expect(result.status, `${kind}: classify must fail on a failed fetch`).not.toBe(0);
        else expect(result.status, `${kind}: the fetch is best effort\n${result.stderr}`).toBe(0);
      });

      it(`leaves classify green on a good tag fetch on ${kind}`, () => {
        const result = runFetch(environment, true);
        expect(result.status, `${kind}\n${result.stderr}`).toBe(0);
      });
    }

    it("still hands classify.env to the pipeline as a dotenv artefact", () => {
      expect(blockOf("classify")).toMatch(/^ {6}dotenv: classify\.env$/mu);
    });

    // Run, not read: the step with a stub git and node.
    it("adds the keys the script prints to the file it already wrote, after fetching tags", () => {
      const step = scriptItems("classify").filter((item) => /upgrade-versions\.mjs/u.test(item));
      expect(step, "one step runs upgrade-versions.mjs").toHaveLength(1);
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-classify-upgrade-")));
      try {
        stubBin(directory, {
          node: '#!/bin/sh\nprintf "%s\\n" "node $*" >> "$STUB_GIT_LOG"\nprintf "ORBIT_UPGRADE_MATRIX=true\\nORBIT_UPGRADE_LATEST_1=v0.3.5\\nORBIT_UPGRADE_LATEST_2=\\n"\n',
        });
        writeFileSync(join(directory, "classify.env"), "ORBIT_LANE=full\n", "utf8");
        const result = runItems(step, jobEnvironment(directory, {}), directory);
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(directory, "classify.env"), "utf8")).toBe(
          "ORBIT_LANE=full\nORBIT_UPGRADE_MATRIX=true\nORBIT_UPGRADE_LATEST_1=v0.3.5\nORBIT_UPGRADE_LATEST_2=\n",
        );
        const calls = readFileSync(join(directory, "git.log"), "utf8").split("\n").filter(Boolean);
        const fetch = calls.findIndex((call) => /^fetch\b.*--tags\b/u.test(call));
        expect(fetch, calls.join("\n")).toBeGreaterThan(-1);
        expect(fetch).toBeLessThan(calls.findIndex((call) => call === "node scripts/ci/upgrade-versions.mjs"));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});

// D-SEC1 / D-SEC2: two CI-policy findings, read from .gitlab-ci.yml the same
// way as above.
function secScriptLines(block) {
  return block
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

function secRulesOf(block) {
  const start = block.search(/^ {2}rules:\s*$/mu);
  if (start < 0) return "";
  const rest = block.slice(start).split("\n").slice(1);
  const body = [];
  for (const line of rest) {
    if (/^ {2}\S/u.test(line) && !/^ {2}-/u.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

const SEC_INSTALL = /\b(pnpm install|npm install|npm i|npm ci|yarn install|pip3? install|apk add|apk_add|apt(-get)? install)\b/u;

describe("D-SEC1: hotfix images keep the runtime and deployment checks", () => {
  const scripts = [
    "verify-nonroot-runtime.sh",
    "verify-privacy-boundary.sh",
    "validate-deployment-assets.sh",
    "validate-compose.sh",
  ];

  function hotfixJobs() {
    return jobs
      .map(([name, block]) => ({ name, block: withTemplate(name, block).block }))
      .filter(({ block }) => {
        const rules = secRulesOf(block);
        return rules !== "" && !rules.includes("*not_on_hotfix") && /hotfix/u.test(rules);
      });
  }

  function recordImageNeeds() {
    const block = allBlocks.get("record_image");
    const needs = block.slice(block.search(/^ {2}needs:\s*$/mu));
    const entries = needs.split(/^ {4}- job: /mu).slice(1);
    return new Map(
      entries.map((entry) => {
        const [name] = entry.split("\n");
        const optional = /^\s*optional: true\s*$/mu.test(entry.split("\n").slice(1, 3).join("\n"));
        return [name.trim(), { optional }];
      }),
    );
  }

  for (const script of scripts) {
    it(`${script} runs in a job a hotfix push admits, which record_image requires`, () => {
      const carriers = hotfixJobs().filter(({ block }) => secScriptLines(block).includes(script));
      expect(carriers.map(({ name }) => name), `no job admitting hotfix/* runs ${script}`).not.toEqual([]);
      const needs = recordImageNeeds();
      const required = carriers.filter(({ name }) => needs.has(name) && !needs.get(name).optional);
      expect(
        required.map(({ name }) => name),
        `record_image does not need a hotfix-admitting job running ${script} non-optionally`,
      ).not.toEqual([]);
    });
  }
});

describe("D-SEC2: the tap-floor filing token never meets a dependency install", () => {
  const usesToken = (text) =>
    /SIDECAR_ISSUE_TOKEN/u.test(text.replace(/-u SIDECAR_ISSUE_TOKEN/gu, "")) || /nightly-browsers\.mjs\s+(tap-floor|report)\b/u.test(text);

  it("no job that installs dependencies reads SIDECAR_ISSUE_TOKEN or files via nightly-browsers", () => {
    const offenders = jobs
      .map(([name, block]) => ({ name, text: secScriptLines(withTemplate(name, block).block) }))
      .filter(({ text }) => SEC_INSTALL.test(text) && usesToken(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("pocket_measure does not run the tap-floor filing", () => {
    expect(secScriptLines(allBlocks.get("pocket_measure"))).not.toMatch(/nightly-browsers\.mjs\s+tap-floor/u);
  });

  it("a separate small job files tap-floor from pocket_measure's log, installing nothing", () => {
    const filers = jobs
      .filter(([name]) => name !== "pocket_measure")
      .map(([name, block]) => ({ name, block: withTemplate(name, block).block }))
      .filter(({ block }) => /nightly-browsers\.mjs\s+tap-floor/u.test(secScriptLines(block)));
    expect(filers.length, "exactly one job runs the tap-floor filing").toBe(1);
    const [{ block }] = filers;
    const text = secScriptLines(block);
    expect(text).not.toMatch(SEC_INSTALL);
    expect(text).toMatch(/pocket-measure\.log/u);
    expect(block).toMatch(/job: pocket_measure\s*\n\s*artifacts: true/u);
  });

  /* Run, not read: the filing step with a stub `node` standing in for the filer. */
  function filingRun({ marker, filerExit = 0 }) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "orbit-pocket-filing-")));
    try {
      stubBin(directory, { node: `#!/bin/sh\necho "$@" >> node.log\nexit ${filerExit}\n` });
      writeFileSync(join(directory, "pocket-measure.log"), "  1) [pocket-measure] › x.spec.js:1:1 › a › /inbox · empty\n");
      if (marker) writeFileSync(join(directory, "pocket-measure.missed"), "");
      const items = scriptItems("pocket_measure_filing");
      // GitLab runs a job's script with errexit.
      const result = spawnSync("sh", ["-ec", items.join("\n")], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: `${join(directory, "bin")}:${process.env.PATH}` },
      });
      expect(result.error, result.stderr).toBeUndefined();
      const log = join(directory, "node.log");
      return { status: result.status, filed: existsSync(log) ? readFileSync(log, "utf8").trim() : null };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("files nothing on a green night, files a miss from the log, and fails when the filer fails (#1616, D-SEC2)", () => {
    const green = filingRun({ marker: false });
    expect(green.status).toBe(0);
    expect(green.filed, "a green night files nothing").toBeNull();
    const missed = filingRun({ marker: true });
    expect(missed.status).toBe(0);
    expect(missed.filed).toBe("scripts/ci/nightly-browsers.mjs tap-floor pocket-measure.log");
    // A log that names no screen makes the filer fail; the job fails with it.
    expect(filingRun({ marker: true, filerExit: 1 }).status).not.toBe(0);
  });
});

// #1755: base_image blocks only on the way to publishing; elsewhere it warns.
// The rule shape assumed: the four skip rules first, in their order, then
// `allow_failure: false` on the rules for the publishing pipelines, and a last
// `when: on_success` with `allow_failure: true` for everything else.
describe("base_image blocks only on the way to publishing (#1755)", () => {
  const kinds = {
    "a merge request into preview": [{ CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "dev" }, "blocks"],
    "a merge request into preview from a feature branch": [{ CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/z" }, "blocks"],
    "a push to preview": [{ CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "preview" }, "blocks"],
    "a merge request into main": [{ CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "preview" }, "blocks"],
    "a push to hotfix/*": [{ CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "hotfix/1.2" }, "blocks"],
    "a merge request into dev": [events.devMergeRequest, "warns"],
    "a labelled merge request into dev": [{ ...events.devMergeRequest, CI_MERGE_REQUEST_LABELS: "ci: acceptance" }, "warns"],
    "a push to dev (starts no pipeline)": [events.devPush, "never"],
    "a merge request into hotfix/*": [{ CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "hotfix/1.2", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "fix/y" }, "warns"],
    "a pipeline started by hand": [{ CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" }, "warns"],
    "a pipeline started through the API on a feature branch": [{ CI_PIPELINE_SOURCE: "api", CI_COMMIT_BRANCH: "feature/x" }, "warns"],
    "a push to a feature branch (starts no pipeline)": [{ CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "feature/x" }, "never"],
    "a push to main": [events.mainPush, "never"],
    "a schedule": [events.nightly, "never"],
    "a merge request into a batch under intake": [{ CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "batch-a", BATCH_INTAKE: "true" }, "never"],
  };

  // "never" | "blocks" | "warns" for the first rule that matches.
  const outcome = (env) => {
    if (verdictOf(rulesOf("workflow"), env) === "never") return "never";
    for (const rule of rulesOf("base_image")) {
      if (rule.if !== undefined && !evaluate(rule.if, env)) continue;
      if ((rule.when ?? "on_success") === "never") return "never";
      return String(rule.allow_failure ?? "false").trim() === "true" ? "warns" : "blocks";
    }
    return "never";
  };

  it.each(Object.entries(kinds))("%s", (kind, [environment, expected]) => {
    expect(outcome(environment), `base_image on ${kind}`).toBe(expected);
  });

  it("starts base_image the same way as before wherever it starts", () => {
    for (const [kind, [environment, expected]] of Object.entries(kinds)) {
      const starts = jobVerdict("base_image", environment) !== "never";
      expect(starts, kind).toBe(expected !== "never");
    }
  });

  it("keeps the four skip rules first, in their order", () => {
    const text = allBlocks.get("base_image");
    const at = ["!reference [.backmerge-skip, job_rule]", "- *batch_intake_skip", "- *not_on_main_push", "- *not_scheduled"].map((item) => text.indexOf(item));
    expect(at.every((index) => index !== -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text.indexOf("allow_failure")).toBeGreaterThan(at[3]);
  });

  it("leaves no job taking base_image's artefacts", () => {
    for (const [name, block] of allBlocks) {
      expect(block, name).not.toMatch(/- job: base_image\n\s+artifacts: true/u);
    }
  });

  it("says where base_image blocks and cites #1755 in the comment above it", () => {
    const above = gitlabCi.slice(0, gitlabCi.indexOf("\nbase_image:\n")).split("\n").slice(-14).join("\n");
    expect(above).toContain("#1755");
    expect(above).toMatch(/preview/u);
    expect(above).toMatch(/hotfix/u);
    expect(above).toMatch(/main/u);
    expect(above).not.toMatch(/^# Blocking, like the old workflow's job/mu);
  });
});

// #1831: `fast` is split by phase. `fast_checks` runs the static checks, the web
// build and the render proof and publishes web/build; `fast` keeps the tests.
describe("the fast job is split by phase (#1831)", () => {
  const code = (name) =>
    (allBlocks.get(name) ?? "")
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n");
  const needsText = (name) => code(name).match(/\n {2}needs:\n((?: {4}[^\n]*\n| *\n)*)/u)?.[1] ?? null;
  const artifactPaths = (name) => {
    const section = code(name).match(/\n {2}artifacts:\n((?: {4}[^\n]*\n| *\n)*)/u)?.[1] ?? "";
    return [...section.matchAll(/^ {6}- (\S+)\s*$/gmu)].map((m) => m[1]);
  };

  // Every list of `- job: x` entries in the file, anchors and inline needs alike.
  function needLists() {
    const lists = [];
    let current = null;
    let indent = -1;
    for (const line of gitlabCi.split("\n")) {
      const entry = /^(\s*)- job: (\S+)\s*$/u.exec(line);
      if (entry) {
        if (current === null || entry[1].length !== indent) {
          current = [];
          indent = entry[1].length;
          lists.push(current);
        }
        current.push({ job: entry[2], artifacts: undefined });
        continue;
      }
      const flag = /^\s+artifacts: (true|false)\s*$/u.exec(line);
      if (flag && current?.length) {
        current[current.length - 1].artifacts = flag[1] === "true";
        continue;
      }
      if (/^\s*(#.*)?$/u.test(line) || /^\s+optional: /u.test(line)) continue;
      current = null;
    }
    return lists;
  }

  it("defines fast_checks in stage fast", () => {
    expect(allBlocks.has("fast_checks")).toBe(true);
    expect(code("fast_checks")).toMatch(/^ {2}stage: fast$/mu);
  });

  it("gives fast_checks the same rules as fast", () => {
    expect(rulesText("fast_checks")).toBe(rulesText("fast"));
  });

  it("gives fast_checks the same needs as fast", () => {
    expect(needsText("fast_checks")).not.toBeNull();
    expect(needsText("fast_checks")).toBe(needsText("fast"));
  });

  it("keeps fast at 20m and gives fast_checks 10m", () => {
    expect(code("fast")).toMatch(/^ {2}timeout: 20m\s*$/mu);
    expect(code("fast_checks")).toMatch(/^ {2}timeout: 10m\s*$/mu);
  });

  it("names fast_checks in every needs list that names fast", () => {
    const withFast = needLists().filter((list) => list.some((need) => need.job === "fast"));
    expect(withFast.length, "lists naming fast").toBeGreaterThan(0);
    for (const list of withFast) {
      expect(list.map((need) => need.job), JSON.stringify(list)).toContain("fast_checks");
    }
  });

  it("makes every job that takes fast's artifacts take fast_checks' as well", () => {
    const takers = needLists().filter((list) => list.some((need) => need.job === "fast" && need.artifacts === true));
    expect(takers.length, "lists taking fast's artifacts").toBeGreaterThan(0);
    for (const list of takers) {
      expect(list.find((need) => need.job === "fast_checks"), JSON.stringify(list)).toMatchObject({ artifacts: true });
    }
  });

  it("publishes web/build from fast_checks and not from fast", () => {
    expect(artifactPaths("fast_checks")).toContain("web/build/");
    expect(artifactPaths("fast")).not.toContain("web/build/");
  });

  it("still publishes coverage/ from fast", () => {
    expect(artifactPaths("fast")).toContain("coverage/");
  });

  it("calls test-backend.sh with ORBIT_TEST_PHASE=checks in fast_checks and tests in fast", () => {
    expect(code("fast_checks")).toMatch(/ORBIT_TEST_PHASE=['"]?checks\b[^\n]*test-backend\.sh|ORBIT_TEST_PHASE: ["']?checks/u);
    expect(code("fast_checks")).not.toMatch(/ORBIT_TEST_PHASE=['"]?tests/u);
    expect(code("fast")).toMatch(/ORBIT_TEST_PHASE=['"]?tests\b[^\n]*test-backend\.sh|ORBIT_TEST_PHASE: ["']?tests/u);
    expect(code("fast")).not.toMatch(/ORBIT_TEST_PHASE=['"]?checks/u);
  });

  it("lists ci:fast_checks in the lane case list", () => {
    expect(gitlabCi).toMatch(/\bci:fast_checks\b/u);
  });
});
