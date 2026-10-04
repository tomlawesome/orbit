import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { dockerRunFailure } from "./docker-run-outcome.mjs";

/*
 * O2-R4 (#1151): findTika() in cli.ts used to ignore the exit code of the
 * `docker run -d` command entirely, so a leftover container from an
 * interrupted run (or any other reason `docker run` itself fails) was
 * invisible: the CLI polled Tika's HTTP endpoint for the full two minutes
 * and then reported the unrelated "Tika never answered on port 9998",
 * hiding the real, already-printed docker error. dockerRunFailure() is the
 * decision that now gates that: a docker run exit code other than 0 is
 * reported immediately instead.
 */
describe("dockerRunFailure", () => {
  it("is not a failure when docker run exits 0 -- the container started", () => {
    expect(dockerRunFailure(0)).toBeUndefined();
  });

  it("names the exit code when docker run failed outright", () => {
    expect(dockerRunFailure(1)).toContain("exited with code 1");
  });

  it("treats docker run never giving a numeric exit code as a failure too", () => {
    expect(dockerRunFailure(null)).toBeDefined();
  });
});

describe("cli.ts's docker branch", () => {
  it("checks docker run's own exit code before polling for Tika, not just Tika's two-minute timeout", () => {
    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import\s*\{\s*dockerRunFailure\s*\}\s*from\s*"\.\/docker-run-outcome\.mjs"/u);
    expect(source).toContain("dockerRunFailure(");
    // The check has to run before the 2-minute poll, not after it.
    const dockerRunCall = source.indexOf('spawn("docker"');
    const failureCheck = source.indexOf("dockerRunFailure(");
    const pollCall = source.indexOf("waitForTika(LOCAL_TIKA, undefined, 120)");
    expect(dockerRunCall).toBeGreaterThan(-1);
    expect(failureCheck).toBeGreaterThan(dockerRunCall);
    expect(pollCall).toBeGreaterThan(failureCheck);
  });
});
