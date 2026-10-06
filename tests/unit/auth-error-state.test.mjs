import { describe, expect, it } from "vitest";

import {
  INCOMPLETE, REFUSED, authErrorMessageFor, authErrorStateFor,
} from "$lib/flight/auth-error-state.js";

/*
 * `/auth/error?code=…`'s own two faces (#1056), pinned without a browser:
 * the ratified wording (design/v19/auth-error/round-1/README.md, direction
 * B, owner-ratified 2026-09-19) and which of the callback's codes gets
 * which face.
 */

describe("which face a failed callback wears", () => {
  it("refuses only account_disabled — a retry is a lie there", () => {
    expect(authErrorStateFor("account_disabled")).toBe(REFUSED);
  });

  it("reads every other known callback code as incomplete", () => {
    for (const code of [
      "auth_not_configured", "provider_error", "invalid_request", "invalid_state",
      "discovery_failed", "token_exchange_failed", "invalid_id_token", "missing_email",
      "step_up_failed", "link_exists", "bootstrap_claimed", "instance_locked",
    ]) {
      expect(authErrorStateFor(code)).toBe(INCOMPLETE);
    }
  });

  it("defaults anything unreadable to incomplete rather than refusing on a guess", () => {
    /* asAuthError folds an unrecognised error to provider_error server-side,
       but a stranger can still reach this page with any string, or none —
       failing open to the face with a way back, never to the one that says
       an administrator switched them off. */
    expect(authErrorStateFor(undefined)).toBe(INCOMPLETE);
    expect(authErrorStateFor(null)).toBe(INCOMPLETE);
    expect(authErrorStateFor("")).toBe(INCOMPLETE);
    expect(authErrorStateFor("account_disabled ")).toBe(INCOMPLETE);
    expect(authErrorStateFor("ACCOUNT_DISABLED")).toBe(INCOMPLETE);
  });
});

describe("what each face says", () => {
  it("speaks Orbit's own fixed words, with no contact address on either line", () => {
    expect(authErrorMessageFor(INCOMPLETE)).toEqual({
      primary: "Sign-in didn’t complete.",
      sub: "Nothing was changed.",
    });
    expect(authErrorMessageFor(REFUSED)).toEqual({
      primary: "Sign-in was refused.",
      sub: "The administrator has disabled this account.",
    });
  });

  it("never echoes the code or an email address", () => {
    for (const state of [INCOMPLETE, REFUSED]) {
      const { primary, sub } = authErrorMessageFor(state);
      expect(primary + sub).not.toMatch(/@|_|«|»/u);
    }
  });

  it("falls back to the incomplete words for anything it does not recognise", () => {
    expect(authErrorMessageFor("something_else")).toEqual(authErrorMessageFor(INCOMPLETE));
  });
});

describe("a refusal that has its own reason (#1242)", () => {
  /* ADR-0023 §3: a provider identity whose email already belongs to an Orbit
     account is refused with `link_required`, and the person is told the
     fixed remedy. Before #1242 this screen said only "Nothing was changed.",
     so the acceptance bed's "Orbit Administrator" (same address as the local
     administrator) simply looked broken. */
  it("keeps the face with the way back to the door, which is the remedy", () => {
    expect(authErrorStateFor("link_required")).toBe(INCOMPLETE);
  });

  it("says why, in ADR-0023's own fixed words", () => {
    expect(authErrorMessageFor(INCOMPLETE, "link_required")).toEqual({
      primary: "Sign-in didn’t complete.",
      sub: "An Orbit account already uses this email address. Sign in to it and link this provider from settings.",
    });
  });

  it("never echoes the code or an address there either", () => {
    const { primary, sub } = authErrorMessageFor(INCOMPLETE, "link_required");
    expect(primary + sub).not.toMatch(/@|_|«|»/u);
  });

  it("leaves every other code on the ordinary words", () => {
    for (const code of ["invalid_state", "bootstrap_claimed", "link_exists", null, undefined, "LINK_REQUIRED"]) {
      expect(authErrorMessageFor(INCOMPLETE, code)).toEqual(authErrorMessageFor(INCOMPLETE));
    }
    expect(authErrorMessageFor(REFUSED, "account_disabled")).toEqual(authErrorMessageFor(REFUSED));
  });
});
