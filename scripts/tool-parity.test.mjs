import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * Parity: the real tools, asserted against the behaviours the fakes model.
 *
 * Every fake in this repository stands in for `docker`, `docker compose`,
 * `curl` or `cosign`, and each one now refuses what the real tool refuses
 * (#616). That refusal is only worth having if it stays true of the real
 * tool, so this file asserts the behaviours the fakes were written from —
 * against the real binaries, not against a description of them. When a real
 * tool changes, this is what goes red, and the comments beside each fake name
 * this file as the thing that keeps them honest.
 *
 * OPT-IN, BECAUSE IT NEEDS THE REAL TOOLS
 *
 *   ORBIT_TOOL_PARITY=1
 *     Check every tool below: docker (with a running daemon), curl, cosign.
 *
 *   ORBIT_TOOL_PARITY=docker,curl
 *     Check only the named tools. Names are `docker`, `curl` and `cosign`.
 *
 * Unset, the whole file does nothing and says so. Set, it never skips: a tool
 * you asked for that is missing, or a daemon that is not running, is a
 * failure naming what to install, not a quiet pass. That is the point — a
 * parity check that skips itself is indistinguishable from one that passed,
 * which is the same blindness #616 is about.
 *
 * Nothing here reaches the network. The curl HTTP-status cases are served by
 * a throwaway server on 127.0.0.1, and every docker case is a client-side
 * refusal or a lookup of a name that cannot exist.
 */

const ALL_TOOLS = ["docker", "curl", "cosign"];
const requested = (process.env.ORBIT_TOOL_PARITY ?? "").trim();
const selected = requested === ""
  ? []
  : requested === "1" || requested.toLowerCase() === "all"
    ? ALL_TOOLS
    : requested.split(",").map((name) => name.trim()).filter((name) => name.length > 0);

const unknownTools = selected.filter((name) => !ALL_TOOLS.includes(name));

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options });
}

/** Absent by construction: a name no image or container can already be using. */
function absentName(prefix) {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

describe("tool parity: the real tools behave as every fake claims", () => {
  it("names the opt-in variable when it is not set", () => {
    if (selected.length === 0) {
      expect(requested).toBe("");
      return;
    }
    expect(unknownTools, `ORBIT_TOOL_PARITY names tools this file does not know: ${unknownTools.join(", ")}`)
      .toEqual([]);
  });
});

// ---------------------------------------------------------------- docker ---

describe.runIf(selected.includes("docker"))("docker", () => {
  it("is on PATH with a daemon that answers, or this check fails rather than skips", () => {
    const version = run("docker", ["version", "--format", "{{.Server.Version}}"]);
    expect(
      version.status,
      "ORBIT_TOOL_PARITY asked for docker. Install it and start the daemon, or drop 'docker' from the variable. "
        + `docker version said: ${(version.stderr ?? "").trim() || version.error?.message || "nothing"}`,
    ).toBe(0);
  });

  // The #607 defect itself: `-T` is a `docker compose exec` flag and has never
  // been a plain `docker exec` one. Modelled by the shims in
  // scripts/repair.test.mjs, scripts/install.test.mjs and
  // src/lib/install-docker-adapter.docker-adapter.test.ts.
  it("refuses `exec -T` with 125 and names the shorthand", () => {
    const result = run("docker", ["exec", "-T", absentName("orbit-parity"), "true"]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("unknown shorthand flag: 'T' in -T");
  });

  // Every fake's flag parser refuses an unknown long flag with 125 and this
  // message, on every subcommand.
  it.each(["ps", "create", "cp", "rm", "pull", "inspect", "run"])(
    "refuses an unknown flag on `%s` with 125",
    (subcommand) => {
      const result = run("docker", [subcommand, "--orbit-parity-not-a-flag"]);
      expect(result.status).toBe(125);
      expect(result.stderr).toContain("unknown flag: --orbit-parity-not-a-flag");
    },
  );

  it("refuses an unknown flag on `image inspect` with 125", () => {
    const result = run("docker", ["image", "inspect", "--orbit-parity-not-a-flag", "whatever"]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("unknown flag: --orbit-parity-not-a-flag");
  });

  it("refuses an unknown flag on `volume ls` with 125", () => {
    const result = run("docker", ["volume", "ls", "--orbit-parity-not-a-flag"]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("unknown flag: --orbit-parity-not-a-flag");
  });

  // The fakes exit 125 with this message when a value-taking flag is last.
  it("refuses a flag given no value with 125", () => {
    const result = run("docker", ["ps", "--format"]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("flag needs an argument: --format");
  });

  // An unknown subcommand is exit 1, not 125 — which is why the fakes use two
  // different statuses rather than one.
  it("refuses an unknown subcommand with 1, not 125", () => {
    const result = run("docker", [absentName("orbit-parity-subcommand")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });

  // scripts/install.test.mjs's `cp` branch models this exact status and
  // message for FAKE_DOCKER_CP_FAIL.
  it("`cp` from a container that does not exist exits 1 and names it", () => {
    const container = absentName("orbit-parity-container");
    const result = run("docker", ["cp", `${container}:/opt/orbit/deploy/.`, "/tmp"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Error response from daemon: No such container: ${container}`);
  });

  // scripts/install.test.mjs's `image` branch falls through to this status and
  // message when asked for an image it does not model.
  it("`image inspect` of an image that is not present exits 1 and names it", () => {
    const image = `${absentName("orbit-parity-image")}:missing`;
    const result = run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Error response from daemon: No such image: ${image}`);
  });

  // The compose plugin is a different program from the docker CLI and refuses
  // with 1, never 125. Every fake's `compose` branch carries that distinction.
  it("`docker compose` refuses an unknown flag with 1, not 125", () => {
    const result = run("docker", ["compose", "--orbit-parity-not-a-flag", "version"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown flag: --orbit-parity-not-a-flag");
  });

  it("`docker compose` refuses an unknown subcommand with 1", () => {
    const subcommand = absentName("orbit-parity-sub");
    const result = run("docker", ["compose", subcommand]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unknown docker command: "compose ${subcommand}"`);
  });

  // `-T` is valid here and nowhere else — the pair of assertions is the whole
  // point, so a fake cannot answer both alike.
  it("`docker compose exec` accepts -T, unlike `docker exec`", () => {
    const result = run("docker", ["compose", "exec", "-T", absentName("orbit-parity-service"), "true"], {
      cwd: "/nonexistent-orbit-parity-directory",
    });
    expect(result.stderr ?? "").not.toContain("unknown shorthand flag: 'T'");
  });
});

// ------------------------------------------------------------------ curl ---

describe.runIf(selected.includes("curl"))("curl", () => {
  // The server runs in its own process on purpose: every assertion below uses
  // spawnSync, which blocks this process's event loop, so an in-process server
  // could never answer the request it was started for.
  let server;
  let base = "";

  beforeAll(async () => {
    const source = [
      'const { createServer } = require("node:http");',
      'const server = createServer((request, response) => {',
      '  if (request.url === "/ok") {',
      '    response.writeHead(200, { "content-type": "application/json" });',
      '    response.end("{}");',
      "    return;",
      "  }",
      '  response.writeHead(404, { "content-type": "text/plain" });',
      '  response.end("nope");',
      "});",
      'server.listen(0, "127.0.0.1", () => { process.stdout.write(`${server.address().port}\\n`); });',
    ].join("\n");
    server = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(() => reject(new Error("the parity HTTP server did not report a port")), 20_000);
      server.stdout.setEncoding("utf8");
      server.stdout.on("data", (chunk) => {
        buffered += chunk;
        if (buffered.includes("\n")) {
          clearTimeout(timer);
          resolve(buffered.trim());
        }
      });
      server.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    base = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(() => {
    server?.kill("SIGKILL");
  });

  it("is on PATH, or this check fails rather than skips", () => {
    const version = run("curl", ["--version"]);
    expect(
      version.status,
      "ORBIT_TOOL_PARITY asked for curl. Install it, or drop 'curl' from the variable.",
    ).toBe(0);
  });

  // Every fake curl refuses an unrecognised option with this status and
  // message: scripts/install.test.mjs, scripts/test-install-acceptance.sh,
  // scripts/test-repair-journeys.sh and src/lib/install-curl-adapter.test.ts.
  it("refuses an option it does not know with 2", () => {
    const result = run("curl", ["--orbit-parity-not-an-option", `${base}/ok`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("curl: option --orbit-parity-not-an-option: is unknown");
  });

  it("refuses an option given no value with 2", () => {
    const result = run("curl", ["--silent", `${base}/ok`, "--output"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--output");
  });

  // --fail turns an HTTP error into exit 22. install.sh deliberately does not
  // use --fail — it reads the status out of --write-out — so the fakes model
  // 22 only to prove they are not silently more forgiving than curl.
  it("--fail on an HTTP error exits 22", () => {
    const result = run("curl", ["--silent", "--fail", "--output", "/dev/null", `${base}/missing`]);
    expect(result.status).toBe(22);
  });

  it("without --fail an HTTP error is exit 0 and the status reaches --write-out", () => {
    const result = run("curl", ["--silent", "--output", "/dev/null", "--write-out", "%{http_code}", `${base}/missing`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("404");
  });

  // The fakes' fail-closed branch: a host that will not resolve exits 6, and
  // --write-out still prints, with %{http_code} as 000 because no response
  // arrived. `.invalid` is reserved by RFC 2606 and never resolves.
  it("a host that will not resolve exits 6 and writes 000", () => {
    const result = run("curl", [
      "--silent",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "https://orbit-parity.invalid/.well-known/openid-configuration",
    ]);
    expect(result.status).toBe(6);
    expect(result.stdout).toBe("000");
  });
});

// ---------------------------------------------------------------- cosign ---

describe.runIf(selected.includes("cosign"))("cosign", () => {
  const cosign = process.env.ORBIT_COSIGN ?? "cosign";

  it("is on PATH, or this check fails rather than skips", () => {
    const version = run(cosign, ["version"]);
    expect(
      version.status,
      "ORBIT_TOOL_PARITY asked for cosign. Put the pinned binary on PATH (scripts/ci/ensure-cosign.sh prints its "
        + "path; ORBIT_COSIGN overrides the command), or drop 'cosign' from the variable.",
    ).toBe(0);
  });

  // cosign is a Cobra CLI: it has one status for everything it refuses, which
  // is why the stubs in scripts/attest-tested-image.test.mjs and
  // scripts/verify-validation-evidence.test.mjs use 1 rather than docker's
  // 125/1 split.
  it("refuses an unknown subcommand with 1", () => {
    const subcommand = absentName("orbit-parity-subcommand");
    const result = run(cosign, [subcommand]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unknown command "${subcommand}" for "cosign"`);
  });

  it.each(["attest", "verify-attestation"])("refuses an unknown flag on `%s` with 1", (subcommand) => {
    const result = run(cosign, [subcommand, "--orbit-parity-not-a-flag"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown flag: --orbit-parity-not-a-flag");
  });
});
