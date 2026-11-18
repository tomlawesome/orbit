import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1604 10-22 (docs/adr/0022:198). Owner decision #1450, answer 11a: nothing
 * that points an operator at the claim link says where in the log it sits;
 * it says only that it is in the app's logs. The ADR's installer-contract
 * bullet still says "open the last line".
 */
const adr = readFileSync(new URL("../../docs/adr/0022-bootstrap-claim-and-lost-administrator-recovery.md", import.meta.url), "utf8");

describe("ADR-0022's installer contract (#1604 10-22)", () => {
  it("tells the operator to read the app's logs without naming a line", () => {
    const start = adr.indexOf("The installer's contract changes");
    expect(start).toBeGreaterThan(-1);
    const bullet = adr.slice(start).split(/\n(?=- |\n)/u)[0];
    expect(bullet).toMatch(/docker compose logs orbit-app/u);
    expect(bullet).not.toMatch(/\b(?:last|final|bottom)\s+line\b/iu);
  });
});
