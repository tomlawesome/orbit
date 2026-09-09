import { describe, expect, it } from "vitest";
import { decideProvisioning, resolveRefreshedEmail, type ProvisioningFacts } from "./provision";

/* The registration policy on its own (ADR-0022 §2, ADR-0023 §3). The
   transaction that carries it out needs a database and is proved in
   tests/integration/bootstrap.test.ts; what belongs here is the rule itself,
   because the rule is the part that must be readable and exhaustive. */
function facts(overrides: Partial<ProvisioningFacts> = {}): ProvisioningFacts {
  return { identityKnown: false, claimed: false, bootstrap: false, emailTaken: false, ...overrides };
}

describe("who a successful OIDC sign-in provisions", () => {
  it("signs a known identity in whatever the instance's claim state is", () => {
    for (const claimed of [true, false]) {
      for (const bootstrap of [true, false]) {
        for (const emailTaken of [true, false]) {
          expect(decideProvisioning(facts({ identityKnown: true, claimed, bootstrap, emailTaken })))
            .toEqual({ kind: "sign_in" });
        }
      }
    }
  });

  it("creates nothing for an unknown identity while the instance is unclaimed", () => {
    expect(decideProvisioning(facts())).toEqual({ kind: "refuse", code: "bootstrap_required" });
    // Not even when the email is free: there is one way to get the first
    // account, and it is the code printed at start-up.
    expect(decideProvisioning(facts({ emailTaken: false }))).toEqual({ kind: "refuse", code: "bootstrap_required" });
  });

  it("claims the instance for a sign-in that started from the claim cookie", () => {
    expect(decideProvisioning(facts({ bootstrap: true }))).toEqual({ kind: "claim" });
  });

  it("refuses a claim that arrives after the instance is claimed", () => {
    expect(decideProvisioning(facts({ claimed: true, bootstrap: true })))
      .toEqual({ kind: "refuse", code: "bootstrap_claimed" });
  });

  it("self-registers an ordinary user once the instance is claimed", () => {
    expect(decideProvisioning(facts({ claimed: true }))).toEqual({ kind: "register" });
  });

  it("refuses a new subject whose email already belongs to someone, and creates nothing", () => {
    expect(decideProvisioning(facts({ claimed: true, emailTaken: true })))
      .toEqual({ kind: "refuse", code: "link_required" });
  });
});

describe("the email a returning user keeps", () => {
  it("takes the provider's new address when nobody else holds it", () => {
    expect(resolveRefreshedEmail("old@example.test", "new@example.test", false)).toBe("new@example.test");
  });

  it("keeps the stored address rather than failing the sign-in on a collision", () => {
    expect(resolveRefreshedEmail("old@example.test", "taken@example.test", true)).toBe("old@example.test");
  });
});
