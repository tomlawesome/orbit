import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1901 W-F5: pocket.svelte ran `$effect(() => resumeProvenErrand())`, which
 * runs again on every re-read of `view`, so a proven errand was resumed (and
 * its sheet reopened / re-spent) again and again. It must resume at most once
 * per proof. Structural (no mount): the effect must not be the bare call, and
 * the resume must record that it has happened.
 */
const source = readFileSync(new URL("../../web/src/routes/administration/pocket.svelte", import.meta.url), "utf8");
const fnStart = source.indexOf("function resumeProvenErrand");
const fnBody = source.slice(fnStart, source.indexOf("\n  }\n", fnStart));

describe("a proven errand is resumed once per proof (#1901 W-F5)", () => {
  it("the effect is not the bare re-running call", () => {
    expect(source).not.toMatch(/\$effect\(\(\)\s*=>\s*resumeProvenErrand\(\)\)/);
  });

  it("the resume is still wired to an effect or mount", () => {
    expect(source).toMatch(/resumeProvenErrand\(\)/);
    expect(source.match(/resumeProvenErrand/g).length).toBeGreaterThan(1);
  });

  it("the resume remembers what it already resumed and returns early next time", () => {
    expect(fnBody).toMatch(/if\s*\([^)]*(resumed|done|spent)[^)]*\)\s*return/i);
  });
});
