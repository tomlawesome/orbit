import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
// before `classify`, so it never sees ORBIT_LANE and always runs. So does
// `private-details` (#1562).
const laneMembers = {
  [CI_LANE.IGNORE_POLICY]: ["gitleaks", "licence_policy", "private-details", "supply_chain_source"],
  [CI_LANE.CI]: ["fast", "fast_docker", "gitleaks", "private-details", "supply_chain_source"],
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
      "fast",
      "fast_docker",
      "fidelity",
      "fidelity_webkit",
      "integration",
      // #1076: it consumes build_image's artifact, so it has to stop on a
      // lane that skipped the build rather than load the placeholder.
      "launcher_install_compat",
      "licence_policy",
      "repair_journeys",
      "smoke",
      "smoke_firefox",
      "smoke_local_only",
      "smoke_webkit",
      "smoke_webkit_mobile",
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

  // #1181: the browser suite has its own axis, and every job that runs it
  // reads that axis rather than the front-end one `fidelity` reads.
  it("gates every browser-suite job on ORBIT_E2E", () => {
    for (const name of ["smoke", "smoke_firefox", "smoke_webkit", "smoke_webkit_mobile"]) {
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
    for (const name of ["smoke", "smoke_firefox", "smoke_webkit", "smoke_webkit_mobile"]) {
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
    for (const name of ["fidelity", "fidelity_webkit", "smoke", "smoke_firefox", "smoke_webkit", "smoke_webkit_mobile"]) {
      const block = allBlocks.get(name);
      expect(block, `${name}: only exit 3 is allowed to fail`).toMatch(/\n  allow_failure:\n    exit_codes:\n      - 3\n/u);
      expect(block, `${name}: the quarantine run marks its failure`).toMatch(/--quarantine|:quarantine/u);
      expect(block, name).toMatch(/\|\| \{ echo "[a-z_]+: a quarantined test failed[^"]*"; touch \.quarantine-failed; \}/u);
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
    for (const name of ["smoke", "smoke_firefox", "smoke_webkit", "smoke_webkit_mobile"]) {
      const block = allBlocks.get(name);
      expect(block, name).toBeDefined();
      const rules = block.match(/\n {2}rules:\n((?: {4}[^\n]*\n| *\n)*)/u);
      expect(rules, `${name}: no rules block`).not.toBeNull();
      const entries = rules[1].split(/\n(?= {4}- )/u);
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
    expect(classify).toMatch(/dev \| preview \| main \| hotfix\/\*\) lane=full ;;/u);
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
  "smoke_firefox",
  "smoke_webkit",
  "smoke_webkit_mobile",
  "smoke_local_only",
  "fidelity",
  "fidelity_webkit",
];
// What the nightly needs besides the browsers: the build and the image.
const NIGHTLY_SUPPORT_JOBS = ["classify", "fast", "build_image"];

// The `rules:` list of a block as [{ if, when }], with `- *alias` entries
// replaced by the hidden key's own rule, and `rules: *alias` followed to the
// hidden list. A `changes:` condition is not evaluated (nothing here asks
// about one). A job with no `rules:` at all starts in every pipeline, as it
// does in GitLab, so it comes back as one rule that always matches.
function rulesOf(name) {
  const block = allBlocks.get(name);
  const lines = block.split("\n");
  let entries;
  let indent;
  const whole = lines.find((line) => /^ {2}rules: \*\S+$/u.test(line));
  if (whole) {
    entries = allBlocks.get(`.${whole.match(/\*(\S+)$/u)[1]}`).split("\n").slice(1);
    indent = 2;
  } else {
    const start = lines.indexOf("  rules:");
    if (start === -1) return [{}];
    entries = [];
    for (const line of lines.slice(start + 1)) {
      if (/^ {2}\S/u.test(line)) break; // the next key of the job
      entries.push(line);
    }
    indent = 4;
  }
  const lead = " ".repeat(indent);
  const rules = [];
  for (const line of entries) {
    if (/^\s*(#.*)?$/u.test(line)) continue;
    const alias = line.match(new RegExp(`^${lead}- \\*(\\S+)$`, "u"));
    if (alias) {
      const hidden = allBlocks.get(`.${alias[1]}`);
      expect(hidden, `no hidden key defines *${alias[1]}`).toBeDefined();
      const rule = {};
      for (const entry of hidden.split("\n").slice(1)) {
        const pair = entry.match(/^ {2}(if|when): (.*)$/u);
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
    const more = line.match(new RegExp(`^${lead}  (if|when): (.*)$`, "u"));
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

  it("starts every browser job at promotion: the preview push, hotfix pushes and the merge request into main (#1546)", () => {
    for (const environment of [
      events.previewPush,
      { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "hotfix/x" },
      { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" },
    ]) {
      for (const name of BROWSER_JOBS) {
        expect(jobVerdict(name, environment), `${name} on ${JSON.stringify(environment)}`).toBe("run");
      }
    }
  });

  it("starts the same jobs on the dev -> preview merge request as on a merge request into dev (#1546)", () => {
    const everyJob = jobs.filter(([, block]) => /^ {2}stage: /mu.test(block)).map(([name]) => name);
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

  it("leaves a pipeline started by hand on dev as it was", () => {
    for (const name of BROWSER_JOBS) {
      expect(jobVerdict(name, { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" }), name).toBe("run");
    }
  });

  it("starts every browser job, and only the jobs they need, on the nightly schedule", () => {
    for (const name of [...BROWSER_JOBS, ...NIGHTLY_SUPPORT_JOBS]) {
      expect(jobVerdict(name, events.nightly), `${name} on the nightly`).toBe("run");
    }
    const everyJob = jobs.filter(([, block]) => /^ {2}stage: /mu.test(block)).map(([name]) => name);
    const started = everyJob.filter((name) => jobVerdict(name, events.nightly) !== "never");
    expect(started.sort()).toEqual([...BROWSER_JOBS, ...NIGHTLY_SUPPORT_JOBS, "nightly_report"].sort());
    // The alarm waits for a failure; it does not run on a green night.
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
      for (const name of [...BROWSER_JOBS, ...NIGHTLY_SUPPORT_JOBS, "nightly_report"]) {
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
    for (const name of [...BROWSER_JOBS, "fast", "build_image"]) {
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
  const readingScripts = readdirSync(ciDir)
    .filter((file) => !/\.test\.[cm]?[jt]s$/u.test(file))
    .filter((file) => TOKEN.test(readFileSync(new URL(file, ciDir), "utf8")));
  // nightly-browsers.mjs reads the token in every mode: `report` reads the
  // night's failed jobs with it before filing with SIDECAR_ISSUE_TOKEN (the
  // first nightly, 3069, got 401 when the job lacked the environment).
  const TOKEN_MODES = { "nightly-browsers.mjs": ["moved", "report"] };

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
