import { describe, expect, it } from "vitest";

import { jobBlocks } from "./test-support/gitlab-ci.mjs";

// #1592 item 1: `supply_chain_source` also runs Trivy's misconfiguration
// scanner, report-only, beside the blocking vuln,secret scan.

const job = jobBlocks().get("supply_chain_source") ?? "";
// Commands with backslash continuations folded onto one line.
const commands = job.replace(/\\\n\s*/gu, " ").split("\n").map((line) => line.trim());
const trivyCommands = commands.filter((line) => /^trivy (fs|config)\b/u.test(line));
const misconfigScan = trivyCommands.find(
  (line) => line.startsWith("trivy config") || /--scanners[= ]\S*misconfig/u.test(line),
);
const artifactPaths = job.slice(job.indexOf("  artifacts:"));

describe("supply_chain_source misconfiguration scan (#1592)", () => {
  it("runs a Trivy misconfiguration scan", () => {
    expect(misconfigScan).toBeDefined();
  });

  it("is report-only: the scan carries --exit-code 0", () => {
    expect(misconfigScan).toMatch(/--exit-code[= ]0(\s|$)/u);
  });

  it("writes JSON to .orbit-supply-chain/misconfig.json", () => {
    expect(misconfigScan).toMatch(/--format[= ]json\b/u);
    expect(misconfigScan).toMatch(/--output[= ]\.orbit-supply-chain\/misconfig\.json(\s|$)/u);
  });

  it("uploads misconfig.json and keeps artifacts when: always", () => {
    expect(artifactPaths).toMatch(/^\s+- \.orbit-supply-chain\/misconfig\.json\s*$/mu);
    expect(artifactPaths).toMatch(/^\s+when: always\s*$/mu);
  });

  it("leaves the blocking vuln,secret scan as it was, with misconfig a separate command", () => {
    const blocking = trivyCommands.filter((line) => /--scanners[= ]vuln,secret(\s|$)/u.test(line));
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatch(/^trivy fs /u);
    expect(blocking[0]).toContain("--output .orbit-supply-chain/source-raw.json");
    expect(blocking[0]).not.toMatch(/--exit-code/u);
    expect(job).toContain('exit "$policy_status"');
    expect(misconfigScan).not.toBe(blocking[0]);
  });
});
