import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostOwnershipError, applyHostOwnership, readHostIdentity } from "./host-ownership";

// #1210 D5 / #1258: files the engine writes belong to the host operator. The
// rootful end of this (container root chowning to the operator) is proven by
// scripts/ci/create-test-configuration.sh's ownership assertion in CI's
// rootful docker-in-job; these cover the helper's rules.

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbit-host-ownership-"));
  file = join(dir, "f");
  writeFileSync(file, "x");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

describe("readHostIdentity", () => {
  it("is undefined when neither variable is set", () => {
    expect(readHostIdentity({})).toBeUndefined();
    expect(readHostIdentity({ ORBIT_HOST_UID: "", ORBIT_HOST_GID: "" })).toBeUndefined();
  });

  it("parses a numeric pair", () => {
    expect(readHostIdentity({ ORBIT_HOST_UID: "1000", ORBIT_HOST_GID: "100" })).toEqual({ uid: 1000, gid: 100 });
    expect(readHostIdentity({ ORBIT_HOST_UID: "0", ORBIT_HOST_GID: "0" })).toEqual({ uid: 0, gid: 0 });
  });

  it.each([
    [{ ORBIT_HOST_UID: "1000" }],
    [{ ORBIT_HOST_GID: "1000" }],
    [{ ORBIT_HOST_UID: "-1", ORBIT_HOST_GID: "1000" }],
    [{ ORBIT_HOST_UID: "1000", ORBIT_HOST_GID: "abc" }],
    [{ ORBIT_HOST_UID: "01000", ORBIT_HOST_GID: "1000" }],
    [{ ORBIT_HOST_UID: "1000 ", ORBIT_HOST_GID: "1000" }],
  ])("fails closed on %j", (env) => {
    expect(() => readHostIdentity(env)).toThrow(HostOwnershipError);
  });
});

describe("applyHostOwnership", () => {
  it("is a no-op when no identity is configured", () => {
    expect(() => applyHostOwnership(file, {})).not.toThrow();
    expect(statSync(file).uid).toBe(uid);
  });

  it("is a no-op when the process already runs as the operator (rootless engine, or a host run)", () => {
    expect(() => applyHostOwnership(file, { ORBIT_HOST_UID: String(uid), ORBIT_HOST_GID: "99999" })).not.toThrow();
    expect(statSync(file).gid).toBe(gid);
  });

  it("refuses, naming the path, when it cannot hand the file over", () => {
    if (uid === 0) return; // root can chown anywhere
    expect(() => applyHostOwnership(file, { ORBIT_HOST_UID: String(uid + 1), ORBIT_HOST_GID: String(gid) })).toThrow(
      new RegExp(`Could not hand ${file} to the host operator`),
    );
  });

  it("fails closed on a malformed identity even before touching the file", () => {
    expect(() => applyHostOwnership(file, { ORBIT_HOST_UID: "x", ORBIT_HOST_GID: "0" })).toThrow(HostOwnershipError);
  });
});
