import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1280: a local fidelity run never silently uses a server it did not start.
 * web/playwright.config.js stands up two web servers (the built app and the
 * mockup host). Each may reuse a server already on its port only when
 * FIDELITY_REUSE=1 is set; otherwise a busy port fails the run with
 * Playwright's own message, which names the URL and port. CI never reuses.
 * With FIDELITY_REUSE=1 the run prints one line naming each reused port.
 *
 * The config reads the environment when it is loaded, so each case loads a
 * fresh copy. web/** is excluded from the vitest projects, hence this lives in
 * scripts/ (the same arrangement as e2e-playwright-config.test.mjs).
 */
const VARIABLES = ["CI", "FIDELITY_REUSE", "FIDELITY_PORT", "FIDELITY_MOCKUP_PORT"];
const APP_PORT = "4871";
const MOCKUP_PORT = "5871";
let saved;
let printed;
let restores;

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  printed = [];
  restores = [];
  const record = (text) => printed.push(String(text));
  for (const method of ["log", "info", "warn", "error"]) {
    const spy = vi.spyOn(console, method).mockImplementation((...args) => record(args.join(" ")));
    restores.push(() => spy.mockRestore());
  }
  for (const stream of [process.stdout, process.stderr]) {
    const spy = vi.spyOn(stream, "write").mockImplementation((chunk) => {
      record(chunk);
      return true;
    });
    restores.push(() => spy.mockRestore());
  }
  vi.resetModules();
});

afterEach(() => {
  for (const restore of restores) restore();
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function loadServers(env) {
  Object.assign(process.env, { FIDELITY_PORT: APP_PORT, FIDELITY_MOCKUP_PORT: MOCKUP_PORT, ...env });
  vi.resetModules();
  const config = (await import("../web/playwright.config.js")).default;
  const servers = [config.webServer].flat();
  return { servers, output: printed.join("\n") };
}

describe("web/playwright.config.js reuse of an existing server (#1280)", () => {
  it("stands up the two servers the gate needs, on the ports given", async () => {
    const { servers } = await loadServers({});
    expect(servers).toHaveLength(2);
    expect(servers[0].url).toContain(`:${APP_PORT}/`);
    expect(servers[1].url).toContain(`:${MOCKUP_PORT}/`);
  });

  it("does not reuse either server with CI and FIDELITY_REUSE both unset", async () => {
    const { servers } = await loadServers({});
    expect(servers.map((server) => server.reuseExistingServer)).toEqual([false, false]);
  });

  it("reuses both servers with FIDELITY_REUSE=1", async () => {
    const { servers } = await loadServers({ FIDELITY_REUSE: "1" });
    expect(servers.map((server) => server.reuseExistingServer)).toEqual([true, true]);
  });

  it("does not reuse either server when FIDELITY_REUSE is 0", async () => {
    const { servers } = await loadServers({ FIDELITY_REUSE: "0" });
    expect(servers.map((server) => server.reuseExistingServer)).toEqual([false, false]);
  });

  it("does not reuse either server under CI", async () => {
    const { servers } = await loadServers({ CI: "true" });
    expect(servers.map((server) => server.reuseExistingServer)).toEqual([false, false]);
  });

  it("with FIDELITY_REUSE=1 prints a line naming each reused port, one line per port", async () => {
    const { output } = await loadServers({ FIDELITY_REUSE: "1" });
    const lines = output.split("\n");
    expect(lines.filter((line) => line.includes(APP_PORT))).toHaveLength(1);
    expect(lines.filter((line) => line.includes(MOCKUP_PORT))).toHaveLength(1);
  });
});
