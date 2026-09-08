import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Runs a real bash child (a fake apk, a fake sleep); a spawn that takes tens
// of milliseconds quiet takes seconds on a starved core (#698). Budget and
// reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

// Isolates Dockerfile:128's apk_retry helper and its one call site, the way
// trivy-db-retry.test.mjs isolates that script -- proof the bounded retry
// actually retries, not just that the words are present (#734). Same shape
// as orbit-base-image's #9/!7: three attempts, sleeping 5s then 10s, failing
// loudly if every attempt fails.
const retrySnippet = (() => {
  const match = dockerfile.match(
    /RUN (apk_retry\(\) \{[^\n]*\}) \\\n\s*&& (apk_retry apk add --no-cache su-exec) \\/,
  );
  if (!match) {
    throw new Error("could not find the apk_retry helper and its call site in Dockerfile");
  }
  return `${match[1]}\n${match[2]}\nexit $?\n`;
})();

function makeFixture({ failures }) {
  const dir = mkdtempSync(join(tmpdir(), "apk-retry-"));
  const countFile = join(dir, "count");
  const sleepLog = join(dir, "sleeps");
  writeFileSync(countFile, "0\n");
  writeFileSync(sleepLog, "");

  const apk = join(dir, "apk");
  writeFileSync(
    apk,
    [
      "#!/usr/bin/env bash",
      `count=$(($(cat "${countFile}") + 1))`,
      `printf '%s\\n' "$count" > "${countFile}"`,
      `if [ "$count" -le ${failures} ]; then`,
      '  echo "ERROR: fetching https://dl-cdn.alpinelinux.org/...: DNS: transient error (try again later)" >&2',
      "  exit 99",
      "fi",
      'echo "OK: su-exec installed"',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(apk, 0o755);

  // The real Dockerfile sleeps 5s then 10s. A fake `sleep` on PATH records
  // the delay it was asked for and returns immediately, so the test proves
  // the retry waits between attempts without actually waiting -- a
  // wall-clock budget standing in for a real condition tells nobody
  // anything true (#698).
  const sleep = join(dir, "sleep");
  writeFileSync(
    sleep,
    ["#!/usr/bin/env bash", `printf '%s\\n' "$1" >> "${sleepLog}"`, "exit 0", ""].join("\n"),
  );
  chmodSync(sleep, 0o755);

  const script = join(dir, "run.sh");
  writeFileSync(script, `#!/usr/bin/env bash\nset -u\n${retrySnippet}`);
  chmodSync(script, 0o755);

  return {
    attempts: () => Number(readFileSync(countFile, "utf8")),
    sleeps: () => readFileSync(sleepLog, "utf8").trim().split("\n").filter(Boolean),
    run: () =>
      failOnProcessDeadline(
        spawnSync("bash", [script], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          ...processGuard(),
        }),
        { label: "apk_retry" },
      ),
  };
}

describe("Dockerfile apk_retry (#734)", () => {
  it("runs apk once when the network is healthy", () => {
    const fixture = makeFixture({ failures: 0 });
    const result = fixture.run();
    expect(result.status).toBe(0);
    expect(fixture.attempts()).toBe(1);
    expect(fixture.sleeps()).toEqual([]);
  });

  it("retries one transient failure and then succeeds", () => {
    const fixture = makeFixture({ failures: 1 });
    const result = fixture.run();
    expect(result.status).toBe(0);
    expect(fixture.attempts()).toBe(2);
    expect(fixture.sleeps()).toEqual(["5"]);
  });

  it("exhausts three attempts, sleeping 5s then 10s, and still fails loudly", () => {
    const fixture = makeFixture({ failures: 99 });
    const result = fixture.run();
    expect(result.status).toBe(99);
    expect(fixture.attempts()).toBe(3);
    expect(fixture.sleeps()).toEqual(["5", "10"]);
  });
});

describe("Dockerfile:128 apk add wiring", () => {
  it("wraps only the apk fetch, not the local rm/user/mkdir chain", () => {
    expect(dockerfile).toMatch(/apk_retry apk add --no-cache su-exec/);
    expect(dockerfile).not.toMatch(/apk_retry (rm|addgroup|adduser|mkdir|chown|chmod)/);
  });

  it("never proceeds against a stale index", () => {
    // The comment above the RUN names the flag deliberately, to say it must
    // not be used -- check only executable lines, not that prose.
    const executableLines = dockerfile
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(executableLines).not.toContain("force-missing-repositories");
  });

  it("keeps the seed-mount RUN a single layer", () => {
    const suExecRuns = dockerfile.match(/^RUN apk_retry/gm) || [];
    expect(suExecRuns.length).toBe(1);
  });
});
