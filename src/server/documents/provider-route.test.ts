import { describe, expect, it } from "vitest";
import { capsMentions } from "./provider-caps-mentions";
import { dealingVotes } from "./provider-dealing-cues";
import { chooseProviderFromPage, providerPicks } from "./provider-route";

const cue = (text: string, name: string): string[] => dealingVotes(text, name).map((vote) => vote.cue);

describe("capsMentions reads names off the page by their shape", () => {
  it("finds a capitalised run, a name before Ltd, and a brand-shaped word", () => {
    const found = capsMentions("Your policy with Kestrel Broadband Limited.\nlessons from Pass2Drive, bookings@pass2drive.co.uk").map((m) => m.value);
    expect(found).toContain("Kestrel Broadband Limited");
    expect(found).toContain("Pass2Drive");
    expect(found).toContain("pass2drive");
  });

  it("does not take a unit, a postcode or a common mailbox for a name", () => {
    const found = capsMentions("Usage 320 kWh at CV2 9LT · write to fred@gmail.com").map((m) => m.value);
    expect(found).not.toContain("kWh");
    expect(found).not.toContain("gmail");
  });
});

describe("dealingVotes says who acts, not who is printed most", () => {
  it("prefers the trading name to the company behind it", () => {
    const text = "Kelbridge Home Loans is a trading name of Priorswood Bank plc.";
    expect(cue(text, "Kelbridge Home Loans")).toContain("is a trading name of");
    expect(cue(text, "Priorswood Bank plc")).toContain("the name behind a trading name");
  });

  it("votes for the firm that signs, is paid or owns the address, and against a person", () => {
    const text = "Customer Mr D. Whitlock\nSignature for Northgate Home Security · D. Sutton\nqueries to accounts@northgatehs.co.uk";
    expect(cue(text, "Northgate Home Security")).toEqual(expect.arrayContaining(["acts: signature for", "own web/e-mail domain"]));
    expect(cue(text, "Whitlock")).toContain("a person, not a firm");
  });

  it("gives a fragment of a longer name no cue", () => {
    expect(cue("licence from Cravenshire District Council", "Cravenshire")).toEqual([]);
  });
});

describe("chooseProviderFromPage", () => {
  const page = [
    "Thornfield Court — service charge demand",
    "Thornfield Court comprises 24 flats. Thornfield Court is managed for the freeholder.",
    "Please make cheques payable to Purbeck & Vane Property Management Ltd.",
    "Purbeck & Vane Property Management Ltd · Account TFC-014",
  ].join("\n");

  it("ranks the firm that acts above the name printed more", () => {
    expect(providerPicks(page).map((pick) => pick.run.display)[0]).toBe("Purbeck & Vane Property Management Ltd");
    expect(chooseProviderFromPage(page)).toBe("Purbeck & Vane Property Management Ltd");
  });

  it("answers nothing where two names are level on cues and printings", () => {
    expect(chooseProviderFromPage("Alder Homes. Birch Homes.\nAlder Homes. Birch Homes.")).toBeUndefined();
  });

  it("answers nothing for an empty page", () => {
    expect(chooseProviderFromPage("")).toBeUndefined();
  });
});
