import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q16: belt.css kept .docview/.docbody/.getrow rules from the
 * pre-#1088 document card. #1088 replaced that layout with
 * .readcard/.topsheet/.sheet/.rcfoot; no element anywhere ever carries
 * docview/docbody/getrow any more, so the rules were dead weight that
 * misdescribed the current layout to the next reader. .belt-page .plate
 * is still live (the honest "no page to show" card face) and is kept.
 *
 * #1151 W1-Q18: the seat ring and the end-cap ring (#1065's "the seats
 * above now do it the same way [as the end-caps]") hard-coded the same
 * outline width/offset twice. A shared --belt-seat-ring/-offset custom
 * property means a future width/offset change is made once.
 */

const BELT_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/item/[[id]]/belt.css"),
  "utf8",
);

describe("#1151 W1-Q16: the pre-#1088 docview/docbody/getrow rules are gone", () => {
  for (const dead of [".docview{", ".docbody{", ".docbody h2{", ".docbody .sub{", ".getrow{", ".getrow a.btn-primary{"]) {
    it(`no longer declares ${dead}`, () => {
      expect(BELT_CSS).not.toContain(`.belt-page ${dead}`);
    });
  }

  it("still declares the live .plate / .plate::before rules", () => {
    expect(BELT_CSS).toContain(".belt-page .plate{");
    expect(BELT_CSS).toContain(".belt-page .plate::before{");
  });
});

describe("#1151 W1-Q18: the seat and end-cap focus rings share one custom property", () => {
  it("declares --belt-seat-ring/-offset once", () => {
    const matches = [...BELT_CSS.matchAll(/--belt-seat-ring:2px dashed var\(--accent\);--belt-seat-ring-offset:3px/gu)];
    expect(matches.length).toBe(1);
  });

  it("both the seat and end-cap rules read the shared property", () => {
    expect(BELT_CSS).toMatch(/\.belt-page \.seat \.hit:focus-visible\{outline:var\(--belt-seat-ring\);outline-offset:var\(--belt-seat-ring-offset\)\}/u);
    expect(BELT_CSS).toMatch(/\.belt-page \.endcap-hit:focus-visible\{outline:var\(--belt-seat-ring\);outline-offset:var\(--belt-seat-ring-offset\)\}/u);
  });
});
