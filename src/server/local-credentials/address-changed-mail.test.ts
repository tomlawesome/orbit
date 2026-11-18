import { describe, expect, it } from "vitest";
import { renderAddressChangedMail } from "./mail";

/**
 * The notice to the OLD address when an administrator changes it (#1869).
 * The code's own contract: it says that it happened and whom to tell, and it
 * never names the new address.
 */

describe("the address-changed notice", () => {
  it("writes the plain text word for word, with the host from APP_URL", () => {
    const mail = renderAddressChangedMail({ displayName: "Priya Raman", appUrl: "https://orbit.example/" });
    expect(mail.subject).toBe("Your Orbit email address was changed");
    expect(mail.text).toBe([
      "Hello Priya,",
      "",
      "An administrator has changed the email address on your Orbit account at orbit.example.",
      "This address will no longer be used for the account.",
      "",
      "Not expecting this? Tell your administrator.",
      "",
      "Orbit at orbit.example, run by a household, not a company.",
      "",
    ].join("\n"));
  });

  it("leaves the host out when APP_URL is missing or unreadable", () => {
    for (const appUrl of [undefined, "", "not a url"]) {
      const { text } = renderAddressChangedMail({ displayName: "Priya", appUrl });
      expect(text).toContain("on your Orbit account.\n");
      expect(text).not.toContain(" at ");
      expect(text).toContain("Orbit, run by a household, not a company.");
    }
  });

  it("names no address and carries no link, so a lost mailbox learns nothing about where the account went", () => {
    const mail = renderAddressChangedMail({ displayName: "Priya Raman", appUrl: "https://orbit.example" });
    expect(mail.text.match(/[\w.+-]+@[\w.-]+\w/gu)).toBeNull();
    expect(mail.text.match(/https?:\/\/\S+/gu)).toBeNull();
    expect(mail.html).toContain("Your Orbit email address was changed");
    expect(mail.html).not.toMatch(/[\w.+-]+@[\w-]+\.\w/u);
  });
});
