import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1089: the repair-journeys harness failed in a different journey on each
 * run of the same commit. One of the two causes was its own diagnostic.
 *
 * Every journey that answers a machine prompt answers it by piping the answer
 * into `repair` (`printf 'y\n' | repair --execute --safe-only`, and
 * credential-drift's three-line `--dangerous` pipe), and `repair` calls
 * `execution_snapshot` on the way past -- inside that same pipeline, so they
 * share one stdin. That snapshot reads the app container through
 * `docker compose exec -T`, which keeps stdin attached and streams it to the
 * container: against a running container it consumes everything the caller's
 * stdin holds (10 runs out of 10 on docker-ce 29.7.2 with compose v5.5.0;
 * with `</dev/null` the answer survived 10 of 10), and against a stopped one
 * it fails before reading anything. So the diagnostic ate the answer the run
 * under test was waiting for and repair.sh read EOF: job 20104 aborted at
 * `field=safe-batch` and exited 1, job 20663 at `field=action-word` and
 * exited 6. Those are the only two sightings after `execution_snapshot`
 * landed in 40d0cfc8, and whether it happened at all depended on whether
 * orbit-app was up at that moment, which is what moved the failure between
 * journeys.
 *
 * A diagnostic may never consume the stdin of the run it is describing. It is
 * one redirect, and nothing at runtime notices when it goes missing (the
 * harness stays green until the container happens to be up), so it is
 * asserted here instead.
 */
const harness = readFileSync(
  new URL("./test-repair-journeys.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

/** The body of `name() { ... }`, from its opening line to the closing `}`. */
function functionBody(name) {
  const lines = harness.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  expect(start, `${name}() is not defined in test-repair-journeys.sh`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line === "}");
  expect(end, `${name}() has no closing brace`).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join("\n");
}

describe("repair-journeys execution snapshot", () => {
  it("takes its own stdin from /dev/null, so it cannot eat a prompt answer", () => {
    expect(functionBody("execution_snapshot")).toContain("} >&2 </dev/null");
  });

  it("never leaves stdin attached to the app-secret probe's compose exec", () => {
    const body = functionBody("app_secret_probe");
    expect(body).toContain("compose exec -T orbit-app");
    expect(body).toContain("</dev/null");
  });

  it("still has journeys that answer a prompt through a pipe, which is what made this matter", () => {
    // Both shapes seen failing: the safe-batch confirm (job 20104) and the
    // dangerous batch's typed action word (job 20663).
    expect(harness).toContain("printf 'y\\n' | repair --execute --safe-only");
    expect(harness).toMatch(/printf 'rotate\\n[^']*' \|\n?\s*repair --execute --dangerous/);
  });

  // The snapshot only runs because `repair()` calls it for any --execute, in
  // the caller's own pipeline. If that call ever moves out of the pipeline the
  // redirects above stop mattering; if it stays, they are the whole defence.
  it("calls the snapshot from inside repair(), which is why it shares the journey's stdin", () => {
    expect(functionBody("repair")).toContain('execution_snapshot "repair $*"');
  });
});
