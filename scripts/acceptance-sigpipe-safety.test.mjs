/*
 * #809: acceptance scripts run under `set -Eeuo pipefail` and read a
 * producer through `producer | grep -q …` or `x="$(producer | head -1)"`.
 * When the consumer (grep -q, head -1) decides it has enough and exits
 * before the producer has finished writing, the producer's next write takes
 * SIGPIPE and the pipeline's exit status becomes 141 -- not the consumer's
 * answer. Under `&&`/`||` that 141 silently skips the branch it should have
 * taken (a real failure goes unreported); in a bare `x=$(…)` assignment
 * `set -e` aborts the script with no message at all. This is the same fault
 * fixed for scripts/check-base-image-current.sh and scripts/ci/publish-image.sh
 * in 3aa5b29 ("Read the first line of a pipeline without racing SIGPIPE");
 * this file covers the rest of it, in scripts/test-*.sh.
 *
 * It is a race, not a guarantee: on GNU userland it can take many runs to
 * show (0 of 20 on GitHub's runner, 15 of 20 on Alpine's busybox for the
 * original base_image bug). The fixtures below make the producer write far
 * more than a pipe buffer holds after the point the consumer already has its
 * answer, so the race is lost every time on every platform rather than
 * intermittently -- the same technique check-base-image-current.test.mjs
 * uses with a 3000-stage Dockerfile.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));

function run(script) {
  return failOnProcessDeadline(spawnSync("bash", ["-c", script], { encoding: "utf8", ...processGuard() }), {
    label: "sigpipe fixture",
  });
}

// A producer this large guarantees more queued output than a 64KB pipe
// buffer can hold once the consumer has already made up its mind on line 1,
// so the write that would land after the consumer exits always happens.
const LINE_COUNT = 200_000;

describe("a killed producer is not a verdict (#809)", () => {
  it("`producer | grep -q … && report` swallows a match it should have reported", () => {
    // Mirrors scripts/test-install-acceptance.sh's old
    // `find … | grep -q . && fail "…"`: the consumer finds its match on the
    // very first line and exits immediately, while the producer is still
    // partway through writing the other ${LINE_COUNT - 1} lines.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = run(`
        set -Eeuo pipefail
        seq 1 ${LINE_COUNT} | grep -q '^1$' && printf 'REPORTED\\n'
        printf 'reached-end\\n'
      `);

      // The bug: the pipeline's 141 (SIGPIPE on the producer) takes the
      // place of grep's real answer, so the '&&' branch that should have
      // fired for a genuine match never runs, and the script carries on as
      // if nothing was found.
      expect(result.stdout, `attempt ${attempt}`).not.toContain("REPORTED");
      expect(result.stdout, `attempt ${attempt}`).toContain("reached-end");
    }
  });

  it("`x=\"$(producer | head -1)\"` dies of SIGPIPE with no message", () => {
    // Mirrors scripts/test-install-bootstrap.sh's old
    // `pinned="$(grep '^ORBIT_IMAGE=' file | head -1)"`.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = run(`
        set -Eeuo pipefail
        x="$(seq 1 ${LINE_COUNT} | head -1)"
        printf 'captured=%s\\n' "$x"
      `);

      expect(result.status, `attempt ${attempt}: 141 is SIGPIPE, not a captured value`).toBe(141);
      expect(result.stdout, `attempt ${attempt}`).not.toContain("captured=");
    }
  });

  it("capture-first reads the producer to completion regardless of consumer size", () => {
    // The fix applied throughout this file: `out=$(producer)` always reads
    // the producer to EOF before anything tests the result, so there is no
    // consumer left to exit early and no write left to SIGPIPE.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = run(`
        set -Eeuo pipefail
        out="$(seq 1 ${LINE_COUNT})"
        if grep -q '^1$' <<<"$out"; then printf 'REPORTED\\n'; fi
        printf 'reached-end\\n'
      `);

      expect(result.status, `attempt ${attempt}`).toBe(0);
      expect(result.stdout, `attempt ${attempt}`).toContain("REPORTED");
      expect(result.stdout, `attempt ${attempt}`).toContain("reached-end");
    }
  });

  it("a self-quitting producer (find … -quit) is equally safe piped into grep -q", () => {
    // scripts/test-backup-restore.sh's existing
    // `find … -print -quit | grep -q .`: bounding the producer to at most
    // one line of output, rather than bounding the consumer, is the other
    // safe idiom this file's fixes use (scripts/test-install-acceptance.sh's
    // staging-directory checks). find quits on its own once it has printed
    // one match, so it never has a second line queued when grep exits.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = run(`
        set -Eeuo pipefail
        workdir="$(mktemp -d)"
        trap 'rm -rf "$workdir"' EXIT
        for i in $(seq 1 500); do mkdir "$workdir/dir-$i"; done
        find "$workdir" -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q . && printf 'REPORTED\\n'
        printf 'reached-end\\n'
      `);

      expect(result.status, `attempt ${attempt}`).toBe(0);
      expect(result.stdout, `attempt ${attempt}`).toContain("REPORTED");
      expect(result.stdout, `attempt ${attempt}`).toContain("reached-end");
    }
  });
});

/*
 * Static half of the proof: nothing left in the scoped directories still
 * carries the bad shape. A dynamic fixture can only prove the mechanism; it
 * cannot prove the fleet is clean, and the fleet is what ships.
 */

const SCOPED_FILES = [
  ...readdirSync(scriptsDir)
    .filter((name) => /^(test-|acceptance-).*\.sh$/.test(name))
    .map((name) => `scripts/${name}`),
  ...readdirSync(`${scriptsDir}ci`)
    .filter((name) => name.endsWith(".sh"))
    .map((name) => `scripts/ci/${name}`),
];

/*
 * Bash lets a line end in `|`, `&&`, or `||` and continue on the next line
 * with no backslash, which is how several of the real instances this issue
 * fixed were written (e.g. the three-line engine-events check in
 * scripts/test-install-acceptance.sh). Join those before matching, or a
 * pipe-then-newline-then-grep-q would slip past a single-line check.
 */
function logicalLines(source) {
  const lines = [];
  for (const raw of source.split("\n")) {
    const previous = lines[lines.length - 1];
    if (previous !== undefined && /(\||&&|\|\|)\s*$/.test(previous)) {
      lines[lines.length - 1] = `${previous} ${raw.trim()}`;
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

// A `-quit` on the producer side of the pipe (find's own early-exit flag)
// bounds it to at most one line of output on its own, which is what makes
// scripts/test-backup-restore.sh's existing `find … -quit | grep -q .` safe
// without rewriting it: see the dynamic case above. That is the one allowed
// shape; anything else piping into a quiet grep or a `head -1`/`head -n1` is
// the bug this issue fixes.
function isSelfBoundedProducer(line) {
  return /-quit\b/.test(line);
}

const PIPED_INTO_QUIET_GREP = /\|\s*grep\b[^|;]*\s-[a-zA-Z]*q[a-zA-Z]*(\s|$)/;
const PIPED_INTO_HEAD_FIRST_LINE = /\|\s*head\s+(-1\b|-n\s*1\b)/;

describe("no scoped script reads a pipeline in the shape that races SIGPIPE (#809)", () => {
  it("covers at least the scripts this issue named", () => {
    // A regression here means the file list changed under the test, not
    // that the check below stopped running.
    expect(SCOPED_FILES).toEqual(
      expect.arrayContaining([
        "scripts/test-install-acceptance.sh",
        "scripts/test-install-bootstrap.sh",
        "scripts/test-repair-journeys.sh",
        "scripts/test-backup-restore.sh",
      ]),
    );
  });

  it.each(SCOPED_FILES)("%s", (relativePath) => {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const offenders = logicalLines(source)
      .map((line, index) => ({ line, number: index + 1 }))
      // A comment explaining the fix (this file's own fixes quote the bad
      // shape in prose, e.g. "not `| head -1`") is not code and must not
      // trip the scanner it is describing.
      .filter(({ line }) => !line.trim().startsWith("#"))
      .filter(({ line }) => !isSelfBoundedProducer(line))
      .filter(({ line }) => PIPED_INTO_QUIET_GREP.test(line) || PIPED_INTO_HEAD_FIRST_LINE.test(line));

    expect(
      offenders,
      offenders.map((o) => `line ${o.number}: ${o.line.trim()}`).join("\n"),
    ).toEqual([]);
  });
});
