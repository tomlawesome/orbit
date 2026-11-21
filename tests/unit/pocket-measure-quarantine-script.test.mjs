import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1670 W-F3: the pocket-measure states tagged @quarantine run outside the
 * merge gate, so the gate script leaves them out and a sibling script runs them.
 */
const root = new URL("../../", import.meta.url);
const scripts = JSON.parse(readFileSync(new URL("web/package.json", root), "utf8")).scripts;

describe("pocket-measure quarantine (#1670 W-F3)", () => {
  it("pocket-measure leaves @quarantine tests out", () => {
    expect(scripts["pocket-measure"]).toContain("--grep-invert @quarantine");
  });

  it("pocket-measure:quarantine runs only the @quarantine tests of that project", () => {
    const line = scripts["pocket-measure:quarantine"];
    expect(line, "no pocket-measure:quarantine script").toBeDefined();
    expect(line).toContain("--project=pocket-measure");
    expect(line).toContain("--grep @quarantine");
    expect(line).toContain("--pass-with-no-tests");
  });
});
