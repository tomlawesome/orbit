import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1450 (the claim link is not the log's last line). Owner decision, answer
 * 11a: every place that tells a new operator where the claim link is says only
 * that it is in the app's logs, and how to read them. Orbit itself holds the
 * link back until the usual start-up lines are out, so the link lands last
 * (that half is pinned in src/server/boot-claim-order.test.ts).
 *
 * A source-level check, in the shape of tests/unit/desk-phone-small-drifts.test.mjs:
 * the surfaces are an installer message, one Svelte component and four docs,
 * none of which has a harness to run here. The claim screen is one component
 * for both layouts (desk and phone), so it is checked once.
 */

const ROOT = new URL("../../", import.meta.url);
/** @param {string} path under the repository root */
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");

/**
 * Any way of saying where in the log the link sits. "In the logs" is the
 * instruction; a position inside them is the fault.
 */
const SAYS_A_POSITION =
  /\b(?:last|final|bottom|latest|newest)\b[\s*_`"']*(?:line|entry|thing)|\bend of (?:the |its |that )?(?:container'?s? )?(?:own )?(?:start-?up )?log/i;

/** What the operator is told to run: Compose's logs command for the app container. */
const READS_THE_LOGS = /docker compose[^\n]*\blogs\b[^\n]*\borbit-app\b/;

/** The installer's final message: the print_completion_screen function's printf lines, comments dropped. */
function installerFinalMessage() {
  const source = read("scripts/install.sh");
  const start = source.indexOf("print_completion_screen() {");
  expect(start, "print_completion_screen() exists in scripts/install.sh").toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** What the claim screen shows: the markup below the script, HTML comments dropped. */
function claimScreenMarkup() {
  const source = read("web/src/lib/flight/Claim.svelte");
  const afterScript = source.slice(source.indexOf("</script>"));
  return afterScript.replace(/<!--[\s\S]*?-->/g, "");
}

/** The line of the final message that is about claiming. */
function installerClaimLine() {
  const line = installerFinalMessage()
    .split("\n")
    .find((candidate) => /claim/i.test(candidate));
  expect(line, "the installer's final message has a claim line").toBeDefined();
  return line;
}

const DOCS = ["docs/installing.md", "docs/operating.md", "docs/authentication.md", "docs/installing-preview.md"];

describe("none of the places that point at the claim link calls it the last line (#1450)", () => {
  it("the installer's final message", () => {
    expect(installerClaimLine()).not.toMatch(SAYS_A_POSITION);
  });

  it("the claim screen, which is the same component on the desk and the phone", () => {
    expect(claimScreenMarkup()).not.toMatch(SAYS_A_POSITION);
  });

  it.each(DOCS)("%s", (path) => {
    const lines = read(path)
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => SAYS_A_POSITION.test(line));
    expect(lines.map(({ number, line }) => `${path}:${number}: ${line.trim()}`)).toEqual([]);
  });
});

describe("each still says the link is in the app's logs, and how to read them (#1450)", () => {
  it("the installer's final message names the claim link and the logs command, with the env file filled in", () => {
    const line = installerClaimLine();
    expect(line).toMatch(/link/i);
    expect(line).toMatch(READS_THE_LOGS);
    expect(line).toContain("%s");
  });

  it("the claim screen gives the exact command, because 'check the logs' is not an instruction", () => {
    const markup = claimScreenMarkup();
    expect(markup).toMatch(/docker compose[\s\S]{0,20}logs[\s\S]{0,20}orbit-app/);
    expect(markup).toMatch(/\blogs?\b/i);
  });

  it.each(["docs/operating.md", "docs/authentication.md", "docs/installing-preview.md"])(
    "%s names the claim link, the logs command and the app container",
    (path) => {
      const text = read(path);
      expect(text).toMatch(READS_THE_LOGS);
      expect(text).toMatch(/claim link|link[^\n]{0,80}claim|claim[^\n]{0,80}link/i);
    },
  );

  it("docs/installing.md says the link that creates the first administrator is in the container's log and points at the page with the command", () => {
    const text = read("docs/installing.md");
    expect(text).toMatch(/Claim the new Orbit:[^\n]*(?:\n[^\n-][^\n]*){0,3}\blogs?\b/i);
    expect(text).toContain("authentication.md#claiming-a-fresh-install");
  });
});
