import { describe, expect, it } from "vitest";

import { computeKeys, definitionScripts, jobDefinition, readConfig } from "./job-inputs.mjs";

/*
 * The per-job definition axis (#1546, amending ADR-0028). Written from the
 * specification alone, before the code exists.
 *
 * Until now every job's key carried one definition hash over the whole pipeline
 * file and all of scripts/ci/**, so any CI edit reran every job. These tests pin
 * the replacement: a job's definition is its own block of the pipeline file,
 * whatever that block reaches (anchors, `extends`, the global blocks), and the
 * scripts those blocks name, followed through the scripts themselves.
 *
 * The fixture is a small pipeline of its own, not the real one. Its names echo
 * the real file because one trap is real: `*needs_gated` is a prefix of
 * `*needs_gated_image`, and a reader that matches by prefix pulls in a block
 * the job never mentions.
 */

const FIXTURE = `stages:
  - build
  - test

# Settings every job inherits.
variables:
  NODE_ENV: ci
  FF_TIMESTAMPS: "true"

workflow:
  rules:
    - if: $CI_COMMIT_BRANCH

include:
  - local: ci/extra.yml

default:
  image: node:22
  retry: 1
  before_script:
    - scripts/ci/common-setup.sh

# The wait for the classifier and the fast gates.
.needs_gated: &needs_gated
  - job: classify
    artifacts: true
  - job: fast
    optional: true

.build_rules: &build_rules
  - if: $CI_PIPELINE_SOURCE == "push"

# The wait for the image.

.needs_gated_image: &needs_gated_image
  - job: build_image
    artifacts: true
    rules: *build_rules

.unused_anchor: &unused_anchor
  - job: nobody

.base_runner:
  tags:
    - docker

.privileged_runner:
  extends: .base_runner
  before_script:
    - scripts/ci/setup-runner.sh
  variables:
    PRIVILEGED: "true"

.cache_settings:
  cache:
    key: pnpm

.unrelated_template:
  tags:
    - never-used

fast:
  stage: test
  needs: *needs_gated
  script:
    - pnpm test

smoke:
  extends: .privileged_runner
  stage: test
  # Slow on a cold runner.
  timeout: 20m
  needs: *needs_gated_image
  script:
    - scripts/ci/start-acceptance-stack.sh
    - scripts/ci/start-acceptance-stack.sh --probe

    - node scripts/ci/lib/probe.mjs

acceptance:
  extends: [.privileged_runner, .cache_settings]
  stage: test
  script:
    - pnpm acceptance
`;

const SCRIPT_FILES = {
  "scripts/ci/common-setup.sh": "#!/bin/sh\necho setup\n",
  "scripts/ci/setup-runner.sh": "#!/bin/sh\necho runner\n",
  "scripts/ci/start-acceptance-stack.sh": "#!/bin/sh\nexec scripts/ci/lib/wait.sh \"$@\"\n",
  "scripts/ci/lib/wait.sh": "#!/bin/sh\necho waiting\n",
  "scripts/ci/lib/probe.mjs": "console.log('probe');\n",
};

// A readFile stub backed by an object map; a path outside the map throws, as a
// missing file does.
const reader = (files) => (path) => {
  if (Object.hasOwn(files, path)) return files[path];
  throw new Error(`ENOENT: ${path}`);
};

// Replace exactly one occurrence, so a fixture edit that silently matched
// nothing fails here and not as a vacuous pass further down.
function edit(text, from, to) {
  expect(text.split(from).length, `fixture has no single "${from}"`).toBe(2);
  return text.replace(from, to);
}

const lines = (text) => text.split("\n");
const hasLine = (text, line) => lines(text).includes(line);

describe("jobDefinition", () => {
  it("returns the job's own block", () => {
    const { text } = jobDefinition(FIXTURE, "smoke");
    expect(hasLine(text, "smoke:")).toBe(true);
    expect(text).toContain("timeout: 20m");
    expect(text).toContain("scripts/ci/start-acceptance-stack.sh");
  });

  it("leaves out other jobs and templates the job never reaches", () => {
    const { text } = jobDefinition(FIXTURE, "smoke");
    expect(hasLine(text, "fast:")).toBe(false);
    expect(hasLine(text, "acceptance:")).toBe(false);
    expect(text).not.toContain("pnpm test");
    expect(text).not.toContain("pnpm acceptance");
    expect(hasLine(text, ".unrelated_template:")).toBe(false);
    expect(hasLine(text, ".cache_settings:")).toBe(false);
  });

  it("pulls in the block behind an alias the job uses", () => {
    const { text } = jobDefinition(FIXTURE, "smoke");
    expect(hasLine(text, ".needs_gated_image: &needs_gated_image")).toBe(true);
    expect(text).toContain("job: build_image");
  });

  it("does not mistake *needs_gated for a reference to *needs_gated_image", () => {
    const smoke = jobDefinition(FIXTURE, "smoke").text;
    expect(hasLine(smoke, ".needs_gated: &needs_gated")).toBe(false);
    expect(smoke).not.toContain("job: classify");
    const fast = jobDefinition(FIXTURE, "fast").text;
    expect(hasLine(fast, ".needs_gated: &needs_gated")).toBe(true);
    expect(hasLine(fast, ".needs_gated_image: &needs_gated_image")).toBe(false);
  });

  it("follows aliases transitively", () => {
    // smoke -> *needs_gated_image, whose block uses *build_rules.
    const { text } = jobDefinition(FIXTURE, "smoke");
    expect(hasLine(text, ".build_rules: &build_rules")).toBe(true);
    expect(text).toContain('$CI_PIPELINE_SOURCE == "push"');
    expect(hasLine(jobDefinition(FIXTURE, "fast").text, ".build_rules: &build_rules")).toBe(false);
  });

  it("leaves out an anchor block nothing references", () => {
    for (const job of ["fast", "smoke", "acceptance"]) {
      expect(hasLine(jobDefinition(FIXTURE, job).text, ".unused_anchor: &unused_anchor"), job).toBe(false);
    }
  });

  it("pulls in the block an extends names, and the one that block extends", () => {
    const { text } = jobDefinition(FIXTURE, "smoke");
    expect(hasLine(text, ".privileged_runner:")).toBe(true);
    expect(hasLine(text, ".base_runner:")).toBe(true);
    expect(text).toContain("- docker");
  });

  it("reads an extends list", () => {
    const { text } = jobDefinition(FIXTURE, "acceptance");
    expect(hasLine(text, ".privileged_runner:")).toBe(true);
    expect(hasLine(text, ".cache_settings:")).toBe(true);
    expect(hasLine(text, ".base_runner:")).toBe(true);
  });

  it("includes the global blocks: default, variables, workflow, stages and include", () => {
    for (const job of ["fast", "smoke", "acceptance"]) {
      const { text } = jobDefinition(FIXTURE, job);
      for (const key of ["default:", "variables:", "workflow:", "stages:", "include:"]) {
        expect(hasLine(text, key), `${job} lacks ${key}`).toBe(true);
      }
    }
  });

  it("copes with a file that has no global blocks at all", () => {
    const bare = "smoke:\n  script:\n    - echo hi\n\nfast:\n  script:\n    - echo ho\n";
    const { text, scripts } = jobDefinition(bare, "smoke");
    expect(hasLine(text, "smoke:")).toBe(true);
    expect(text).not.toContain("echo ho");
    expect(scripts).toEqual([]);
  });

  it("includes each block once, in file order", () => {
    const { text } = jobDefinition(FIXTURE, "smoke");
    for (const header of [".needs_gated_image: &needs_gated_image", ".privileged_runner:", "default:", "smoke:"]) {
      expect(lines(text).filter((line) => line === header), header).toHaveLength(1);
    }
    const order = [
      "stages:",
      "variables:",
      "workflow:",
      "include:",
      "default:",
      ".build_rules: &build_rules",
      ".needs_gated_image: &needs_gated_image",
      ".base_runner:",
      ".privileged_runner:",
      "smoke:",
    ].map((header) => lines(text).indexOf(header));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("drops comment lines and blank lines", () => {
    const { text } = jobDefinition(FIXTURE, "smoke");
    expect(text).not.toContain("Settings every job inherits");
    expect(text).not.toContain("Slow on a cold runner");
    expect(text).not.toContain("The wait for the image");
    for (const line of text.trimEnd().split("\n")) {
      expect(line.trim(), "a blank line survived").not.toBe("");
      expect(line.trimStart().startsWith("#"), `a comment survived: ${line}`).toBe(false);
    }
  });

  it("is unchanged by comment-only and blank-line-only edits", () => {
    let noisy = `# a new header\n\n${FIXTURE}\n\n# a trailing note\n`;
    noisy = edit(noisy, "  timeout: 20m\n", "\n  # why this long\n  timeout: 20m\n\n");
    noisy = edit(noisy, "fast:\n", "\n\n# the quick one\nfast:\n");
    for (const job of ["fast", "smoke", "acceptance"]) {
      expect(jobDefinition(noisy, job), job).toEqual(jobDefinition(FIXTURE, job));
    }
  });

  it("changes when a line inside the job's block changes", () => {
    const edited = edit(FIXTURE, "timeout: 20m", "timeout: 30m");
    expect(jobDefinition(edited, "smoke").text).not.toBe(jobDefinition(FIXTURE, "smoke").text);
    expect(jobDefinition(edited, "fast")).toEqual(jobDefinition(FIXTURE, "fast"));
  });

  it("lists every scripts/ci path in the text, sorted and without repeats", () => {
    // start-acceptance-stack.sh is named twice in smoke; common-setup.sh comes
    // from default and setup-runner.sh from the extended template.
    expect(jobDefinition(FIXTURE, "smoke").scripts).toEqual([
      "scripts/ci/common-setup.sh",
      "scripts/ci/lib/probe.mjs",
      "scripts/ci/setup-runner.sh",
      "scripts/ci/start-acceptance-stack.sh",
    ]);
    expect(jobDefinition(FIXTURE, "fast").scripts).toEqual(["scripts/ci/common-setup.sh"]);
    expect(jobDefinition(FIXTURE, "acceptance").scripts).toEqual([
      "scripts/ci/common-setup.sh",
      "scripts/ci/setup-runner.sh",
    ]);
  });

  it("throws for an unknown job, naming it", () => {
    expect(() => jobDefinition(FIXTURE, "no_such_job")).toThrow(Error);
    expect(() => jobDefinition(FIXTURE, "no_such_job")).toThrow(/no_such_job/);
  });

  it("does not take a name that only appears inside a block for a job", () => {
    // `classify` is named under needs: but has no block of its own here.
    expect(() => jobDefinition(FIXTURE, "classify")).toThrow(/classify/);
    // And an anchor name without its dotted key is not the template's name.
    expect(() => jobDefinition(FIXTURE, "needs_gated")).toThrow(/needs_gated/);
  });
});

describe("definitionScripts", () => {
  it("returns the starting paths when nothing they contain names another script", () => {
    expect(definitionScripts(["scripts/ci/lib/wait.sh"], reader(SCRIPT_FILES))).toEqual(["scripts/ci/lib/wait.sh"]);
  });

  it("returns an empty list for an empty start", () => {
    expect(definitionScripts([], reader(SCRIPT_FILES))).toEqual([]);
  });

  it("follows a script into the scripts it calls", () => {
    expect(definitionScripts(["scripts/ci/start-acceptance-stack.sh"], reader(SCRIPT_FILES))).toEqual([
      "scripts/ci/lib/wait.sh",
      "scripts/ci/start-acceptance-stack.sh",
    ]);
  });

  it("follows a chain to the end", () => {
    const files = {
      "scripts/ci/a.sh": "scripts/ci/b.sh\n",
      "scripts/ci/b.sh": "source scripts/ci/lib/c.sh\n",
      "scripts/ci/lib/c.sh": "scripts/ci/d.mjs\n",
      "scripts/ci/d.mjs": "// leaf\n",
    };
    expect(definitionScripts(["scripts/ci/a.sh"], reader(files))).toEqual([
      "scripts/ci/a.sh",
      "scripts/ci/b.sh",
      "scripts/ci/d.mjs",
      "scripts/ci/lib/c.sh",
    ]);
  });

  it("returns a sorted list without repeats", () => {
    const files = {
      "scripts/ci/z.sh": "scripts/ci/m.sh scripts/ci/m.sh scripts/ci/a.sh\n",
      "scripts/ci/m.sh": "scripts/ci/a.sh\n",
      "scripts/ci/a.sh": "\n",
    };
    const result = definitionScripts(["scripts/ci/z.sh", "scripts/ci/a.sh", "scripts/ci/z.sh"], reader(files));
    expect(result).toEqual(["scripts/ci/a.sh", "scripts/ci/m.sh", "scripts/ci/z.sh"]);
  });

  it("terminates on a cycle", () => {
    const files = {
      "scripts/ci/a.sh": "scripts/ci/b.sh\n",
      "scripts/ci/b.sh": "scripts/ci/a.sh\n",
    };
    expect(definitionScripts(["scripts/ci/a.sh"], reader(files))).toEqual(["scripts/ci/a.sh", "scripts/ci/b.sh"]);
  });

  it("keeps a path that cannot be read, without following it", () => {
    const files = { "scripts/ci/a.sh": "scripts/ci/gone.sh\n" };
    expect(definitionScripts(["scripts/ci/a.sh"], reader(files))).toEqual(["scripts/ci/a.sh", "scripts/ci/gone.sh"]);
  });

  it("treats a null read as a missing file", () => {
    const files = { "scripts/ci/a.sh": "scripts/ci/gone.sh\n" };
    const readFile = (path) => (Object.hasOwn(files, path) ? files[path] : null);
    expect(definitionScripts(["scripts/ci/a.sh"], readFile)).toEqual(["scripts/ci/a.sh", "scripts/ci/gone.sh"]);
    expect(definitionScripts(["scripts/ci/never.sh"], readFile)).toEqual(["scripts/ci/never.sh"]);
  });

  it("ignores paths outside scripts/ci", () => {
    const files = {
      "scripts/ci/a.sh": "node scripts/other/tool.mjs && cat src/server/boot.ts && scripts/ci/b.sh\n",
      "scripts/ci/b.sh": "\n",
    };
    expect(definitionScripts(["scripts/ci/a.sh"], reader(files))).toEqual(["scripts/ci/a.sh", "scripts/ci/b.sh"]);
  });

  it("matches the paths jobDefinition reports for the same text", () => {
    const { scripts } = jobDefinition(FIXTURE, "smoke");
    expect(definitionScripts(scripts, reader(SCRIPT_FILES))).toEqual([
      "scripts/ci/common-setup.sh",
      "scripts/ci/lib/probe.mjs",
      "scripts/ci/lib/wait.sh",
      "scripts/ci/setup-runner.sh",
      "scripts/ci/start-acceptance-stack.sh",
    ]);
  });
});

describe("the per-job definition axis", () => {
  const entry = (path, sha) => ({ type: "blob", path, sha });

  // The always list: the reuse machinery itself. Named by no job's text.
  const ALWAYS = ["scripts/ci/job-inputs.json", "scripts/ci/reuse-gate.sh"];
  // The jobs deny the pipeline file and the scripts from their checkout axis, so
  // that the only road from a script or a pipeline edit to a key is the
  // definition axis under test.
  const DENY = [".gitlab-ci.yml", "scripts/ci/**"];
  const fixtureConfig = {
    ...readConfig(),
    definition: ALWAYS,
    jobs: {
      fast: { deny: DENY },
      smoke: { deny: DENY },
      acceptance: { deny: DENY },
    },
  };

  const baseTree = [
    entry(".gitlab-ci.yml", "a0"),
    entry("src/app.ts", "a1"),
    entry("scripts/ci/job-inputs.json", "a2"),
    entry("scripts/ci/reuse-gate.sh", "a3"),
    entry("scripts/ci/common-setup.sh", "a4"),
    entry("scripts/ci/setup-runner.sh", "a5"),
    entry("scripts/ci/start-acceptance-stack.sh", "a6"),
    entry("scripts/ci/lib/wait.sh", "a7"),
    entry("scripts/ci/lib/probe.mjs", "a8"),
    entry("scripts/ci/unrelated.sh", "a9"),
  ];

  const withSha = (tree, path, sha) => tree.map((file) => (file.path === path ? entry(path, sha) : file));
  const keys = (ciText, tree = baseTree) => computeKeys(fixtureConfig, tree, { ciText, readFile: reader(SCRIPT_FILES) });
  const source = (map, job) => map.get(job).source;
  const JOBS = ["fast", "smoke", "acceptance"];

  const expectMoved = (before, after, moved) => {
    for (const job of JOBS) {
      if (moved.includes(job)) expect(source(after, job), `${job} should have moved`).not.toBe(source(before, job));
      else expect(source(after, job), `${job} should have stood still`).toBe(source(before, job));
    }
  };

  it("gives the three jobs three different keys", () => {
    const before = keys(FIXTURE);
    expect(new Set(JOBS.map((job) => source(before, job))).size).toBe(3);
  });

  it("is stable: the same inputs give the same keys", () => {
    const first = keys(FIXTURE);
    const second = keys(FIXTURE);
    for (const job of JOBS) expect(source(second, job)).toBe(source(first, job));
  });

  it("moves one job when its own block is edited, and no other", () => {
    const before = keys(FIXTURE);
    const after = keys(edit(FIXTURE, "timeout: 20m", "timeout: 30m"));
    expectMoved(before, after, ["smoke"]);
  });

  it("moves a job when an anchor block it reaches is edited", () => {
    const before = keys(FIXTURE);
    const after = keys(edit(FIXTURE, "    artifacts: true\n    rules: *build_rules", "    artifacts: false\n    rules: *build_rules"));
    expectMoved(before, after, ["smoke"]);
  });

  it("moves a job when an anchor reached only through another anchor is edited", () => {
    const before = keys(FIXTURE);
    const after = keys(edit(FIXTURE, '$CI_PIPELINE_SOURCE == "push"', '$CI_PIPELINE_SOURCE == "merge_request_event"'));
    expectMoved(before, after, ["smoke"]);
  });

  it("moves only the job that reaches the edited anchor, not one that reaches a prefix of its name", () => {
    const before = keys(FIXTURE);
    const after = keys(edit(FIXTURE, "  - job: fast\n    optional: true", "  - job: fast\n    optional: false"));
    expectMoved(before, after, ["fast"]);
  });

  it("moves no key when an anchor block no job references is edited", () => {
    const before = keys(FIXTURE);
    expectMoved(before, keys(edit(FIXTURE, "  - job: nobody", "  - job: somebody")), []);
    expectMoved(before, keys(edit(FIXTURE, "    - never-used", "    - used-by-nobody")), []);
  });

  it("moves the jobs that extend a template when the template is edited", () => {
    const before = keys(FIXTURE);
    expectMoved(before, keys(edit(FIXTURE, '    PRIVILEGED: "true"', '    PRIVILEGED: "false"')), ["smoke", "acceptance"]);
    // .base_runner is two extends away from both.
    expectMoved(before, keys(edit(FIXTURE, "    - docker", "    - podman")), ["smoke", "acceptance"]);
    expectMoved(before, keys(edit(FIXTURE, "    key: pnpm", "    key: npm")), ["acceptance"]);
  });

  it("moves every job when the default block is edited", () => {
    const before = keys(FIXTURE);
    expectMoved(before, keys(edit(FIXTURE, "  retry: 1", "  retry: 2")), JOBS);
  });

  it("moves every job when the variables block is edited", () => {
    const before = keys(FIXTURE);
    expectMoved(before, keys(edit(FIXTURE, "  NODE_ENV: ci", "  NODE_ENV: production")), JOBS);
  });

  it("moves no key on a comment-only edit, wherever it lands", () => {
    const before = keys(FIXTURE);
    let noisy = `# a new header\n\n${FIXTURE}\n\n# a trailing note\n`;
    noisy = edit(noisy, "  timeout: 20m\n", "  # why\n\n  timeout: 20m\n");
    noisy = edit(noisy, "default:\n", "# the defaults\n\ndefault:\n");
    expectMoved(before, keys(noisy), []);
  });

  it("moves no key on a blank-line-only edit", () => {
    const before = keys(FIXTURE);
    const spaced = edit(edit(FIXTURE, "fast:\n", "\n\n\nfast:\n"), "  stage: test\n  # Slow", "  stage: test\n\n  # Slow");
    expectMoved(before, keys(spaced), []);
  });

  it("moves a job when the sha of a script its text names moves, and no other", () => {
    const before = keys(FIXTURE);
    const after = keys(FIXTURE, withSha(baseTree, "scripts/ci/start-acceptance-stack.sh", "zz"));
    expectMoved(before, after, ["smoke"]);
  });

  it("moves a job when a script reached through an extended template moves", () => {
    const before = keys(FIXTURE);
    const after = keys(FIXTURE, withSha(baseTree, "scripts/ci/setup-runner.sh", "zz"));
    expectMoved(before, after, ["smoke", "acceptance"]);
  });

  it("moves every job when a script named in the default block moves", () => {
    const before = keys(FIXTURE);
    expectMoved(before, keys(FIXTURE, withSha(baseTree, "scripts/ci/common-setup.sh", "zz")), JOBS);
  });

  it("moves a job when a script reached only through another script moves", () => {
    // wait.sh is named by no pipeline block; start-acceptance-stack.sh calls it.
    const before = keys(FIXTURE);
    const after = keys(FIXTURE, withSha(baseTree, "scripts/ci/lib/wait.sh", "zz"));
    expectMoved(before, after, ["smoke"]);
  });

  it("moves no key when a script nothing reaches moves", () => {
    const before = keys(FIXTURE);
    expectMoved(before, keys(FIXTURE, withSha(baseTree, "scripts/ci/unrelated.sh", "zz")), []);
  });

  it("moves every job when a file on the always list moves", () => {
    const before = keys(FIXTURE);
    for (const path of ALWAYS) {
      expectMoved(before, keys(FIXTURE, withSha(baseTree, path, "zz")), JOBS);
    }
  });

  it("does not hash the whole pipeline file any more", () => {
    // A new sha for .gitlab-ci.yml alone, with the text it holds unchanged: the
    // per-job text is what counts, so nothing moves.
    const before = keys(FIXTURE);
    expectMoved(before, keys(FIXTURE, withSha(baseTree, ".gitlab-ci.yml", "zz")), []);
  });

  describe("without options", () => {
    const plain = (tree) => computeKeys(fixtureConfig, tree);

    it("hashes the definition globs alone, as before", () => {
      const before = plain(baseTree);
      for (const path of ALWAYS) {
        const after = plain(withSha(baseTree, path, "zz"));
        for (const job of JOBS) expect(source(after, job), `${job} ignored ${path}`).not.toBe(source(before, job));
      }
    });

    it("ignores a script that is outside the globs, even one a job would name", () => {
      const before = plain(baseTree);
      const after = plain(withSha(baseTree, "scripts/ci/start-acceptance-stack.sh", "zz"));
      for (const job of JOBS) expect(source(after, job)).toBe(source(before, job));
    });

    it("gives different keys from the same call with options", () => {
      const without = plain(baseTree);
      const withOptions = keys(FIXTURE);
      for (const job of JOBS) expect(source(withOptions, job)).not.toBe(source(without, job));
    });
  });
});
