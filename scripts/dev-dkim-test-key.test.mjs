import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/*
 * #1681 review: scripts/dev-dkim-test-key.sh builds the TXT record from
 * `openssl pkey -pubout`. When that fails, the record must not be written
 * with an empty `p=` and the script must not say "ready": a record with no
 * key makes every signed e2e forward look unsigned, far from the cause.
 *
 * The script runs from a scratch copy of the repository layout (it cds to its
 * own parent), with an `openssl` stub first on PATH: `genpkey` writes a
 * placeholder key file, `pkey` fails.
 */
const script = fileURLToPath(new URL("./dev-dkim-test-key.sh", import.meta.url));
const scratch = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture({ pkeyFails }) {
  const dir = mkdtempSync(join(tmpdir(), "dev-dkim-test-key-"));
  scratch.push(dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(script, join(dir, "scripts/dev-dkim-test-key.sh"));
  mkdirSync(join(dir, ".orbit-secrets"));
  const bin = join(dir, "stub-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "openssl"), `#!/usr/bin/env bash
case "$1" in
  genpkey)
    out=""
    while [[ $# -gt 0 ]]; do [[ "$1" == "-out" ]] && out="$2"; shift; done
    printf 'PLACEHOLDER NOT A KEY\\n' > "$out"
    exit 0 ;;
  pkey)
    ${pkeyFails ? `echo "stub: pkey failed" >&2; exit 1` : `printf 'DERBYTES'; exit 0`} ;;
esac
exit 2
`);
  chmodSync(join(bin, "openssl"), 0o755);
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function run(fx) {
  return spawnSync("bash", [join(fx.dir, "scripts/dev-dkim-test-key.sh")], { env: fx.env, encoding: "utf8", timeout: 30_000 });
}

describe("dev-dkim-test-key.sh when openssl pkey fails (#1681 review)", () => {
  it("exits non-zero, does not say ready, and writes no record", () => {
    const fx = fixture({ pkeyFails: true });
    const result = run(fx);
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).not.toBe(0);
    expect(result.stdout).not.toContain("dkim test key ready");
    const record = join(fx.dir, ".orbit-secrets/dkim-test-record.txt");
    /* No record at all; an empty or `p=`-only file would still be served. */
    expect(existsSync(record) ? readFileSync(record, "utf8") : null).toBeNull();
  });

  it("control: with a working openssl the record carries the key's bytes and the script says ready", () => {
    const fx = fixture({ pkeyFails: false });
    const result = run(fx);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("dkim test key ready");
    expect(readFileSync(join(fx.dir, ".orbit-secrets/dkim-test-record.txt"), "utf8"))
      .toBe(`v=DKIM1; k=rsa; p=${Buffer.from("DERBYTES").toString("base64")}\n`);
  });
});
