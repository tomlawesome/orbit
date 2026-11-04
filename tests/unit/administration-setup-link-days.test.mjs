import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1676 review: the People row's "send a new setup link…" act lost the days
 * the administrator chose, so 3 or 30 days were sent as the server default.
 * The act must post the chosen days as expiresInDays.
 */
const acts = readFileSync(new URL("../../web/src/routes/administration/acts.svelte.js", import.meta.url), "utf8");

describe("sending a new setup link from People", () => {
  it("posts the days the administrator chose", () => {
    const start = acts.indexOf("export async function issueSetupLink(");
    expect(start).toBeGreaterThan(-1);
    const body = acts.slice(start, acts.indexOf("\nexport ", start + 1));
    expect(body).toMatch(/expiresInDays:\s*Number\(days\)/u);
  });
});
