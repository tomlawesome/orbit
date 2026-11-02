import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * The Dockerfile sources release-metadata-patterns.sh from a RUN step, which
 * runs under /bin/sh (dash), not bash. The file must source cleanly under
 * both, define the same values, and be safe to source twice.
 */
const file = join(dirname(fileURLToPath(import.meta.url)), "release-metadata-patterns.sh");
const SHELLS = ["sh", "bash"];

function run(shell, script) {
  const result = spawnSync(shell, ["-c", script], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Prints every ORBIT_*_PATTERN variable as NAME=value, sorted, using only POSIX sh.
const DUMP = `for n in $(set | sed -n 's/^\\(ORBIT_[A-Z_]*\\)=.*/\\1/p' | sort); do eval "v=\\$$n"; printf '%s=%s\\n' "$n" "$v"; done`;
const source = `. '${file}'`;

describe("scripts/release-metadata-patterns.sh under sh and bash", () => {
  for (const shell of SHELLS) {
    it(`sourcing under ${shell} exits 0 with no output on stderr`, () => {
      const result = run(shell, source);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it(`sourcing twice under ${shell} succeeds silently and leaves the values unchanged`, () => {
      const once = run(shell, `${source}\n${DUMP}`);
      const twice = run(shell, `${source}\n${source}\n${DUMP}`);
      expect(twice.stderr).toBe("");
      expect(twice.status).toBe(0);
      expect(twice.stdout).toBe(once.stdout);
    });

    it(`the values are read-only after the first source under ${shell}`, () => {
      const result = run(shell, `${source}\n( ORBIT_VERSION_PATTERN=x ) 2>/dev/null && echo WRITABLE || echo READONLY`);
      expect(result.stdout.trim()).toBe("READONLY");
    });
  }

  it("defines the same variables with the same values under sh as under bash", () => {
    const viaBash = run("bash", `${source}\n${DUMP}`);
    const viaSh = run("sh", `${source}\n${DUMP}`);
    expect(viaBash.stdout).toMatch(/^ORBIT_VERSION_PATTERN=/mu);
    expect(viaBash.stdout).toMatch(/^ORBIT_DIGEST_PATTERN=/mu);
    expect(viaSh.stdout).toBe(viaBash.stdout);
    for (const name of ["ORBIT_VERSION_PATTERN", "ORBIT_REVISION_PATTERN", "ORBIT_CHANNEL_PATTERN", "ORBIT_DIGEST_PATTERN"]) {
      expect(viaSh.stdout, name).toContain(`${name}=`);
    }
  });
});
