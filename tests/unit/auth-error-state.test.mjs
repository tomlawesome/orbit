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
