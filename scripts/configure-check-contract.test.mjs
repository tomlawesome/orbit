import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/engine-events.md's "Configuration readiness report (v0)" section is a
// versioned machine interface: orbit-launcher's RunConfigCheck
// (internal/deploy/configure.go) parses exactly these "ready"/"missing"/
// "optional" lines. Like the installer event stream (engine-events.test.mjs)
// and the repair stream (repair-stream-contract.test.mjs), the document
// promises that any vocabulary change lands in the same pull request as its
// update here -- this is what enforces that promise for the readiness
// report, comparing implemented against documented in both directions.
//
// configure.sh's own run_check() calls are the source of truth for what is
// implemented: report_required_bool() is called once per required field,
// report_optional() once per optional group.

const configureSource = readFileSync(
  fileURLToPath(new URL("./configure.sh", import.meta.url)),
  "utf8",
).replaceAll("\r\n", "\n");
const contract = readFileSync(
  fileURLToPath(new URL("../docs/engine-events.md", import.meta.url)),
  "utf8",
).replaceAll("\r\n", "\n");

function implementedFields() {
  const required = [
    ...configureSource.matchAll(/report_required_bool\s+([A-Za-z_][A-Za-z0-9_]*)\s/gu),
  ].map((match) => match[1]);
  const optional = [
    ...configureSource.matchAll(/report_optional\s+([a-z][a-z]*)\s/gu),
  ].map((match) => match[1]);

  expect(required.length, "found no report_required_bool calls in configure.sh").toBeGreaterThan(0);
  expect(optional.length, "found no report_optional calls in configure.sh").toBeGreaterThan(0);

  return { required: new Set(required), optional: new Set(optional) };
}

// The readiness report's own section, so a field documented for the prompt
// grammar or event stream earlier in the same file cannot satisfy an
// assertion here.
function readinessSection() {
  const start = contract.indexOf("## Configuration readiness report (v0)");
  expect(start, "docs/engine-events.md no longer has a Configuration readiness report section").toBeGreaterThan(-1);
  const next = contract.indexOf("\n## ", start + 1);
  return contract.slice(start, next === -1 ? contract.length : next);
}

// The fenced block immediately following a given line of prose within the
// section, identified by a unique substring of that prose.
function fencedBlockAfter(marker) {
  const section = readinessSection();
  const markerIndex = section.indexOf(marker);
  expect(markerIndex, `the readiness section has no text matching "${marker}"`).toBeGreaterThan(-1);
  const open = section.indexOf("```", markerIndex);
  const close = section.indexOf("```", open + 3);
  expect(close, `the fenced block after "${marker}" is not closed`).toBeGreaterThan(open);
  return section
    .slice(open + 3, close)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function documentedFields() {
  return {
    required: new Set(fencedBlockAfter("Required fields")),
    optional: new Set(fencedBlockAfter("Optional groups")),
  };
}

describe("configuration readiness report v0 contract", () => {
  it("documents exactly the required fields configure.sh --check can report", () => {
    const implemented = implementedFields().required;
    const documented = documentedFields().required;

    const undocumented = [...implemented].filter((value) => !documented.has(value)).sort();
    const phantom = [...documented].filter((value) => !implemented.has(value)).sort();

    expect(undocumented, "reported by configure.sh but absent from engine-events.md").toEqual([]);
    expect(phantom, "documented in engine-events.md but never reported").toEqual([]);
  });

  it("documents exactly the optional groups configure.sh --check can report", () => {
    const implemented = implementedFields().optional;
    const documented = documentedFields().optional;

    const undocumented = [...implemented].filter((value) => !documented.has(value)).sort();
    const phantom = [...documented].filter((value) => !implemented.has(value)).sort();

    expect(undocumented, "reported by configure.sh but absent from engine-events.md").toEqual([]);
    expect(phantom, "documented in engine-events.md but never reported").toEqual([]);
  });

  it("keeps required and optional fields disjoint", () => {
    const { required, optional } = implementedFields();
    const overlap = [...required].filter((value) => optional.has(value));
    expect(overlap, "fields reported both as required and optional").toEqual([]);
  });
});
