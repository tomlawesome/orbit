import type { ReleaseNotes } from "./index";

// What v0.3.7 tells people (docs/releasing.md); wording approved by the owner, 121a.
export const notes: ReleaseNotes = {
  version: "v0.3.7",
  forEveryone: [
    { lead: "Importance", text: "Every item now has an importance, low, medium or high, and its planet's colour shows it; Orbit offers once to set it on the items you already have." },
    { lead: "Key date and repeat", text: "An item has no type any more: its schedule follows from its key date and its repeat." },
    { lead: "Orbit's own choosers", text: "Add's date, repeat and reminder choices are Orbit's own, the same on desk and phone." },
    { lead: "Distance from the sun", text: "Planets sit on a log scale, so the next few weeks get more room, and you choose whether distance follows the key date or your warning date." },
    { lead: "Planet names", text: "A new setting keeps every planet's name on show." },
  ],
  forAdministrators: [
    { lead: "Forwarded mail", text: "A forward is matched to a member only by Orbit's own check of the sender's DKIM signature; the trusted mail server name setting from 0.3.6 is gone, and a saved value is ignored." },
    { lead: "Unsigned forwards", text: "A member whose forward wasn't signed now sees it in their inbox as not kept, instead of it vanishing." },
    { lead: "DKIM lookups", text: "The new optional MAIL_IN_DKIM_DNS_SERVERS setting names the DNS server Orbit asks for DKIM keys." },
    { lead: "Sign-in providers", text: "After removing a sign-in provider, you can remove every member's link to it at once." },
  ],
};
