import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #823: the runner host ran out of disk. Part of it was ours -- a job that
// starts its own Docker daemon leaves the daemon's image store in the slot's
// /builds volume, which outlives the job. This pins the rule that every such
// job tears the store down on its way out, whatever else its after_script does.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level job blocks by name: a line that is `name:` at column zero, with
// or without an `&anchor |` after it, up to the next such line. Anchors
// (`.name:`) are included and filtered below.
function jobBlocks() {
  const blocks = new Map();
  const headers = [...gitlabCi.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):\s*(?:&\S+\s*\|?\s*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : gitlabCi.length;
    blocks.set(match[1], gitlabCi.slice(start, end));
  });
  return blocks;
}

function afterScriptEntries(block) {
  const start = block.indexOf("\n  after_script:\n");
  if (start < 0) {
    return null;
  }
  const rest = block.slice(start + "\n  after_script:\n".length);
  // The section ends at the next key indented two spaces (artifacts:, rules:,
  // ...) or at the end of the block.
  const end = rest.search(/^ {2}[a-z_]+:/mu);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^ {4}- (.*)$/gmu)].map((match) => match[1].trim());
}

describe("in-job Docker daemons clean up after themselves (#823)", () => {
  const jobs = [...jobBlocks()].filter(
    ([name, block]) => !name.startsWith(".") && block.includes("- *docker_in_job\n"),
  );

  it("covers the jobs known to start a daemon", () => {
    expect(jobs.map(([name]) => name).sort()).toEqual(
      ["acceptance", "repair_journeys", "smoke", "supply_chain_image"].sort(),
    );
  });

  it.each(jobs.map(([name, block]) => [name, block]))(
    "%s ends its after_script with the teardown",
    (_name, block) => {
      const entries = afterScriptEntries(block);
      expect(entries, "after_script is missing").not.toBeNull();
      expect(entries.at(-1)).toBe("*docker_in_job_teardown");
    },
  );

  it("stops the daemon before removing its store, and removes the scanner temp too", () => {
    const anchor = jobBlocks().get(".docker_in_job_teardown");
    expect(anchor).toBeDefined();
    const killAt = anchor.indexOf("kill ");
    const removeAt = anchor.indexOf("rm -rf");
    expect(killAt).toBeGreaterThan(0);
    expect(removeAt).toBeGreaterThan(killAt);
    expect(anchor).toContain('.orbit-docker-data" || :');
    expect(anchor).toContain('rm -rf "$RUNNER_TEMP" || :');
  });
});
