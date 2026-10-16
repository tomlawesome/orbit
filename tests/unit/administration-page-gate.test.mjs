import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * #1440: /administration is the instance administrator's screen. An ordinary
 * member must not be served it at all (the same 404 the kit page gives), and
 * the shell must not even offer the link. The page load refuses before any
 * render: a reader without an active instance administrator session gets
 * `error(404, "Not found")`. On a fixtures instance there is no session at
 * all, so the gate lets the fidelity harness through.
 */
function load(locals) {
  return import("../../web/src/routes/administration/+page.server.js").then((module) => module.load({ locals }));
}

beforeEach(() => {
  delete process.env.ORBIT_FIXTURES;
});

afterEach(() => {
  delete process.env.ORBIT_FIXTURES;
});

describe("/administration page load (#1440)", () => {
  it("refuses an ordinary member with a 404", async () => {
    await expect(load({ session: { user: { id: "member-1", isInstanceAdmin: false } } })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a reader with no session with a 404", async () => {
    await expect(load({})).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a session whose user record is missing the administrator flag", async () => {
    await expect(load({ session: { user: { id: "member-2" } } })).rejects.toMatchObject({ status: 404 });
  });

  it("lets an instance administrator through", async () => {
    await load({ session: { user: { id: "admin-1", isInstanceAdmin: true } } });
  });

  it("lets a fixtures instance through, where no session exists", async () => {
    process.env.ORBIT_FIXTURES = "1";
    await load({});
  });

  it("does not let fixtures mode be inferred from anything but ORBIT_FIXTURES=1", async () => {
    process.env.ORBIT_FIXTURES = "0";
    await expect(load({})).rejects.toMatchObject({ status: 404 });
  });
});
