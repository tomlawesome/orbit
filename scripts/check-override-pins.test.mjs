import { describe, expect, it } from "vitest";

import { findStaleSelectors, readLockedPackages, readOverrideKeys } from "./check-override-pins.mjs";

// pnpm quotes any lockfile key that starts with `@`, so scoped packages appear
// as `'@scope/name@1.2.3':` while unscoped ones appear bare (#1955).
const LOCKFILE = [
  "lockfileVersion: '9.0'",
  "",
  "packages:",
  "",
  "  '@actions/expressions@0.3.61':",
  "    resolution: {integrity: sha512-fake}",
  "",
  '  "@dq/scoped@2.0.0":',
  "    resolution: {integrity: sha512-fake}",
  "",
  "  nanoid@3.3.18:",
  "    resolution: {integrity: sha512-fake}",
  "",
  "snapshots:",
  "",
  "  '@snapshot/only@9.9.9': {}",
  "",
].join("\n");

function check(workspaceOverrides) {
  const keys = readOverrideKeys(`overrides:\n${workspaceOverrides}\n`);
  const locked = readLockedPackages(LOCKFILE);
  const lockedNames = new Set(
    [...locked].map((id) => id.slice(0, id.lastIndexOf("@"))),
  );
  return findStaleSelectors(keys, locked, lockedNames);
}

describe("readLockedPackages", () => {
  it("reads unscoped entries as bare name@version", () => {
    expect(readLockedPackages(LOCKFILE).has("nanoid@3.3.18")).toBe(true);
  });

  it("reads single-quoted scoped keys without the quotes", () => {
    expect(readLockedPackages(LOCKFILE).has("@actions/expressions@0.3.61")).toBe(true);
  });

  it("reads double-quoted scoped keys without the quotes", () => {
    expect(readLockedPackages(LOCKFILE).has("@dq/scoped@2.0.0")).toBe(true);
  });

  it("records no key that still carries a quote", () => {
    for (const id of readLockedPackages(LOCKFILE)) expect(id).not.toMatch(/['"]/u);
  });

  it("ignores snapshots entries", () => {
    expect(readLockedPackages(LOCKFILE).has("@snapshot/only@9.9.9")).toBe(false);
  });
});

describe("override pins against the lockfile", () => {
  it("passes an unscoped pin that matches", () => {
    expect(check("  'nanoid@3.3.18': 3.3.18")).toEqual([]);
  });

  it("fails an unscoped pin whose version is not locked", () => {
    const stale = check("  'nanoid@3.3.19': 3.3.19");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ key: "nanoid@3.3.19", id: "nanoid@3.3.19" });
  });

  it("passes a scoped pin whose version is locked (single-quoted lockfile key)", () => {
    expect(check("  '@actions/expressions@0.3.61': 0.3.61")).toEqual([]);
  });

  it("passes a scoped pin whose version is locked (double-quoted lockfile key)", () => {
    expect(check("  '@dq/scoped@2.0.0': 2.0.0")).toEqual([]);
  });

  it("passes a scoped pin reached through a parent selector", () => {
    expect(check("  '@actions/expressions@0.3.61>nanoid': 3.3.18")).toEqual([]);
  });

  it("fails a scoped pin whose version is not locked, as an unscoped one does", () => {
    const stale = check("  '@actions/expressions@0.3.62': 0.3.62");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      key: "@actions/expressions@0.3.62",
      name: "@actions/expressions",
      version: "0.3.62",
      id: "@actions/expressions@0.3.62",
    });
  });

  it("fails a scoped pin whose package is absent from the lockfile", () => {
    const stale = check("  '@nope/missing@1.0.0': 1.0.0");
    expect(stale.map((s) => s.id)).toContain("@nope/missing@1.0.0");
  });
});
