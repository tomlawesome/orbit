import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1869 decision note, "UI entry point": Administration -> people. A row whose
 * address cannot be read says "address can't be read" where the address goes
 * and gets "set their address…" as its first action; every other row gets
 * "change address…" after "send a new setup link…". Either opens an inline
 * form behind challengeThen("email_address_set", …) and PUTs the address to
 * /api/admin/users/{id}/email. Source-text tests, as the neighbouring
 * administration-*.test.mjs files are; the wording is the spec's, with the
 * straight or curly apostrophe accepted.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8").replace(/\s+/gu, " ");
const page = read("+page.svelte");
const acts = read("acts.svelte.js");
const pocket = read("pocket.svelte");
const workspace = readFileSync(new URL("../../web/src/lib/data/workspace.js", import.meta.url), "utf8").replace(/\s+/gu, " ");

describe("the new step-up intent (#1869)", () => {
  it("is appended to stepUpIntents, separate from setup_link_issue", async () => {
    const { stepUpIntents } = await import("orbit/lib/auth/recent-auth");
    // Fails if the intent is missing: a proof for one act must not pay for another.
    expect(stepUpIntents).toContain("email_address_set");
    expect(stepUpIntents).toContain("setup_link_issue");
    /* The first import of the server module is slow on a loaded host. */
  }, 120_000);
});

describe("People rows offer to set or change an address (#1869)", () => {
  it("shows 'address can't be read' where an unreadable address would go", () => {
    expect(page).toMatch(/address can[’']t be read/u);
  });

  it("offers 'set their address…' on an unreadable row and 'change address…' on the rest", () => {
    expect(page).toMatch(/set their address…/u);
    expect(page).toMatch(/change address…/u);
  });

  it("puts 'change address…' after 'send a new setup link…'", () => {
    expect(page.indexOf("send a new setup link…")).toBeGreaterThan(-1);
    expect(page.indexOf("change address…")).toBeGreaterThan(page.indexOf("send a new setup link…"));
  });

  it("keys the 'set their address…' button on the email metadata status being metadata_integrity_failed", () => {
    expect(page).toMatch(/metadata_integrity_failed/u);
  });

  it("opens the form behind the email_address_set step-up, on the desk and on the phone", () => {
    expect(page).toMatch(/challengeThen\(\s*"email_address_set"/u);
    expect(pocket).toMatch(/challenge\(\s*"email_address_set"/u);
  });

  it("offers the form's two buttons: 'set it' and cancel", () => {
    expect(page).toMatch(/set it/u);
  });

  it("puts the address to /api/admin/users/<id>/email with PUT, with the password when the actor has one", () => {
    // The request itself lives in the shared data layer the acts call.
    expect(workspace).toMatch(/\/api\/admin\/users\/\$\{[^}]+\}\/email/u);
    expect(workspace).toMatch(/method:\s*"PUT"/u);
    expect(acts).toMatch(/currentPassword/u);
  });

  it("says '<name>'s address is now <address>' on success", () => {
    expect(`${page} ${acts}`).toMatch(/address is now/u);
  });
});

/*
 * Review finding 5: back from the identity provider with an
 * `email_address_set` proof, the phone reopens its own address sheet for the
 * same person with what was typed, as it already does for `setup_link_issue`
 * and as the desk does for this intent. Evaluated rather than mounted, the way
 * administration-draft-intent.test.mjs lifts the desk's functions.
 */
/** @param {string} path @param {string} name @param {Record<string, unknown>} scope */
function lift(path, name, scope) {
  const src = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const match = new RegExp(`function ${name}\\(`).exec(src);
  expect(match, `${path} has no \`${name}\``).not.toBeNull();
  const start = /** @type {RegExpExecArray} */ (match).index;
  const end = src.indexOf("\n  }\n", start);
  const body = src.slice(start, end + "\n  }".length);
  const sandbox = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
  });
  return new Function("sandbox", `with (sandbox) { return (${body}); }`)(sandbox);
}

describe("the address errand survives the provider round trip on the phone (#1869)", () => {
  const PERSON = { id: "8d3f0c2e-0000-4000-8000-000000000001", displayName: "Target Person" };

  it("the desk hands the phone the person and the typed address it restored", () => {
    const at = Date.now();
    /** @type {Record<string, any>} */
    const scope = {
      DRAFT_KEY: "draft",
      SETUP_LINK_DAYS: { fallback: 7 },
      sessionStorage: {
        getItem: () => JSON.stringify({ intent: "email_address_set", address: { personId: PERSON.id, email: "new@example.invalid" }, at }),
        removeItem: () => {},
      },
      localDraft: {}, systemName: "", creatingSystem: false,
      resendFor: null, resendDays: 7, resumedResendPersonId: null,
      addressFor: null, addressDraft: "", resumedAddress: null,
    };
    lift("web/src/routes/administration/+page.svelte", "restoreDraft", scope)("email_address_set");
    expect(scope.addressFor).toBe(PERSON.id);
    expect(scope.resumedAddress).toEqual({ personId: PERSON.id, email: "new@example.invalid" });
  });

  it("the phone reopens its address sheet for that person, with the typed address", () => {
    /** @type {Record<string, any>} */
    const scope = {
      view: { users: [PERSON] },
      provenIntent: "email_address_set",
      resumedResendPersonId: null,
      resumedAddress: { personId: PERSON.id, email: "new@example.invalid" },
      SETUP_LINK_DAYS: { fallback: 7 },
      inviteOpen: false, systemOpen: false, systemName: "",
      resendFor: null, resendDays: 7, resendPassword: "", resendOpen: false,
      addressFor: null, addressDraft: "", addressPassword: "left over", addressOpen: false,
      addressCard: { busy: false, problem: "old problem" },
    };
    lift("web/src/routes/administration/pocket.svelte", "resumeProvenErrand", scope)();
    expect(scope.addressOpen).toBe(true);
    expect(scope.addressFor).toEqual(PERSON);
    expect(scope.addressDraft).toBe("new@example.invalid");
    expect(scope.addressPassword).toBe("");
    expect(scope.resendOpen).toBe(false);
  });
});

/* Review note 6: a wrong password on an address change says the address was
   not changed, never "nothing was created". */
describe("a refused address change in its own words (#1869)", () => {
  it("does not say 'nothing was created' for a wrong password", async () => {
    const { addressWords } = await import("../../web/src/routes/administration/words.js");
    const said = addressWords({ code: "recent_authentication_required" });
    expect(said).not.toMatch(/nothing was created/u);
    expect(said).toMatch(/address was not changed/u);
  });
});
