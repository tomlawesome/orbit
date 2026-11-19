import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1901 (ruling 1): the SignIn card says "Your new password is saved. Sign in
 * with it." for both the `sign_in_again` state the new-password route answers
 * and the `password_change_saved` refusal a retry gets. A source tripwire in
 * the shape of forced-reset-card-wording-1881: mounting the card is heavy.
 */

const flight = path.resolve(import.meta.dirname, "../../web/src/lib/flight");
const card = readFileSync(path.join(flight, "SignIn.svelte"), "utf8");
const flightSource = readdirSync(flight)
  .filter((name) => /\.(svelte|js)$/u.test(name))
  .map((name) => readFileSync(path.join(flight, name), "utf8"))
  .join("\n");

describe("the saved-password card (#1901)", () => {
  it("speaks the saved sentence", () => {
    expect(flightSource).toContain("Your new password is saved. Sign in with it.");
  });

  it("handles the sign_in_again answer and the password_change_saved refusal in the card itself", () => {
    expect(card).toContain("sign_in_again");
    expect(card).toContain("password_change_saved");
  });

  it("still reads a refusal at the hold as the card's own state (password_change_required after the save)", () => {
    expect(card).toContain("password_change_required");
  });
});
