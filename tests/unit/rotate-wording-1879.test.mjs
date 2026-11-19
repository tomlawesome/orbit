import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1879: a rotate that came back rotated:false says which of two things
 * happened. A fresh address different from the one before: "already changed".
 * The same address: "not confirmed". Both panels carry the same choice; the
 * panels have no component harness, so the choice is read from the source.
 */
const web = (path) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");

describe.each([
  ["the desk RelayPanel", "routes/settings/RelayPanel.svelte"],
  ["the phone settings page", "routes/settings/pocket.svelte"],
])("%s rotate wording (#1879)", (_name, file) => {
  const choice = web(file).split("\n").find((line) => line.includes("ROTATE_ALREADY_CHANGED") && line.includes("?"));

  it("a refused rotate with a different fresh address says ROTATE_ALREADY_CHANGED, the same address ROTATE_NOT_CONFIRMED", () => {
    expect(choice, "the choosing line").toBeTruthy();
    expect(choice).toMatch(/outcome\.relay\s*&&\s*outcome\.relay\.address\s*!==\s*before\s*\?\s*ROTATE_ALREADY_CHANGED\s*:\s*ROTATE_NOT_CONFIRMED/);
  });
});
