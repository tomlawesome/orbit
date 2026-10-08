import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #1295: the ClamAV image starts freshclam and clamd side by side. On a volume
// that already holds an older database, freshclam downloads the newer one while
// clamd is still starting, cannot tell clamd ("Clamd was NOT notified"), and
// clamd keeps the older set. The standard fix is a first, blocking freshclam
// run before the image's own entrypoint starts clamd. These tests run the
// entrypoint script docker-compose.yml declares against stand-in freshclam and
// /init programs and check the order of events.

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");

function clamavBlock() {
  const start = compose.indexOf("\n  orbit-clamav:\n");
  if (start < 0) throw new Error("orbit-clamav is not declared");
  const rest = compose.slice(start + 1);
  const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/u);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The inline shell script of `entrypoint: [/bin/sh, -c, |<script>]`, or null. */
function entrypointScript() {
  const match = /\n {4}entrypoint:\n {6}- \/bin\/sh\n {6}- -c\n {6}- \|\n((?: {8}.*\n|\n)+)/u.exec(`${clamavBlock()}\n`);
  return match ? match[1].replaceAll(/^ {8}/gmu, "") : null;
}

function sandbox({ freshclam, database = true }) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-clamav-entrypoint-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "events.log");
  // The stand-in signature directory is the sandbox directory itself.
  if (database) writeFileSync(join(dir, "daily.cvd"), "stand-in database");
  const conf = join(dir, "freshclam.conf");
  writeFileSync(conf, "DatabaseOwner clamav\nNotifyClamd /etc/clamav/clamd.conf\nDatabaseMirror database.clamav.net\n");
  const program = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  program("chown", "exit 0");
  // The stand-in updater takes a moment, like a real download, then either
  // finishes or fails. It records the config it was given.
  program(
    "freshclam",
    [
      `echo "freshclam-start $*" >> ${log}`,
      `config=$(printf '%s\\n' "$@" | sed -n 's/^--config-file=//p')`,
      `if grep -q '^NotifyClamd' "$config"; then echo "notify-enabled" >> ${log}; fi`,
      "sleep 0.3",
      freshclam === "fail" ? `echo "freshclam-failed" >> ${log}; exit 2` : `echo "freshclam-done" >> ${log}`,
    ].join("\n"),
  );
  program("init", `echo "init-start $*" >> ${log}`);
  return { dir, bin, log, conf };
}

function run(script, { bin, dir, log, conf }) {
  const adapted = script
    .replaceAll("/etc/clamav/freshclam.conf", conf)
    .replaceAll("/tmp/", `${dir}/`)
    .replaceAll("/var/lib/clamav", dir)
    .replaceAll("exec /init", `exec ${join(bin, "init")}`);
  const result = spawnSync("/bin/sh", ["-c", adapted, "orbit-clamav-entrypoint"], {
    env: { PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
    timeout: 4_000,
  });
  const events = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
  return { status: result.status, events, stderr: result.stderr };
}

describe("ClamAV first signature update before clamd starts (#1295)", () => {
  it("declares an entrypoint that updates once before handing over to the image", () => {
    expect(entrypointScript()).not.toBeNull();
  });

  it("finishes the first freshclam run before the image's entrypoint (and so clamd) starts", () => {
    const script = entrypointScript();
    expect(script).not.toBeNull();
    const result = run(script, sandbox({ freshclam: "ok" }));
    expect(result.events).toEqual(["freshclam-start", "freshclam-done", "init-start"]);
  });

  it("starts the image's entrypoint anyway when the first update fails (offline host)", () => {
    const result = run(entrypointScript(), sandbox({ freshclam: "fail" }));
    expect(result.events).toEqual(["freshclam-start", "freshclam-failed", "init-start"]);
    expect(result.status).toBe(0);
  });

  it("runs the first update without NotifyClamd, because clamd is not up to be told", () => {
    const result = run(entrypointScript(), sandbox({ freshclam: "ok" }));
    expect(result.events).not.toContain("notify-enabled");
  });

  it("leaves a volume with no database to the image, which already downloads one before clamd starts", () => {
    // A fresh install has nothing to update. The image's own entrypoint does
    // the blocking first download (about 200 MB) with no time limit; a bounded
    // run first would kill a slow download part-way and make the image start it
    // over, which can outlast the installer's readiness wait.
    const result = run(entrypointScript(), sandbox({ freshclam: "ok", database: false }));
    expect(result.events).toEqual(["init-start"]);
    expect(result.status).toBe(0);
  });

  it("updates first when any one of the database files is present", () => {
    for (const file of ["daily.cvd", "daily.cld", "main.cvd", "main.cld"]) {
      const box = sandbox({ freshclam: "ok", database: false });
      writeFileSync(join(box.dir, file), "stand-in database");
      expect(run(entrypointScript(), box).events, file).toEqual(["freshclam-start", "freshclam-done", "init-start"]);
    }
  });

  it("bounds the first update so an offline host cannot hold clamd back indefinitely", () => {
    expect(entrypointScript()).toMatch(/timeout \d+ freshclam /u);
  });
});
