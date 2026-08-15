import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

const compatibilitySelector = "@esbuild-kit/core-utils>esbuild";
const compatibilityRange = ">=0.25.0 <0.26.0";

function parseOverrides(workspaceText) {
  const section = workspaceText.match(/^overrides:\n((?: {2}.*(?:\n|$))*)/m)?.[1] ?? "";
  return Object.fromEntries(
    [...section.matchAll(/^  (?:'([^']+)'|([^:]+)):\s*(?:'([^']+)'|"([^"]+)"|([^\n]+))$/gm)].map(
      ([, quotedKey, plainKey, singleQuotedValue, doubleQuotedValue, plainValue]) => [
        quotedKey ?? plainKey.trim(),
        singleQuotedValue ?? doubleQuotedValue ?? plainValue.trim(),
      ],
    ),
  );
}

function validateOverridePolicy(workspaceText) {
  const overrides = parseOverrides(workspaceText);
  const policyComment = workspaceText.split("overrides:", 2)[1]?.split("  postcss:", 1)[0] ?? "";

  if (overrides.esbuild === ">=0.25.0") {
    return { valid: false, reason: "global esbuild override is unbounded" };
  }
  if (overrides.esbuild !== undefined) {
    return { valid: false, reason: "esbuild override must be package-scoped" };
  }
  if (overrides[compatibilitySelector] !== compatibilityRange) {
    return { valid: false, reason: "deprecated core-utils edge is not bounded" };
  }
  if (!/security floor[^\n]*0\.25\.0/i.test(policyComment)) {
    return { valid: false, reason: "security floor is missing from the policy comment" };
  }
  if (!/compatibility (?:ceiling|upper bound)[^\n]*<0\.26\.0/i.test(policyComment)) {
    return { valid: false, reason: "compatibility ceiling is missing from the policy comment" };
  }
  return { valid: true };
}

function versionsInLockfile(lockfileText) {
  return [...lockfileText.matchAll(/^  esbuild@(\d+\.\d+\.\d+):$/gm)].map(([, version]) => version);
}

function majorMinorPatch(version) {
  return version.split(".").map(Number);
}

function isAtLeast(version, minimum) {
  const actual = majorMinorPatch(version);
  const floor = majorMinorPatch(minimum);
  return actual[0] > floor[0] || (actual[0] === floor[0] && (actual[1] > floor[1] || (actual[1] === floor[1] && actual[2] >= floor[2])));
}

describe("bounded esbuild override", () => {
  it("rejects the former unbounded global >=0.25.0 policy", () => {
    expect(validateOverridePolicy("overrides:\n  esbuild: '>=0.25.0'\n  postcss: 8.5.18\n")).toEqual({
      valid: false,
      reason: "global esbuild override is unbounded",
    });
  });

  it("uses only the bounded compatibility override for deprecated core-utils", () => {
    expect(validateOverridePolicy(workspace)).toEqual({ valid: true });
  });

  it("keeps every resolved esbuild at or above the security floor", () => {
    const versions = versionsInLockfile(lockfile);

    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => isAtLeast(version, "0.25.0"))).toBe(true);
  });

  it("keeps the compatibility edge bounded without changing other consumers", () => {
    expect(lockfile).toMatch(/  '@esbuild-kit\/core-utils@3\.3\.2':\n    dependencies:\n      esbuild: 0\.25\.12/m);
    expect(lockfile).toMatch(/  drizzle-kit@0\.31\.10:\n    dependencies:[\s\S]*?\n      esbuild: 0\.25\.12\n/m);
    expect(lockfile).toMatch(/  tsx@4\.23\.1:\n    dependencies:\n      esbuild: 0\.28\.1/m);
    /* Pinned deliberately, so an unreviewed change to vite's resolution shows
       up here. Moved 8.1.5 -> 8.2.1 when web/ joined the workspace (#419):
       one lockfile means web's vite requirement now governs the root's too.
       esbuild stays 0.28.1, which is what this policy is actually about. */
    expect(lockfile).toMatch(/  vite@8\.2\.1\([^\n]*esbuild@0\.28\.1[^\n]*\):[\s\S]*?\n      esbuild: 0\.28\.1\n/m);
  });
});
