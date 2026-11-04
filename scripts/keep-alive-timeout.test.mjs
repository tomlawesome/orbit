import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #1683: adapter-node's Node default closes idle connections at about 6 s,
// under the idle timeout of the reverse proxies the docs recommend (Caddy
// 120 s upstream). The backend's idle timeout must exceed the proxy's.
//
// Units: adapter-node reads these two variables in SECONDS and multiplies by
// 1000 (see the adapter source test below), so the spec's "125000 ms" is
// written here as 125 s. A bare 125000 would mean about 35 hours.

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const adminDocs = readFileSync(new URL("../docs/administrator-operations.md", import.meta.url), "utf8");

const CADDY_UPSTREAM_IDLE_SECONDS = 120;
const MAX_SANE_SECONDS = 3600;

function runnerEnv() {
  const lines = dockerfile.split("\n");
  const start = lines.findIndex((l) => /^FROM\s.*\sAS runner\s*$/i.test(l));
  expect(start, "Dockerfile has a runner stage").toBeGreaterThanOrEqual(0);
  let end = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l));
  if (end === -1) end = lines.length;
  const env = {};
  for (const line of lines.slice(start, end)) {
    const m = line.match(/^ENV\s+([A-Z_][A-Z0-9_]*)=("?)([^"\s]*)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

function tableRow(name) {
  return adminDocs.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${name}\``));
}

describe("Dockerfile runner stage idle timeouts (#1683)", () => {
  it("sets KEEP_ALIVE_TIMEOUT above Caddy's 120 s upstream idle timeout", () => {
    const raw = runnerEnv().KEEP_ALIVE_TIMEOUT;
    expect(raw, "ENV KEEP_ALIVE_TIMEOUT in the runner stage").toBeDefined();
    const seconds = Number(raw);
    expect(seconds).toBeGreaterThan(CADDY_UPSTREAM_IDLE_SECONDS);
    expect(seconds).toBeLessThanOrEqual(MAX_SANE_SECONDS);
  });

  it("sets HEADERS_TIMEOUT greater than KEEP_ALIVE_TIMEOUT", () => {
    const env = runnerEnv();
    expect(env.HEADERS_TIMEOUT, "ENV HEADERS_TIMEOUT in the runner stage").toBeDefined();
    expect(env.KEEP_ALIVE_TIMEOUT, "ENV KEEP_ALIVE_TIMEOUT in the runner stage").toBeDefined();
    expect(Number(env.HEADERS_TIMEOUT)).toBeGreaterThan(Number(env.KEEP_ALIVE_TIMEOUT));
    expect(Number(env.HEADERS_TIMEOUT)).toBeLessThanOrEqual(MAX_SANE_SECONDS);
  });
});

describe("docs/administrator-operations.md environment table (#1683)", () => {
  for (const name of ["KEEP_ALIVE_TIMEOUT", "HEADERS_TIMEOUT"]) {
    it(`lists ${name} and says why it must exceed the reverse proxy's idle timeout`, () => {
      const row = tableRow(name);
      expect(row, `a table row naming ${name}`).toBeDefined();
      expect(row).toMatch(/reverse prox/i);
      expect(row).toMatch(/idle/i);
      expect(row).toMatch(/exceed|longer|above|greater|higher/i);
    });
  }
});

describe("adapter-node reads the variables (#1683)", () => {
  const dir = new URL("../web/node_modules/@sveltejs/adapter-node/", import.meta.url);
  const sources = ["src/index.js", "src/env.js", "files/index.js", "files/env.js"]
    .map((p) => new URL(p, dir))
    .filter((u) => existsSync(u))
    .map((u) => readFileSync(u, "utf8"))
    .join("\n");

  it("reads KEEP_ALIVE_TIMEOUT and HEADERS_TIMEOUT by these exact names", () => {
    expect(sources).toContain("'KEEP_ALIVE_TIMEOUT'");
    expect(sources).toContain("'HEADERS_TIMEOUT'");
  });

  it("treats the values as seconds (multiplies by 1000)", () => {
    expect(sources).toMatch(/keepAliveTimeout\s*=\s*keep_alive_timeout\s*\*\s*1000/);
    expect(sources).toMatch(/headersTimeout\s*=\s*headers_timeout\s*\*\s*1000/);
  });
});
