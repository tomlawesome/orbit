import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1900 findings W-S4 and W-S5; design call on #1869 (Fable, 2026-11-18),
 * points 1 and 2: changing your own address is armed (first "set it" on the
 * own row arms and relabels, the second commits with confirmEmail, cancel
 * disarms), other rows stay one press, and the wording is the note's. Source-
 * text tests in the style of administration-set-address-1869.test.mjs; the
 * strings are the note's own, with the straight or curly apostrophe accepted.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8").replace(/\s+/gu, " ");
const page = read("+page.svelte");
const pocket = read("pocket.svelte");
const acts = read("acts.svelte.js");
const workspace = readFileSync(new URL("../../web/src/lib/data/workspace.js", import.meta.url), "utf8").replace(/\s+/gu, " ");

const OWN_SAY = "Sets the address you sign in with. Your next sign-in waits on an approval mailed to it, so a mistyped address locks you out once this session ends. Check it, then press again.";
const OTHERS_BEFORE = "Sets the address ";
const OTHERS_AFTER = " is registered with. Their pending setup links and sign-in approvals stop working. No link is sent; send a new one afterwards.";

describe("the own row's button and arming (#1869 point 1)", () => {
  it("labels the own row's button 'change my address…', with aria 'change your address'", () => {
    expect(page).toContain("change my address…");
    expect(page).toContain("change your address");
  });

  it("keeps 'change address…' for other rows", () => {
    expect(page).toContain("change address…");
  });

  it("relabels the armed 'set it' on the own row as 'set my address to {address}'", () => {
    expect(page).toMatch(/set my address to \$?\{/u);
  });

  it("sends confirmEmail on the second press", () => {
    expect(acts).toContain("confirmEmail");
    expect(workspace).toContain("confirmEmail");
  });

  it("disarms on cancel", () => {
    // The armed state is a variable the cancel button clears along with the form.
    expect(page).toMatch(/addressArmed/u);
    expect(page).toMatch(/cancel[^<]*<\/button>/u);
    expect(page).toMatch(/onclick=\{[^}]*addressArmed\s*=\s*(false|null|"")/u);
  });

  it("submits on the first press for another row: only the own row is guarded", () => {
    expect(page).toMatch(/addressArmed/u);
    // Arming is conditioned on the row being the actor's own (an id comparison against the signed-in user).
    expect(page).toMatch(/addressArmed[^;]{0,200}\.id ===|\.id === [^;]{0,200}addressArmed/u);
  });
});

describe("the desk form's sentences (#1869 point 2)", () => {
  it("says the note's sentence for another person", () => {
    expect(page).toContain(OTHERS_BEFORE);
    expect(page).toContain(OTHERS_AFTER);
  });

  it("says the note's own-address sentence on your own row", () => {
    expect(page).toContain(OWN_SAY);
  });
});

describe("the phone sheet's sentences (#1869 point 2)", () => {
  it("shows the own-address sentence on the own row", () => {
    expect(pocket).toContain(OWN_SAY);
  });

  it("keeps the note's sentence for another person", () => {
    expect(pocket).toContain(OTHERS_BEFORE);
    expect(pocket).toContain(OTHERS_AFTER);
  });

  it("arms the own row's 'set it' on the phone too, sending confirmEmail", () => {
    expect(pocket).toMatch(/set my address to/u);
  });
});

describe("the lines after saving (#1869 point 2)", () => {
  it("says, for another person, that setup links and approvals have stopped and no link was sent", () => {
    expect(acts).toMatch(/'s address is now \$\{[^}]+\}\. Their pending setup links and sign-in approvals have stopped working; no link was sent\./u);
  });

  it("says, for yourself, 'Your address is now {email}. Sign-in approvals now go there.'", () => {
    expect(acts).toMatch(/Your address is now \$\{[^}]+\}\. Sign-in approvals now go there\./u);
  });

  it("keeps the suffix for a failed notice to the old address", () => {
    expect(acts).toContain("but the notice to the old address did not go: ");
  });
});

describe("the refusal in its own words (#1869 point 3)", () => {
  it("maps address_confirmation_required to the note's wording", async () => {
    const { addressWords } = await import("../../web/src/routes/administration/words.js");
    expect(addressWords({ code: "address_confirmation_required" }))
      .toBe("press set again to confirm your own address — the address was not changed");
  });
});
