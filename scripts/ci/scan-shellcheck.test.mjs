import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/*
 * scripts/ci/scan-shellcheck.sh is report-only: findings never fail the scan,
 * but a shellcheck that cannot be run (crash, kill, bad call, output that is
 * not a json1 report) must fail it, as the code_scanners job comment in
 * .gitlab-ci.yml says. Otherwise a dead tool reads as "0 findings".
 *
 * Each test builds a scratch git repo holding a copy of the script, a stub
 * scripts/ci/ensure-shellcheck.sh that prints the path of a stub shellcheck,
 * and one tracked .sh file. The stub answers --version and otherwise prints
 * `out` and exits `code`.
 */
const script = new URL("./scan-shellcheck.sh", import.meta.url).pathname;
const scratch = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run({ out, code }) {
  const root = mkdtempSync(join(tmpdir(), "scan-shellcheck-"));
  scratch.push(root);
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  copyFileSync(script, join(root, "scripts/ci/scan-shellcheck.sh"));
  writeFileSync(join(root, "stub-output"), out);
  const stub = join(root, "stub-shellcheck");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then printf 'ShellCheck\\nversion: 0.0.0\\n'; exit 0; fi
cat ${JSON.stringify(join(root, "stub-output"))}
exit ${code}
`,
  );
  chmodSync(stub, 0o755);
  writeFileSync(join(root, "scripts/ci/ensure-shellcheck.sh"), `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(stub)}\n`);
  writeFileSync(join(root, "t.sh"), "#!/usr/bin/env bash\necho $1\n");
  const git = (...args) => spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  const r = spawnSync("bash", ["scripts/ci/scan-shellcheck.sh"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const reportPath = join(root, ".orbit-code-scan/shellcheck.json");
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null };
}

const finding = {
  file: "t.sh",
  line: 2,
  endLine: 2,
  column: 6,
  endColumn: 8,
  level: "info",
  code: 2086,
  message: "Double quote to prevent globbing and word splitting.",
  fix: null,
};

describe("scan-shellcheck.sh", () => {
  it.each([1, 2, 137])("fails when shellcheck exits %i with no output, leaving no zero-findings report", (code) => {
    const r = run({ out: "", code });
    expect(r.status).not.toBe(0);
    if (r.report !== null) expect(JSON.parse(r.report.trim() || "null")?.comments).not.toEqual([]);
  });

  it.each([
    ["plain text", "shellcheck: internal error\n"],
    ["a truncated document", '{"comments":[{"file":'],
    ["json with no comments array", '{"version":1}\n'],
    ["a bare array", "[]\n"],
    ["comments that is not an array", '{"comments":"none"}\n'],
  ])("fails when shellcheck writes %s", (_name, out) => {
    expect(run({ out, code: 0 }).status).not.toBe(0);
  });

  it("fails when shellcheck exits 1 but writes something that is not json1", () => {
    expect(run({ out: "oops\n", code: 1 }).status).not.toBe(0);
  });

  it("exits 0 and keeps the report when shellcheck exits 1 with findings", () => {
    const out = JSON.stringify({ comments: [finding] }) + "\n";
    const r = run({ out, code: 1 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.report).comments).toHaveLength(1);
    expect(r.stdout).toContain("1 findings");
  });

  it("exits 0 when shellcheck exits 0 with no comments", () => {
    const r = run({ out: '{"comments":[]}\n', code: 0 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 findings");
  });
});
